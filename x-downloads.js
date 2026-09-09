const X_HOST = 'com.blob_video_downloader.ytdlp';
const X_MENU = 'download-x-video';
const xJobs = new Map();
const xPatterns = ['https://x.com/*', 'https://www.x.com/*', 'https://twitter.com/*', 'https://www.twitter.com/*'];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      reportWorkerError('Reset X download menu', chrome.runtime.lastError);
      return;
    }
    chrome.contextMenus.create({ id: X_MENU, title: 'Download this video', contexts: ['all'], documentUrlPatterns: xPatterns }, () => {
      if (chrome.runtime.lastError) reportWorkerError('Create X download menu', chrome.runtime.lastError);
    });
  });
});

function isXPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname);
  } catch { return false; }
}

function saveXJob(job, patch) {
  Object.assign(job.record, patch);
  const snapshot = { ...job.record };
  job.writes = job.writes.then(async () => {
    // This cache is optional: a storage failure must not poison the progress
    // queue or prevent the native port from closing after completion.
    await runWorkerTask('Cache X download progress', () => chrome.storage.session.set({ [`x_job_${snapshot.id}`]: snapshot }));
    // The page may have been closed or navigated away. Delivery failure must
    // not interrupt a download that is already running in the background.
    await chrome.tabs.sendMessage(snapshot.tabId, { action: 'xDownloadProgress', job: snapshot }, { frameId: 0 }).catch(() => {});
  });
  return job.writes;
}

async function startXDownload(url, tabId) {
  const id = crypto.randomUUID();
  const job = { record: { id, tabId, url, status: 'connecting', message: 'Connecting to the downloader…', percent: null }, writes: Promise.resolve(), port: null, settled: false, cancelRequested: false };
  xJobs.set(id, job);

  const finish = async (patch) => {
    if (job.settled) return;
    job.settled = true;
    try {
      await saveXJob(job, patch);
    } finally {
      try { job.port?.disconnect(); }
      finally { xJobs.delete(id); }
    }
  };
  try {
    // Content scripts on existing pages may not be present after an extension
    // reload. The panel script is idempotent, so it is safe to ensure it here.
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['x-progress.js'] });
  } catch {
    await finish({ status: 'error', message: 'Refresh X and try again so the download panel can open.' });
    await runWorkerTask('Show refresh badge', () => chrome.action.setBadgeText({ tabId, text: '!' }));
    await runWorkerTask('Show refresh hint', () => chrome.action.setTitle({ tabId, title: 'Refresh X and try the video download again.' }));
    return;
  }
  await saveXJob(job, {});
  if (job.cancelRequested) {
    await finish({ status: 'cancelled', message: 'Download cancelled.' });
    return;
  }
  if (!url) {
    await finish({ status: 'error', message: 'Right-click a video inside an X post, or use this option on a post’s timestamp link. Refresh X if you just reloaded the extension.' });
    return;
  }
  if ([...xJobs.values()].filter(item => !item.settled).length > 2) {
    await finish({ status: 'error', message: 'Two downloads are already running. Please wait for one to finish.' });
    return;
  }
  try {
    // The background worker owns the port, so dismissing the in-page panel or
    // navigating away does not stop a download. Keep Chrome running to finish.
    job.port = chrome.runtime.connectNative(X_HOST);
    job.port.onMessage.addListener(message => {
      if (job.settled) return;
      if (message.status === 'complete') {
        void runWorkerTask('Finish X download', () => finish({ status: 'complete', message: 'Saved to your chosen folder', filename: String(message.filename || ''), percent: 100 }));
      } else if (message.status === 'error' || message.status === 'cancelled') {
        void runWorkerTask('Finish X download', () => finish({ status: message.status, message: String(message.message || 'Download stopped.') }));
      } else if (message.status === 'progress') {
        const percent = Number.isFinite(message.percent) ? Math.max(0, Math.min(100, message.percent)) : null;
        void runWorkerTask('Update X download progress', () => saveXJob(job, { status: 'downloading', message: String(message.message || 'Downloading…'), percent }));
      }
    });
    job.port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      if (!job.settled) void runWorkerTask('Finish X download', () => finish({ status: 'error', message: error ? 'Chrome could not connect to the local helper. Check that it is installed for this extension ID, then reload the extension.' : 'The downloader stopped before finishing. Please try again.' }));
    });
    job.port.postMessage({ action: 'download', url });
  } catch {
    await finish({ status: 'error', message: 'Could not start the local downloader. Check the helper installation.' });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => runWorkerTask('Start X video download', async () => {
  if (info.menuItemId !== X_MENU || !tab?.id || !isXPage(info.pageUrl || tab.url)) return;
  const key = `x_context_${tab.id}`;
  const stored = (await chrome.storage.session.get(key))[key];
  // A recent context wins even when it has no URL: never silently download the
  // main post when the clicked reply could not be identified.
  const recent = stored && Date.now() - stored.at < 120000 && stored.pageUrl === (info.pageUrl || tab.url);
  const url = canonicalTweetUrl(info.linkUrl) || (recent ? canonicalTweetUrl(stored.url) : canonicalTweetUrl(info.pageUrl || tab.url));
  await startXDownload(url, tab.id);
}));

chrome.tabs.onRemoved.addListener(tabId => { void runWorkerTask('Clear X post context', () => chrome.storage.session.remove(`x_context_${tabId}`)); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'rememberTweetContext' && sender.tab && sender.frameId === 0 && isXPage(sender.url)) {
    chrome.storage.session.set({ [`x_context_${sender.tab.id}`]: { url: canonicalTweetUrl(message.url), at: Date.now(), pageUrl: sender.url } }).then(() => sendResponse({ ok: true }), error => {
      reportWorkerError('Remember clicked X video', error);
      sendResponse({ ok: false });
    });
    return true;
  }
  // Progress/cancel messages come from our isolated content script. Scope them
  // to the sender's tab; page scripts have no direct native-download interface.
  const ownXTab = sender.tab && sender.frameId === 0 && isXPage(sender.url);
  if (message.action === 'getXDownloads' && ownXTab) {
    sendResponse({ jobs: [...xJobs.values()].filter(job => !job.settled && job.record.tabId === sender.tab.id).map(job => ({ ...job.record })) });
  }
  if (message.action === 'cancelXDownload' && ownXTab) {
    const job = xJobs.get(message.jobId);
    const allowed = job?.record.tabId === sender.tab.id && !job.settled;
    if (allowed) {
      job.cancelRequested = true;
      job.port?.postMessage({ action: 'cancel' });
    }
    sendResponse({ ok: Boolean(allowed) });
  }
  return false;
});

const X_HOST = 'com.blob_video_downloader.ytdlp';
const X_MENU = 'download-x-video';
const xJobs = new Map();
const xPatterns = ['https://x.com/*', 'https://www.x.com/*', 'https://twitter.com/*', 'https://www.twitter.com/*'];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: X_MENU, title: 'Download this video', contexts: ['all'], documentUrlPatterns: xPatterns });
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
  job.writes = job.writes.then(() => chrome.storage.session.set({ [`x_job_${snapshot.id}`]: snapshot }));
  return job.writes;
}

async function startXDownload(url) {
  const id = crypto.randomUUID();
  const job = { record: { id, url, status: 'connecting', message: 'Connecting to the downloader…', percent: null }, writes: Promise.resolve(), port: null, settled: false };
  xJobs.set(id, job);
  await saveXJob(job, {});
  await chrome.tabs.create({ url: chrome.runtime.getURL(`download.html?job=${encodeURIComponent(id)}`) });

  const finish = async (patch) => {
    if (job.settled) return;
    job.settled = true;
    await saveXJob(job, patch);
    job.port?.disconnect();
    xJobs.delete(id);
  };
  if (!url) {
    await finish({ status: 'error', message: 'Right-click a video inside an X post, or use this option on a post’s timestamp link. Refresh X if you just reloaded the extension.' });
    return;
  }
  if ([...xJobs.values()].filter(item => !item.settled).length > 2) {
    await finish({ status: 'error', message: 'Two downloads are already running. Please wait for one to finish.' });
    return;
  }
  try {
    // The background worker owns the port, so closing the progress tab does not
    // stop a download. Chrome keeps the worker alive while this port is open.
    job.port = chrome.runtime.connectNative(X_HOST);
    job.port.onMessage.addListener(message => {
      if (job.settled) return;
      if (message.status === 'complete') {
        void finish({ status: 'complete', message: 'Saved to Downloads', filename: String(message.filename || ''), percent: 100 });
      } else if (message.status === 'error' || message.status === 'cancelled') {
        void finish({ status: message.status, message: String(message.message || 'Download stopped.') });
      } else if (message.status === 'progress') {
        const percent = Number.isFinite(message.percent) ? Math.max(0, Math.min(100, message.percent)) : null;
        void saveXJob(job, { status: 'downloading', message: String(message.message || 'Downloading…'), percent });
      }
    });
    job.port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      if (!job.settled) void finish({ status: 'error', message: error ? 'Chrome could not connect to the local helper. Check that it is installed for this extension ID, then reload the extension.' : 'The downloader stopped before finishing. Please try again.' });
    });
    job.port.postMessage({ action: 'download', url });
  } catch {
    await finish({ status: 'error', message: 'Could not start the local downloader. Check the helper installation.' });
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== X_MENU || !tab?.id || !isXPage(info.pageUrl || tab.url)) return;
  const key = `x_context_${tab.id}`;
  const stored = (await chrome.storage.session.get(key))[key];
  // A recent context wins even when it has no URL: never silently download the
  // main post when the clicked reply could not be identified.
  const recent = stored && Date.now() - stored.at < 120000 && stored.pageUrl === (info.pageUrl || tab.url);
  const url = canonicalTweetUrl(info.linkUrl) || (recent ? canonicalTweetUrl(stored.url) : canonicalTweetUrl(info.pageUrl || tab.url));
  await startXDownload(url);
});

chrome.tabs.onRemoved.addListener(tabId => { void chrome.storage.session.remove(`x_context_${tabId}`); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'rememberTweetContext' && sender.tab && sender.frameId === 0 && isXPage(sender.url)) {
    chrome.storage.session.set({ [`x_context_${sender.tab.id}`]: { url: canonicalTweetUrl(message.url), at: Date.now(), pageUrl: sender.url } }).then(() => sendResponse({ ok: true }));
    return true;
  }
  // Websites can provide context but cannot start or cancel native downloads.
  // Only our own progress page can send this control message.
  if (message.action === 'cancelXDownload' && sender.url?.split('?')[0] === chrome.runtime.getURL('download.html')) {
    const job = xJobs.get(message.jobId);
    if (job?.port && !job.settled) job.port.postMessage({ action: 'cancel' });
    sendResponse({ ok: Boolean(job) });
  }
  return false;
});

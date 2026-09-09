chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== 'rememberYouTubeContext' || sender.frameId !== 0 || !sender.tab || !isYouTubePage(sender.url)) return false;
  chrome.storage.session.set({[`yt_context_${sender.tab.id}`]: {url: canonicalYouTubeUrl(message.url), at: Date.now(), pageUrl: sender.url}})
    .then(() => sendResponse({ok: true}), error => {reportWorkerError('Remember YouTube video', error); sendResponse({ok: false});});
  return true;
});
chrome.contextMenus.onClicked.addListener((info, tab) => runWorkerTask('Start YouTube download', async () => {
  if (info.menuItemId !== 'download-youtube-video' || !tab?.id || !isYouTubePage(info.pageUrl || tab.url)) return;
  const pageUrl = info.pageUrl || tab.url;
  const stored = (await chrome.storage.session.get(`yt_context_${tab.id}`))[`yt_context_${tab.id}`];
  const recent = stored && Date.now() - stored.at < 120000 && stored.pageUrl === pageUrl;
  const url = canonicalYouTubeUrl(info.linkUrl) || (recent ? stored.url : canonicalYouTubeUrl(pageUrl));
  await startXDownload(url, tab.id, 'Open the YouTube video or Short, then right-click its picture and choose Download this video.');
}));
chrome.tabs.onRemoved.addListener(tabId => {
  void runWorkerTask('Clear YouTube context', () => chrome.storage.session.remove(`yt_context_${tabId}`));
});

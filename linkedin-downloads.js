const LI_MENU = 'download-linkedin-video';
const linkedInStreams = new Map();

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) return;
  const url = canonicalLinkedInMedia(details.url);
  const assetId = linkedInAssetId(url);
  if (!url || !assetId) return;
  const streams = linkedInStreams.get(details.tabId) || new Map();
  streams.set(assetId, url);
  // Bound tab-local metadata; never retain a browsing history of media URLs.
  if (streams.size > 100) streams.delete(streams.keys().next().value);
  linkedInStreams.set(details.tabId, streams);
}, { urls: ['https://dms.licdn.com/*', 'https://media.licdn.com/*'] });

// Read only the clicked Video.js player's current source. This runs in the page
// world because blob: URLs hide the underlying HLS URL from isolated scripts.
// Treat the result as untrusted and validate it before using the native helper.
function readLinkedInPlayer(playerId) {
  const element = document.getElementById(playerId);
  if (!element) return [];
  const player = element.player || window.videojs?.getPlayer?.(playerId);
  const sources = player?.currentSources?.() || [];
  return [player?.currentSrc?.(), ...sources.map(source => source.src)].filter(value => typeof value === 'string').slice(0, 10);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== 'rememberLinkedInContext' || sender.frameId !== 0 || !sender.tab || !isLinkedInPage(sender.url)) return false;
  const context = message.context;
  const safe = context && {
    playerId: typeof context.playerId === 'string' ? context.playerId.slice(0, 500) : '',
    assetId: typeof context.assetId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(context.assetId) ? context.assetId : null,
    url: canonicalLinkedInMedia(context.url)
  };
  chrome.storage.session.set({ [`li_context_${sender.tab.id}`]: { context: safe, at: Date.now(), pageUrl: sender.url } })
    .then(() => sendResponse({ok: true}), error => { reportWorkerError('Remember LinkedIn video', error); sendResponse({ok: false}); });
  return true;
});

chrome.contextMenus.onClicked.addListener((info, tab) => runWorkerTask('Start LinkedIn video download', async () => {
  if (info.menuItemId !== LI_MENU || !tab?.id || !isLinkedInPage(info.pageUrl || tab.url)) return;
  const stored = (await chrome.storage.session.get(`li_context_${tab.id}`))[`li_context_${tab.id}`];
  const context = stored && Date.now() - stored.at < 120000 && stored.pageUrl === (info.pageUrl || tab.url) ? stored.context : null;
  let url = context?.url || null;
  if (!url && context?.playerId) {
    try {
      const results = await chrome.scripting.executeScript({ target: {tabId: tab.id, frameIds: [0]}, world: 'MAIN', func: readLinkedInPlayer, args: [context.playerId] });
      url = (results[0]?.result || []).map(canonicalLinkedInMedia).find(candidate => candidate && (!context.assetId || linkedInAssetId(candidate) === context.assetId)) || null;
    } catch { /* A disposed player can still be matched by its poster below. */ }
  }
  if (!url && context?.assetId) url = linkedInStreams.get(tab.id)?.get(context.assetId) || null;
  // Never fall back to an arbitrary stream from the tab's other search results.
  await startXDownload(url, tab.id, 'Play this LinkedIn video for a moment, then right-click it again. Refresh LinkedIn if you just reloaded the extension.');
}));

chrome.tabs.onRemoved.addListener(tabId => {
  linkedInStreams.delete(tabId);
  void runWorkerTask('Clear LinkedIn context', () => chrome.storage.session.remove(`li_context_${tabId}`));
});
chrome.webNavigation.onBeforeNavigate.addListener(details => {
  if (details.frameId === 0) linkedInStreams.delete(details.tabId);
});

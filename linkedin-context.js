function findLinkedInVideo(target) {
  if (!(target instanceof Element)) return null;
  const player = target.closest('[data-vjs-player], .video-js, [role="region"][aria-label="Video Player"], video');
  if (!player) return null;
  const video = player.matches('video') ? player : player.querySelector('video');
  const poster = video?.poster || player.querySelector('.vjs-poster img')?.src || '';
  const sources = [video?.currentSrc, video?.src, ...[...player.querySelectorAll('source[src]')].map(node => node.src)];
  return { playerId: player.id, assetId: linkedInAssetId(poster), url: sources.map(canonicalLinkedInMedia).find(Boolean) || null };
}

window.addEventListener('contextmenu', event => {
  if (!event.isTrusted || !chrome.runtime?.id) return;
  const context = findLinkedInVideo(event.target);
  try {
    chrome.runtime.sendMessage({ action: 'rememberLinkedInContext', context }).catch(() => {});
    // Keep the native Chrome menu available over custom video controls.
    if (context) event.stopImmediatePropagation();
  } catch { /* Old content scripts are disconnected after an extension reload. */ }
}, true);

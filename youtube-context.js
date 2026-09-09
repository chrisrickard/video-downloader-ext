window.addEventListener('contextmenu', event => {
  if (!event.isTrusted || !chrome.runtime?.id || !(event.target instanceof Element)) return;
  const target = event.target;
  const player = target.closest('#movie_player, #shorts-player, .html5-video-player, video');
  const url = canonicalYouTubeUrl(target.closest('a[href]')?.href) || (player ? canonicalYouTubeUrl(location.href) : null);
  try {
    chrome.runtime.sendMessage({action: 'rememberYouTubeContext', url}).catch(() => {});
    // YouTube normally replaces the native menu; preserve Chrome's extension item.
    if (player) event.stopImmediatePropagation();
  } catch { /* A stale content script is disconnected after extension reload. */ }
}, true);

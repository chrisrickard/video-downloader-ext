function findTweetVideo(target) {
  if (!(target instanceof Element)) return { url: null, overVideo: false };
  const player = target.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"], video');
  const article = target.closest('article');
  if (!article) return { url: null, overVideo: false };

  // Prefer the timestamp permalink of the clicked post. The tab URL may refer
  // to a different post when the user right-clicks a reply or a timeline video.
  const time = article.querySelector('a[href*="/status/"] time');
  let url = canonicalTweetUrl(time?.closest('a')?.href);
  if (!url) return { url: null, overVideo: Boolean(player) };
  if (player) {
    const players = [...article.querySelectorAll('[data-testid="videoPlayer"]')];
    const index = players.findIndex(item => item === player || item.contains(player) || player.contains(item));
    if (index >= 0 && index < 4) url = `${url.replace(/\/video\/[1-4]$/, '')}/video/${index + 1}`;
  }
  return { url, overVideo: Boolean(player) };
}

window.addEventListener('contextmenu', event => {
  if (!event.isTrusted || !chrome.runtime?.id) return;
  const context = findTweetVideo(event.target);
  // Let Chrome's native menu open over X's player. Do not preventDefault():
  // that would also hide the extension's download menu item.
  try {
    chrome.runtime.sendMessage({ action: 'rememberTweetContext', url: context.url }).catch(() => {});
    if (context.overVideo && context.url) event.stopImmediatePropagation();
  } catch {
    // An old content script can survive an extension reload until X refreshes.
    // Leave the site's menu alone when that script no longer has a connection.
  }
}, true);

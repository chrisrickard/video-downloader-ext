// A tweet URL is the only input accepted by the local downloader. Never pass
// media URLs, command arguments, or output paths supplied by a website.
function canonicalTweetUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
        !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/(\d{1,25})(?:\/video\/([1-4]))?\/?$/);
    if (!match) return null;
    return `https://x.com/i/status/${match[1]}${match[2] ? `/video/${match[2]}` : ''}`;
  } catch {
    return null;
  }
}

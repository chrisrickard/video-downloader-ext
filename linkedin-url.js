// Only LinkedIn's media hosts are passed to the native helper. Preserve signed
// query parameters; stripping them makes otherwise valid video links expire.
function isLinkedInPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['linkedin.com', 'www.linkedin.com'].includes(url.hostname);
  } catch { return false; }
}

function linkedInAssetId(value) {
  try {
    const url = new URL(value);
    if (!['media.licdn.com', 'dms.licdn.com'].includes(url.hostname)) return null;
    return url.pathname.match(/\/(?:dms\/(?:image|video)|playlist\/vid|video\/vid)\/(?:(?:v2|dash)\/)?([A-Za-z0-9_-]+)\//)?.[1] || null;
  } catch { return null; }
}

function canonicalLinkedInMedia(value) {
  if (typeof value !== 'string' || value.length > 7000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !['media.licdn.com', 'dms.licdn.com'].includes(url.hostname)) return null;
    const playlist = /^\/playlist\/vid\/(?:v2\/)?[A-Za-z0-9_-]+\//.test(url.pathname);
    const video = /^\/dms\/video\/(?:v2\/)?[A-Za-z0-9_-]+\//.test(url.pathname) && /\.mp4$/i.test(url.pathname);
    if ((!playlist && !video) || /\.(?:m4s|ts|aac|m4a)$/i.test(url.pathname) || (playlist && /\.mp4$/i.test(url.pathname))) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

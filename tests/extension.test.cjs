const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const data = {}, tabs = [], ports = [], menus = [];
  const chrome = {
    runtime: { id: 'a'.repeat(32), onInstalled: event(), onMessage: event(), getURL: p => 'chrome-extension://' + 'a'.repeat(32) + '/' + p,
      connectNative(name) { const port = { name, onMessage: event(), onDisconnect: event(), sent: [], disconnected: false, postMessage(m) { this.sent.push(m); }, disconnect() { this.disconnected = true; } }; ports.push(port); return port; } },
    contextMenus: { onClicked: event(), removeAll(cb) { cb(); }, create(menu) { menus.push(menu); } },
    storage: { session: { async get(key) { return { [key]: data[key] }; }, async set(values) { Object.assign(data, values); }, async remove(key) { delete data[key]; } } },
    tabs: { onRemoved: event(), async create(tab) { tabs.push(tab); } }
  };
  const scope = vm.createContext({ chrome, URL, crypto, console });
  for (const file of ['x-url.js', 'x-downloads.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), scope);
  return { scope, chrome, data, tabs, ports, menus, async click(info = {}, tab = {id: 10, url: 'https://x.com/u/status/123'}) { await chrome.contextMenus.onClicked.listeners[0]({ menuItemId: 'download-x-video', pageUrl: tab.url, ...info }, tab); }, async message(msg, sender) { for (const fn of chrome.runtime.onMessage.listeners) fn(msg, sender, () => {}); await tick(); } };
}

test('only canonical X post links are accepted', () => {
  const {scope} = setup();
  assert.equal(scope.canonicalTweetUrl('https://twitter.com/u/status/123/video/2?s=46'), 'https://x.com/i/status/123/video/2');
  for (const value of ['https://x.com.evil.test/u/status/1', 'javascript:alert(1)', 'https://u@x.com/u/status/1', 'https://x.com/u/status/1/video/9']) assert.equal(scope.canonicalTweetUrl(value), null);
});

test('menu is restricted to X and a real menu click starts a download', async () => {
  const app = setup(); app.chrome.runtime.onInstalled.listeners[0]();
  assert(app.menus[0].documentUrlPatterns.every(url => url.startsWith('https://')));
  await app.click();
  assert.equal(app.ports[0].sent[0].url, 'https://x.com/i/status/123');
  assert.match(app.tabs[0].url, /download.html\?job=/);
});

test('clicked reply wins over the main post and remembers the video index', async () => {
  const app = setup();
  await app.message({ action: 'rememberTweetContext', url: 'https://x.com/reply/status/456/video/2' }, { tab: {id: 10}, frameId: 0, url: 'https://x.com/u/status/123' });
  await app.click();
  assert.equal(app.ports[0].sent[0].url, 'https://x.com/i/status/456/video/2');
});

test('unresolved recent context never silently selects the main post', async () => {
  const app = setup();
  await app.message({ action: 'rememberTweetContext', url: null }, { tab: {id: 10}, frameId: 0, url: 'https://x.com/u/status/123' });
  await app.click();
  assert.equal(app.ports.length, 0);
  assert.equal(Object.values(app.data).find(x => x.status)?.status, 'error');
});

test('webpages cannot start or cancel native downloads', async () => {
  const app = setup();
  await app.message({ action: 'startXDownload', url: 'https://x.com/u/status/123' }, { tab: {id: 10}, url: 'https://x.com/' });
  assert.equal(app.ports.length, 0);
  await app.click();
  const job = Object.values(app.data).find(x => x.id);
  await app.message({ action: 'cancelXDownload', jobId: job.id }, { tab: {id: 10}, url: 'https://x.com/' });
  assert.equal(app.ports[0].sent.length, 1);
  await app.message({ action: 'cancelXDownload', jobId: job.id }, { url: app.chrome.runtime.getURL('download.html?job=' + job.id) });
  assert.equal(app.ports[0].sent[1].action, 'cancel');
});

test('progress, completion and helper failures reach the status page', async () => {
  const app = setup(); await app.click();
  const port = app.ports[0];
  port.onMessage.listeners[0]({status: 'progress', percent: 42, message: 'Downloading'}); await tick();
  assert.equal(Object.values(app.data)[0].percent, 42);
  port.onMessage.listeners[0]({status: 'complete', filename: 'X-123.mp4'}); await tick();
  assert.equal(Object.values(app.data)[0].status, 'complete');
  assert.equal(port.disconnected, true);
  await app.click();
  app.chrome.runtime.lastError = {message: 'Missing host'};
  app.ports[1].onDisconnect.listeners[0](); await tick();
  assert(Object.values(app.data).some(job => job.status === 'error' && /helper/.test(job.message)));
});

test('at most two native downloads can run at once', async () => {
  const app = setup(); await app.click(); await app.click(); await app.click();
  assert.equal(app.ports.length, 2);
  assert(Object.values(app.data).some(job => /Two downloads/.test(job.message)));
});

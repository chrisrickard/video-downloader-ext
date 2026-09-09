const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const data = {}, tabs = [], ports = [], menus = [], deliveries = [], replies = [], errors = [];
  const chrome = {
    runtime: { id: 'a'.repeat(32), onInstalled: event(), onMessage: event(), getURL: p => 'chrome-extension://' + 'a'.repeat(32) + '/' + p,
      connectNative(name) { const port = { name, onMessage: event(), onDisconnect: event(), sent: [], disconnected: false, postMessage(m) { this.sent.push(m); }, disconnect() { this.disconnected = true; } }; ports.push(port); return port; } },
    contextMenus: { onClicked: event(), removeAll(cb) { cb(); }, create(menu, cb) { menus.push(menu); cb?.(); } },
    storage: { local: { async set() {}, async remove() {} }, session: { async get(key) { return { [key]: data[key] }; }, async set(values) { Object.assign(data, values); }, async remove(key) { delete data[key]; } } },
    tabs: { onRemoved: event(), async create(tab) { tabs.push(tab); }, async sendMessage(tabId, message, options) { deliveries.push({tabId, message, options}); } },
    scripting: { async executeScript() {} },
    action: { async setBadgeText() {}, async setTitle() {}, async setBadgeBackgroundColor() {} },
    webNavigation: { onBeforeNavigate: event() }, webRequest: { onBeforeRequest: event() }
  };
  const scope = vm.createContext({ chrome, URL, crypto, console: {error: message => errors.push(message)} });
  const evaluate = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), scope, {filename: file});
  scope.importScripts = (...files) => files.forEach(evaluate);
  evaluate('background.js');
  return { scope, chrome, data, tabs, ports, menus, deliveries, replies, errors, async click(info = {}, tab = {id: 10, url: 'https://x.com/u/status/123'}) { await chrome.contextMenus.onClicked.listeners[0]({ menuItemId: 'download-x-video', pageUrl: tab.url, ...info }, tab); }, async message(msg, sender) { for (const fn of chrome.runtime.onMessage.listeners) fn(msg, sender, reply => replies.push(reply)); await tick(); } };
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
  assert.equal(app.tabs.length, 0);
  assert.equal(app.deliveries[0].tabId, 10);
  assert.equal(app.deliveries[0].message.action, 'xDownloadProgress');
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

test('only the content script in the owning X tab can cancel a download', async () => {
  const app = setup();
  await app.message({ action: 'startXDownload', url: 'https://x.com/u/status/123' }, { tab: {id: 10}, url: 'https://x.com/' });
  assert.equal(app.ports.length, 0);
  await app.click();
  const job = Object.values(app.data).find(x => x.id);
  await app.message({ action: 'cancelXDownload', jobId: job.id }, { tab: {id: 10}, url: 'https://x.com/' });
  assert.equal(app.ports[0].sent.length, 1);
  await app.message({ action: 'cancelXDownload', jobId: job.id }, { tab: {id: 10}, frameId: 0, url: 'https://x.com/u/status/123' });
  assert.equal(app.ports[0].sent[1].action, 'cancel');
});

test('progress, completion and helper failures reach the in-page panel', async () => {
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


test('another tab cannot read or cancel the current tab download', async () => {
  const app = setup(); await app.click();
  const job = Object.values(app.data).find(x => x.id);
  await app.message({action: 'getXDownloads'}, {tab: {id: 11}, frameId: 0, url: 'https://x.com/home'});
  assert.equal(app.replies.at(-1).jobs.length, 0);
  await app.message({action: 'cancelXDownload', jobId: job.id}, {tab: {id: 11}, frameId: 0, url: 'https://x.com/home'});
  assert.equal(app.replies.at(-1).ok, false);
  assert.equal(app.ports[0].sent.length, 1);
  await app.message({action: 'getXDownloads'}, {tab: {id: 10}, frameId: 0, url: 'https://x.com/home'});
  assert.equal(app.replies.at(-1).jobs[0].id, job.id);
});

test('closing or navigating away from the page does not interrupt native download', async () => {
  const app = setup(); await app.click();
  app.chrome.tabs.sendMessage = async () => { throw new Error('No receiver'); };
  app.ports[0].onMessage.listeners[0]({status: 'complete', filename: 'X-123.mp4'});
  await tick();
  assert.equal(Object.values(app.data)[0].status, 'complete');
  assert.equal(app.ports[0].disconnected, true);
  assert.equal(app.tabs.length, 0);
});

test('failure to inject the panel does not start an invisible download', async () => {
  const app = setup();
  app.chrome.scripting.executeScript = async () => { throw new Error('Permission withheld'); };
  await app.click();
  assert.equal(app.ports.length, 0);
  assert.equal(Object.values(app.data)[0].status, 'error');
});


test('reload rejections in background badge, cache and context APIs are handled', async () => {
  const app = setup();
  const stopped = async () => { throw new Error('No SW'); };
  app.chrome.storage.local.set = stopped;
  app.chrome.storage.local.remove = stopped;
  app.chrome.storage.session.set = stopped;
  app.chrome.storage.session.remove = stopped;
  app.chrome.storage.session.get = stopped;
  app.chrome.action.setBadgeText = stopped;
  app.chrome.action.setBadgeBackgroundColor = stopped;
  app.chrome.webRequest.onBeforeRequest.listeners[0]({tabId: 10, url: 'https://video.twimg.com/test.mp4'});
  app.chrome.webNavigation.onBeforeNavigate.listeners[0]({tabId: 10, frameId: 0});
  for (const listener of app.chrome.tabs.onRemoved.listeners) listener(10);
  await app.message({action: 'clearDetectedVideos', tabId: 10}, {});
  await app.message({action: 'rememberTweetContext', url: 'https://x.com/u/status/123'}, {tab: {id: 10}, frameId: 0, url: 'https://x.com/u/status/123'});
  assert.equal(app.replies.at(-1).ok, false);
  await app.click();
  await tick();
  assert.equal(app.ports.length, 0);
  assert.deepEqual(app.errors, []);
});

test('a rejected cache update cannot strand a finished native download', async () => {
  const app = setup(); await app.click();
  app.chrome.storage.session.set = async () => { throw new Error('No SW'); };
  app.ports[0].onMessage.listeners[0]({status: 'progress', percent: 60});
  app.ports[0].onMessage.listeners[0]({status: 'complete', filename: 'Saved.mp4'});
  await tick(); await tick();
  assert.equal(app.deliveries.at(-1).message.job.status, 'complete');
  assert.equal(app.ports[0].disconnected, true);
  assert.equal(vm.runInContext('xJobs.size', app.scope), 0);
  assert.deepEqual(app.errors, []);
});

test('unexpected API failures retain a useful diagnostic', async () => {
  const app = setup();
  await app.scope.runWorkerTask('Cache test', async () => { throw new Error('Quota exceeded'); });
  assert.deepEqual(app.errors, ['Cache test: Quota exceeded']);
});

test('reload during menu registration and refresh badge updates is handled', async () => {
  const app = setup();
  app.chrome.runtime.lastError = {message: 'No SW'};
  app.chrome.runtime.onInstalled.listeners[0]();
  assert.equal(app.menus.length, 0);
  delete app.chrome.runtime.lastError;
  const stopped = async () => { throw new Error('No SW'); };
  app.chrome.scripting.executeScript = stopped;
  app.chrome.action.setBadgeText = stopped;
  app.chrome.action.setTitle = stopped;
  await app.click();
  assert.equal(app.ports.length, 0);
  assert.equal(vm.runInContext('xJobs.size', app.scope), 0);
  assert.deepEqual(app.errors, []);
});

const downloadMenuDefinitions = [
  {id: 'download-x-video', title: 'Download this video', contexts: ['all'], documentUrlPatterns: ['https://x.com/*', 'https://www.x.com/*', 'https://twitter.com/*', 'https://www.twitter.com/*']},
  {id: 'download-youtube-video', title: 'Download this video', contexts: ['all'], documentUrlPatterns: ['https://youtube.com/*', 'https://www.youtube.com/*', 'https://m.youtube.com/*', 'https://youtu.be/*']},
  {id: 'download-linkedin-video', title: 'Download this video', contexts: ['all'], documentUrlPatterns: ['https://linkedin.com/*', 'https://www.linkedin.com/*']}
];
const pendingMenus = new Set();
function ensureDownloadMenus() {
  for (const definition of downloadMenuDefinitions) {
    const {id, ...properties} = definition;
    if (pendingMenus.has(id)) continue;
    pendingMenus.add(id);
    // Update in place. Removing all menus first leaves no download command if
    // Chrome stops this worker between deletion and recreation during a reload.
    chrome.contextMenus.update(id, properties, () => {
      const error = chrome.runtime.lastError;
      if (!error) { pendingMenus.delete(id); return; }
      if (!/Cannot find (?:context )?menu item/i.test(error.message)) {
        pendingMenus.delete(id);
        reportWorkerError('Update video download menu', error);
        return;
      }
      chrome.contextMenus.create(definition, () => {
        pendingMenus.delete(id);
        if (chrome.runtime.lastError) reportWorkerError('Create video download menu', chrome.runtime.lastError);
      });
    });
  }
}
chrome.runtime.onInstalled.addListener(ensureDownloadMenus);
chrome.runtime.onStartup.addListener(ensureDownloadMenus);
// Menus also recover on a normal worker wake, without requiring another install.
ensureDownloadMenus();

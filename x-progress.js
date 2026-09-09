(() => {
  // An extension reload or a first click can inject this script again. Keep a
  // single listener and panel in the isolated world, without exposing a page API.
  if (globalThis.__blobVideoProgress) return;
  globalThis.__blobVideoProgress = true;

  const cards = new Map();
  const dismissed = new Set();
  let host;
  let list;

  function ensurePanel() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    // Reset the host as well as the shadow contents so X's styles cannot move
    // or restyle the panel. A closed root keeps page scripts out of its controls.
    host.style.cssText = 'all:initial !important;position:fixed !important;right:20px !important;bottom:20px !important;z-index:2147483647 !important;width:min(350px,calc(100vw - 40px)) !important;pointer-events:none !important;color-scheme:dark !important;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { color-scheme: dark; }
      * { box-sizing: border-box; }
      .list { display: grid; gap: 10px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #f8fafc; max-height: calc(100vh - 40px); overflow: auto; }
      .card { pointer-events: auto; padding: 18px; border: 1px solid #475569; border-radius: 16px; background: #172033; box-shadow: 0 12px 40px #0006; }
      .header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      h2 { font-size: 15px; font-weight: 650; line-height: 1.4; margin: 0; }
      p { font-size: 13px; line-height: 1.5; margin: 10px 0 0; color: #cbd5e1; overflow-wrap: anywhere; }
      .filename { font-size: 11px; color: #94a3b8; }
      progress { display: block; width: 100%; height: 8px; accent-color: #a5b4fc; margin-top: 14px; }
      .actions { display: flex; justify-content: flex-end; margin-top: 12px; }
      button { font: inherit; color: #e2e8f0; cursor: pointer; }
      .close { border: 0; background: transparent; padding: 3px 5px; font-size: 20px; line-height: 1; }
      .cancel { background: #26354b; border: 1px solid #64748b; border-radius: 7px; padding: 6px 10px; font-size: 12px; }
      button:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 3px; }
      button:disabled { opacity: .6; cursor: default; }
      [hidden] { display: none !important; }
      .card[data-status="complete"] { border-color: #34d399; }
      .card[data-status="error"] { border-color: #fb7185; }
    `;
    list = document.createElement('div');
    list.className = 'list';
    root.append(style, list);
    for (const item of cards.values()) list.append(item.card);
    document.documentElement.append(host);
  }

  function removeCard(id) {
    const item = cards.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    item.card.remove();
    cards.delete(id);
    if (!cards.size) host?.remove();
  }

  function render(job) {
    if (!job || typeof job.id !== 'string' || dismissed.has(job.id)) return;
    ensurePanel();
    let item = cards.get(job.id);
    if (!item) {
      const card = document.createElement('section');
      card.className = 'card';
      // This template is constant. All messages and filenames use textContent.
      card.innerHTML = '<div class="header"><h2>Downloading video</h2><button class="close" type="button" aria-label="Dismiss download progress" title="Dismiss (download continues)">×</button></div><p class="status" role="status" aria-live="polite"></p><progress max="100" aria-label="Download progress"></progress><p class="filename" hidden></p><div class="actions"><button class="cancel" type="button">Cancel download</button></div>';
      item = { card, heading: card.querySelector('h2'), status: card.querySelector('.status'), progress: card.querySelector('progress'), filename: card.querySelector('.filename'), actions: card.querySelector('.actions'), cancel: card.querySelector('.cancel'), timer: null, terminal: false };
      cards.set(job.id, item);
      card.querySelector('.close').addEventListener('click', event => {
        if (!event.isTrusted) return;
        dismissed.add(job.id);
        removeCard(job.id);
      });
      item.cancel.addEventListener('click', async event => {
        // Ignore synthetic DOM clicks from scripts; cancellation is a user action.
        if (!event.isTrusted) return;
        item.cancel.disabled = true;
        item.status.textContent = 'Cancelling…';
        try {
          const reply = await chrome.runtime.sendMessage({ action: 'cancelXDownload', jobId: job.id });
          if (!reply?.ok) render({ id: job.id, status: 'error', message: 'This download is no longer active.' });
        } catch {
          render({ id: job.id, status: 'error', message: 'The extension was reloaded. Refresh X to reconnect.' });
        }
      });
      list.append(card);
    }
    const done = ['complete', 'cancelled', 'error'].includes(job.status);
    // A completion message must win over any late, queued progress message.
    if (item.terminal && !done) return;
    item.terminal = done;
    item.card.dataset.status = job.status;
    item.heading.textContent = job.status === 'complete' ? 'Video saved' : job.status === 'error' ? 'Download couldn’t finish' : job.status === 'cancelled' ? 'Download cancelled' : 'Downloading video';
    item.status.textContent = job.status === 'complete' ? 'Your MP4 is in Downloads.' : String(job.message || 'Downloading…');
    item.filename.textContent = String(job.filename || '');
    item.filename.hidden = !job.filename;
    item.actions.hidden = done;
    item.progress.hidden = done;
    if (Number.isFinite(job.percent)) item.progress.value = Math.max(0, Math.min(100, job.percent));
    else item.progress.removeAttribute('value');
    // Errors remain visible until dismissed so the user can read what happened.
    if (job.status === 'complete' || job.status === 'cancelled') {
      clearTimeout(item.timer);
      item.timer = setTimeout(() => { dismissed.add(job.id); removeCard(job.id); }, 3500);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message.action === 'xDownloadProgress') render(message.job);
  });
  // Reattach active downloads after refreshing X. New progress updates are also
  // delivered here while the background worker keeps the helper connection open.
  chrome.runtime.sendMessage({ action: 'getXDownloads' }).then(reply => {
    for (const job of reply?.jobs || []) render(job);
  }).catch(() => {});
})();

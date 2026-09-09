const jobId = new URLSearchParams(location.search).get('job');
const key = `x_job_${jobId}`;
const heading = document.getElementById('heading');
const status = document.getElementById('status');
const progress = document.getElementById('progress');
const cancel = document.getElementById('cancel');

function renderDownload(job) {
  if (!job) {
    heading.textContent = 'Download unavailable';
    status.textContent = 'This download session has ended. Right-click the video to start again.';
    progress.hidden = cancel.hidden = true;
    document.getElementById('hint').hidden = true;
    return;
  }
  const done = ['complete', 'error', 'cancelled'].includes(job.status);
  heading.textContent = job.status === 'complete' ? 'Your video is ready' : job.status === 'error' ? 'Download couldn’t finish' : job.status === 'cancelled' ? 'Download cancelled' : 'Downloading your video';
  // All downloader output remains plain text, including filenames and errors.
  status.textContent = job.message;
  document.getElementById('filename').textContent = job.filename || '';
  cancel.hidden = done;
  progress.hidden = job.status === 'error' || job.status === 'cancelled';
  document.getElementById('hint').hidden = job.status === 'error' || job.status === 'cancelled';
  if (job.status === 'complete') document.getElementById('hint').textContent = 'Find this MP4 in Finder → Downloads.';
  if (Number.isFinite(job.percent)) progress.value = job.percent;
  else progress.removeAttribute('value');
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[key]) renderDownload(changes[key].newValue);
});
chrome.storage.session.get(key).then(data => renderDownload(data[key]));
cancel.addEventListener('click', async () => {
  cancel.disabled = true;
  status.textContent = 'Cancelling…';
  const result = await chrome.runtime.sendMessage({ action: 'cancelXDownload', jobId });
  if (!result?.ok) renderDownload(null);
});

// Chrome can reject pending API calls after stopping the old worker during an
// extension reload. That worker cannot retry; the new worker handles new events.
function reportWorkerError(operation, error) {
  const message = String(error?.message || error);
  if (message === 'No SW' || message === 'Extension context invalidated.') return;
  // Keep unexpected failures visible, with the operation that actually failed.
  console.error(`${operation}: ${message}`);
}

async function runWorkerTask(operation, task) {
  try {
    return await task();
  } catch (error) {
    reportWorkerError(operation, error);
  }
}

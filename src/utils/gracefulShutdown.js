'use strict';

async function gracefulShutdown({
  server,
  stopAndDrainProducers,
  closeAndDrainAudits,
  timeoutMs = 5000,
  exit = process.exit,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const deadline = setTimer(() => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    exit(0);
  }, timeoutMs);
  const serverClosed = new Promise(resolve => server.close(resolve));
  await Promise.all([serverClosed, stopAndDrainProducers()]);
  await closeAndDrainAudits();
  clearTimer(deadline);
  exit(0);
}

module.exports = { gracefulShutdown };
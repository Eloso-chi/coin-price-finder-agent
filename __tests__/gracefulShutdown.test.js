'use strict';

const { gracefulShutdown } = require('../src/utils/gracefulShutdown');

test('waits for HTTP and producers before sealing and draining audits', async () => {
  let closeServer;
  let finishProducers;
  const server = { close: jest.fn(callback => { closeServer = callback; }) };
  const stopAndDrainProducers = jest.fn(() => new Promise(resolve => { finishProducers = resolve; }));
  const closeAndDrainAudits = jest.fn().mockResolvedValue(undefined);
  const exit = jest.fn();
  const clearTimer = jest.fn();

  const shutdown = gracefulShutdown({
    server,
    stopAndDrainProducers,
    closeAndDrainAudits,
    exit,
    setTimer: jest.fn(() => 'deadline'),
    clearTimer,
  });
  expect(closeAndDrainAudits).not.toHaveBeenCalled();
  closeServer();
  finishProducers();
  await shutdown;

  expect(closeAndDrainAudits).toHaveBeenCalledTimes(1);
  expect(clearTimer).toHaveBeenCalledWith('deadline');
  expect(exit).toHaveBeenCalledWith(0);
});

test('hard deadline closes connections and exits immediately', () => {
  let expire;
  const server = {
    close: jest.fn(),
    closeAllConnections: jest.fn(),
  };
  const exit = jest.fn();

  void gracefulShutdown({
    server,
    stopAndDrainProducers: () => new Promise(() => {}),
    closeAndDrainAudits: jest.fn(),
    exit,
    setTimer: callback => { expire = callback; return 'deadline'; },
  });
  expire();

  expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(0);
});
/**
 * @jest-environment @stryker-mutator/jest-runner/jest-env/jsdom
 *
 * collectionStorageErrors.test.js -- BACKLOG #306H
 *
 * CoinStorage must report collection failures as categorized CollectionError
 * values instead of mapping them to an empty list, so the UI can tell a failed
 * load from a genuinely empty collection.
 */

'use strict';

global.CoinAuth = { currentUser: () => ({ userId: 'u1', token: 'tok123' }) };

const CoinStorage = require('../../public/js/storage');
const { CollectionError } = CoinStorage;

function respond(status, body, { badJson = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: badJson
      ? () => Promise.reject(new SyntaxError('Unexpected token <'))
      : () => Promise.resolve(body),
  };
}

async function microflush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

afterEach(() => {
  jest.useRealTimers();
  delete global.fetch;
});

describe('CoinStorage.getAllDecrypted (#306H)', () => {
  test('a successful empty collection resolves to an empty array', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(200, { coins: [] }));
    await expect(CoinStorage.getAllDecrypted('u1', 'k')).resolves.toEqual([]);
  });

  test('returns the coins and sends the bearer token', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(200, { coins: [{ coinHash: 'a' }, { coinHash: 'b' }] }));
    const coins = await CoinStorage.getAllDecrypted('u1', 'k');
    expect(coins).toEqual([{ coinHash: 'a' }, { coinHash: 'b' }]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/coins');
    expect(opts.headers.Authorization).toBe('Bearer tok123');
  });

  test.each([
    [401, 'auth-expired'],
    [403, 'forbidden'],
    [429, 'rate-limited'],
    [500, 'server'],
    [503, 'server'],
    [404, 'server'],
  ])('HTTP %i rejects with code %s instead of returning an empty list', async (status, code) => {
    global.fetch = jest.fn().mockResolvedValue(respond(status, { error: 'nope' }));
    const err = await CoinStorage.getAllDecrypted('u1', 'k').catch((e) => e);
    expect(err).toBeInstanceOf(CollectionError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message).toBe('nope');
  });

  test('an unreadable error body falls back to a default message', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(500, null, { badJson: true }));
    const err = await CoinStorage.getAllDecrypted('u1', 'k').catch((e) => e);
    expect(err).toBeInstanceOf(CollectionError);
    expect(err.code).toBe('server');
    expect(err.message).toBe('Could not load your collection.');
  });

  test('an unparseable success body is malformed, not empty', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(200, null, { badJson: true }));
    const err = await CoinStorage.getAllDecrypted('u1', 'k').catch((e) => e);
    expect(err).toBeInstanceOf(CollectionError);
    expect(err.code).toBe('malformed');
  });

  test.each([
    ['an empty object', {}],
    ['a null coins field', { coins: null }],
    ['a string coins field', { coins: 'none' }],
    ['a null body', null],
  ])('a success body with %s is malformed, not empty', async (_label, body) => {
    global.fetch = jest.fn().mockResolvedValue(respond(200, body));
    const err = await CoinStorage.getAllDecrypted('u1', 'k').catch((e) => e);
    expect(err).toBeInstanceOf(CollectionError);
    expect(err.code).toBe('malformed');
  });

  test('a transport failure rejects with code network', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await CoinStorage.getAllDecrypted('u1', 'k').catch((e) => e);
    expect(err).toBeInstanceOf(CollectionError);
    expect(err.code).toBe('network');
  });

  test('a response that never arrives rejects with code timeout', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn((_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const pending = CoinStorage.getAllDecrypted('u1', 'k').catch((e) => e);
    jest.advanceTimersByTime(CoinStorage.REQUEST_TIMEOUT_MS);
    const err = await pending;
    expect(err).toBeInstanceOf(CollectionError);
    expect(err.code).toBe('timeout');
  });

  test('a body that never finishes reading rejects with code timeout', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn((_url, opts) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    }));
    const pending = CoinStorage.getAllDecrypted('u1', 'k').catch((e) => e);
    await microflush();
    jest.advanceTimersByTime(CoinStorage.REQUEST_TIMEOUT_MS);
    const err = await pending;
    expect(err).toBeInstanceOf(CollectionError);
    expect(err.code).toBe('timeout');
  });

  test('a completed request leaves no timeout timer behind', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn().mockResolvedValue(respond(200, { coins: [] }));
    await CoinStorage.getAllDecrypted('u1', 'k');
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe.each([
  ['updateCount', () => CoinStorage.updateCount('u1', 'k', 'h1', 3), 'PUT', { count: 3 }, 'Failed to update count'],
  ['updateCostPer', () => CoinStorage.updateCostPer('u1', 'k', 'h1', 4.5), 'PUT', { costPer: 4.5 }, 'Failed to update cost'],
  ['removeCoin', () => CoinStorage.removeCoin('u1', 'h1'), 'DELETE', undefined, 'Failed to remove coin'],
])('CoinStorage.%s (#306H)', (_name, run, method, body, fallback) => {
  test('success resolves and sends the expected request', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(200, { ok: true }));
    await expect(run()).resolves.toBeUndefined();
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/coins/h1');
    expect(opts.method).toBe(method);
    expect(opts.headers.Authorization).toBe('Bearer tok123');
    if (body === undefined) expect(opts.body).toBeUndefined();
    else expect(JSON.parse(opts.body)).toEqual(body);
  });

  test('success with an empty body still resolves', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(204, null, { badJson: true }));
    await expect(run()).resolves.toBeUndefined();
  });

  test.each([
    [401, 'auth-expired'],
    [403, 'forbidden'],
    [429, 'rate-limited'],
    [500, 'server'],
  ])('HTTP %i rejects with code %s and keeps the server message', async (status, code) => {
    global.fetch = jest.fn().mockResolvedValue(respond(status, { error: 'server said no' }));
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(CollectionError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message).toBe('server said no');
  });

  test('a failure with an unreadable body uses the default message', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(500, null, { badJson: true }));
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(CollectionError);
    expect(err.message).toBe(fallback);
  });

  test('a transport failure rejects with code network', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(CollectionError);
    expect(err.code).toBe('network');
  });

  test('a response that never arrives rejects with code timeout', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn((_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const pending = run().catch((e) => e);
    jest.advanceTimersByTime(CoinStorage.REQUEST_TIMEOUT_MS);
    const err = await pending;
    expect(err).toBeInstanceOf(CollectionError);
    expect(err.code).toBe('timeout');
  });
});

describe('coin that no longer exists (#306H)', () => {
  test.each([
    ['updateCount', () => CoinStorage.updateCount('u1', 'k', 'h1', 3)],
    ['updateCostPer', () => CoinStorage.updateCostPer('u1', 'k', 'h1', 4.5)],
  ])('%s rejects with code not-found on HTTP 404', async (_name, run) => {
    global.fetch = jest.fn().mockResolvedValue(respond(404, { error: 'Coin not found' }));
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(CollectionError);
    expect(err.code).toBe('not-found');
    expect(err.status).toBe(404);
    expect(err.message).toBe('Coin not found');
  });

  test('removeCoin treats HTTP 404 as already removed', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(404, { error: 'Coin not found' }));
    await expect(CoinStorage.removeCoin('u1', 'h1')).resolves.toBeUndefined();
  });

  test('a 404 on the collection load is a service failure, not a missing coin', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(404, { error: 'Not found' }));
    const err = await CoinStorage.getAllDecrypted('u1', 'k').catch((e) => e);
    expect(err).toBeInstanceOf(CollectionError);
    expect(err.code).toBe('server');
  });
});
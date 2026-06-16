// __tests__/ebayRetryExhaustion.test.js -- retry exhaustion contract for
// src/services/ebayService.js#withRetry, exercised via the exported
// browseSearch() function (the most direct public surface that wraps
// axios.get in withRetry without the multi-tier fetchSoldComps complexity).
//
// Existing ebayFetchSoldComps.test.js covers:
//   - "handles Finding API failure gracefully and falls back to Browse"
//     (a single non-retryable error path)
//
// This file adds the explicit retry behavior:
//   1. 429 -> 429 -> 429: exhausts the budget and throws after 3 attempts.
//   2. 503 -> 503 -> 503: exhausts the budget and throws after 3 attempts.
//   3. 503 -> 503 -> 200: succeeds on the 3rd attempt.
//   4. 500 -> 200: succeeds on the 2nd attempt.
//   5. Network error (no .response): NOT retried, throws after 1 attempt.
//   6. 404 (4xx non-429): NOT retried, throws after 1 attempt.
//   7. The retry delays use exponential growth (baseDelay * attempt).
'use strict';

jest.mock('axios');
jest.mock('../src/services/terapeakService');
jest.mock('../src/utils/stats');
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, existsSync: jest.fn(() => true), mkdirSync: jest.fn() };
});

const axios = require('axios');

// Safety: axios fully mocked above -- stubs cannot reach a real eBay endpoint.
process.env.EBAY_APP_ID = 'test-app-id-retry';
process.env.EBAY_CLIENT_SECRET = 'test-secret-retry';
process.env.EBAY_THROTTLE_MS = '0';
process.env.EBAY_CACHE_TTL_MS = '1000';

const ebayService = require('../src/services/ebayService');

function makeErr(status) {
  const e = new Error(`HTTP ${status}`);
  e.response = { status };
  return e;
}

function makeOAuthResp() {
  return { data: { access_token: 'tok-retry', expires_in: 3600 } };
}

beforeEach(() => {
  jest.clearAllMocks();
  ebayService.clearCache();
  // Default: OAuth succeeds.
  axios.post.mockResolvedValue(makeOAuthResp());
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ebayService.browseSearch -- retry exhaustion (429)', () => {
  test('429-429-429 exhausts the budget and throws after 3 attempts', async () => {
    jest.useFakeTimers();
    axios.get
      .mockRejectedValueOnce(makeErr(429))
      .mockRejectedValueOnce(makeErr(429))
      .mockRejectedValueOnce(makeErr(429));

    const promise = ebayService.browseSearch('retry-429-test', 10);
    const assertion = expect(promise).rejects.toThrow(/HTTP 429/);
    await jest.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(axios.get).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

describe('ebayService.browseSearch -- retry exhaustion (5xx)', () => {
  test('503-503-503 exhausts the budget and throws', async () => {
    jest.useFakeTimers();
    axios.get
      .mockRejectedValueOnce(makeErr(503))
      .mockRejectedValueOnce(makeErr(503))
      .mockRejectedValueOnce(makeErr(503));

    const promise = ebayService.browseSearch('retry-503-test', 10);
    const assertion = expect(promise).rejects.toThrow(/HTTP 503/);
    await jest.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(axios.get).toHaveBeenCalledTimes(3);
  });

  test('500-502-504 exhausts the budget (mixed 5xx)', async () => {
    jest.useFakeTimers();
    axios.get
      .mockRejectedValueOnce(makeErr(500))
      .mockRejectedValueOnce(makeErr(502))
      .mockRejectedValueOnce(makeErr(504));

    const promise = ebayService.browseSearch('retry-mixed-5xx', 10);
    const assertion = expect(promise).rejects.toThrow(/HTTP 504/);
    await jest.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(axios.get).toHaveBeenCalledTimes(3);
  });
});

describe('ebayService.browseSearch -- retry success after transient failures', () => {
  test('503-503-200 succeeds on the 3rd attempt', async () => {
    jest.useFakeTimers();
    axios.get
      .mockRejectedValueOnce(makeErr(503))
      .mockRejectedValueOnce(makeErr(503))
      .mockResolvedValueOnce({ data: { itemSummaries: [] } });

    const promise = ebayService.browseSearch('retry-success-3rd', 10);
    await jest.advanceTimersByTimeAsync(5000);

    const result = await promise;
    expect(result).toEqual([]);
    expect(axios.get).toHaveBeenCalledTimes(3);
  });

  test('500-200 succeeds on the 2nd attempt', async () => {
    jest.useFakeTimers();
    axios.get
      .mockRejectedValueOnce(makeErr(500))
      .mockResolvedValueOnce({ data: { itemSummaries: [] } });

    const promise = ebayService.browseSearch('retry-success-2nd', 10);
    await jest.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toEqual([]);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  test('429-200 succeeds on the 2nd attempt (429 is retryable in ebay withRetry)', async () => {
    jest.useFakeTimers();
    axios.get
      .mockRejectedValueOnce(makeErr(429))
      .mockResolvedValueOnce({ data: { itemSummaries: [] } });

    const promise = ebayService.browseSearch('retry-429-then-ok', 10);
    await jest.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toEqual([]);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
});

describe('ebayService.browseSearch -- NON-retryable failures', () => {
  test('network error (no .response) is NOT retried', async () => {
    const netErr = new Error('ECONNREFUSED');
    axios.get.mockRejectedValueOnce(netErr);

    await expect(ebayService.browseSearch('no-retry-network', 10))
      .rejects.toThrow(/ECONNREFUSED/);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('ETIMEDOUT is NOT retried', async () => {
    const e = Object.assign(new Error('timeout of 10000ms'), { code: 'ETIMEDOUT' });
    axios.get.mockRejectedValueOnce(e);

    await expect(ebayService.browseSearch('no-retry-timeout', 10))
      .rejects.toThrow(/timeout/);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('404 is NOT retried', async () => {
    axios.get.mockRejectedValueOnce(makeErr(404));

    await expect(ebayService.browseSearch('no-retry-404', 10))
      .rejects.toThrow(/HTTP 404/);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('400 is NOT retried', async () => {
    axios.get.mockRejectedValueOnce(makeErr(400));

    await expect(ebayService.browseSearch('no-retry-400', 10))
      .rejects.toThrow(/HTTP 400/);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('5xx then 4xx stops on the 4xx', async () => {
    jest.useFakeTimers();
    axios.get
      .mockRejectedValueOnce(makeErr(502))
      .mockRejectedValueOnce(makeErr(404));

    const promise = ebayService.browseSearch('5xx-then-4xx', 10);
    const assertion = expect(promise).rejects.toThrow(/HTTP 404/);
    await jest.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(axios.get).toHaveBeenCalledTimes(2); // initial + 1 retry then stops
  });
});

describe('ebayService.browseSearch -- backoff timing', () => {
  test('uses exponential delays (does not return before backoff elapses)', async () => {
    jest.useFakeTimers();
    axios.get
      .mockRejectedValueOnce(makeErr(503))
      .mockResolvedValueOnce({ data: { itemSummaries: [] } });

    const promise = ebayService.browseSearch('backoff-timing', 10);
    promise.catch(() => {}); // suppress unhandled-rejection until awaited

    // Advance only 100ms -- second axios.get should NOT yet have been issued
    await jest.advanceTimersByTimeAsync(100);
    // First attempt has already run; second has not (delay >= 800ms).
    expect(axios.get).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2000);
    await promise;
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
});

// __tests__/pcgsRetryExhaustion.test.js -- retry exhaustion + fast-fail
// semantics for src/services/pcgsService.js#pcgsGet.
//
// Existing pcgsService.test.js covers:
//   - "trips breaker on 429 (no retry)"
//   - "retries on 5xx errors" (one retry then success)
//   - "returns unverified on API error" (single network error)
//
// This file adds the missing exhaustion + non-retryable + fast-fail cases:
//   1. Persistent 5xx -> retry budget exhausted, returns unverified envelope.
//   2. Network error (no response) -> single attempt, NOT retried.
//   3. 4xx that is not 429 -> single attempt, NOT retried.
//   4. 5xx then 4xx -> one retry then stops on the 4xx.
//   5. Breaker tripped -> fails fast without any HTTP call.
//   6. Retry backoff respects sequential delays (1s, 2s).
'use strict';

const axios = require('axios');
jest.mock('axios');

const quotaState = { tripped: false };
jest.mock('../src/services/pcgsQuotaService', () => ({
  syncFromHeaders: jest.fn(),
  recordCall: jest.fn().mockReturnValue({ remaining: 999, used: 1 }),
  tripBreaker: jest.fn(() => { quotaState.tripped = true; }),
  isBreakerTripped: jest.fn(() => quotaState.tripped),
  getStatus: jest.fn().mockReturnValue({ used: 0, remaining: 1000, limit: 1000 }),
  getAvailableForPrefetch: jest.fn().mockReturnValue(900),
  DAILY_LIMIT: 1000,
}));

// Safety: axios fully mocked above -- stub key cannot reach real PCGS.
process.env.PCGS_API_KEY = 'test-key-exhaust';

const pcgsService = require('../src/services/pcgsService');

function makeErr(status) {
  const e = new Error(`HTTP ${status}`);
  e.response = { status, headers: {} };
  return e;
}

beforeEach(() => {
  jest.clearAllMocks();
  quotaState.tripped = false;
  pcgsService.clearCache();
});

afterEach(() => {
  // Make sure timers are restored even if a test bailed out early.
  jest.useRealTimers();
});

describe('pcgsService retry exhaustion -- 5xx persistent', () => {
  test('503-503-503 exhausts the budget and returns unverified envelope', async () => {
    jest.useFakeTimers();
    axios.get
      .mockRejectedValueOnce(makeErr(503))
      .mockRejectedValueOnce(makeErr(503))
      .mockRejectedValueOnce(makeErr(503));

    const promise = pcgsService.lookupByCert('30000001');
    // Drain the backoff delays: 1000 * (attempt+1) = 1000, 2000
    await jest.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result.verified).toBe(false);
    expect(axios.get).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(result.limitations[0]).toMatch(/PCGS cert lookup failed/);
  });

  test('500-500-500 exhausts the budget', async () => {
    jest.useFakeTimers();
    axios.get
      .mockRejectedValueOnce(makeErr(500))
      .mockRejectedValueOnce(makeErr(500))
      .mockRejectedValueOnce(makeErr(500));

    const promise = pcgsService.lookupByCert('30000002');
    await jest.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result.verified).toBe(false);
    expect(axios.get).toHaveBeenCalledTimes(3);
  });

  test('502 then 503 then 200 succeeds on the 3rd attempt', async () => {
    jest.useFakeTimers();
    axios.get
      .mockRejectedValueOnce(makeErr(502))
      .mockRejectedValueOnce(makeErr(503))
      .mockResolvedValueOnce({ data: { PCGSNo: 1, SeriesName: 'X', Year: 1900 }, headers: {} });

    const promise = pcgsService.lookupByCert('30000003');
    await jest.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result.verified).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(3);
  });
});

describe('pcgsService NON-retryable failures', () => {
  test('network error (no response) is NOT retried', async () => {
    const netErr = new Error('ECONNREFUSED');
    // Intentionally no .response field -- network-level failure.
    axios.get.mockRejectedValueOnce(netErr);

    const result = await pcgsService.lookupByCert('30000004');

    expect(result.verified).toBe(false);
    expect(axios.get).toHaveBeenCalledTimes(1); // single attempt, no retry
  });

  test('ETIMEDOUT is NOT retried', async () => {
    const timeoutErr = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    axios.get.mockRejectedValueOnce(timeoutErr);

    const result = await pcgsService.lookupByCert('30000005');

    expect(result.verified).toBe(false);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('404 is NOT retried (4xx non-429)', async () => {
    axios.get.mockRejectedValueOnce(makeErr(404));

    const result = await pcgsService.lookupByCert('30000006');

    expect(result.verified).toBe(false);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('400 is NOT retried', async () => {
    axios.get.mockRejectedValueOnce(makeErr(400));

    const result = await pcgsService.lookupByCert('30000007');

    expect(result.verified).toBe(false);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('5xx then 4xx stops on the 4xx (no further retries)', async () => {
    jest.useFakeTimers();
    axios.get
      .mockRejectedValueOnce(makeErr(503))
      .mockRejectedValueOnce(makeErr(404));

    const promise = pcgsService.lookupByCert('30000008');
    await jest.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(result.verified).toBe(false);
    expect(axios.get).toHaveBeenCalledTimes(2); // initial + 1 retry, then stops
  });
});

describe('pcgsService circuit breaker fast-fail', () => {
  test('when breaker is tripped, no HTTP request is issued', async () => {
    quotaState.tripped = true;

    const result = await pcgsService.lookupByCert('30000009');

    expect(result.verified).toBe(false);
    // PCGS lookup wrapper catches the breaker error and returns unverified.
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('breaker fast-fail surfaces breaker reason in limitations', async () => {
    quotaState.tripped = true;

    const result = await pcgsService.lookupByCert('30000010');

    expect(result.limitations[0]).toMatch(/PCGS cert lookup failed/);
  });

  test('429 trips the breaker and prevents subsequent retries', async () => {
    axios.get.mockRejectedValueOnce(makeErr(429));
    const result = await pcgsService.lookupByCert('30000011');
    expect(result.verified).toBe(false);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(quotaState.tripped).toBe(true);
  });
});

// __tests__/pcgsBreakerInteraction.test.js -- end-to-end interaction test
// for the PCGS circuit-breaker + retry pipeline.
//
// Existing pcgsRetryExhaustion.test.js covers the breaker in isolation
// (tripped -> no HTTP call). This file covers the full *interaction* loop:
//
//   1. A 429 response trips the breaker via pcgsQuotaService.tripBreaker().
//   2. The NEXT lookup, while the breaker is tripped, fast-fails with zero
//      HTTP calls -- proves the breaker check sits ahead of the request.
//   3. After the breaker is externally reset (simulating the midnight PT
//      daily rollover documented in pcgsQuotaService.js), the next lookup
//      proceeds normally and a single 200 response is observed.
//
// Strategy: hold the tripped state in a shared `quotaState` object that the
// mocked pcgsQuotaService reads from on every call. Toggle it across the
// three phases of the interaction. Axios is fully mocked.
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
process.env.PCGS_API_KEY = 'test-key-breaker-interaction';

const pcgsService = require('../src/services/pcgsService');
const pcgsQuota = require('../src/services/pcgsQuotaService');

function makeErr(status) {
  const e = new Error(`HTTP ${status}`);
  e.response = { status, headers: {} };
  return e;
}

beforeEach(() => {
  // Reset axios call history without disturbing module mocks (clearAllMocks
  // can wipe implementations set via the jest.mock factory above).
  axios.get.mockReset();
  axios.post && axios.post.mockReset && axios.post.mockReset();
  // Clear pcgsQuota call history but re-arm the implementations so they
  // survive any mockReset side-effects between tests.
  pcgsQuota.isBreakerTripped.mockClear();
  pcgsQuota.tripBreaker.mockClear();
  pcgsQuota.isBreakerTripped.mockImplementation(() => quotaState.tripped);
  pcgsQuota.tripBreaker.mockImplementation(() => { quotaState.tripped = true; });
  quotaState.tripped = false;
  pcgsService.clearCache();
});

describe('pcgsService -- breaker interaction (429 -> trip -> fast-fail -> reset -> ok)', () => {
  test('429 trips the breaker AND blocks the immediately-following lookup with no HTTP call', async () => {
    // Phase 1: first call hits 429 -> tripBreaker() invoked.
    axios.get.mockRejectedValueOnce(makeErr(429));
    const first = await pcgsService.lookupByCert('40000001');
    expect(first.verified).toBe(false);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(pcgsQuota.tripBreaker).toHaveBeenCalledTimes(1);
    expect(quotaState.tripped).toBe(true);

    // Phase 2: NEXT call must fast-fail. Set up an axios mock that would
    // succeed if reached -- if the breaker check is wrong, the test fails by
    // surfacing the verified=true result OR an extra axios.get call.
    axios.get.mockResolvedValueOnce({
      data: { PCGSNo: 999, SeriesName: 'Should Not Be Used', Year: 1900 },
      headers: {},
    });
    const second = await pcgsService.lookupByCert('40000002');
    expect(second.verified).toBe(false);
    // axios.get count is unchanged from phase 1 -> proves no HTTP call issued.
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(second.limitations[0]).toMatch(/PCGS cert lookup failed/);
  });

  test('after breaker is reset, the next lookup proceeds normally (simulates midnight PT rollover)', async () => {
    // Phase 1: trip the breaker.
    axios.get.mockRejectedValueOnce(makeErr(429));
    await pcgsService.lookupByCert('40000003');
    expect(quotaState.tripped).toBe(true);

    // Phase 2: confirm fast-fail before reset.
    axios.get.mockResolvedValueOnce({ data: { PCGSNo: 1 }, headers: {} });
    await pcgsService.lookupByCert('40000004');
    expect(axios.get).toHaveBeenCalledTimes(1); // unchanged

    // Phase 3: simulate the daily reset by toggling the breaker state off.
    quotaState.tripped = false;

    // The next lookup must now actually hit axios.get and succeed.
    axios.get.mockResolvedValueOnce({
      data: { PCGSNo: 7000, SeriesName: 'Morgan Dollar', Year: 1921 },
      headers: {},
    });
    const third = await pcgsService.lookupByCert('40000005');
    expect(third.verified).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(2); // phase 1 (429) + phase 3 (200)
  });

  test('tripBreaker is NOT re-invoked while already tripped (idempotent fast-fail)', async () => {
    // Trip the breaker once.
    axios.get.mockRejectedValueOnce(makeErr(429));
    await pcgsService.lookupByCert('40000006');
    expect(pcgsQuota.tripBreaker).toHaveBeenCalledTimes(1);

    // Subsequent fast-fail lookups should NOT re-trip the breaker (no HTTP
    // call means no opportunity to encounter another 429).
    await pcgsService.lookupByCert('40000007');
    await pcgsService.lookupByCert('40000008');
    await pcgsService.lookupByCert('40000009');
    expect(pcgsQuota.tripBreaker).toHaveBeenCalledTimes(1);
  });
});

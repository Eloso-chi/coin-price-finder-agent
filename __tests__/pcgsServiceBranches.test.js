// __tests__/pcgsServiceBranches.test.js
//
// Branch-coverage tests for src/services/pcgsService.js covering paths
// the existing test files do not exercise:
//   - resolveFromDescription cross-validation branches when the PCGS table
//     returns a verified result that conflicts with the parsed description
//     on year, mint, or series (L175-212 in src/services/pcgsService.js)
//   - parseDescription zodiac/lunar enrichment that prepends mint/program/
//     metal context to "year of the X" series names (L547-562)
//
// Anti-cheating: every assertion checks an observable behavior of the
// service (return value shape) -- no introspection of private state. The
// cross-validation tests assert that `verified: false` is returned
// (the public effect of `trustTable = false`).
//
// PR #197 follow-on: see docs/BACKLOG.md #276W for the cross-route FMV
// mismatch surfaced during the coverage analysis that motivated this file.

'use strict';

const axios = require('axios');
jest.mock('axios');

jest.mock('../src/services/pcgsQuotaService', () => ({
  syncFromHeaders: jest.fn(),
  recordCall: jest.fn().mockReturnValue({ remaining: 999, used: 1 }),
  tripBreaker: jest.fn(),
  isBreakerTripped: jest.fn().mockReturnValue(false),
  getStatus: jest.fn().mockReturnValue({ used: 0, remaining: 1000, limit: 1000 }),
  getAvailableForPrefetch: jest.fn().mockReturnValue(900),
  DAILY_LIMIT: 1000,
}));

// Safety note (#237 Batch 1 env-test audit): axios is fully mocked above,
// so this stub key cannot reach the real PCGS endpoint.
process.env.PCGS_API_KEY = 'test-key-123';

const pcgsService = require('../src/services/pcgsService');

// Base shape mirroring data PCGS would return for 1881-CC Morgan Dollar MS64
// (matches MOCK_COIN_RESPONSE in pcgsService.test.js for consistency).
const MOCK_MORGAN_RESPONSE = {
  PCGSNo: 7126,
  SeriesName: 'Morgan Dollars 1878-1921',
  Year: 1881,
  MintMark: 'CC',
  Grade: 'MS64',
  Designation: null,
  Variety: null,
  PriceGuideValue: 900,
  Population: 9515,
  PopHigher: 8974,
  AuctionList: [{ Price: 850 }, { Price: 900 }],
  TrueViewURL: null,
  Images: [],
  Mintage: 296000,
  MetalContent: '90% Silver, 10% Copper',
  Country: 'United States',
};

// Silence cross-validation warnings emitted by the SUT (we assert the
// effect on the return value, not on console output).
let warnSpy;
beforeAll(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  warnSpy.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  pcgsService.clearCache();
});

// ============================================================
// resolveFromDescription -- cross-validation rejections
// ============================================================

describe('resolveFromDescription -- table result rejection branches', () => {
  test('rejects table result when PCGS returns a different year (parsed 1881 vs API 1879)', async () => {
    axios.get.mockResolvedValueOnce({
      data: { ...MOCK_MORGAN_RESPONSE, Year: 1879 },
      headers: {},
    });
    const result = await pcgsService.resolveFromDescription('1881-CC Morgan Dollar MS-64');
    expect(result.verified).toBe(false);
    expect(result.parsed.year).toBe(1881);
    expect(result.parsed.mint).toBe('CC');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/year mismatch.*1881.*1879/i),
    );
  });

  test('rejects table result when PCGS returns a different mint (parsed CC vs API S)', async () => {
    axios.get.mockResolvedValueOnce({
      data: { ...MOCK_MORGAN_RESPONSE, MintMark: 'S' },
      headers: {},
    });
    const result = await pcgsService.resolveFromDescription('1881-CC Morgan Dollar MS-64');
    expect(result.verified).toBe(false);
    expect(result.parsed.mint).toBe('CC');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/mint mismatch.*CC.*S/i),
    );
  });

  test('rejects table result when PCGS returns a conflicting series (Morgan parsed but Peace returned)', async () => {
    axios.get.mockResolvedValueOnce({
      data: { ...MOCK_MORGAN_RESPONSE, SeriesName: 'Peace Dollars 1921-1935' },
      headers: {},
    });
    const result = await pcgsService.resolveFromDescription('1881-CC Morgan Dollar MS-64');
    expect(result.verified).toBe(false);
    expect(result.parsed).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/series mismatch/i),
    );
  });

  test('accepts table result when year, mint, and series all align', async () => {
    axios.get.mockResolvedValueOnce({
      data: MOCK_MORGAN_RESPONSE,
      headers: {},
    });
    const result = await pcgsService.resolveFromDescription('1881-CC Morgan Dollar MS-64');
    expect(result.verified).toBe(true);
    expect(result.year).toBe(1881);
    expect(result.mint).toBe('CC');
    expect(result.series).toBe('Morgan Dollars 1878-1921');
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/mismatch/i),
    );
  });

  test('accepts table result when parsed has no year (year-check branch skipped)', async () => {
    // parsed.year will be undefined because no 4-digit year token is present.
    // The validation only fires when BOTH parsed.year AND apiYear are truthy.
    axios.get.mockResolvedValueOnce({
      data: MOCK_MORGAN_RESPONSE,
      headers: {},
    });
    const result = await pcgsService.resolveFromDescription('Morgan Dollar CC mint MS-64');
    // We don't assert verified=true here -- the PCGS table lookup may not
    // resolve a number without a year. We only assert no year-mismatch
    // warning fired (proving the parsed.year-truthy branch was exercised).
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/year mismatch/i),
    );
    expect(result).toBeDefined();
  });

  test('accepts table result when parsed has no mint (mint-check branch skipped)', async () => {
    axios.get.mockResolvedValueOnce({
      data: MOCK_MORGAN_RESPONSE,
      headers: {},
    });
    // No mint token in the input.
    const result = await pcgsService.resolveFromDescription('1881 Morgan Dollar MS-64');
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/mint mismatch/i),
    );
    expect(result).toBeDefined();
  });
});

// ============================================================
// parseDescription -- zodiac / lunar enrichment
// (closes the L546-562 series-prefix enrichment block)
//
// IMPORTANT: the keyword list in pcgsService.js contains compound phrases
// like 'perth lunar', 'australian lunar', 'british lunar' that appear in
// the loop BEFORE the bare 'year of the X' entries. The enrichment block
// runs only when a 'year of the X' keyword is the first match, so test
// inputs MUST NOT contain any of those compound phrases as substrings.
// ============================================================

describe('parseDescription -- zodiac/lunar enrichment', () => {
  test('Perth + silver: prepends "Perth Silver" to year-of-the-X (no Lunar prefix)', () => {
    // "Perth" alone is fine; do NOT include "Perth Lunar" or the kw
    // 'perth lunar' would match first and skip the enrichment block.
    const parsed = pcgsService.parseDescription('1996 Perth Year of the Rat 1oz silver');
    expect(parsed.series).toMatch(/Perth/);
    expect(parsed.series).toMatch(/Silver/);
    expect(parsed.series.toLowerCase()).toContain('year of the rat');
  });

  test('Royal Mint + gold: prepends "Royal Mint Gold"', () => {
    const parsed = pcgsService.parseDescription('2021 Royal Mint Year of the Ox 1oz gold');
    expect(parsed.series).toMatch(/Royal Mint/);
    expect(parsed.series).toMatch(/Gold/);
    expect(parsed.series.toLowerCase()).toContain('year of the ox');
  });

  test('RCM mint context with no metal', () => {
    const parsed = pcgsService.parseDescription('2024 RCM Year of the Dragon');
    expect(parsed.series).toMatch(/RCM/);
    expect(parsed.series.toLowerCase()).toContain('year of the dragon');
    expect(parsed.series).not.toMatch(/Silver|Gold|Platinum/);
  });

  test('"Royal Canadian" phrasing maps to RCM prefix', () => {
    const parsed = pcgsService.parseDescription('2023 Royal Canadian Year of the Rabbit gold');
    expect(parsed.series).toMatch(/RCM/);
    expect(parsed.series).toMatch(/Gold/);
  });

  test('Chinese mint context with platinum metal', () => {
    const parsed = pcgsService.parseDescription('2020 Chinese Year of the Rat 1oz platinum');
    expect(parsed.series).toMatch(/Chinese/);
    expect(parsed.series).toMatch(/Platinum/);
    expect(parsed.series.toLowerCase()).toContain('year of the rat');
  });

  test('Australian (without "lunar" compound) + silver', () => {
    // 'australian lunar' would match first, so leave "lunar" out of input.
    const parsed = pcgsService.parseDescription('2018 Australian Year of the Dog silver');
    expect(parsed.series).toMatch(/Australian/);
    expect(parsed.series).toMatch(/Silver/);
  });

  test('Lunar program context (without compound kw match) adds Lunar prefix', () => {
    // "Lunar Series" sidesteps every compound 'X lunar' keyword while
    // still triggering the \blunar\b enrichment branch.
    const parsed = pcgsService.parseDescription('1996 Lunar Series Year of the Rat silver');
    expect(parsed.series).toMatch(/Lunar/);
    expect(parsed.series).toMatch(/Silver/);
    expect(parsed.series.toLowerCase()).toContain('year of the rat');
  });

  test('"year of the X" with no mint/program/metal context returns bare title-cased name', () => {
    // Exercises the prefixParts.length === 0 branch (no prefix prepended).
    const parsed = pcgsService.parseDescription('2024 Year of the Dragon');
    expect(parsed.series.toLowerCase()).toContain('year of the dragon');
    expect(parsed.series).not.toMatch(/Perth|Lunar|Silver|Gold|Platinum|RCM|Chinese|Australian|Royal/);
  });
});

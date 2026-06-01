// __tests__/pcgsService.test.js -- Tests for PCGS API integration (mocked HTTP)
'use strict';

const axios = require('axios');
jest.mock('axios');

// Mock pcgsQuotaService to avoid file I/O in tests
jest.mock('../src/services/pcgsQuotaService', () => ({
  syncFromHeaders: jest.fn(),
  recordCall: jest.fn().mockReturnValue({ remaining: 999, used: 1 }),
  tripBreaker: jest.fn(),
  isBreakerTripped: jest.fn().mockReturnValue(false),
  getStatus: jest.fn().mockReturnValue({ used: 0, remaining: 1000, limit: 1000 }),
  getAvailableForPrefetch: jest.fn().mockReturnValue(900),
  DAILY_LIMIT: 1000
}));

// Ensure PCGS_API_KEY is set so we exercise the API paths (not the "no key" early return).
// Safety note (#237 Batch 1 env-test audit): axios is fully mocked above, so this
// stub key can never reach the real PCGS endpoint. Do NOT remove `jest.mock('axios')`.
process.env.PCGS_API_KEY = 'test-key-123';

const pcgsService = require('../src/services/pcgsService');

// Sample PCGS API responses
const MOCK_COIN_RESPONSE = {
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
  AuctionList: [
    { Price: 850 }, { Price: 900 }, { Price: 870 },
  ],
  TrueViewURL: 'https://images.pcgs.com/trueview/123.jpg',
  Images: [{ Fullsize: 'https://images.pcgs.com/coin/123_obv.jpg' }],
  Mintage: 296000,
  MetalContent: '90% Silver, 10% Copper',
  Country: 'United States',
};

beforeEach(() => {
  jest.clearAllMocks();
  pcgsService.clearCache();
});

describe('lookupByCert', () => {
  test('returns verified coin for valid cert number', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_COIN_RESPONSE, headers: {} });
    const result = await pcgsService.lookupByCert('12345678');

    expect(result.verified).toBe(true);
    expect(result.pcgsCoinNumber).toBe(7126);
    expect(result.series).toBe('Morgan Dollars 1878-1921');
    expect(result.year).toBe(1881);
    expect(result.mint).toBe('CC');
    expect(result.grade).toBe('MS64');
    expect(result.priceGuide.valueUsd).toBe(900);
    expect(result.population.thisGrade).toBe(9515);
    expect(result.population.higher).toBe(8974);
    expect(result.auction.count).toBe(3);
    expect(result.auction.medianUsd).toBe(870);
    expect(result.mintage).toBe(296000);
  });

  test('returns cached result on second call', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_COIN_RESPONSE, headers: {} });
    await pcgsService.lookupByCert('12345678');
    const result2 = await pcgsService.lookupByCert('12345678');

    expect(axios.get).toHaveBeenCalledTimes(1); // only one HTTP call
    expect(result2.verified).toBe(true);
  });

  test('returns unverified on API error', async () => {
    axios.get.mockRejectedValueOnce(new Error('Network error'));
    const result = await pcgsService.lookupByCert('99999999');

    expect(result.verified).toBe(false);
    expect(result.limitations[0]).toMatch(/PCGS cert lookup failed/);
  });

  test('trips breaker on 429 (no retry)', async () => {
    const err429 = new Error('Too Many Requests');
    err429.response = { status: 429 };
    axios.get.mockRejectedValueOnce(err429);

    const result = await pcgsService.lookupByCert('11111111');
    expect(result.verified).toBe(false);
    expect(result.limitations[0]).toMatch(/PCGS cert lookup failed/);
    expect(axios.get).toHaveBeenCalledTimes(1); // no retry on 429
  });

  test('retries on 5xx errors', async () => {
    jest.useFakeTimers();
    const err500 = new Error('Internal Server Error');
    err500.response = { status: 500 };
    axios.get
      .mockRejectedValueOnce(err500)
      .mockResolvedValueOnce({ data: MOCK_COIN_RESPONSE, headers: {} });

    const promise = pcgsService.lookupByCert('11111111');
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result.verified).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  test('passes correct URL and auth headers', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_COIN_RESPONSE, headers: {} });
    await pcgsService.lookupByCert('12345678');

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/coindetail/GetCoinFactsByCertNo/12345678'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key-123',
        }),
      })
    );
  });
});

describe('lookupByCoinNumberAndGrade', () => {
  test('returns verified coin for valid PCGS number + grade', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_COIN_RESPONSE, headers: {} });
    const result = await pcgsService.lookupByCoinNumberAndGrade(7126, 64);

    expect(result.verified).toBe(true);
    expect(result.pcgsCoinNumber).toBe(7126);
  });

  test('passes correct URL with PCGSNo and GradeNo', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_COIN_RESPONSE, headers: {} });
    await pcgsService.lookupByCoinNumberAndGrade(7126, 64);

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringMatching(/PCGSNo=7126.*GradeNo=64/),
      expect.anything()
    );
  });

  test('returns unverified on API failure', async () => {
    axios.get.mockRejectedValueOnce(new Error('timeout'));
    const result = await pcgsService.lookupByCoinNumberAndGrade(9999, 65);

    expect(result.verified).toBe(false);
    expect(result.limitations[0]).toMatch(/PCGS coin# lookup failed/);
  });
});

describe('resolveFromDescription', () => {
  test('returns parsed data when cert number is detected and API succeeds', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_COIN_RESPONSE, headers: {} });
    const result = await pcgsService.resolveFromDescription('12345678');

    expect(result.verified).toBe(true);
    expect(result.series).toBe('Morgan Dollars 1878-1921');
  });

  test('returns best-effort parsed data when all API lookups fail', async () => {
    axios.get.mockRejectedValue(new Error('Network down'));

    const result = await pcgsService.resolveFromDescription('1881-CC Morgan Dollar MS-64');
    expect(result.verified).toBe(false);
    expect(result.parsed).toBeDefined();
    expect(result.parsed.year).toBe(1881);
    expect(result.parsed.mint).toBe('CC');
  });
});

describe('parseDescription - fractional word weights', () => {
  test('parses half oz as 0.5', () => {
    const parsed = pcgsService.parseDescription('2022 mexico half oz gold libertad');
    expect(parsed.weight).toBe(0.5);
    expect(parsed.weightRaw).toBe('half oz');
  });

  test('parses tenth oz as 0.1', () => {
    const parsed = pcgsService.parseDescription('2020 mexico tenth oz silver libertad proof');
    expect(parsed.weight).toBe(0.1);
    expect(parsed.weightRaw).toBe('tenth oz');
  });

  test('parses twentieth oz as 0.05', () => {
    const parsed = pcgsService.parseDescription('2023 mexico twentieth oz gold libertad');
    expect(parsed.weight).toBe(0.05);
    expect(parsed.weightRaw).toBe('twentieth oz');
  });

  test('does not treat half dollar as a weight', () => {
    const parsed = pcgsService.parseDescription('1964 Kennedy half dollar');
    expect(parsed.weight).toBeUndefined();
  });

  test('does not treat quarter dollar as a weight', () => {
    const parsed = pcgsService.parseDescription('1932 Washington quarter dollar');
    expect(parsed.weight).toBeUndefined();
  });

  test('does not treat dime as a weight', () => {
    const parsed = pcgsService.parseDescription('1916 Mercury dime');
    expect(parsed.weight).toBeUndefined();
  });

  test('does not treat nickel as a weight', () => {
    const parsed = pcgsService.parseDescription('1937 Buffalo nickel');
    expect(parsed.weight).toBeUndefined();
  });

  test('parses plural form (half ounces) as 0.5', () => {
    const parsed = pcgsService.parseDescription('2024 mexico half ounces silver libertad');
    expect(parsed.weight).toBe(0.5);
  });

  test('parses troy modifier (half troy oz) as 0.5', () => {
    const parsed = pcgsService.parseDescription('2024 half troy oz gold');
    expect(parsed.weight).toBe(0.5);
  });

  test('parses title case (HALF OZ) as 0.5 case-insensitively', () => {
    const parsed = pcgsService.parseDescription('2024 HALF OZ GOLD libertad');
    expect(parsed.weight).toBe(0.5);
  });
});

describe('_mapResponse internals (via lookupByCert)', () => {
  test('handles empty/null PCGS response', async () => {
    axios.get.mockResolvedValueOnce({ data: null, headers: {} });
    const result = await pcgsService.lookupByCert('00000000');
    expect(result.verified).toBe(false);
    expect(result.limitations[0]).toMatch(/Empty PCGS response/);
  });

  test('extracts coin images from Images array', async () => {
    const data = {
      ...MOCK_COIN_RESPONSE,
      Images: [
        { Fullsize: 'https://images.pcgs.com/obv.jpg' },
        { Fullsize: 'https://images.pcgs.com/rev.jpg' },
      ],
    };
    axios.get.mockResolvedValueOnce({ data, headers: {} });
    const result = await pcgsService.lookupByCert('22222222');
    expect(result.coinImages).toHaveLength(2);
  });

  test('maps auction array to stats', async () => {
    const data = {
      ...MOCK_COIN_RESPONSE,
      AuctionList: [{ Price: 100 }, { Price: 200 }, { Price: 150 }],
    };
    axios.get.mockResolvedValueOnce({ data, headers: {} });
    const result = await pcgsService.lookupByCert('33333333');
    expect(result.auction.count).toBe(3);
    expect(result.auction.medianUsd).toBe(150);
    expect(result.auction.highUsd).toBe(200);
  });

  test('maps price guide value', async () => {
    const data = { ...MOCK_COIN_RESPONSE, PriceGuideValue: 1500 };
    axios.get.mockResolvedValueOnce({ data, headers: {} });
    const result = await pcgsService.lookupByCert('44444444');
    expect(result.priceGuide.valueUsd).toBe(1500);
  });

  test('handles zero price guide value as null', async () => {
    const data = { ...MOCK_COIN_RESPONSE, PriceGuideValue: 0 };
    axios.get.mockResolvedValueOnce({ data, headers: {} });
    const result = await pcgsService.lookupByCert('55555555');
    expect(result.priceGuide.valueUsd).toBeNull();
  });
});

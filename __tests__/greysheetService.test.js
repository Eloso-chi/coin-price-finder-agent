// __tests__/greysheetService.test.js -- Tests for Greysheet CDN Public API V2 integration
'use strict';

const axios = require('axios');
jest.mock('axios');

// Set env vars before requiring the module so it picks them up
process.env.GREYSHEET_API_TOKEN = 'test-token-abc';
process.env.GREYSHEET_API_KEY   = 'test-key-xyz';
process.env.GREYSHEET_BASE_URL  = 'https://test-greysheet.example.com/api';

const greysheetService = require('../src/services/greysheetService');

// ── Sample API responses ────────────────────────────────────

const MOCK_PRICING_RESPONSE = {
  OpCode: 200,
  Data: [{
    GsId: 7486,
    Name: '1881-S Morgan Dollar',
    PricingData: [
      {
        Grade: 65,
        GradeLabel: 'MS65',
        GreyVal: '275.00',
        CpgVal: '310.00',
        PcgsVal: '290.00',
        NgcVal: '285.00',
        BlueBookVal: '250.00',
        IsCac: false
      },
      {
        Grade: 65,
        GradeLabel: 'MS65+CAC',
        GreyVal: '350.00',
        CpgVal: '400.00',
        PcgsVal: null,
        NgcVal: null,
        BlueBookVal: null,
        IsCac: true
      },
      {
        Grade: 64,
        GradeLabel: 'MS64',
        GreyVal: '130.00',
        CpgVal: '155.00',
        PcgsVal: '140.00',
        NgcVal: '138.00',
        BlueBookVal: '120.00',
        IsCac: false
      }
    ]
  }]
};

const MOCK_COLLECTIBLE_RESPONSE = {
  OpCode: 200,
  Data: [{
    Gsid: 7486,
    Name: '1881-S Morgan Dollar',
    PcgsNumber: '7130',
    CoinDate: '1881',
    DenominationShort: '$1',
    Desg: null,
    MintMark: 'S',
    Composition: '90% Silver, 10% Copper',
    Mintage: 12760000,
    Fineness: '0.900',
    WeightOunces: '0.7734',
    StrikeType: 'Business'
  }]
};

// ─────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  greysheetService._cache.clear();
});

// ════════════════════════════════════════════════════════════
//  fetchPriceByPcgsNumber
// ════════════════════════════════════════════════════════════
describe('fetchPriceByPcgsNumber', () => {
  test('returns parsed pricing for valid PCGS number + grade', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_PRICING_RESPONSE });

    const result = await greysheetService.fetchPriceByPcgsNumber('7130', 65);

    expect(result).not.toBeNull();
    expect(result.greyVal).toBe(275);
    expect(result.cpgVal).toBe(310);
    expect(result.pcgsVal).toBe(290);
    expect(result.ngcVal).toBe(285);
    expect(result.blueBookVal).toBe(250);
    expect(result.gsid).toBe(7486);
    expect(result.name).toBe('1881-S Morgan Dollar');
    expect(result.grade).toBe(65);
    expect(result.gradeLabel).toBe('MS65');
  });

  test('passes correct params to API', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_PRICING_RESPONSE });

    await greysheetService.fetchPriceByPcgsNumber('7130', 65);

    expect(axios.get).toHaveBeenCalledWith(
      'https://test-greysheet.example.com/api/GetPricingRequest',
      expect.objectContaining({
        params: { PcgsNumber: '7130', Grade: 65, ApiLevel: 'advanced' },
        headers: expect.objectContaining({
          'x-api-token': 'test-token-abc',
          'x-api-key':   'test-key-xyz'
        })
      })
    );
  });

  test('filters out CAC rows', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_PRICING_RESPONSE });

    const result = await greysheetService.fetchPriceByPcgsNumber('7130', 65);

    // The non-CAC MS65 row has GreyVal 275, the CAC row has 350
    expect(result.greyVal).toBe(275);
  });

  test('returns cached result on second call', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_PRICING_RESPONSE });

    const r1 = await greysheetService.fetchPriceByPcgsNumber('7130', 65);
    const r2 = await greysheetService.fetchPriceByPcgsNumber('7130', 65);

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(r2.greyVal).toBe(r1.greyVal);
  });

  test('returns null when no credentials are set', async () => {
    const origToken = process.env.GREYSHEET_API_TOKEN;
    const origKey   = process.env.GREYSHEET_API_KEY;
    process.env.GREYSHEET_API_TOKEN = '';
    process.env.GREYSHEET_API_KEY   = '';

    // Must re-require to pick up new env vars
    jest.resetModules();
    jest.mock('axios');
    const freshService = require('../src/services/greysheetService');

    const result = await freshService.fetchPriceByPcgsNumber('7130', 65);
    expect(result).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();

    // Restore
    process.env.GREYSHEET_API_TOKEN = origToken;
    process.env.GREYSHEET_API_KEY   = origKey;
  });

  test('returns null when pcgsNumber is falsy', async () => {
    const result = await greysheetService.fetchPriceByPcgsNumber(null, 65);
    expect(result).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('returns null on API error (non-fatal)', async () => {
    axios.get.mockRejectedValueOnce(new Error('Network error'));

    const result = await greysheetService.fetchPriceByPcgsNumber('7130', 65);
    expect(result).toBeNull();
  });

  test('returns null when API returns empty Data', async () => {
    axios.get.mockResolvedValueOnce({ data: { OpCode: 200, Data: [] } });

    const result = await greysheetService.fetchPriceByPcgsNumber('9999', 65);
    expect(result).toBeNull();
  });

  test('returns null when OpCode is not 200', async () => {
    axios.get.mockResolvedValueOnce({ data: { OpCode: 404, Data: [] } });

    const result = await greysheetService.fetchPriceByPcgsNumber('7130', 65);
    expect(result).toBeNull();
  });

  test('returns null when no matching grade in PricingData', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_PRICING_RESPONSE });

    // Ask for grade 70 which doesn't exist in mock data
    const result = await greysheetService.fetchPriceByPcgsNumber('7130', 70);
    expect(result).toBeNull();
  });

  test('handles grade passed as string like "MS65"', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_PRICING_RESPONSE });

    const result = await greysheetService.fetchPriceByPcgsNumber('7130', 'MS65');
    expect(result).not.toBeNull();
    expect(result.grade).toBe(65);
  });

  test('fetches without grade filter when grade is null', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_PRICING_RESPONSE });

    const result = await greysheetService.fetchPriceByPcgsNumber('7130', null);

    expect(result).not.toBeNull();
    // Should return first non-CAC row (MS65)
    expect(result.grade).toBe(65);
    // Params should not include Grade
    expect(axios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        params: { PcgsNumber: '7130', ApiLevel: 'advanced' }
      })
    );
  });

  test('handles null value fields gracefully', async () => {
    const nullPricingResp = {
      OpCode: 200,
      Data: [{
        GsId: 100,
        Name: 'Test Coin',
        PricingData: [{
          Grade: 65,
          GradeLabel: 'MS65',
          GreyVal: '100.00',
          CpgVal: null,
          PcgsVal: null,
          NgcVal: null,
          BlueBookVal: null,
          IsCac: false
        }]
      }]
    };
    axios.get.mockResolvedValueOnce({ data: nullPricingResp });

    const result = await greysheetService.fetchPriceByPcgsNumber('1000', 65);
    expect(result.greyVal).toBe(100);
    expect(result.cpgVal).toBeNull();
    expect(result.pcgsVal).toBeNull();
    expect(result.ngcVal).toBeNull();
    expect(result.blueBookVal).toBeNull();
  });

  test('retries on 429 then succeeds', async () => {
    jest.useFakeTimers();
    const err429 = new Error('Too Many Requests');
    err429.response = { status: 429 };
    axios.get
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce({ data: MOCK_PRICING_RESPONSE });

    const promise = greysheetService.fetchPriceByPcgsNumber('7130', 65);
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result).not.toBeNull();
    expect(result.greyVal).toBe(275);
    expect(axios.get).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  test('retries on 500 then succeeds', async () => {
    jest.useFakeTimers();
    const err500 = new Error('Internal Server Error');
    err500.response = { status: 500 };
    axios.get
      .mockRejectedValueOnce(err500)
      .mockResolvedValueOnce({ data: MOCK_PRICING_RESPONSE });

    const promise = greysheetService.fetchPriceByPcgsNumber('7130', 65);
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result).not.toBeNull();
    expect(axios.get).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  test('does not retry on 401', async () => {
    const err401 = new Error('Unauthorized');
    err401.response = { status: 401 };
    axios.get.mockRejectedValueOnce(err401);

    const result = await greysheetService.fetchPriceByPcgsNumber('7130', 65);
    expect(result).toBeNull();
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('returns null after exhausting retries', async () => {
    jest.useFakeTimers();
    const err500 = new Error('Server Error');
    err500.response = { status: 500 };
    axios.get
      .mockRejectedValueOnce(err500)
      .mockRejectedValueOnce(err500)
      .mockRejectedValueOnce(err500);

    const promise = greysheetService.fetchPriceByPcgsNumber('7130', 65);
    await jest.advanceTimersByTimeAsync(5000);
    const result = await promise;
    expect(result).toBeNull();
    expect(axios.get).toHaveBeenCalledTimes(3); // initial + 2 retries
    jest.useRealTimers();
  });

  test('caches null results (negative caching)', async () => {
    axios.get.mockResolvedValueOnce({ data: { OpCode: 200, Data: [] } });

    const r1 = await greysheetService.fetchPriceByPcgsNumber('NONE', 65);
    const r2 = await greysheetService.fetchPriceByPcgsNumber('NONE', 65);

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(axios.get).toHaveBeenCalledTimes(1); // only 1 call, second from cache
  });
});

// ════════════════════════════════════════════════════════════
//  fetchPriceByGsid
// ════════════════════════════════════════════════════════════
describe('fetchPriceByGsid', () => {
  test('returns parsed pricing for valid GSID + grade', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_PRICING_RESPONSE });

    const result = await greysheetService.fetchPriceByGsid(7486, 65);

    expect(result).not.toBeNull();
    expect(result.greyVal).toBe(275);
    expect(result.gsid).toBe(7486);
  });

  test('passes Gsid param (not PcgsNumber)', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_PRICING_RESPONSE });

    await greysheetService.fetchPriceByGsid(7486, 65);

    expect(axios.get).toHaveBeenCalledWith(
      'https://test-greysheet.example.com/api/GetPricingRequest',
      expect.objectContaining({
        params: { Gsid: 7486, Grade: 65, ApiLevel: 'advanced' }
      })
    );
  });

  test('returns null for falsy gsid', async () => {
    expect(await greysheetService.fetchPriceByGsid(null, 65)).toBeNull();
    expect(await greysheetService.fetchPriceByGsid(0, 65)).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('returns cached result on repeat call', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_PRICING_RESPONSE });

    await greysheetService.fetchPriceByGsid(7486, 65);
    await greysheetService.fetchPriceByGsid(7486, 65);

    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('returns null on API error', async () => {
    axios.get.mockRejectedValueOnce(new Error('timeout'));

    const result = await greysheetService.fetchPriceByGsid(7486, 65);
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
//  fetchCollectible
// ════════════════════════════════════════════════════════════
describe('fetchCollectible', () => {
  test('returns metadata for valid GSID', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_COLLECTIBLE_RESPONSE });

    const result = await greysheetService.fetchCollectible(7486);

    expect(result).not.toBeNull();
    expect(result.gsid).toBe(7486);
    expect(result.name).toBe('1881-S Morgan Dollar');
    expect(result.pcgsNumber).toBe('7130');
    expect(result.coinDate).toBe('1881');
    expect(result.denomination).toBe('$1');
    expect(result.mintMark).toBe('S');
    expect(result.composition).toBe('90% Silver, 10% Copper');
    expect(result.mintage).toBe(12760000);
    expect(result.fineness).toBe(0.9);
    expect(result.weightOz).toBe('0.7734');
    expect(result.strikeType).toBe('Business');
  });

  test('passes correct params to API', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_COLLECTIBLE_RESPONSE });

    await greysheetService.fetchCollectible(7486);

    expect(axios.get).toHaveBeenCalledWith(
      'https://test-greysheet.example.com/api/GetCollectibleRequest',
      expect.objectContaining({
        params: { GsId: 7486, ApiLevel: 'advanced' }
      })
    );
  });

  test('returns null for falsy gsid', async () => {
    expect(await greysheetService.fetchCollectible(null)).toBeNull();
    expect(await greysheetService.fetchCollectible(0)).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('returns cached result on repeat call', async () => {
    axios.get.mockResolvedValueOnce({ data: MOCK_COLLECTIBLE_RESPONSE });

    await greysheetService.fetchCollectible(7486);
    await greysheetService.fetchCollectible(7486);

    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('returns null on API error', async () => {
    axios.get.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await greysheetService.fetchCollectible(7486);
    expect(result).toBeNull();
  });

  test('returns null when no Data returned', async () => {
    axios.get.mockResolvedValueOnce({ data: { OpCode: 200, Data: [] } });

    const result = await greysheetService.fetchCollectible(7486);
    expect(result).toBeNull();
  });

  test('handles null optional fields', async () => {
    const sparseResp = {
      OpCode: 200,
      Data: [{
        Gsid: 100,
        Name: 'Test',
        PcgsNumber: null,
        CoinDate: null,
        DenominationShort: '',
        Desg: null,
        MintMark: null,
        Composition: null,
        Mintage: null,
        Fineness: null,
        WeightOunces: null,
        StrikeType: null
      }]
    };
    axios.get.mockResolvedValueOnce({ data: sparseResp });

    const result = await greysheetService.fetchCollectible(100);
    expect(result.pcgsNumber).toBeNull();
    expect(result.fineness).toBeNull();
    expect(result.denomination).toBe('');
  });
});

// ── fetchTypePrice (generic / yearless coin lookup) ──────────
describe('fetchTypePrice', () => {
  beforeEach(() => greysheetService._cache.clear());

  test('returns Type pricing for Silver Libertad 1 oz', async () => {
    const typeResp = {
      OpCode: 200,
      Data: [{
        GsId: 393495,
        Name: 'Libertad 1 Onza Silver, 31.1g MS [Type]',
        PricingData: [
          {
            Grade: 65,
            GradeLabel: 'MS65',
            GreyVal: '76.68',
            CpgVal: '105.00',
            PcgsVal: '',
            NgcVal: '',
            BlueBookVal: '70.00',
            IsCac: false
          }
        ]
      }]
    };
    axios.get.mockResolvedValueOnce({ data: typeResp });

    const result = await greysheetService.fetchTypePrice('Mexican Silver Libertad 1 oz', 65);
    expect(result).not.toBeNull();
    expect(result.gsid).toBe(393495);
    expect(result.greyVal).toBe(76.68);
    expect(result.cpgVal).toBe(105.0);
    expect(result.isType).toBe(true);
    expect(result.lookupKey).toBe('libertad|1|silver');
  });

  test('returns Type pricing for ASE via hints', async () => {
    const typeResp = {
      OpCode: 200,
      Data: [{
        GsId: 72469,
        Name: 'American Silver Eagle (ASE) $1 One Ounce MS [Type]',
        PricingData: [
          {
            Grade: 69,
            GradeLabel: 'MS69',
            GreyVal: '74.71',
            CpgVal: '100.00',
            PcgsVal: '',
            NgcVal: '',
            BlueBookVal: '65.00',
            IsCac: false
          }
        ]
      }]
    };
    axios.get.mockResolvedValueOnce({ data: typeResp });

    const result = await greysheetService.fetchTypePrice('American Silver Eagle', 69, {
      series: 'Silver Eagle',
      weight: 1,
      metal: 'silver'
    });
    expect(result).not.toBeNull();
    expect(result.gsid).toBe(72469);
    expect(result.greyVal).toBe(74.71);
    expect(result.isType).toBe(true);
  });

  test('returns null for unrecognized series', async () => {
    const result = await greysheetService.fetchTypePrice('Somali Elephant 1 oz', 65);
    expect(result).toBeNull();
    // No API call should have been made
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('returns null when API returns no pricing', async () => {
    axios.get.mockResolvedValueOnce({ data: { OpCode: 200, Data: [] } });

    const result = await greysheetService.fetchTypePrice('Gold Krugerrand 1 oz', 65);
    expect(result).toBeNull();
  });

  test('uses hints to disambiguate Maple Leaf', async () => {
    const goldResp = {
      OpCode: 200,
      Data: [{
        GsId: 213178,
        Name: 'Gold Maple Leaf G$50 One Ounce MS [Type]',
        PricingData: [{
          Grade: 69, GradeLabel: 'MS69',
          GreyVal: '2850.00', CpgVal: '2980.00',
          PcgsVal: '', NgcVal: '', BlueBookVal: '2700.00',
          IsCac: false
        }]
      }]
    };
    axios.get.mockResolvedValueOnce({ data: goldResp });

    const result = await greysheetService.fetchTypePrice('Maple Leaf 1 oz', 69, { metal: 'gold' });
    expect(result).not.toBeNull();
    expect(result.gsid).toBe(213178);
    expect(result.lookupKey).toBe('maple leaf|1|gold');
  });
});

'use strict';

const fs = require('fs');
const path = require('path');
const MockAdapter = require('axios-mock-adapter');

process.env.PCGS_API_KEY = 'fixture-key';
process.env.GREYSHEET_API_TOKEN = 'fixture-token';
process.env.GREYSHEET_API_KEY = 'fixture-key';
process.env.NUMISTA_API_KEY = 'fixture-key';
process.env.EBAY_APP_ID = 'fixture-app';
process.env.EBAY_CLIENT_SECRET = 'fixture-secret';

const axios = require('axios');
const ebayService = require('../src/services/ebayService');
const pcgsService = require('../src/services/pcgsService');
const greysheetService = require('../src/services/greysheetService');
const numistaService = require('../src/services/numistaService');
const terapeakService = require('../src/services/terapeakService');

const fixturePath = name => path.join(__dirname, 'fixtures', 'upstream-shapes', name);
const fixture = name => JSON.parse(fs.readFileSync(fixturePath(name), 'utf8'));

describe('redacted upstream response contracts', () => {
  let mock;

  beforeEach(() => {
    mock = new MockAdapter(axios);
    pcgsService.clearCache();
    greysheetService._cache.clear();
    numistaService.clearCache();
  });

  afterEach(() => mock.restore());

  test('eBay Browse shape normalizes into an active comp', async () => {
    mock.onPost('https://api.ebay.com/identity/v1/oauth2/token').reply(200, {
      access_token: 'fixture-token', expires_in: 3600,
    });
    mock.onGet('https://api.ebay.com/buy/browse/v1/item_summary/search').reply(200, fixture('ebay.json'));

    const result = await ebayService.browseSearch('1921 Morgan', 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({
      itemId: 'v1|REDACTED|0',
      totalUsd: 130,
      _source: 'browse',
      _certificationAspect: 'PCGS',
    }));
  });

  test('PCGS APR shape maps guide, population, auction, and images', async () => {
    mock.onGet(/pcgs/).reply(200, fixture('pcgs-apr.json'));
    const result = await pcgsService.lookupByCoinNumberAndGrade('7130', 63);
    expect(result).toEqual(expect.objectContaining({
      verified: true,
      pcgsCoinNumber: '7130',
      series: 'Morgan Dollar',
      priceGuide: expect.objectContaining({ valueUsd: 125 }),
      population: { thisGrade: 1200, higher: 4100 },
      auction: expect.objectContaining({ count: 2, medianUsd: 125 }),
      coinImages: ['https://images.example.test/obverse.jpg'],
    }));
  });

  test('Greysheet shape maps the non-CAC pricing row', async () => {
    mock.onGet(/greysheet/).reply(200, fixture('greysheet.json'));
    const result = await greysheetService.fetchPriceByPcgsNumber('7130', 63);
    expect(result).toEqual(expect.objectContaining({
      greyVal: 105,
      cpgVal: 125,
      pcgsVal: 130,
      gsid: 7130,
      gradeLabel: 'MS63',
    }));
  });

  test('Numista type-search shape returns catalogue types', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => fixture('numista.json'),
    }));
    try {
      await expect(numistaService.searchTypes('Morgan Dollar', { issuer: 'united-states' }))
        .resolves.toEqual(fixture('numista.json').types);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('Terapeak CSV shape parses into normalized sold comps', () => {
    const source = fixture('terapeak-csv.json');
    const result = terapeakService.parseCSV(source.csv, source.searchTerm);
    expect(result.comps).toHaveLength(1);
    expect(result.comps[0]).toEqual(expect.objectContaining({
      title: '1921 Morgan Silver Dollar MS63',
      itemId: 'REDACTED',
      totalUsd: 130,
      _source: 'terapeak',
    }));
  });
});
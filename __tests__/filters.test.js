// __tests__/filters.test.js
const { isDenied, DENY_PATTERNS } = require('../src/utils/filters');

describe('isDenied — expanded deny list', () => {
  // ── Original patterns still work ──
  describe('original deny patterns', () => {
    test.each([
      ['5 coin lot Morgan Silver Dollar', 'lot'],
      ['Estate Sale Silver Coins', 'estate'],
      ['REPLICA 1893-S Morgan Dollar', 'replica'],
      ['COPY 1804 Dollar', 'copy'],
      ['Cleaned 1881-S Morgan', 'cleaned'],
      ['Gold plated 2024 ASE', 'plated'],
      ['Fake 1893-S Morgan', 'fake'],
      ['Lucky Token Dollar Size', 'token'],
      ['Whitman Morgan Dollar Album', 'album/whitman'],
      ['Dansco 7070 Type Set Album', 'album/dansco'],
      ['Littleton Coin Folder', 'folder/littleton'],
    ])('denies "%s" (%s)', (title) => {
      expect(isDenied(title)).toBe(true);
    });
  });

  // ── New jewelry / wearable patterns ──
  describe('jewelry and wearables', () => {
    test.each([
      ['Silver Dollar Coin Ring Size 7-13 Handmade'],
      ['Morgan Dollar Style Coin Ring Silver Tone'],
      ['Walking Liberty Half Dollar Rings for Men'],
      ['Eagle American Emblem Necklace Patriotic United States'],
      ['Silver Dollar Pendant Necklace Vintage Jewelry'],
      ['Mercury Dime Pendant Sterling Silver'],
      ['Coin Bracelet Silver Dollar Jewelry'],
      ['Morgan Dollar Cufflinks Sterling Silver'],
      ['Peace Dollar Belt Buckle Western'],
      ['Liberty Keychain Silver Tone'],
      ['Silver Eagle Earrings Sterling'],
    ])('denies "%s"', (title) => {
      expect(isDenied(title)).toBe(true);
    });
  });

  // ── Non-coin merchandise ──
  describe('non-coin merchandise', () => {
    test.each([
      ['Morgan Dollar Magnet Refrigerator'],
      ['Silver Eagle Poster Wall Art'],
      ['Christmas Ornament Coin Design'],
      ['Mercury Dime Button Vintage'],
      ['US Mint T-Shirt Collector'],
      ['US Coin Patch Iron On'],
    ])('denies "%s"', (title) => {
      expect(isDenied(title)).toBe(true);
    });
  });

  // ── Books / media ──
  describe('books and media', () => {
    test.each([
      ['Comprehensive Catalog and Encyclopedia of Morgan & Peace Silver Dollars'],
      ['Red Book Guide to United States Coins 2025'],
      ['PCGS Price Guide Book of US Coins'],
      ['Whitman Encyclopedia of Colonial Coins'],
      ['Coin Catalogue 2024 Edition'],
    ])('denies "%s"', (title) => {
      expect(isDenied(title)).toBe(true);
    });
  });

  // ── Stamps ──
  describe('stamps', () => {
    test.each([
      ['1951 US Postage Stamp Mint Set'],
      ['United States Stamps 1960 Collection'],
      ['1961 Commemorative Stamp Plate Block'],
    ])('denies "%s"', (title) => {
      expect(isDenied(title)).toBe(true);
    });
  });

  // ── Medals and coin roll hunt ──
  describe('medals and misc', () => {
    test.each([
      ['Indian Head Double Eagle 1907 Tribute Gold Medal'],
      ['Coin Roll Hunt Silver Dollar Search Video'],
    ])('denies "%s"', (title) => {
      expect(isDenied(title)).toBe(true);
    });
  });

  // ── FALSE POSITIVE safeguards ──
  describe('must NOT deny legitimate coin listings', () => {
    test.each([
      ['1886 Morgan Silver Dollar NGC MS65', 'Morgan dollar'],
      ['2024 American Silver Eagle 1 oz BU', 'ASE'],
      ['1921 Peace Silver Dollar High Relief', 'Peace dollar'],
      ['1916-D Mercury Dime PCGS VG-8', 'key date'],
      ['2023 Mexico 1 oz Silver Libertad BU', 'Libertad'],
      ['1 oz American Gold Buffalo 2026 BU', 'Gold Buffalo'],
      ['1889-CC Morgan Silver Dollar VF Details', 'CC Morgan'],
      ['2024 1/4 oz Gold American Eagle', 'fractional gold'],
      ['1964 Kennedy Half Dollar 90% Silver', 'silver Kennedy'],
      ['1932-D Washington Quarter PCGS F-12', 'key date quarter'],
      ['1878-CC Trade Dollar XF40', 'Trade Dollar'],
      ['1955 Double Die Lincoln Cent MS63', 'error coin'],
      ['1942/1 Mercury Dime Overdate NGC VF30', 'overdate'],
      ['Double Stamped Die Error 1972 Lincoln Cent', 'stamp die error -- not postal stamp'],
      ['Overstamped Mint Mark Variety 1938', 'stamp variety -- not postal stamp'],
    ])('allows "%s" (%s)', (title) => {
      expect(isDenied(title)).toBe(false);
    });
  });

  // ── Roll allow-list ──
  describe('roll handling', () => {
    test('denies roll by default', () => {
      expect(isDenied('Original Bank Roll Morgan Dollars')).toBe(true);
    });
    test('allows roll when allowRoll is set', () => {
      expect(isDenied('Original Bank Roll Morgan Dollars', { allowRoll: true })).toBe(false);
    });
  });

  // ── Edge cases ──
  describe('edge cases', () => {
    test('empty title is not denied', () => {
      expect(isDenied('')).toBe(false);
    });
    test('null-ish title is not denied', () => {
      expect(isDenied(undefined)).toBe(false);
    });
  });
});

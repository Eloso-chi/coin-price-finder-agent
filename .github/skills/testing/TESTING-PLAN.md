# Testing Plan -- Code Review Fixes #201-205

This document records testing requirements introduced by PR #30 so that
automated test agents and future reviewers know what to verify.

---

## 1. ExcelJS Migration (#201)

### What Changed
- `xlsx` replaced by `exceljs` (async API)
- `mapExcelToBackup()` is now `async` and returns a Promise
- Parse timeout of 10s added via `Promise.race`
- Header storage uses `Map<colNumber, string>` instead of sparse array

### Test Coverage Required

| Scenario | File | Status |
|----------|------|--------|
| Valid .xlsx parse with multiple columns | `excelImport.test.js` | Covered |
| Missing "Collectors" sheet returns error | `excelImport.test.js` | Covered |
| Empty sheet returns zero coins | `excelImport.test.js` | Covered |
| Header normalization (typos, case) | `excelImport.test.js` | Covered |
| Parse timeout on pathological buffer | `excelImport.test.js` | **NEW -- added** |
| Non-ZIP file rejected at magic-byte check | `excelImport.test.js` | Covered |
| OLE/CFB (.xls) file now rejected | `excelImport.test.js` | **NEW -- added** |
| Large file (approaching 10MB limit) | `excelImport.test.js` | Covered |
| Multi-sheet workbook (only reads Collectors) | `excelImport.test.js` | Covered |

### Future Considerations
- If ExcelJS adds streaming parse, consider benchmarking vs buffer load
- Monitor `npm audit` for exceljs advisories
- ZIP bomb mitigation: Node.js process memory should be monitored in production

---

## 2. Process Crash Handlers (#202)

### What Changed
- `process.on('unhandledRejection')` logs and exits after 100ms
- `process.on('uncaughtException')` logs and exits after 100ms

### Test Coverage Required

| Scenario | File | Status |
|----------|------|--------|
| Unhandled rejection triggers console.error | Integration (manual) | Not automated |
| Process exits with code 1 | Integration (manual) | Not automated |

### Notes
- These handlers are process-level; unit testing requires child_process spawn.
- Production validation: check App Service logs for `[FATAL]` prefix.
- The 100ms delay is a tradeoff -- sufficient for synchronous log write.

---

## 3. Rate Limiter Coverage (#203)

### What Changed
- `apiLimiter` added to `/api/coin-variant` and `/api/coin-history` mounts

### Test Coverage Required

| Scenario | File | Status |
|----------|------|--------|
| coin-variant returns 429 after limit exceeded | `coinHistoryRoute.test.js` | Future |
| coin-history returns 429 after limit exceeded | `coinHistoryRoute.test.js` | Future |
| Existing rate-limited routes still pass | `priceRoute.test.js` | Covered |

### Notes
- Rate limit tests are slow (must exhaust window). Run in integration suite only.
- Verify `X-RateLimit-*` headers present in response.

---

## 4. Shared Constants (#204)

### What Changed
- `BULLION_1OZ_DEFAULT` and `ALLOWED_LABELS` moved to `src/data/constants.js`
- All consumers import from single source
- Test mocks use `jest.requireActual('../src/data/constants')` pattern

### Test Coverage Required

| Scenario | File | Status |
|----------|------|--------|
| Constants export correct values | `constants.test.js` | Covered |
| BULLION_1OZ_DEFAULT has 15 entries | `constants.test.js` | **NEW -- added** |
| ALLOWED_LABELS is a Set with 26 entries | `constants.test.js` | **NEW -- added** |
| Label validation rejects unknown labels | `priceRoute.test.js` | Covered |
| Bullion detection works for all listed series | `priceRoute.test.js` | Covered |

### Mock Pattern (for future test authors)
```javascript
// DO: Spread real constants, mock only functions
jest.mock('../src/data/constants', () => ({
  ...jest.requireActual('../src/data/constants'),
  zodiacForYear: jest.fn(() => null),
  perthLunarSeries: jest.fn(() => null),
  getRollQuantity: jest.fn(() => 20),
}));

// DON'T: Duplicate constant arrays in mock blocks
```

---

## 5. Test Assertion Tolerance (#205)

### What Changed
- `terapeakDataIntegrity.test.js`: comp count upper bound relaxed from
  `rawPrices.length + 10` to `rawPrices.length * 2`

### Rationale
Deep pagination merges multiple CSV files for the same search term.
Stored comps can legitimately exceed a single file's row count.

### Test Coverage Required

| Scenario | File | Status |
|----------|------|--------|
| Merged dataset within 2x bound | `terapeakDataIntegrity.test.js` | Covered |
| Single-file dataset passes original bounds | `terapeakDataIntegrity.test.js` | Covered |

---

## Pre-existing Flaky Test (Not PR #30)

**`cross-route consistency > 2018 Kookaburra`**: confidence=0 despite FMV present.
Root cause: valuation engine returns `confidence: 0` when all comps are
low-match-score. Fix tracked separately.

---

## Running Tests

```bash
# Full suite (68 suites, ~2859 tests)
npm test

# Excel import suite only
npx jest __tests__/excelImport.test.js

# Constants validation
npx jest __tests__/constants.test.js

# Data integrity (requires terapeak-meta.json)
npx jest __tests__/terapeakDataIntegrity.test.js
```

# Test Runtime Analysis

Source: `jest-294w-baseline.json`

Command: `COIN_TEST_SEED=294w-baseline-20260811 npx jest --runInBand --silent --json`

- Jest suite span: 489.9s (full-run budget: 60s)
- Wall clock: 513.3s
- Minimum over budget: 429.9s
- Suites: 154 total, 5 over 5s
- Tests: 4338 timed, 75 over 500ms
- Note: process startup, teardown, and reporting require a separate wall-clock measurement.

## Slowest Suites

| Rank | Suite | Duration |
|---:|---|---:|
| 1 | `__tests__/terapeakDataIntegrity.test.js` | 341.49s |
| 2 | `__tests__/authServiceAdmin.test.js` | 15.54s |
| 3 | `__tests__/excelImport.test.js` | 12.13s |
| 4 | `__tests__/authServiceStrictCache.test.js` | 11.02s |
| 5 | `__tests__/requireAdminOrKey.test.js` | 5.24s |
| 6 | `__tests__/optionalAdminContext.test.js` | 4.81s |
| 7 | `__tests__/freshnessReport.test.js` | 4.26s |
| 8 | `__tests__/terapeakOperator.test.js` | 3.09s |
| 9 | `__tests__/canonicalizeMetaFiles.test.js` | 3.08s |
| 10 | `__tests__/prefetchScheduler.test.js` | 2.53s |
| 11 | `__tests__/freshnessReportEvidenceGates.test.js` | 2.19s |
| 12 | `__tests__/bulkLotEstimatorHealth.test.js` | 1.95s |
| 13 | `__tests__/mergeDuplicateKeys.test.js` | 1.94s |
| 14 | `__tests__/freshnessReportDeepPaginate.test.js` | 1.82s |
| 15 | `__tests__/pcgsQuotaService.test.js` | 1.64s |
| 16 | `__tests__/barPriceRoute.test.js` | 1.50s |
| 17 | `__tests__/bulkEvaluate.test.js` | 1.49s |
| 18 | `__tests__/adminRoute.test.js` | 1.25s |
| 19 | `__tests__/auctionPriceServiceHappyPath.test.js` | 1.14s |
| 20 | `__tests__/crossRouteConsistency.test.js` | 1.09s |

## Slowest Tests

| Rank | Test | File | Duration |
|---:|---|---|---:|
| 1 | parse timeout rejects when xlsx.load exceeds timeout | `__tests__/excelImport.test.js` | 10.01s |
| 2 | Terapeak data integrity — raw CSV vs FMV pipeline 1867 Indian Head Cent comp prices trace back to raw CSV prices (no phantom values) | `__tests__/terapeakDataIntegrity.test.js` | 7.84s |
| 3 | Terapeak data integrity — raw CSV vs FMV pipeline 1860-S Seated Liberty Dime comp prices trace back to raw CSV prices (no phantom values) | `__tests__/terapeakDataIntegrity.test.js` | 7.57s |
| 4 | Terapeak data integrity — raw CSV vs FMV pipeline 1902 Morgan Silver Dollar MS63 comp prices trace back to raw CSV prices (no phantom values) | `__tests__/terapeakDataIntegrity.test.js` | 7.45s |
| 5 | Terapeak data integrity — raw CSV vs FMV pipeline 1916 Barber Quarter comp prices trace back to raw CSV prices (no phantom values) | `__tests__/terapeakDataIntegrity.test.js` | 7.45s |
| 6 | Terapeak data integrity — raw CSV vs FMV pipeline 1874 Indian Head Cent comp prices trace back to raw CSV prices (no phantom values) | `__tests__/terapeakDataIntegrity.test.js` | 7.37s |
| 7 | Terapeak data integrity — raw CSV vs FMV pipeline 1926-S Peace Silver Dollar MS64 comp prices trace back to raw CSV prices (no phantom values) | `__tests__/terapeakDataIntegrity.test.js` | 7.36s |
| 8 | Terapeak data integrity — raw CSV vs FMV pipeline 1935 Peace Dollar -D -S comp prices trace back to raw CSV prices (no phantom values) | `__tests__/terapeakDataIntegrity.test.js` | 7.30s |
| 9 | Terapeak data integrity — raw CSV vs FMV pipeline 1904 Liberty V Nickel stored comps count is not catastrophically inflated | `__tests__/terapeakDataIntegrity.test.js` | 7.29s |
| 10 | Terapeak data integrity — raw CSV vs FMV pipeline 1904 Liberty V Nickel comp prices trace back to raw CSV prices (no phantom values) | `__tests__/terapeakDataIntegrity.test.js` | 7.28s |
| 11 | Terapeak data integrity — raw CSV vs FMV pipeline 1911-D Barber Dime comp prices trace back to raw CSV prices (no phantom values) | `__tests__/terapeakDataIntegrity.test.js` | 7.27s |
| 12 | Terapeak data integrity — raw CSV vs FMV pipeline 1867 Indian Head Cent stored comps count is not catastrophically inflated | `__tests__/terapeakDataIntegrity.test.js` | 7.26s |
| 13 | Terapeak data integrity — raw CSV vs FMV pipeline 1860-S Seated Liberty Dime stored comps count is not catastrophically inflated | `__tests__/terapeakDataIntegrity.test.js` | 7.25s |
| 14 | Terapeak data integrity — raw CSV vs FMV pipeline 2013 Australia 1oz Silver Kookaburra stored comps count is not catastrophically inflated | `__tests__/terapeakDataIntegrity.test.js` | 7.24s |
| 15 | Terapeak data integrity — raw CSV vs FMV pipeline 1903-S Barber Quarter stored comps count is not catastrophically inflated | `__tests__/terapeakDataIntegrity.test.js` | 7.24s |
| 16 | Terapeak data integrity — raw CSV vs FMV pipeline 2013 Australia 1oz Silver Kookaburra comp prices trace back to raw CSV prices (no phantom values) | `__tests__/terapeakDataIntegrity.test.js` | 7.18s |
| 17 | Terapeak data integrity — raw CSV vs FMV pipeline 1916 Barber Quarter stored comps count is not catastrophically inflated | `__tests__/terapeakDataIntegrity.test.js` | 7.15s |
| 18 | Terapeak data integrity — raw CSV vs FMV pipeline 1880-S Morgan Silver Dollar MS64 comp prices trace back to raw CSV prices (no phantom values) | `__tests__/terapeakDataIntegrity.test.js` | 7.11s |
| 19 | Terapeak data integrity — raw CSV vs FMV pipeline 1859-S Seated Liberty Dollar comp prices trace back to raw CSV prices (no phantom values) | `__tests__/terapeakDataIntegrity.test.js` | 7.09s |
| 20 | Terapeak data integrity — raw CSV vs FMV pipeline 1945-D Washington Quarter comp prices trace back to raw CSV prices (no phantom values) | `__tests__/terapeakDataIntegrity.test.js` | 7.07s |

## Findings and Remediation

`terapeakDataIntegrity.test.js` accounted for 341.5s (70% of the Jest runtime). Each sampled dataset repeatedly read and parsed every Terapeak CSV, then rebuilt the same global price index. Caching each immutable CSV parse and building the global count/index once reduced the isolated seeded suite from 341.5s to 55.0s (84%) while all 111 tests continued to pass.

The Excel timeout test also waited the full production 10 seconds, and successful workbook loads left that timeout handle pending. Fake timers plus production timeout cleanup reduced the isolated Excel suite from 16.5s wall time with an open-handle warning to 3.6s Jest time with a clean exit.

The post-change canonical run passed 155 suites and 4,342 tests in 96.3s (99.6s wall time). A separate JSON profile completed in 82.8s. Limiting Jest from seven workers to four took 89.3s and was rejected. The remaining critical path is the integrity suite's one-time forced import of the full Terapeak corpus. CI sharding remains Phase 3 only if targeted fixes do not meet the 60s full-suite budget.

# Known Flaky Tests

Migrated from `/memories/repo/` to `docs/memory/` on 2026-07-05.

## `__tests__/terapeakService.test.js` -- "autoImportFolder > freshness check skips recently imported files" (L478)

- **Symptom**: `expect(r2.freshSkipped).toBeGreaterThanOrEqual(1)` fails intermittently in full parallel runs (~25% miss rate observed on 2026-06-24).
- **Isolation result**: passes 9/9 when run alone (`npx jest __tests__/terapeakService.test.js -t "freshness check skips recently imported files"`).
- **Cause (suspected)**: filesystem mtime resolution / scheduling jitter under load when many suites run concurrently. Not related to fake timers (Jest workers isolate process state).
- **Workaround**: re-run `npm test` if it fails on this test only. Do NOT count it as a regression unless it fails in isolation.
- **Fix candidate (someday)**: stub `fs.statSync` mtimes deterministically OR add a small mtime nudge before the freshness check. Not blocking.
- **First documented**: PR #188 (2026-06-24) -- noticed while validating nit additions.
- **Confirmed still flaking**: 2026-07-04 during the dependabot ESLint bump merge validation (first `npm test` run showed 1 failure in `terapeakRoute.js` /report-no-data test path -- similar mtime-race class; re-run was clean).

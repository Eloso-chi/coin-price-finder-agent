// __tests__/backfillNoData.test.js -- Tests for scripts/backfill-no-data.js (Fix C of #245)
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Pure-function tests: parseLog / aggregateHits / buildPlan ──
describe('backfill-no-data internals', () => {
  const backfill = require('../scripts/backfill-no-data');

  test('parseLog extracts term from line preceding NO EXPORT', () => {
    const tmp = path.join(os.tmpdir(), `tp-log-${Date.now()}.log`);
    fs.writeFileSync(tmp,
      '  [  1%] 1875 Liberty Half Eagle...     WARNING: No data rows found (2 tables on page)\n' +
      'NO EXPORT (no results or button not found)\n' +
      '  [  2%] 1882-S Morgan Silver Dollar... OK (uploaded)\n' +
      '  [  3%] 1992 Great Britain 1oz Gold Britannia...     WARNING: No data rows found\n' +
      'NO EXPORT (no results or button not found)\n'
    );
    fs.utimesSync(tmp, new Date(), new Date('2026-05-10T12:00:00Z'));
    const stat = fs.statSync(tmp);
    const hits = backfill.parseLog({ name: 'tp-log.log', path: tmp, mtimeMs: stat.mtimeMs });
    expect(hits).toHaveLength(2);
    expect(hits[0].term).toBe('1875 Liberty Half Eagle');
    expect(hits[1].term).toBe('1992 Great Britain 1oz Gold Britannia');
    fs.unlinkSync(tmp);
  });

  test('parseLog ignores NO EXPORT without preceding term line', () => {
    const tmp = path.join(os.tmpdir(), `tp-log-${Date.now()}.log`);
    fs.writeFileSync(tmp, 'NO EXPORT (no results or button not found)\nrandom junk\n');
    const stat = fs.statSync(tmp);
    const hits = backfill.parseLog({ name: 'x.log', path: tmp, mtimeMs: stat.mtimeMs });
    expect(hits).toHaveLength(0);
    fs.unlinkSync(tmp);
  });

  test('aggregateHits collapses by normalized key and counts hits', () => {
    const hits = [
      { term: '1875 Liberty Half Eagle', logName: 'a.log', logMtimeMs: 1000 },
      { term: '1875 Liberty Half Eagle', logName: 'b.log', logMtimeMs: 2000 },
      { term: '1882-S Morgan Silver Dollar', logName: 'a.log', logMtimeMs: 1500 },
    ];
    const agg = backfill.aggregateHits(hits);
    expect(agg).toHaveLength(2);
    const liberty = agg.find(a => /liberty/i.test(a.searchTerm));
    expect(liberty.hitCount).toBe(2);
    expect(liberty.lastHitMs).toBe(2000);
    expect(liberty.logs.size).toBe(2);
  });

  test('NO_DATA_CAP caps the stamp at 5', () => {
    expect(backfill.NO_DATA_CAP).toBe(5);
  });
});

// ── End-to-end: --apply persists to terapeakService meta ────
describe('backfill-no-data buildPlan against live store', () => {
  // Use unique fixture keys that won't collide with the real meta corpus.
  // We mutate state through the public terapeakService API rather than
  // file-writing the meta, because the service caches _store in memory.
  const terapeakService = require('../src/services/terapeakService');
  const LIBERTY_TERM = '__test_backfill_liberty_' + Date.now();
  const MORGAN_TERM = '__test_backfill_morgan_' + Date.now();
  const LIBERTY_KEY = terapeakService.normalizeSearchKey(LIBERTY_TERM);
  const MORGAN_KEY = terapeakService.normalizeSearchKey(MORGAN_TERM);

  beforeAll(() => {
    // Liberty: empty skeleton (no comps, no noDataCount yet)
    terapeakService.updateDatasetMeta(LIBERTY_TERM, { page1At: '2026-05-01T00:00:00.000Z' });
    // Morgan: has comps via importComps -- buildPlan must skip this entry
    terapeakService.importComps(MORGAN_TERM, [
      { price: 100, soldDate: '2026-05-15', title: 'morgan test', _source: 'terapeak' },
    ]);
  });

  afterAll(() => {
    terapeakService.deleteDataset(LIBERTY_KEY);
    terapeakService.deleteDataset(MORGAN_KEY);
  });

  test('buildPlan marks empty entries as stamp and entries-with-data as skip', () => {
    const backfill = require('../scripts/backfill-no-data');
    const aggregated = [
      { normalizedKey: LIBERTY_KEY,
        searchTerm: LIBERTY_TERM, hitCount: 3, lastHitMs: Date.now(), logs: new Set(['a.log']) },
      { normalizedKey: MORGAN_KEY,
        searchTerm: MORGAN_TERM, hitCount: 1, lastHitMs: Date.now(), logs: new Set(['a.log']) },
    ];
    const plan = backfill.buildPlan(aggregated);
    const liberty = plan.find(p => p.normalizedKey === LIBERTY_KEY);
    const morgan = plan.find(p => p.normalizedKey === MORGAN_KEY);
    expect(liberty.action).toBe('stamp');
    expect(liberty.newNoDataCount).toBe(3);
    expect(morgan.action).toBe('skip');
    expect(morgan.reason).toMatch(/has comps/);
  });

  test('buildPlan caps newNoDataCount at NO_DATA_CAP (5)', () => {
    const backfill = require('../scripts/backfill-no-data');
    const aggregated = [
      { normalizedKey: LIBERTY_KEY,
        searchTerm: LIBERTY_TERM, hitCount: 99, lastHitMs: Date.now(), logs: new Set(['a.log']) },
    ];
    const plan = backfill.buildPlan(aggregated);
    expect(plan[0].newNoDataCount).toBe(5);
  });

  test('idempotency: re-running with same input produces skip "no change"', () => {
    const backfill = require('../scripts/backfill-no-data');
    terapeakService.updateDatasetMeta(LIBERTY_TERM, {
      noDataCount: 3,
      noDataAt: '2026-06-01T00:00:00.000Z',
    });
    const lastHitMs = new Date('2026-06-01T00:00:00.000Z').getTime();
    const aggregated = [
      { normalizedKey: LIBERTY_KEY,
        searchTerm: LIBERTY_TERM, hitCount: 3, lastHitMs, logs: new Set(['a.log']) },
    ];
    const plan = backfill.buildPlan(aggregated);
    expect(plan[0].action).toBe('skip');
    expect(plan[0].reason).toMatch(/no change/);
  });

  test('never decreases existing noDataCount (monotonic)', () => {
    const backfill = require('../scripts/backfill-no-data');
    terapeakService.updateDatasetMeta(LIBERTY_TERM, {
      noDataCount: 4,
      noDataAt: '2026-06-01T00:00:00.000Z',
    });
    const aggregated = [
      { normalizedKey: LIBERTY_KEY,
        searchTerm: LIBERTY_TERM, hitCount: 1, lastHitMs: 0, logs: new Set(['a.log']) },
    ];
    const plan = backfill.buildPlan(aggregated);
    // Already at 4, new max(4,1)=4, lastHitMs=0 < existing -> no change
    expect(plan[0].action).toBe('skip');
  });
});

// __tests__/usTypeSeed.test.js
// #334H: US type seed terms (loader, injection, committed seed file, status report).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  DEFAULT_SEED_PATH,
  resolveSeedPhase,
  parseSeedDoc,
  loadSeedTerms,
  selectSeedTerms,
  injectSeeds,
} = require('../src/utils/usTypeSeed');
const { normalizeSearchKey } = require('../src/services/terapeakService');
const { analyzeExplicitWeightSources } = require('../src/utils/explicitWeight');
const { classify, buildStatus } = require('../scripts/us-type-seed-status');

const STATUS_SCRIPT = path.join(__dirname, '..', 'scripts', 'us-type-seed-status.js');

function term(overrides = {}) {
  return { term: '1957 American Proof Set', group: 'proof-sets-1950-64', rank: 1, phase: 0, ...overrides };
}

describe('resolveSeedPhase', () => {
  test.each([
    [undefined, 0],
    ['', 0],
    ['0', 0],
    ['2', 2],
    [' 3 ', 3],
    [1, 1],
  ])('%p -> phase %p', (raw, phase) => {
    expect(resolveSeedPhase(raw)).toEqual({ phase });
  });

  test.each(['off', 'OFF', '-1'])('%p turns seeding off', (raw) => {
    expect(resolveSeedPhase(raw)).toEqual({ phase: null });
  });

  test.each(['4', '1.5', 'abc', '99'])('%p warns and falls back to 0', (raw) => {
    const result = resolveSeedPhase(raw);
    expect(result.phase).toBe(0);
    expect(result.warning).toContain(`"${raw}"`);
  });
});

describe('parseSeedDoc', () => {
  test('keeps valid terms and trims the term text', () => {
    const { terms, errors } = parseSeedDoc({ terms: [term({ term: '  1957 American Proof Set  ' })] });
    expect(errors).toEqual([]);
    expect(terms).toEqual([term()]);
  });

  test.each([
    [{ term: '' }, 'term must be a non-empty string'],
    [{ term: 'x'.repeat(201) }, 'longer than 200'],
    [{ term: '1957 Pr\u00f8of Set' }, 'printable ASCII'],
    [{ term: 'Australian Generic Gold Kangaroo' }, 'generic'],
    [{ group: '' }, 'group must be a non-empty string'],
    [{ rank: 0 }, 'rank must be a positive integer'],
    [{ rank: 1.5 }, 'rank must be a positive integer'],
    [{ phase: 4 }, 'phase must be an integer 0-3'],
    [{ phase: '1' }, 'phase must be an integer 0-3'],
  ])('rejects %j', (override, message) => {
    const { terms, errors } = parseSeedDoc({ terms: [term(override), term({ term: '1958 American Proof Set' })] });
    expect(terms).toEqual([term({ term: '1958 American Proof Set' })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('terms[0]');
    expect(errors[0]).toContain(message);
  });

  test.each([null, [], { terms: 'nope' }, 'text'])('rejects a malformed document %j', (doc) => {
    const { terms, errors } = parseSeedDoc(doc);
    expect(terms).toEqual([]);
    expect(errors).toEqual(['seed file must be an object with a terms array']);
  });
});

describe('loadSeedTerms', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpf-seed-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a missing file is reported as missing, not as an error', () => {
    expect(loadSeedTerms(path.join(dir, 'nope.json'))).toEqual({ terms: [], errors: [], missing: true });
  });

  test('invalid JSON yields an error and no terms', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{ not json');
    const result = loadSeedTerms(file);
    expect(result.terms).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('not valid JSON');
  });

  test('loads a valid file', () => {
    const file = path.join(dir, 'ok.json');
    fs.writeFileSync(file, JSON.stringify({ terms: [term()] }));
    expect(loadSeedTerms(file)).toEqual({ terms: [term()], errors: [] });
  });
});

describe('selectSeedTerms', () => {
  const terms = [term({ phase: 0 }), term({ term: 'b', phase: 1 }), term({ term: 'c', phase: 3 })];

  test('includes every term up to and including the phase', () => {
    expect(selectSeedTerms(terms, 0).map((t) => t.phase)).toEqual([0]);
    expect(selectSeedTerms(terms, 1).map((t) => t.phase)).toEqual([0, 1]);
    expect(selectSeedTerms(terms, 3)).toHaveLength(3);
  });

  test('a null phase selects nothing', () => {
    expect(selectSeedTerms(terms, null)).toEqual([]);
  });
});

describe('injectSeeds', () => {
  const normalizeKey = normalizeSearchKey;

  test('adds a missing entry shaped for the freshness classifier', () => {
    const meta = {};
    const result = injectSeeds(meta, [term()], { normalizeKey, hasCSV: () => false });
    expect(result.added).toEqual([{ key: '1957 american proof set', ...term() }]);
    expect(meta['1957 american proof set']).toEqual({
      searchTerm: '1957 American Proof Set',
      compCount: null,
      refreshCount: 0,
      noDataCount: 0,
      usSeed: { group: 'proof-sets-1950-64', rank: 1, phase: 0 },
    });
  });

  test('never overwrites a key that already has a meta entry', () => {
    const existing = { compCount: 50, newestSaleDate: '2026-10-01' };
    const meta = { '1957 american proof set': existing };
    const result = injectSeeds(meta, [term()], { normalizeKey, hasCSV: () => false });
    expect(result).toMatchObject({ added: [], existing: 1, withCsv: 0, duplicates: 0 });
    expect(meta['1957 american proof set']).toBe(existing);
    expect(existing).toEqual({ compCount: 50, newestSaleDate: '2026-10-01' });
  });

  test('skips a term that already has a CSV on disk', () => {
    const meta = {};
    const result = injectSeeds(meta, [term()], { normalizeKey, hasCSV: () => true });
    expect(result).toMatchObject({ added: [], existing: 0, withCsv: 1 });
    expect(meta).toEqual({});
  });

  test('counts terms that normalize to the same key once', () => {
    const meta = {};
    const result = injectSeeds(
      meta,
      [term(), term({ term: '1957 american PROOF set' }), term({ term: 'Proof Set 1957 American' })],
      { normalizeKey, hasCSV: () => false },
    );
    expect(result.added).toHaveLength(1);
    expect(result.duplicates).toBe(2);
    expect(Object.keys(meta)).toEqual(['1957 american proof set']);
  });
});

describe('committed seed file (data/research/us-type-seed.json)', () => {
  const loaded = loadSeedTerms(DEFAULT_SEED_PATH);

  test('parses with no errors', () => {
    expect(loaded.missing).toBeUndefined();
    expect(loaded.errors).toEqual([]);
    expect(loaded.terms.length).toBeGreaterThan(100);
  });

  test('every term has a unique normalized key', () => {
    const keys = loaded.terms.map((t) => normalizeSearchKey(t.term));
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });

  test('no term trips the contradictory-weight guard', () => {
    const bad = loaded.terms.filter((t) => {
      const analysis = analyzeExplicitWeightSources(normalizeSearchKey(t.term), t.term);
      return analysis.invalid || analysis.weights.length > 1;
    });
    expect(bad.map((t) => t.term)).toEqual([]);
  });

  test('ranks 1-21 are all present and each group has one rank', () => {
    const ranksByGroup = new Map();
    for (const t of loaded.terms) {
      const set = ranksByGroup.get(t.group) || new Set();
      set.add(t.rank);
      ranksByGroup.set(t.group, set);
    }
    for (const [group, set] of ranksByGroup) expect([group, [...set].length]).toEqual([group, 1]);
    const ranks = [...new Set(loaded.terms.map((t) => t.rank))].sort((a, b) => a - b);
    expect(ranks).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
  });

  test('phase 0 probes every group except the deprioritized gold group', () => {
    const groups = [...new Set(loaded.terms.map((t) => t.group))];
    const probed = new Set(loaded.terms.filter((t) => t.phase === 0).map((t) => t.group));
    expect(groups.filter((g) => !probed.has(g))).toEqual(['gold-types']);
  });

  test('gold types are phase 3 only', () => {
    const gold = loaded.terms.filter((t) => t.group === 'gold-types');
    expect(gold.length).toBeGreaterThan(0);
    expect(gold.every((t) => t.phase === 3)).toBe(true);
  });

  test('excluded modern clad and circulation types are not seeded', () => {
    const excluded = /\b(jefferson|kennedy|roosevelt|sacagawea|presidential|susan|lincoln memorial|union shield)\b/i;
    expect(loaded.terms.filter((t) => excluded.test(t.term)).map((t) => t.term)).toEqual([]);
  });
});

describe('seed status report', () => {
  test.each([
    [null, 'pending'],
    [{}, 'pending'],
    [{ compCount: null, noDataCount: 0 }, 'pending'],
    [{ compCount: 0, noDataCount: 1 }, 'no-data'],
    [{ compCount: 3 }, 'thin'],
    [{ compCount: 9, noDataCount: 2 }, 'thin'],
    [{ compCount: 10 }, 'viable'],
    [{ compCount: 120 }, 'viable'],
  ])('classify(%j) -> %s', (entry, status) => {
    expect(classify(entry)).toBe(status);
  });

  test('buildStatus groups terms by rank and counts each state', () => {
    const terms = [
      term({ term: '1957 American Proof Set' }),
      term({ term: '1958 American Proof Set' }),
      term({ term: '1959 American Proof Set' }),
      term({ term: '1960 American Proof Set' }),
      term({ term: '1857 Flying Eagle Cent', group: 'flying-eagle-cent', rank: 8 }),
    ];
    const meta = {
      '1957 american proof set': { compCount: 40 },
      '1958 american proof set': { compCount: 4 },
      '1959 american proof set': { compCount: 0, noDataCount: 1 },
    };
    expect(buildStatus(terms, meta)).toEqual([
      { group: 'proof-sets-1950-64', rank: 1, terms: 4, pending: 1, noData: 1, thin: 1, viable: 1, medianComps: 40 },
      { group: 'flying-eagle-cent', rank: 8, terms: 1, pending: 1, noData: 0, thin: 0, viable: 0, medianComps: null },
    ]);
  });

  describe('CLI', () => {
    let dir;
    let env;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpf-seed-status-'));
      const seed = path.join(dir, 'seed.json');
      const meta = path.join(dir, 'meta.json');
      fs.writeFileSync(seed, JSON.stringify({
        terms: [
          term({ term: '1957 American Proof Set', phase: 0 }),
          term({ term: '1958 American Proof Set', phase: 1 }),
        ],
      }));
      fs.writeFileSync(meta, JSON.stringify({ '1957 american proof set': { compCount: 25 } }));
      env = { ...process.env, META_PATH: meta, US_TYPE_SEED_PATH: seed };
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('--json reports every phase by default', () => {
      const out = JSON.parse(execFileSync('node', [STATUS_SCRIPT, '--json'], { encoding: 'utf8', env }));
      expect(out.phase).toBe(3);
      expect(out.groups).toEqual([
        { group: 'proof-sets-1950-64', rank: 1, terms: 2, pending: 1, noData: 0, thin: 0, viable: 1, medianComps: 25 },
      ]);
    });

    test('--phase 0 limits the report to the probe terms', () => {
      const out = JSON.parse(execFileSync('node', [STATUS_SCRIPT, '--json', '--phase', '0'], { encoding: 'utf8', env }));
      expect(out.groups[0]).toMatchObject({ terms: 1, pending: 0, viable: 1 });
    });

    test('the text table has a row per group', () => {
      const out = execFileSync('node', [STATUS_SCRIPT], { encoding: 'utf8', env });
      expect(out).toContain('US type seed status (#334H), terms up to phase 3');
      expect(out).toMatch(/proof-sets-1950-64\s+2\s+1\s+0\s+0\s+1\s+25/);
    });

    test('an invalid --phase exits 2', () => {
      expect(() => execFileSync('node', [STATUS_SCRIPT, '--phase', '9'], { encoding: 'utf8', env, stdio: 'pipe' })).toThrow(
        expect.objectContaining({ status: 2 }),
      );
    });
  });
});

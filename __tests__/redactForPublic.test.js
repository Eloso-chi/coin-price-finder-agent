// __tests__/redactForPublic.test.js
// Unit + integration coverage for the Terapeak source-label redaction (#243).
//
// The contract is narrow on purpose:
//   - Non-admin callers MUST NOT see `_source: "terapeak"` anywhere in the
//     /api/price, /api/bar-price, /api/pricing-batch responses.
//   - Admin callers (req.isAdmin === true) MUST see the original label so
//     internal dashboards / dealer tooling can keep filtering on it.
//   - The rest of the comp payload (title, totalUsd, soldDate, etc.) is
//     preserved -- this is a label-only redaction, not a comp strip.

'use strict';

const { redactCompsForPublic } = require('../src/utils/redactForPublic');

function mkComp(extra = {}) {
  return {
    itemId: 'v1|1234|0',
    title: '1882-S Morgan Silver Dollar',
    totalUsd: 76.28,
    soldDate: '2026-05-01',
    _source: 'terapeak',
    ...extra,
  };
}

describe('redactCompsForPublic (#243 -- Terapeak source label)', () => {
  test('rewrites _source: "terapeak" -> "ebay-sold" for non-admin on ebay.us.comps', () => {
    const resp = {
      ebay: { us: { comps: [mkComp(), mkComp({ _source: 'browse' }), mkComp()] } },
    };
    redactCompsForPublic(resp, false);
    expect(resp.ebay.us.comps[0]._source).toBe('ebay-sold');
    expect(resp.ebay.us.comps[1]._source).toBe('browse'); // untouched
    expect(resp.ebay.us.comps[2]._source).toBe('ebay-sold');
  });

  test('also rewrites ebay.global.comps', () => {
    const resp = { ebay: { global: { comps: [mkComp()] } } };
    redactCompsForPublic(resp, false);
    expect(resp.ebay.global.comps[0]._source).toBe('ebay-sold');
  });

  test('preserves the rest of each comp (title, totalUsd, soldDate, itemId)', () => {
    const resp = { ebay: { us: { comps: [mkComp()] } } };
    redactCompsForPublic(resp, false);
    const c = resp.ebay.us.comps[0];
    expect(c.title).toBe('1882-S Morgan Silver Dollar');
    expect(c.totalUsd).toBe(76.28);
    expect(c.soldDate).toBe('2026-05-01');
    expect(c.itemId).toBe('v1|1234|0');
  });

  test('no-op when isAdmin === true (admins keep seeing the real label)', () => {
    const resp = { ebay: { us: { comps: [mkComp()] } } };
    redactCompsForPublic(resp, true);
    expect(resp.ebay.us.comps[0]._source).toBe('terapeak');
  });

  test('walks batch shape: response.results[].ebay.{us,global}.comps[]', () => {
    const resp = {
      ok: true,
      results: [
        { ebay: { us: { comps: [mkComp()] }, global: { comps: [mkComp()] } } },
        { ebay: { us: { comps: [mkComp(), mkComp()] } } },
        { error: 'missing query' }, // mixed-shape: redaction must not throw
      ],
    };
    redactCompsForPublic(resp, false);
    expect(resp.results[0].ebay.us.comps[0]._source).toBe('ebay-sold');
    expect(resp.results[0].ebay.global.comps[0]._source).toBe('ebay-sold');
    expect(resp.results[1].ebay.us.comps[1]._source).toBe('ebay-sold');
  });

  test('does NOT mutate the original comp objects (cache-safety)', () => {
    // Critical: terapeakService returns comp objects from an in-memory cache
    // that is shared across requests. The redactor must clone before
    // rewriting so an anon call cannot poison a subsequent admin call.
    const cachedComp = mkComp();
    const resp = { ebay: { us: { comps: [cachedComp] } } };
    redactCompsForPublic(resp, false);
    expect(cachedComp._source).toBe('terapeak'); // original untouched
    expect(resp.ebay.us.comps[0]._source).toBe('ebay-sold'); // response has clone
    expect(resp.ebay.us.comps[0]).not.toBe(cachedComp);
  });

  test('does NOT mutate the upstream ebay.us / ebay.global objects (ebayService TTL cache safety)', () => {
    // Regression: ebayService.fetchSoldComps caches `result.us` /
    // `result.global` by reference, so reassigning `ebay.us.comps` on the
    // response would poison the next request's cached read. Verify the
    // redactor leaves the upstream side objects -- and their .comps array
    // identity -- untouched.
    const cachedUs = { stats: {}, comps: [mkComp(), mkComp()], removed: {} };
    const cachedGlobal = { stats: {}, comps: [mkComp()], removed: {} };
    const cachedComps = cachedUs.comps;
    const resp = { ebay: { us: cachedUs, global: cachedGlobal } };
    redactCompsForPublic(resp, false);
    expect(resp.ebay.us).not.toBe(cachedUs);
    expect(resp.ebay.global).not.toBe(cachedGlobal);
    expect(cachedUs.comps).toBe(cachedComps);
    expect(cachedUs.comps[0]._source).toBe('terapeak');
    expect(cachedGlobal.comps[0]._source).toBe('terapeak');
  });

  test('idempotent: running twice does not corrupt already-redacted comps', () => {
    const resp = { ebay: { us: { comps: [mkComp()] } } };
    redactCompsForPublic(resp, false);
    redactCompsForPublic(resp, false);
    expect(resp.ebay.us.comps[0]._source).toBe('ebay-sold');
  });

  test('handles missing ebay / null comps / non-array comps without throwing', () => {
    expect(() => redactCompsForPublic({}, false)).not.toThrow();
    expect(() => redactCompsForPublic({ ebay: null }, false)).not.toThrow();
    expect(() => redactCompsForPublic({ ebay: { us: null } }, false)).not.toThrow();
    expect(() => redactCompsForPublic({ ebay: { us: { comps: null } } }, false)).not.toThrow();
    expect(() => redactCompsForPublic({ ebay: { us: { comps: 'not-an-array' } } }, false)).not.toThrow();
  });

  test('returns the same object reference (for chaining inside res.json(...))', () => {
    const resp = { ebay: { us: { comps: [mkComp()] } } };
    const out = redactCompsForPublic(resp, false);
    expect(out).toBe(resp);
  });

  test('returns input unchanged when given null / non-object', () => {
    expect(redactCompsForPublic(null, false)).toBeNull();
    expect(redactCompsForPublic(undefined, false)).toBeUndefined();
    expect(redactCompsForPublic(42, false)).toBe(42);
  });
});

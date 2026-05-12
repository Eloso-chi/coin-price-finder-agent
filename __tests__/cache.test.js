/**
 * cache.test.js — Unit tests for src/utils/cache.js (TTLCache)
 *
 * Covers: get/set, TTL expiration, per-key TTL override, has(),
 * delete(), clear(), prune(), size, file persistence round-trip,
 * and corrupt-file resilience.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TTLCache } = require('../src/utils/cache');

// ── Helpers ─────────────────────────────────────────────────
function tmpFile(name) {
  return path.join(os.tmpdir(), `cache-test-${name}-${Date.now()}.json`);
}

function cleanup(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════
//  Basic in-memory operations
// ═══════════════════════════════════════════════════════════════

describe('TTLCache — in-memory', () => {
  test('get/set round-trip', () => {
    const c = new TTLCache({ defaultTTL: 60_000 });
    c.set('foo', 42);
    expect(c.get('foo')).toBe(42);
  });

  test('get returns undefined for missing key', () => {
    const c = new TTLCache();
    expect(c.get('nope')).toBeUndefined();
  });

  test('has() returns true for live key, false for missing', () => {
    const c = new TTLCache({ defaultTTL: 60_000 });
    c.set('a', 1);
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
  });

  test('delete() removes key', () => {
    const c = new TTLCache({ defaultTTL: 60_000 });
    c.set('x', 'val');
    c.delete('x');
    expect(c.get('x')).toBeUndefined();
    expect(c.has('x')).toBe(false);
  });

  test('clear() removes all keys', () => {
    const c = new TTLCache({ defaultTTL: 60_000 });
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(c.size).toBe(0);
  });

  test('size reflects live entries only', () => {
    const c = new TTLCache({ defaultTTL: 60_000 });
    c.set('a', 1);
    c.set('b', 2);
    expect(c.size).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
//  TTL expiration
// ═══════════════════════════════════════════════════════════════

describe('TTLCache — TTL expiration', () => {
  test('expired key returns undefined', () => {
    const c = new TTLCache({ defaultTTL: 1 }); // 1ms TTL
    c.set('fast', 'gone');
    // Force expiry by advancing past the 1ms TTL
    const entry = c._store.get('fast');
    entry.exp = Date.now() - 1;
    expect(c.get('fast')).toBeUndefined();
  });

  test('per-key TTL overrides default', () => {
    const c = new TTLCache({ defaultTTL: 60_000 });
    c.set('short', 'val', 1); // 1ms per-key TTL
    const entry = c._store.get('short');
    entry.exp = Date.now() - 1; // ensure expired
    expect(c.get('short')).toBeUndefined();

    // Regular key should still be alive
    c.set('long', 'val');
    expect(c.get('long')).toBe('val');
  });

  test('prune() evicts expired entries', () => {
    const c = new TTLCache({ defaultTTL: 60_000 });
    c.set('alive', 1);
    c.set('dead', 2);
    // Manually expire 'dead'
    c._store.get('dead').exp = Date.now() - 1;
    c.prune();
    expect(c._store.has('dead')).toBe(false);
    expect(c._store.has('alive')).toBe(true);
  });

  test('size auto-prunes expired entries', () => {
    const c = new TTLCache({ defaultTTL: 60_000 });
    c.set('a', 1);
    c.set('b', 2);
    c._store.get('b').exp = Date.now() - 1;
    expect(c.size).toBe(1);
  });

  test('has() returns false for expired key', () => {
    const c = new TTLCache({ defaultTTL: 60_000 });
    c.set('x', 1);
    c._store.get('x').exp = Date.now() - 1;
    expect(c.has('x')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
//  File persistence
// ═══════════════════════════════════════════════════════════════

describe('TTLCache — file persistence', () => {
  test('constructor loads from existing file', () => {
    const fp = tmpFile('load');
    const futureExp = Date.now() + 60_000;
    fs.writeFileSync(fp, JSON.stringify({
      key1: { val: 'hello', exp: futureExp },
      key2: { val: 42, exp: futureExp },
    }));
    const c = new TTLCache({ filePath: fp });
    expect(c.get('key1')).toBe('hello');
    expect(c.get('key2')).toBe(42);
    cleanup(fp);
  });

  test('constructor skips expired entries from file', () => {
    const fp = tmpFile('expired');
    fs.writeFileSync(fp, JSON.stringify({
      live: { val: 'ok', exp: Date.now() + 60_000 },
      dead: { val: 'gone', exp: Date.now() - 1000 },
    }));
    const c = new TTLCache({ filePath: fp });
    expect(c.get('live')).toBe('ok');
    expect(c.get('dead')).toBeUndefined();
    cleanup(fp);
  });

  test('corrupt file is handled gracefully (empty cache)', () => {
    const fp = tmpFile('corrupt');
    fs.writeFileSync(fp, '{{{{not json!!!!');
    const c = new TTLCache({ filePath: fp });
    expect(c.size).toBe(0);
    cleanup(fp);
  });

  test('missing file is handled gracefully', () => {
    const fp = tmpFile('missing');
    cleanup(fp); // ensure it doesn't exist
    const c = new TTLCache({ filePath: fp });
    expect(c.size).toBe(0);
  });

  test('set() triggers debounced file write', async () => {
    jest.useFakeTimers();
    const fp = tmpFile('write');
    cleanup(fp);
    const c = new TTLCache({ filePath: fp, defaultTTL: 60_000 });
    c.set('persisted', 'value');
    jest.advanceTimersByTime(600);
    jest.useRealTimers();
    // Allow the async fs.writeFile callback to flush
    await new Promise(r => setTimeout(r, 50));
    expect(fs.existsSync(fp)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    expect(raw.persisted.val).toBe('value');
    cleanup(fp);
  });

  test('delete() triggers file write', async () => {
    jest.useFakeTimers();
    const fp = tmpFile('delete');
    const futureExp = Date.now() + 60_000;
    fs.writeFileSync(fp, JSON.stringify({
      a: { val: 1, exp: futureExp },
      b: { val: 2, exp: futureExp },
    }));
    const c = new TTLCache({ filePath: fp });
    c.delete('a');
    jest.advanceTimersByTime(600);
    jest.useRealTimers();
    await new Promise(r => setTimeout(r, 50));
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    expect(raw.a).toBeUndefined();
    expect(raw.b.val).toBe(2);
    cleanup(fp);
  });

  test('clear() triggers file write', async () => {
    jest.useFakeTimers();
    const fp = tmpFile('clear');
    fs.writeFileSync(fp, JSON.stringify({
      x: { val: 1, exp: Date.now() + 60_000 },
    }));
    const c = new TTLCache({ filePath: fp });
    c.clear();
    jest.advanceTimersByTime(600);
    jest.useRealTimers();
    await new Promise(r => setTimeout(r, 50));
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    expect(Object.keys(raw).length).toBe(0);
    cleanup(fp);
  });
});

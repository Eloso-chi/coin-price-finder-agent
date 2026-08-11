'use strict';

jest.mock('../src/utils/cosmosClient', () => ({
  isEnabled: jest.fn(),
  ensureContainer: jest.fn(),
  container: jest.fn(),
}));

jest.mock('../src/utils/cachePath', () => ({
  CACHE_DIR: require('path').join(require('os').tmpdir(), 'coin-valuation-audit-test'),
}));

const fs = require('fs');
const path = require('path');
const cosmos = require('../src/utils/cosmosClient');
const { CACHE_DIR } = require('../src/utils/cachePath');
const auditService = require('../src/services/auditService');

const originalNodeEnv = process.env.NODE_ENV;
const event = {
  query: '1881-CC Morgan Dollar MS64',
  fmv: 835,
  method: 'sold-data',
  confidence: 82,
  algorithmVersion: '1.0.0',
  configVersion: `sha256:${'a'.repeat(64)}`,
  computedAt: '2026-08-11T12:34:56.000Z',
  requestId: 'request-123',
};

function fallbackPath() {
  return path.join(CACHE_DIR, 'valuation-audit-2026-08-11.jsonl');
}

describe('valuation audit persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    auditService._resetForTests();
    process.env.NODE_ENV = 'production';
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  });

  test('writes a versioned record to the valuation Cosmos container', async () => {
    const create = jest.fn().mockResolvedValue({});
    cosmos.isEnabled.mockReturnValue(true);
    cosmos.ensureContainer.mockResolvedValue(undefined);
    cosmos.container.mockReturnValue({ items: { create } });

    await auditService.writeValuationAudit(event);

    expect(cosmos.ensureContainer).toHaveBeenCalledWith('valuation-audit', '/computedAtDate', {
      defaultTtl: 7776000,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      query: event.query,
      fmv: 835,
      computedAtDate: '2026-08-11',
      algorithmVersion: '1.0.0',
      requestId: 'request-123',
    }));
    expect(fs.existsSync(fallbackPath())).toBe(false);
  });

  test('uses daily JSONL fallback when Cosmos is disabled', async () => {
    cosmos.isEnabled.mockReturnValue(false);

    await auditService.writeValuationAudit(event);

    const lines = fs.readFileSync(fallbackPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(expect.objectContaining({
      query: event.query,
      fmv: 835,
      computedAtDate: '2026-08-11',
    }));
  });

  test('falls back to JSONL when Cosmos write fails', async () => {
    cosmos.isEnabled.mockReturnValue(true);
    cosmos.ensureContainer.mockResolvedValue(undefined);
    cosmos.container.mockReturnValue({
      items: { create: jest.fn().mockRejectedValue(new Error('unavailable')) },
    });

    await expect(auditService.writeValuationAudit(event)).resolves.toBe(true);
    expect(fs.existsSync(fallbackPath())).toBe(true);
  });

  test('attempts a failed local fallback once and rate-limits warnings', async () => {
    cosmos.isEnabled.mockReturnValue(false);
    const append = jest.spyOn(fs.promises, 'appendFile').mockRejectedValue(new Error('disk full'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await auditService.writeValuationAudit(event);
    await auditService.writeValuationAudit({ ...event, query: 'second' });

    expect(append).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    append.mockRestore();
    warn.mockRestore();
  });

  test('prunes fallback files older than 90 days', async () => {
    const expired = path.join(CACHE_DIR, 'valuation-audit-2026-05-01.jsonl');
    const retained = path.join(CACHE_DIR, 'valuation-audit-2026-08-01.jsonl');
    fs.writeFileSync(expired, '{}\n');
    fs.writeFileSync(retained, '{}\n');

    await auditService._pruneValuationFallbacks(event.computedAt);

    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(retained)).toBe(true);
  });

  test('drains queued writes in order', async () => {
    cosmos.isEnabled.mockReturnValue(false);
    const writes = [event, { ...event, query: 'second' }, { ...event, query: 'third' }]
      .map(value => auditService.writeValuationAudit(value));

    await auditService.drainValuationAudits();
    await Promise.all(writes);

    const records = fs.readFileSync(fallbackPath(), 'utf8').trim().split('\n').map(JSON.parse);
    expect(records.map(record => record.query)).toEqual([event.query, 'second', 'third']);
  });

  test('seals admission and drains work already accepted', async () => {
    cosmos.isEnabled.mockReturnValue(false);
    const accepted = auditService.writeValuationAudit(event);
    const draining = auditService.closeAndDrainValuationAudits();
    await expect(auditService.writeValuationAudit({ ...event, query: 'late' })).resolves.toBe(false);
    await draining;
    await expect(accepted).resolves.toBe(true);

    const records = fs.readFileSync(fallbackPath(), 'utf8').trim().split('\n').map(JSON.parse);
    expect(records.map(record => record.query)).toEqual([event.query]);
  });

  test('drops records above the bounded queue capacity', async () => {
    let releaseFirst;
    const create = jest.fn()
      .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }))
      .mockResolvedValue({});
    cosmos.isEnabled.mockReturnValue(true);
    cosmos.ensureContainer.mockResolvedValue(undefined);
    cosmos.container.mockReturnValue({ items: { create } });

    const writes = Array.from({ length: 2001 }, (_, index) =>
      auditService.writeValuationAudit({ ...event, query: `query-${index}` }));

    await expect(writes[2000]).resolves.toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    releaseFirst({});
    await auditService.drainValuationAudits();
    await expect(Promise.all(writes.slice(0, 2000))).resolves.toEqual(
      expect.arrayContaining([true]),
    );
    expect(create).toHaveBeenCalledTimes(2000);
  });

  test('omits actor and IP for anonymous requests', () => {
    const anonymous = auditService._buildValuationAuditRecord({ ...event, ip: '203.0.113.10' });
    const admin = auditService._buildValuationAuditRecord({
      ...event,
      actorId: 'admin-1',
      ip: '203.0.113.10',
    });

    expect(anonymous).not.toHaveProperty('actorId');
    expect(anonymous).not.toHaveProperty('ip');
    expect(admin).toMatchObject({ actorId: 'admin-1', ip: '203.0.113.10' });
  });

  test('is a no-op in the test environment', async () => {
    process.env.NODE_ENV = 'test';
    cosmos.isEnabled.mockReturnValue(false);

    await auditService.writeValuationAudit(event);

    expect(cosmos.isEnabled).not.toHaveBeenCalled();
    expect(fs.existsSync(fallbackPath())).toBe(false);
  });
});
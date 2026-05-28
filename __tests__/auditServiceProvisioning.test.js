// __tests__/auditServiceProvisioning.test.js
//
// Covers the lazy Cosmos `admin-audit` container provisioning added in PR #61:
//   * ensureContainer is awaited before items.create
//   * concurrent first-call audits share one in-flight provisioning promise
//   * transient failures (e.g. 429) reset the promise so the next caller retries
//   * permanent failures (404/403/etc.) latch a disabled flag so we stop
//     issuing both ensureContainer and items.create on every subsequent call
//   * stdout emission happens regardless of Cosmos availability
//
// Strategy: mock `src/utils/cosmosClient` so we can drive isEnabled,
// ensureContainer, and container().items.create() deterministically.

'use strict';

// Hoisted-aware mock. jest.mock() is hoisted above the require below.
jest.mock('../src/utils/cosmosClient', () => {
  return {
    isEnabled: jest.fn(),
    ensureContainer: jest.fn(),
    container: jest.fn(),
  };
});

const cosmos = require('../src/utils/cosmosClient');
const audit = require('../src/services/auditService');

function makeContainerStub() {
  const create = jest.fn().mockResolvedValue({});
  return { items: { create }, _create: create };
}

describe('auditService: cosmos container provisioning', () => {
  let warnSpy;
  let infoSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    audit._resetForTests();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  test('stdout emission always fires, including when Cosmos is disabled', async () => {
    cosmos.isEnabled.mockReturnValue(false);
    await audit.audit({ action: 'test-action', actor: { username: 'alice' } });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toMatch(/\[admin-audit\]/);
    expect(cosmos.ensureContainer).not.toHaveBeenCalled();
    expect(cosmos.container).not.toHaveBeenCalled();
  });

  test('ensureContainer is awaited before items.create on first audit', async () => {
    const order = [];
    cosmos.isEnabled.mockReturnValue(true);
    cosmos.ensureContainer.mockImplementation(async () => {
      order.push('ensure');
    });
    const stub = makeContainerStub();
    stub._create.mockImplementation(async () => { order.push('create'); });
    cosmos.container.mockReturnValue(stub);

    await audit.audit({ action: 'test', actor: { username: 'alice' } });

    expect(order).toEqual(['ensure', 'create']);
    expect(cosmos.ensureContainer).toHaveBeenCalledWith('admin-audit', '/actorUsername');
    expect(stub._create).toHaveBeenCalledTimes(1);
  });

  test('concurrent first-call audits share one in-flight ensureContainer', async () => {
    cosmos.isEnabled.mockReturnValue(true);
    let resolveEnsure;
    cosmos.ensureContainer.mockImplementation(() => new Promise(r => { resolveEnsure = r; }));
    const stub = makeContainerStub();
    cosmos.container.mockReturnValue(stub);

    const a = audit.audit({ action: 'a', actor: { username: 'u1' } });
    const b = audit.audit({ action: 'b', actor: { username: 'u2' } });
    const c = audit.audit({ action: 'c', actor: { username: 'u3' } });

    // Give all three a chance to enter the cosmos branch.
    await Promise.resolve();
    expect(cosmos.ensureContainer).toHaveBeenCalledTimes(1);

    resolveEnsure();
    await Promise.all([a, b, c]);

    expect(cosmos.ensureContainer).toHaveBeenCalledTimes(1);
    expect(stub._create).toHaveBeenCalledTimes(3);
  });

  test('transient ensureContainer failure (429) resets promise so next caller retries', async () => {
    cosmos.isEnabled.mockReturnValue(true);
    const err429 = Object.assign(new Error('Too Many Requests'), { code: 429 });
    cosmos.ensureContainer
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce(undefined);
    const stub = makeContainerStub();
    cosmos.container.mockReturnValue(stub);

    await audit.audit({ action: 'first', actor: { username: 'alice' } });
    expect(cosmos.ensureContainer).toHaveBeenCalledTimes(1);
    expect(stub._create).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Next audit should re-attempt ensureContainer (transient -> not latched).
    await audit.audit({ action: 'second', actor: { username: 'alice' } });
    expect(cosmos.ensureContainer).toHaveBeenCalledTimes(2);
    expect(stub._create).toHaveBeenCalledTimes(1);
  });

  test('permanent ensureContainer failure (404) latches: no more ensureContainer or items.create', async () => {
    cosmos.isEnabled.mockReturnValue(true);
    const err404 = Object.assign(new Error('Not Found'), { code: 404 });
    cosmos.ensureContainer.mockRejectedValue(err404);
    const stub = makeContainerStub();
    cosmos.container.mockReturnValue(stub);

    await audit.audit({ action: 'first', actor: { username: 'alice' } });
    await audit.audit({ action: 'second', actor: { username: 'alice' } });
    await audit.audit({ action: 'third', actor: { username: 'alice' } });

    // Provisioning attempted exactly once; latch keeps subsequent calls quiet.
    expect(cosmos.ensureContainer).toHaveBeenCalledTimes(1);
    expect(stub._create).not.toHaveBeenCalled();
    // Warn only emitted once across all three calls.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // stdout audit emission still fires for every event.
    expect(infoSpy).toHaveBeenCalledTimes(3);
  });

  test('permanent items.create failure (403) also latches', async () => {
    cosmos.isEnabled.mockReturnValue(true);
    cosmos.ensureContainer.mockResolvedValue(undefined);
    const stub = makeContainerStub();
    const err403 = Object.assign(new Error('Forbidden'), { code: 403 });
    stub._create.mockRejectedValueOnce(err403).mockResolvedValue({});
    cosmos.container.mockReturnValue(stub);

    await audit.audit({ action: 'one', actor: { username: 'alice' } });
    await audit.audit({ action: 'two', actor: { username: 'alice' } });

    // After the 403 latch, the second audit must NOT call items.create.
    expect(stub._create).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('audit never throws even when Cosmos rejects synchronously inside container()', async () => {
    cosmos.isEnabled.mockReturnValue(true);
    cosmos.ensureContainer.mockResolvedValue(undefined);
    cosmos.container.mockImplementation(() => { throw new Error('boom'); });

    await expect(
      audit.audit({ action: 'boom', actor: { username: 'alice' } })
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

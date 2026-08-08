'use strict';

const mockFetchAll = jest.fn();
const mockRead = jest.fn();
const mockPatch = jest.fn(() => Promise.resolve());
const mockCreate = jest.fn(() => Promise.resolve());

jest.mock('../src/utils/cosmosClient', () => ({
  isEnabled: jest.fn(() => true),
  container: jest.fn(() => ({
    items: {
      query: jest.fn(() => ({ fetchAll: mockFetchAll })),
      create: mockCreate,
    },
    item: jest.fn(() => ({ read: mockRead, patch: mockPatch })),
  })),
}));

const terapeakService = require('../src/services/terapeakService');

describe('hydrateMetaFromCosmos dormancy metadata', () => {
  const searchTerm = '__test_cosmos_dormancy_only__';
  const key = terapeakService.normalizeSearchKey(searchTerm);

  afterEach(() => {
    terapeakService.deleteDataset(key);
    terapeakService._resetStoreCache();
    jest.clearAllMocks();
  });

  test('hydrates a document containing only no-data markers', async () => {
    mockFetchAll.mockResolvedValue({
      resources: [{
        id: key,
        searchTerm,
        aggregationMeta: {
          noDataCount: 2,
          noDataAt: '2026-08-07T12:00:00Z',
        },
      }],
    });

    const result = await terapeakService.hydrateMetaFromCosmos();
    const dataset = terapeakService.listDatasets().find(item => item.key === key);

    expect(result).toEqual({ hydrated: 1 });
    expect(dataset).toEqual(expect.objectContaining({
      aggregationMeta: expect.objectContaining({
        noDataCount: 2,
        noDataAt: '2026-08-07T12:00:00Z',
      }),
    }));
  });

  test('patches no-data metadata without replacing remote comps', async () => {
    mockRead.mockResolvedValue({
      resource: {
        _etag: 'etag-1',
        comps: [{ itemId: 'remote-comp' }],
        aggregationMeta: { compCount: 1 },
      },
    });
    const result = terapeakService.updateDatasetMeta(searchTerm, {
      noDataCount: 2,
      noDataAt: '2026-08-07T12:00:00Z',
    });
    await result.persistence;

    expect(result.aggregationMeta).toEqual(expect.objectContaining({ noDataCount: 2 }));
    expect(mockPatch).toHaveBeenCalledWith([
      { op: 'set', path: '/aggregationMeta/noDataCount', value: 2 },
      { op: 'set', path: '/aggregationMeta/noDataAt', value: '2026-08-07T12:00:00Z' },
    ], { accessCondition: { type: 'IfMatch', condition: 'etag-1' } });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('creates a metadata-only canonical document when none exists', async () => {
    mockRead.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));

    const result = terapeakService.updateDatasetMeta(searchTerm, {
      noDataCount: 1,
      noDataAt: '2026-08-07T12:00:00Z',
    });
    await result.persistence;

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      id: key,
      searchTerm: key,
      comps: [],
      aggregationMeta: expect.objectContaining({ noDataCount: 1 }),
    }));
    expect(mockPatch).not.toHaveBeenCalled();
  });

  test('surfaces a Cosmos patch failure through the persistence promise', async () => {
    mockRead.mockResolvedValue({
      resource: { _etag: 'etag-1', aggregationMeta: {} },
    });
    mockPatch.mockRejectedValue(new Error('patch failed'));

    const result = terapeakService.updateDatasetMeta(searchTerm, {
      noDataCount: 2,
      noDataAt: '2026-08-07T12:00:00Z',
    });

    await expect(result.persistence).rejects.toThrow('patch failed');
  });
});
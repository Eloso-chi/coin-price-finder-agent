'use strict';

const mockFetchAll = jest.fn();
const mockUpsert = jest.fn(() => Promise.resolve());

jest.mock('../src/utils/cosmosClient', () => ({
  isEnabled: jest.fn(() => true),
  container: jest.fn(() => ({
    items: {
      query: jest.fn(() => ({ fetchAll: mockFetchAll })),
      upsert: mockUpsert,
    },
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

  test('writes no-data metadata through to Cosmos', () => {
    const result = terapeakService.updateDatasetMeta(searchTerm, {
      noDataCount: 2,
      noDataAt: '2026-08-07T12:00:00Z',
    });

    expect(result.aggregationMeta).toEqual(expect.objectContaining({ noDataCount: 2 }));
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({
      id: key,
      searchTerm: key,
      aggregationMeta: expect.objectContaining({
        noDataCount: 2,
        noDataAt: '2026-08-07T12:00:00Z',
      }),
    }));
  });
});
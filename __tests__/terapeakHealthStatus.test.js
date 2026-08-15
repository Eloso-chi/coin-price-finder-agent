'use strict';

const terapeak = require('../src/services/terapeakService');

describe('Terapeak health status', () => {
  test('reports the unloaded state without cold-loading the dataset store', () => {
    terapeak._resetStoreCache();

    expect(terapeak.getHealthStatus()).toEqual({
      status: 'degraded',
      lastSuccess: null,
      datasetCount: null,
    });

    expect(terapeak.getHealthStatus().datasetCount).toBeNull();
  });
});
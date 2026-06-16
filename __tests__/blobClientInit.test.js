// __tests__/blobClientInit.test.js -- env-gated init for src/utils/blobClient
//
// Covers:
//   - isEnabled() returns false when TERAPEAK_BLOB_ACCOUNT or TERAPEAK_BLOB_CONTAINER is missing
//   - empty-string env vars are treated as unset
//   - listBlobs / downloadBlob / uploadBlob return safe no-op values when disabled
//   - getContainerClient() returns null when disabled
//   - When enabled, the blob URL is composed from the account env var
//
// Note: blobClient captures env vars at module load time (top-level consts),
// so each test loads the module fresh via jest.isolateModules().
'use strict';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
});

function loadFresh(envOverrides = {}) {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.TERAPEAK_BLOB_ACCOUNT;
  delete process.env.TERAPEAK_BLOB_CONTAINER;
  Object.assign(process.env, envOverrides);

  // Capture the URL passed to BlobServiceClient
  let capturedUrl = null;
  let capturedContainerName = null;

  let mod;
  jest.isolateModules(() => {
    jest.doMock('@azure/storage-blob', () => {
      const blockBlob = {
        upload: jest.fn().mockResolvedValue({ requestId: 'mock-req' }),
      };
      const blobClient = {
        download: jest.fn().mockResolvedValue({
          readableStreamBody: (async function* () {
            yield Buffer.from('hello,world\n1,2\n', 'utf8');
          })(),
        }),
      };
      const containerClient = {
        listBlobsFlat: jest.fn().mockImplementation(() => (async function* () {
          yield {
            name: 'a.csv',
            properties: { contentLength: 10, lastModified: new Date('2026-01-01') },
          };
          yield {
            name: 'b.csv',
            properties: { contentLength: 20, lastModified: new Date('2026-01-02') },
          };
        })()),
        getBlobClient: jest.fn().mockReturnValue(blobClient),
        getBlockBlobClient: jest.fn().mockReturnValue(blockBlob),
      };
      const BlobServiceClient = jest.fn().mockImplementation((url) => {
        capturedUrl = url;
        return {
          getContainerClient: jest.fn().mockImplementation((name) => {
            capturedContainerName = name;
            return containerClient;
          }),
        };
      });
      return { BlobServiceClient };
    });
    jest.doMock('@azure/identity', () => ({
      DefaultAzureCredential: jest.fn().mockImplementation(() => ({ /* token */ })),
    }));
    mod = require('../src/utils/blobClient');
  });
  return { mod, getCapturedUrl: () => capturedUrl, getCapturedContainerName: () => capturedContainerName };
}

describe('blobClient init contract', () => {
  test('isEnabled() returns false when TERAPEAK_BLOB_ACCOUNT is unset', () => {
    const { mod } = loadFresh({ TERAPEAK_BLOB_CONTAINER: 'comps' });
    expect(mod.isEnabled()).toBe(false);
  });

  test('isEnabled() returns false when TERAPEAK_BLOB_CONTAINER is unset', () => {
    const { mod } = loadFresh({ TERAPEAK_BLOB_ACCOUNT: 'acct' });
    expect(mod.isEnabled()).toBe(false);
  });

  test('isEnabled() returns false when both are unset', () => {
    const { mod } = loadFresh({});
    expect(mod.isEnabled()).toBe(false);
  });

  test('isEnabled() returns false when TERAPEAK_BLOB_ACCOUNT is empty', () => {
    const { mod } = loadFresh({ TERAPEAK_BLOB_ACCOUNT: '', TERAPEAK_BLOB_CONTAINER: 'comps' });
    expect(mod.isEnabled()).toBe(false);
  });

  test('isEnabled() returns false when TERAPEAK_BLOB_CONTAINER is empty', () => {
    const { mod } = loadFresh({ TERAPEAK_BLOB_ACCOUNT: 'acct', TERAPEAK_BLOB_CONTAINER: '' });
    expect(mod.isEnabled()).toBe(false);
  });

  test('isEnabled() returns true when both env vars are set', () => {
    const { mod } = loadFresh({ TERAPEAK_BLOB_ACCOUNT: 'acct', TERAPEAK_BLOB_CONTAINER: 'comps' });
    expect(mod.isEnabled()).toBe(true);
  });

  test('getContainerClient() returns null when disabled', () => {
    const { mod } = loadFresh({});
    expect(mod.getContainerClient()).toBeNull();
  });

  test('getContainerClient() composes URL from TERAPEAK_BLOB_ACCOUNT', () => {
    const { mod, getCapturedUrl } = loadFresh({
      TERAPEAK_BLOB_ACCOUNT: 'myacct',
      TERAPEAK_BLOB_CONTAINER: 'comps',
    });
    mod.getContainerClient();
    expect(getCapturedUrl()).toBe('https://myacct.blob.core.windows.net');
  });

  test('getContainerClient() uses TERAPEAK_BLOB_CONTAINER name', () => {
    const { mod, getCapturedContainerName } = loadFresh({
      TERAPEAK_BLOB_ACCOUNT: 'myacct',
      TERAPEAK_BLOB_CONTAINER: 'csv-uploads',
    });
    mod.getContainerClient();
    expect(getCapturedContainerName()).toBe('csv-uploads');
  });

  test('listBlobs() returns [] when disabled (no throw)', async () => {
    const { mod } = loadFresh({});
    await expect(mod.listBlobs()).resolves.toEqual([]);
    await expect(mod.listBlobs('prefix/')).resolves.toEqual([]);
  });

  test('listBlobs() returns blob metadata when enabled', async () => {
    const { mod } = loadFresh({
      TERAPEAK_BLOB_ACCOUNT: 'acct',
      TERAPEAK_BLOB_CONTAINER: 'comps',
    });
    const blobs = await mod.listBlobs('');
    expect(blobs).toHaveLength(2);
    expect(blobs[0]).toEqual({
      name: 'a.csv',
      contentLength: 10,
      lastModified: new Date('2026-01-01'),
    });
    expect(blobs[1].name).toBe('b.csv');
  });

  test('downloadBlob() returns null when disabled', async () => {
    const { mod } = loadFresh({});
    await expect(mod.downloadBlob('any.csv')).resolves.toBeNull();
  });

  test('downloadBlob() concatenates stream chunks to utf8 string when enabled', async () => {
    const { mod } = loadFresh({
      TERAPEAK_BLOB_ACCOUNT: 'acct',
      TERAPEAK_BLOB_CONTAINER: 'comps',
    });
    const content = await mod.downloadBlob('a.csv');
    expect(content).toBe('hello,world\n1,2\n');
  });

  test('uploadBlob() returns null when disabled', async () => {
    const { mod } = loadFresh({});
    await expect(mod.uploadBlob('a.csv', 'data')).resolves.toBeNull();
  });

  test('uploadBlob() returns name+size when enabled', async () => {
    const { mod } = loadFresh({
      TERAPEAK_BLOB_ACCOUNT: 'acct',
      TERAPEAK_BLOB_CONTAINER: 'comps',
    });
    const out = await mod.uploadBlob('upload.csv', 'a,b\n1,2\n');
    expect(out).toEqual({ name: 'upload.csv', size: Buffer.byteLength('a,b\n1,2\n', 'utf8') });
  });
});

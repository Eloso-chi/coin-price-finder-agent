// src/utils/blobClient.js — Azure Blob Storage client (env-var gated)
// Only activates when TERAPEAK_BLOB_ACCOUNT + TERAPEAK_BLOB_CONTAINER are set.
// Uses DefaultAzureCredential (managed identity in prod, az login locally).
'use strict';

const ACCOUNT = process.env.TERAPEAK_BLOB_ACCOUNT;
const CONTAINER = process.env.TERAPEAK_BLOB_CONTAINER;

let _containerClient = null;

function isEnabled() {
  return !!(ACCOUNT && CONTAINER);
}

function getContainerClient() {
  if (_containerClient) return _containerClient;
  if (!isEnabled()) return null;

  const { BlobServiceClient } = require('@azure/storage-blob');
  const { DefaultAzureCredential } = require('@azure/identity');

  const url = `https://${ACCOUNT}.blob.core.windows.net`;
  const blobService = new BlobServiceClient(url, new DefaultAzureCredential());
  _containerClient = blobService.getContainerClient(CONTAINER);
  return _containerClient;
}

/**
 * List all blobs matching an optional prefix (e.g. '' for all CSVs).
 * Returns array of { name, contentLength, lastModified }.
 */
async function listBlobs(prefix = '') {
  const client = getContainerClient();
  if (!client) return [];

  const results = [];
  for await (const blob of client.listBlobsFlat({ prefix })) {
    results.push({
      name: blob.name,
      contentLength: blob.properties.contentLength,
      lastModified: blob.properties.lastModified,
    });
  }
  return results;
}

/**
 * Download a blob as a UTF-8 string.
 */
async function downloadBlob(blobName) {
  const client = getContainerClient();
  if (!client) return null;

  const blobClient = client.getBlobClient(blobName);
  const resp = await blobClient.download(0);
  const chunks = [];
  for await (const chunk of resp.readableStreamBody) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Upload a string as a blob (overwrite if exists).
 */
async function uploadBlob(blobName, content) {
  const client = getContainerClient();
  if (!client) return null;

  const blockBlob = client.getBlockBlobClient(blobName);
  await blockBlob.upload(content, Buffer.byteLength(content, 'utf8'), {
    blobHTTPHeaders: { blobContentType: 'text/csv' },
  });
  return { name: blobName, size: Buffer.byteLength(content, 'utf8') };
}

module.exports = { isEnabled, listBlobs, downloadBlob, uploadBlob, getContainerClient };

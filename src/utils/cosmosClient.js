// src/utils/cosmosClient.js -- Shared Azure Cosmos DB client singleton
// Returns null when COSMOS_ENDPOINT is not configured (falls back to file storage).
// CommonJS

'use strict';

let _client = null;
let _db = null;
let _enabled = false;

function init() {
  if (_client) return;
  const endpoint = process.env.COSMOS_ENDPOINT;
  const key = process.env.COSMOS_KEY;
  const dbName = process.env.COSMOS_DB || 'coinprice';

  if (!endpoint || !key) return;

  const { CosmosClient } = require('@azure/cosmos');
  _client = new CosmosClient({ endpoint, key });
  _db = _client.database(dbName);
  _enabled = true;
}

function isEnabled() {
  if (!_enabled && !_client) init();
  return _enabled;
}

function container(name) {
  if (!_enabled && !_client) init();
  if (!_db) throw new Error('Cosmos DB not configured');
  return _db.container(name);
}

module.exports = { isEnabled, container };

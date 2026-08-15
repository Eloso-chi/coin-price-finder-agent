'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_SOURCES = [
  path.join(__dirname, '..', 'services', 'valuationService.js'),
  path.join(__dirname, '..', 'data', 'dealerPremiums.js'),
  path.join(__dirname, '..', 'data', 'greysheetTypeMap.js'),
];

let cachedConfigVersion;

function normalizeSource(contents) {
  return contents.toString('utf8').replace(/\r\n/g, '\n');
}

function getConfigVersion() {
  if (cachedConfigVersion) return cachedConfigVersion;

  const hash = crypto.createHash('sha256');
  for (const file of CONFIG_SOURCES) {
    hash.update(path.basename(file));
    hash.update('\0');
    hash.update(normalizeSource(fs.readFileSync(file)));
    hash.update('\0');
  }
  cachedConfigVersion = `sha256:${hash.digest('hex')}`;
  return cachedConfigVersion;
}

module.exports = { getConfigVersion, normalizeSource };
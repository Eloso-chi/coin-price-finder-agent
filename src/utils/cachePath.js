// src/utils/cachePath.js — Centralized cache directory resolution
// All services that read/write to cache/ should import CACHE_DIR from here.
//
// On Azure App Service, set CACHE_DIR to the Azure Files mount path
// (e.g. /home/site/cache) so data persists across deploys and restarts.
// Locally, defaults to the project-level ./cache folder.
// CommonJS

'use strict';

const fs   = require('fs');
const path = require('path');

const CACHE_DIR = process.env.CACHE_DIR
  || path.resolve(__dirname, '..', '..', 'cache');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

module.exports = { CACHE_DIR };

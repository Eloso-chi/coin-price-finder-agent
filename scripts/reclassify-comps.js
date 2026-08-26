#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const CACHE_DIR = require('../src/utils/cachePath').CACHE_DIR;
const { weightToKeyToken } = require('../src/utils/coinMetalProfile');
const pcgsService = require('../src/services/pcgsService');
const {
  resolveProductIdentity,
  findIdentityMismatches,
  PRODUCT_IDENTITY_PARSER_VERSION,
} = require('../src/utils/productIdentityResolver');

const DEFAULT_STORE_PATH = path.join(CACHE_DIR, 'terapeak_sold.json');
const DEFAULT_OUTPUT_DIR = path.join(__dirname, '..', '.local', 'reclassification');

function parseArgs(argv) {
  const valueAfter = flag => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : null;
  };
  return {
    apply: argv.includes('--apply'),
    storePath: path.resolve(valueAfter('--store') || DEFAULT_STORE_PATH),
    outputDir: path.resolve(valueAfter('--output-dir') || DEFAULT_OUTPUT_DIR),
  };
}

function classifyComp(datasetKey, comp) {
  const expected = resolveProductIdentity({ text: datasetKey, parsed: pcgsService.parseDescription(datasetKey) });
  return classifyCompAgainstIdentity(datasetKey, expected, comp);
}

function classifyCompAgainstIdentity(datasetKey, expected, comp) {
  const actual = resolveProductIdentity({ text: comp.title, parsed: pcgsService.parseDescription(comp.title) });
  if (actual.ambiguous) return { status: 'ambiguous', expected, actual, targetKey: null };
  const mismatches = findIdentityMismatches(expected, actual);
  if (mismatches.some(field => field !== 'weight')) {
    return { status: 'wrong_dataset', expected, actual, mismatches, targetKey: null };
  }
  if (expected.nominalWeightOz == null || actual.nominalWeightOz == null) {
    return { status: 'unknown', expected, actual, targetKey: null };
  }
  if (!mismatches.includes('weight')) return { status: 'valid', expected, actual, targetKey: null };

  const currentToken = weightToKeyToken(expected.nominalWeightOz);
  const targetToken = weightToKeyToken(actual.nominalWeightOz);
  const targetKey = currentToken && targetToken
    ? datasetKey.replace(currentToken, targetToken)
    : null;
  return { status: 'wrong_dataset', expected, actual, mismatches, targetKey: targetKey !== datasetKey ? targetKey : null };
}

function analyzeStore(inputStore) {
  const store = JSON.parse(JSON.stringify(inputStore));
  const counts = { valid: 0, wrong_dataset: 0, ambiguous: 0, unknown: 0 };
  const routes = {};
  const rollback = [];
  const reroutes = {};

  for (const [datasetKey, dataset] of Object.entries(store)) {
    if (!Array.isArray(dataset?.comps)) continue;
    const expected = resolveProductIdentity({ text: datasetKey, parsed: pcgsService.parseDescription(datasetKey) });
    const keep = [];
    dataset.comps.forEach((comp, index) => {
      const classification = classifyCompAgainstIdentity(datasetKey, expected, comp);
      counts[classification.status]++;
      if (classification.status === 'valid' || classification.status === 'unknown') {
        keep.push({
          ...comp,
          _productIdentity: publicIdentity(classification.actual),
        });
        return;
      }

      rollback.push({ datasetKey, index, classification: classification.status, comp });
      if (classification.status === 'wrong_dataset' && classification.targetKey) {
        if (!reroutes[classification.targetKey]) reroutes[classification.targetKey] = [];
        reroutes[classification.targetKey].push({ ...comp, _productIdentity: publicIdentity(classification.actual) });
        const route = `${datasetKey} -> ${classification.targetKey}`;
        routes[route] = (routes[route] || 0) + 1;
      }
    });
    dataset.comps = keep;
    syncCompCount(dataset);
  }

  for (const [targetKey, comps] of Object.entries(reroutes)) {
    const target = store[targetKey] || {
      searchTerm: targetKey,
      comps: [],
      lastImport: null,
      importCount: 0,
      aggregationMeta: {},
    };
    const existingKeys = new Set(target.comps.map(compDedupKey));
    for (const comp of comps) {
      const key = compDedupKey(comp);
      if (existingKeys.has(key)) continue;
      target.comps.push(comp);
      existingKeys.add(key);
    }
    syncCompCount(target);
    store[targetKey] = target;
  }

  const before = storeSummary(inputStore);
  const after = storeSummary(store);
  return {
    store,
    manifest: {
      parserVersion: PRODUCT_IDENTITY_PARSER_VERSION,
      before,
      after,
      counts,
      routes,
      changed: counts.wrong_dataset + counts.ambiguous,
    },
    rollback: {
      parserVersion: PRODUCT_IDENTITY_PARSER_VERSION,
      sourceStore: null,
      rows: rollback,
    },
  };
}

function compDedupKey(comp) {
  if (comp.itemId) return `id:${comp.itemId}`;
  const title = (comp.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80);
  const cents = Math.round(Number(comp.totalUsd || 0) * 100);
  return `t:${title}|${cents}|${comp.soldDate || ''}`;
}

function publicIdentity(identity) {
  return {
    series: identity.series,
    year: identity.year,
    mint: identity.mint,
    metal: identity.metal,
    nominalWeightOz: identity.nominalWeightOz,
    finish: identity.finish,
    designation: identity.designation,
    pool: identity.pool,
    weightEvidence: identity.weightEvidence,
    parserVersion: identity.parserVersion,
  };
}

function syncCompCount(dataset) {
  if (!dataset.aggregationMeta) dataset.aggregationMeta = {};
  dataset.aggregationMeta.compCount = dataset.comps.length;
}

function storeSummary(store) {
  const datasets = Object.values(store).filter(dataset => Array.isArray(dataset?.comps));
  return {
    datasets: datasets.length,
    comps: datasets.reduce((total, dataset) => total + dataset.comps.length, 0),
  };
}

function artifactPaths(outputDir) {
  return {
    manifestPath: path.join(outputDir, 'identity-reclassification-manifest.json'),
    rollbackPath: path.join(outputDir, 'identity-reclassification-rollback.json'),
    transactionPath: path.join(outputDir, 'identity-reclassification-transaction.json'),
  };
}

function assertDistinctPaths(storePath, paths) {
  const candidates = [storePath, ...Object.values(paths)];
  const values = candidates.map(canonicalPath);
  if (new Set(values).size !== values.length) {
    throw new Error('Store and reclassification artifact paths must be distinct');
  }
  const existingIdentities = candidates.filter(fs.existsSync).map(candidate => {
    const stat = fs.statSync(candidate);
    return `${stat.dev}:${stat.ino}`;
  });
  if (new Set(existingIdentities).size !== existingIdentities.length) {
    throw new Error('Store and reclassification artifact paths must be distinct');
  }
}

function canonicalPath(filePath) {
  const resolved = path.resolve(filePath);
  const canonical = fs.existsSync(resolved)
    ? fs.realpathSync.native(resolved)
    : path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function syncDirectory(directoryPath) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const unsupportedOnWindows = process.platform === 'win32'
      && ['EACCES', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code);
    if (!unsupportedOnWindows) throw error;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function ensureDurableDirectory(directoryPath) {
  const missing = [];
  let current = path.resolve(directoryPath);
  while (!fs.existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fs.mkdirSync(directoryPath, { recursive: true });
  for (const created of missing.reverse()) {
    syncDirectory(path.dirname(created));
  }
}

function writeArtifacts(outputDir, manifest, rollback, storePath) {
  ensureDurableDirectory(outputDir);
  const normalizedRollback = { ...rollback, sourceStore: storePath };
  const paths = artifactPaths(outputDir);
  assertDistinctPaths(storePath, paths);
  atomicWriteJson(paths.manifestPath, manifest, 0o600);
  atomicWriteJson(paths.rollbackPath, normalizedRollback, 0o600);
  return paths;
}

function atomicWriteJson(filePath, value, defaultMode = 0o600) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  let descriptor = null;
  try {
    const mode = fs.existsSync(filePath) ? fs.statSync(filePath).mode & 0o777 : defaultMode;
    descriptor = fs.openSync(tempPath, 'wx', mode);
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    JSON.parse(fs.readFileSync(tempPath, 'utf8'));
    fs.renameSync(tempPath, filePath);
    syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (descriptor != null) fs.closeSync(descriptor);
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const inputStore = JSON.parse(fs.readFileSync(options.storePath, 'utf8'));
  const result = analyzeStore(inputStore);
  const artifacts = writeArtifacts(options.outputDir, result.manifest, result.rollback, options.storePath);
  if (options.apply && result.manifest.changed > 0) {
    atomicWriteJson(artifacts.transactionPath, {
      state: 'pending',
      sourceStore: options.storePath,
      parserVersion: PRODUCT_IDENTITY_PARSER_VERSION,
      manifestPath: artifacts.manifestPath,
      rollbackPath: artifacts.rollbackPath,
    }, 0o600);
    try {
      atomicWriteJson(options.storePath, result.store);
      fs.rmSync(artifacts.transactionPath, { force: true });
      syncDirectory(path.dirname(artifacts.transactionPath));
    } catch (error) {
      throw new Error(
        `Apply failed; transaction marker retained at ${artifacts.transactionPath}: ${error.message}`,
        { cause: error }
      );
    }
  }
  console.log(JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run',
    ...result.manifest,
    ...artifacts,
  }, null, 2));
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Reclassification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  classifyComp,
  analyzeStore,
  artifactPaths,
  assertDistinctPaths,
  canonicalPath,
  syncDirectory,
  ensureDurableDirectory,
  atomicWriteJson,
  main,
};
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { analyzeExplicitWeightSources } = require('../src/utils/explicitWeight');

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : fallback;
}

function loadJson(filePath, required) {
  if (!fs.existsSync(filePath)) {
    if (required) throw new Error(`Required input not found: ${filePath}`);
    return {};
  }
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected a JSON object in ${filePath}`);
  }
  return value;
}

function canonicalPath(filePath) {
  const missing = [];
  let existing = path.resolve(filePath);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const result = path.join(fs.realpathSync.native(existing), ...missing);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

function validatePaths(metaPath, storePath, reportPath, rollbackPath) {
  const inputs = new Set([canonicalPath(metaPath), canonicalPath(storePath)]);
  const report = canonicalPath(reportPath);
  const rollback = canonicalPath(rollbackPath);
  if (inputs.has(report) || inputs.has(rollback)) throw new Error('Output paths must not overwrite meta or store inputs');
  if (report === rollback) throw new Error('Audit and rollback output paths must be distinct');
  if (fs.existsSync(reportPath) || fs.existsSync(rollbackPath)) throw new Error('Output paths must not already exist');
}

function* jsonChunks(value, depth = 0) {
  if (value === null || typeof value !== 'object') {
    yield JSON.stringify(value);
    return;
  }

  const isArray = Array.isArray(value);
  const keys = isArray ? null : Object.keys(value);
  const length = isArray ? value.length : keys.length;
  const open = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';
  if (length === 0) {
    yield `${open}${close}`;
    return;
  }

  yield `${open}\n`;
  for (let index = 0; index < length; index += 1) {
    const key = isArray ? index : keys[index];
    yield `${' '.repeat((depth + 1) * 2)}${isArray ? '' : `${JSON.stringify(key)}: `}`;
    yield* jsonChunks(value[key], depth + 1);
    yield index + 1 < length ? ',\n' : `\n${' '.repeat(depth * 2)}`;
  }
  yield close;
}

function writeJson(fd, value) {
  let chunks = [];
  let bufferedCharacters = 0;
  const flush = () => {
    const buffer = Buffer.from(chunks.join(''), 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
    }
    chunks = [];
    bufferedCharacters = 0;
  };

  for (const chunk of jsonChunks(value)) {
    chunks.push(chunk);
    bufferedCharacters += chunk.length;
    if (bufferedCharacters >= 64 * 1024) flush();
  }
  chunks.push('\n');
  flush();
}

function stageJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600);
    writeJson(descriptor, value);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return tempPath;
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function publishJsonPair(entries) {
  const staged = [];
  const published = [];
  try {
    for (const [filePath, value] of entries) staged.push({ filePath, tempPath: stageJson(filePath, value) });
    for (const { filePath, tempPath } of staged) {
      fs.linkSync(tempPath, filePath);
      published.push(filePath);
    }
  } catch (error) {
    for (const filePath of published.reverse()) if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    throw error;
  } finally {
    for (const { tempPath } of staged) if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function buildAudit(meta, store) {
  const keys = [...new Set([...Object.keys(meta), ...Object.keys(store)])].sort();
  const affected = [];
  for (const key of keys) {
    const metaEntry = meta[key] || null;
    const storeEntry = store[key] || null;
    const searchTerm = storeEntry?.searchTerm || metaEntry?.searchTerm || null;
    const analysis = analyzeExplicitWeightSources(key, searchTerm);
    if (!analysis.invalid && analysis.weights.length <= 1) continue;
    const storeCount = Array.isArray(storeEntry?.comps) ? storeEntry.comps.length : 0;
    const metaCount = Number(metaEntry?.compCount || storeEntry?.aggregationMeta?.compCount || 0);
    affected.push({
      key,
      searchTerm,
      explicitWeights: analysis.weights,
      compCount: Math.max(storeCount, metaCount),
      presentInMeta: !!metaEntry,
      presentInStore: !!storeEntry,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    mode: 'inventory-only',
    sourceKeyCount: keys.length,
    affectedKeyCount: affected.length,
    affectedCompCount: affected.reduce((sum, item) => sum + item.compCount, 0),
    affected,
  };
}

function main() {
  const args = process.argv.slice(2);
  const root = path.join(__dirname, '..');
  const metaPath = argValue(args, '--meta', path.join(root, 'data', 'terapeak-meta.json'));
  const storePath = argValue(args, '--store', path.join(root, 'cache', 'terapeak_sold.json'));
  const reportPath = argValue(args, '--output', path.join(root, 'cache', 'contradictory-weights-audit.json'));
  const rollbackPath = argValue(args, '--rollback-output', path.join(root, 'cache', 'contradictory-weights-rollback.json'));
  validatePaths(metaPath, storePath, reportPath, rollbackPath);
  const meta = loadJson(metaPath, true);
  const store = loadJson(storePath, false);
  const report = buildAudit(meta, store);
  const affectedKeys = new Set(report.affected.map(item => item.key));
  const selectAffectedEntries = source => {
    const selected = Object.create(null);
    for (const key in source) {
      if (Object.hasOwn(source, key) && affectedKeys.has(key)) selected[key] = source[key];
    }
    return selected;
  };
  const rollback = {
    generatedAt: report.generatedAt,
    mode: 'rollback-source',
    meta: selectAffectedEntries(meta),
    store: selectAffectedEntries(store),
  };
  publishJsonPair([[rollbackPath, rollback], [reportPath, report]]);
  console.log('Contradictory Weight Audit -- inventory only');
  console.log(`  Source keys:       ${report.sourceKeyCount}`);
  console.log(`  Affected keys:     ${report.affectedKeyCount}`);
  console.log(`  Associated comps:  ${report.affectedCompCount}`);
  console.log('  Target/collision analysis: not performed');
  console.log(`  Audit report:      ${reportPath}`);
  console.log(`  Rollback source:   ${rollbackPath}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[audit] ${error.message}`);
    process.exit(1);
  }
}

module.exports = { buildAudit, publishJsonPair };

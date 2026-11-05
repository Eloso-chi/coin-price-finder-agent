'use strict';

// US type seed terms (#334H): search terms for US coin types and Mint sets that
// have no Terapeak dataset yet. The freshness report injects them (in memory
// only) as missing datasets so the existing P2 initial-fetch queue picks them up.

const fs = require('fs');
const path = require('path');

const DEFAULT_SEED_PATH = path.join(__dirname, '..', '..', 'data', 'research', 'us-type-seed.json');
const MAX_PHASE = 3;
const MAX_TERM_LENGTH = 200;

// Returns { phase, warning }. phase is null when seeding is off.
function resolveSeedPhase(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { phase: 0 };
  const text = String(raw).trim().toLowerCase();
  if (text === 'off' || text === '-1') return { phase: null };
  if (/^[0-9]+$/.test(text) && Number(text) <= MAX_PHASE) return { phase: Number(text) };
  return { phase: 0, warning: `US type seed phase "${raw}" must be off or an integer 0-${MAX_PHASE}; using 0` };
}

function validateTerm(item, index) {
  const where = `terms[${index}]`;
  if (!item || typeof item !== 'object') return `${where}: not an object`;
  if (typeof item.term !== 'string' || !item.term.trim()) return `${where}: term must be a non-empty string`;
  if (item.term.length > MAX_TERM_LENGTH) return `${where}: term is longer than ${MAX_TERM_LENGTH} characters`;
  if (!/^[\x20-\x7E]+$/.test(item.term)) return `${where}: term must be printable ASCII`;
  if (/\bgeneric\b/i.test(item.term)) return `${where}: term must not contain the word generic`;
  if (typeof item.group !== 'string' || !item.group) return `${where}: group must be a non-empty string`;
  if (!Number.isInteger(item.rank) || item.rank < 1) return `${where}: rank must be a positive integer`;
  if (!Number.isInteger(item.phase) || item.phase < 0 || item.phase > MAX_PHASE) {
    return `${where}: phase must be an integer 0-${MAX_PHASE}`;
  }
  return null;
}

// Invalid entries are skipped and reported; they never throw.
function parseSeedDoc(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.terms)) {
    return { terms: [], errors: ['seed file must be an object with a terms array'] };
  }
  const terms = [];
  doc.terms.forEach((item, index) => {
    const problem = validateTerm(item, index);
    if (problem) errors.push(problem);
    else terms.push({ term: item.term.trim(), group: item.group, rank: item.rank, phase: item.phase });
  });
  return { terms, errors };
}

function loadSeedTerms(filePath = DEFAULT_SEED_PATH) {
  if (!fs.existsSync(filePath)) return { terms: [], errors: [], missing: true };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { terms: [], errors: [`seed file is not valid JSON: ${err.message}`] };
  }
  return parseSeedDoc(doc);
}

function selectSeedTerms(terms, phase) {
  if (phase === null || phase === undefined) return [];
  return terms.filter((t) => t.phase <= phase);
}

// Adds one in-memory meta entry per seed term that has no meta entry and no CSV.
// A term already in meta or on disk is left alone so real data always wins.
function injectSeeds(meta, terms, { normalizeKey, hasCSV }) {
  const added = [];
  let existing = 0;
  let withCsv = 0;
  let duplicates = 0;
  const claimed = new Set();
  for (const item of terms) {
    const key = normalizeKey(item.term);
    if (!key || claimed.has(key)) {
      duplicates++;
      continue;
    }
    claimed.add(key);
    if (Object.prototype.hasOwnProperty.call(meta, key)) {
      existing++;
      continue;
    }
    if (hasCSV(key)) {
      withCsv++;
      continue;
    }
    meta[key] = {
      searchTerm: item.term,
      compCount: null,
      refreshCount: 0,
      noDataCount: 0,
      usSeed: { group: item.group, rank: item.rank, phase: item.phase },
    };
    added.push({ key, ...item });
  }
  return { added, existing, withCsv, duplicates };
}

module.exports = {
  DEFAULT_SEED_PATH,
  MAX_PHASE,
  resolveSeedPhase,
  parseSeedDoc,
  loadSeedTerms,
  selectSeedTerms,
  injectSeeds,
};

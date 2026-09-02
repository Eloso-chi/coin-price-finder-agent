'use strict';

const SPECIAL_MARKS_REGISTRY_VERSION = '1.0.0';

// Every production record must be traceable to its issuing mint. Secondary
// catalog sources can corroborate an issue, but cannot establish official status.
const SPECIAL_MARKS = Object.freeze([
  Object.freeze({
    markId: 'rcm.maple.emc2',
    canonicalName: 'E=mc2',
    aliases: Object.freeze(['E=mc2', 'EMC2', 'E mc2', 'E=mc\u00b2']),
    issuer: 'Royal Canadian Mint',
    programs: Object.freeze(['maple leaf', 'silver maple leaf']),
    kind: 'privy',
    location: 'reverse',
    years: Object.freeze([2015]),
    metals: Object.freeze(['silver']),
    weightsOz: Object.freeze([1]),
    denominations: Object.freeze([5]),
    finishes: Object.freeze(['reverse proof']),
    officialStatus: 'official',
    sourceReferences: Object.freeze([
      'https://www.mint.ca/en/shop/coins/2015/1-oz.-fine-silver-coin---maple-leaf-privy-mark---e-mc2---mintage-50000-2015',
    ]),
    verificationDate: '2026-09-02',
  }),
  Object.freeze({
    markId: 'usmint.eagle.v75.silver',
    canonicalName: 'V75',
    aliases: Object.freeze(['V75', '75th Anniversary Privy']),
    issuer: 'United States Mint',
    programs: Object.freeze(['american silver eagle', 'silver eagle']),
    kind: 'privy',
    location: 'obverse',
    years: Object.freeze([2020]),
    metals: Object.freeze(['silver']),
    weightsOz: Object.freeze([1]),
    denominations: Object.freeze([1]),
    finishes: Object.freeze(['proof']),
    mintMarks: Object.freeze(['W']),
    officialStatus: 'official',
    sourceReferences: Object.freeze([
      'https://www.usmint.gov/end-of-world-war-ii-75th-anniversary-american-eagle-silver-proof-coin-20XF.html',
    ]),
    verificationDate: '2026-09-02',
  }),
  Object.freeze({
    markId: 'usmint.eagle.v75.gold',
    canonicalName: 'V75',
    aliases: Object.freeze(['V75', '75th Anniversary Privy']),
    issuer: 'United States Mint',
    programs: Object.freeze(['american gold eagle', 'gold eagle']),
    kind: 'privy',
    location: 'obverse',
    years: Object.freeze([2020]),
    metals: Object.freeze(['gold']),
    weightsOz: Object.freeze([1]),
    denominations: Object.freeze([50]),
    finishes: Object.freeze(['proof']),
    mintMarks: Object.freeze(['W']),
    officialStatus: 'official',
    sourceReferences: Object.freeze([
      'https://www.usmint.gov/end-of-world-war-ii-75th-anniversary-american-eagle-gold-proof-coin-20XE.html',
    ]),
    verificationDate: '2026-09-02',
  }),
]);

function normalizeMarkText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\u00b2/g, '2')
    .match(/[a-z0-9]+/g)?.join('') || '';
}

function normalizeContextText(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

function valuesMatch(values, actual, normalize = normalizeContextText, requireContext = false) {
  if (!values?.length) return true;
  if (actual == null || actual === '') return !requireContext;
  const wanted = normalize(actual);
  return values.some(value => normalize(value) === wanted);
}

function weightsMatch(weights, actual, requireContext = false) {
  if (!weights?.length) return true;
  if (actual == null || actual === '') return !requireContext;
  const number = Number(actual);
  return Number.isFinite(number)
    && weights.some(weight => Math.abs(weight - number) / Math.max(weight, number) < 0.05);
}

function denominationMatches(denominations, actual, requireContext = false) {
  if (!denominations?.length) return true;
  if (actual == null || actual === '') return !requireContext;
  const match = String(actual).match(/(?:\$\s*)?(\d+(?:\.\d+)?)\s*(?:dollars?)?/i);
  const value = match ? Number(match[1]) : Number(actual);
  return Number.isFinite(value) && denominations.includes(value);
}

function inferProgramDenomination(program, metal) {
  const value = normalizeContextText(program);
  const normalizedMetal = normalizeContextText(metal);
  if (value.includes('maple leaf') && normalizedMetal === 'silver') return 5;
  if (value.includes('silver eagle')) return 1;
  if (value.includes('gold eagle')) return 50;
  return null;
}

function programMatches(programs, actual, requireContext = false) {
  if (!programs?.length) return true;
  if (!actual) return !requireContext;
  const wanted = normalizeContextText(actual)
    .replace(/^canadian /, '')
    .replace(/^us /, 'american ');
  return programs.some(program => {
    const candidate = normalizeContextText(program);
    return wanted.includes(candidate) || candidate.includes(wanted);
  });
}

function markApplies(mark, context = {}, requireContext = false) {
  return programMatches(mark.programs, context.program || context.series || context.name, requireContext)
    && valuesMatch(mark.years, context.year, value => String(value), requireContext)
    && valuesMatch(mark.metals, context.metal || context.composition, normalizeContextText, requireContext)
    && weightsMatch(mark.weightsOz, context.weight || context.nominalWeightOz, requireContext)
    && denominationMatches(mark.denominations, context.denomination, requireContext)
    && valuesMatch(mark.finishes, context.finish, normalizeContextText, requireContext)
    && valuesMatch(mark.mintMarks, context.mint || context.mintMark, normalizeContextText, requireContext);
}

function getMarkById(markId) {
  return SPECIAL_MARKS.find(mark => mark.markId === markId) || null;
}

function listApplicableMarks(context = {}) {
  return SPECIAL_MARKS.filter(mark => markApplies(mark, context));
}

function aliasesMatchTitle(mark, title) {
  const titleTokens = String(title || '').toLowerCase().replace(/\u00b2/g, '2').match(/[a-z0-9]+/g) || [];
  return mark.aliases.some(alias => {
    const aliasTokens = String(alias).toLowerCase().replace(/\u00b2/g, '2').match(/[a-z0-9]+/g) || [];
    const wanted = aliasTokens.join('');
    for (let start = 0; start < titleTokens.length; start++) {
      let candidate = '';
      for (let offset = 0; offset < aliasTokens.length + 2 && start + offset < titleTokens.length; offset++) {
        candidate += titleTokens[start + offset];
        if (candidate === wanted) return true;
        if (candidate.length >= wanted.length) break;
      }
    }
    return false;
  });
}

function detectMarksInTitle(title, context = {}) {
  return listApplicableMarks(context).filter(mark => aliasesMatchTitle(mark, title));
}

function resolveSpecialMark({ markId, detail, context = {} } = {}) {
  if (markId) {
    const mark = getMarkById(markId);
    if (!mark) return { status: 'unknown', mark: null, candidates: [] };
    return markApplies(mark, context, true)
      ? { status: 'resolved', mark, candidates: [mark] }
      : { status: 'inapplicable', mark, candidates: [mark] };
  }
  const normalizedDetail = normalizeMarkText(detail);
  if (!normalizedDetail) return { status: 'none', mark: null, candidates: [] };
  const candidates = listApplicableMarks(context).filter(mark =>
    mark.aliases.some(alias => normalizeMarkText(alias) === normalizedDetail));
  return candidates.length === 1
    ? { status: 'resolved', mark: candidates[0], candidates }
    : { status: candidates.length ? 'ambiguous' : 'unknown', mark: null, candidates };
}

function validateRegistry() {
  const errors = [];
  const ids = new Set();
  const aliases = new Map();
  for (const mark of SPECIAL_MARKS) {
    if (ids.has(mark.markId)) errors.push(`Duplicate markId: ${mark.markId}`);
    ids.add(mark.markId);
    for (const field of ['canonicalName', 'issuer', 'kind', 'location', 'officialStatus', 'verificationDate']) {
      if (!mark[field]) errors.push(`${mark.markId} is missing ${field}`);
    }
    if (!mark.programs?.length || !mark.years?.length || !mark.metals?.length
      || !mark.weightsOz?.length || !mark.finishes?.length || !mark.aliases?.length
      || !mark.denominations?.length
      || !mark.sourceReferences?.every(source => /^https:\/\//.test(source))) {
      errors.push(`${mark.markId} has incomplete applicability or provenance`);
    }
    for (const alias of mark.aliases) {
      const key = `${normalizeMarkText(alias)}|${mark.programs.join(',')}|${mark.years.join(',')}|${mark.metals.join(',')}|${mark.weightsOz.join(',')}|${mark.finishes.join(',')}`;
      const existing = aliases.get(key);
      if (existing && existing !== mark.markId) errors.push(`Overlapping alias ${alias}: ${existing}, ${mark.markId}`);
      aliases.set(key, mark.markId);
    }
  }
  return errors;
}

function serializeMark(mark) {
  if (!mark) return null;
  return {
    markId: mark.markId,
    canonicalName: mark.canonicalName,
    kind: mark.kind,
    location: mark.location,
    issuer: mark.issuer,
    officialStatus: mark.officialStatus,
    sourceReferences: [...mark.sourceReferences],
    registryVersion: SPECIAL_MARKS_REGISTRY_VERSION,
  };
}

module.exports = {
  SPECIAL_MARKS_REGISTRY_VERSION,
  SPECIAL_MARKS,
  normalizeMarkText,
  markApplies,
  getMarkById,
  listApplicableMarks,
  aliasesMatchTitle,
  detectMarksInTitle,
  resolveSpecialMark,
  serializeMark,
  validateRegistry,
  inferProgramDenomination,
};

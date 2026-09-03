'use strict';

const SPECIAL_MARKS_REGISTRY_VERSION = '1.1.0';

// Every production record must be traceable to its issuing mint. Secondary
// catalog sources can corroborate an issue, but cannot establish official status.
const SPECIAL_MARKS = Object.freeze([
  Object.freeze({
    issueId: 'rcm.sml.2015.emc2.1oz.reverse-proof',
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
    verificationStatus: 'issuer-verified',
    mintage: Object.freeze({ value: 50000, type: 'maximum', sourceReference: 'https://www.mint.ca/en/shop/coins/2015/1-oz.-fine-silver-coin---maple-leaf-privy-mark---e-mc2---mintage-50000-2015' }),
    sourceReferences: Object.freeze([
      'https://www.mint.ca/en/shop/coins/2015/1-oz.-fine-silver-coin---maple-leaf-privy-mark---e-mc2---mintage-50000-2015',
    ]),
    verificationDate: '2026-09-02',
  }),
  Object.freeze({
    issueId: 'rcm.sml.2016.howling-wolf.1oz.reverse-proof',
    markId: 'rcm.maple.howling-wolf.2016',
    canonicalName: 'Howling Wolf',
    aliases: Object.freeze(['Howling Wolf', 'Wolf Privy']),
    issuer: 'Royal Canadian Mint',
    programs: Object.freeze(['maple leaf', 'silver maple leaf']),
    kind: 'privy',
    location: 'reverse',
    years: Object.freeze([2016]),
    metals: Object.freeze(['silver']),
    weightsOz: Object.freeze([1]),
    denominations: Object.freeze([5]),
    finishes: Object.freeze(['reverse proof']),
    officialStatus: 'official',
    verificationStatus: 'issuer-authored-secondary-host',
    mintage: Object.freeze({ value: 50000, type: 'maximum', sourceReference: 'https://coinweek.com/royal-canadian-mint-sells-out-first-coin-in-wild-canada-silver-maple-leaf-series/' }),
    sourceReferences: Object.freeze([
      'https://coinweek.com/royal-canadian-mint-sells-out-first-coin-in-wild-canada-silver-maple-leaf-series/',
      'https://www.pcgs.com/coinfacts/coin/593832',
      'https://canadianpmx.com/product/546836-rcm-privy-1oz-silver-maple-leaf-wolf-2016',
    ]),
    verificationDate: '2026-09-03',
  }),
  Object.freeze({
    issueId: 'rcm.sml.2016.roaring-grizzly-bear.1oz.reverse-proof',
    markId: 'rcm.maple.roaring-grizzly-bear.2016',
    canonicalName: 'Roaring Grizzly Bear',
    aliases: Object.freeze(['Roaring Grizzly Bear', 'Grizzly Bear Privy', 'Grizzly Privy']),
    issuer: 'Royal Canadian Mint',
    programs: Object.freeze(['maple leaf', 'silver maple leaf']),
    kind: 'privy',
    location: 'reverse',
    years: Object.freeze([2016]),
    metals: Object.freeze(['silver']),
    weightsOz: Object.freeze([1]),
    denominations: Object.freeze([5]),
    finishes: Object.freeze(['reverse proof']),
    officialStatus: 'official',
    verificationStatus: 'issuer-authored-secondary-host',
    mintage: Object.freeze({ value: 50000, type: 'maximum', sourceReference: 'https://coinweek.com/royal-canadian-mint-sells-out-first-coin-in-wild-canada-silver-maple-leaf-series/' }),
    sourceReferences: Object.freeze([
      'https://coinweek.com/royal-canadian-mint-sells-out-first-coin-in-wild-canada-silver-maple-leaf-series/',
      'https://canadiancoinnews.com/mint-sells-out-of-new-grizzly-sml/',
      'https://canadianpmx.com/product/546515-rcm-privy-1oz-silver-maple-leaf-grizzly-2016',
    ]),
    verificationDate: '2026-09-03',
  }),
  Object.freeze({
    issueId: 'rcm.sml.2017.cougar.1oz.reverse-proof',
    markId: 'rcm.maple.cougar.2017',
    canonicalName: 'Cougar',
    aliases: Object.freeze(['Cougar', 'Cougar Privy']),
    issuer: 'Royal Canadian Mint',
    programs: Object.freeze(['maple leaf', 'silver maple leaf']),
    kind: 'privy',
    location: 'reverse',
    years: Object.freeze([2017]),
    metals: Object.freeze(['silver']),
    weightsOz: Object.freeze([1]),
    denominations: Object.freeze([5]),
    finishes: Object.freeze(['reverse proof']),
    officialStatus: 'official',
    verificationStatus: 'issuer-authored-secondary-host',
    mintage: Object.freeze({ value: 50000, type: 'maximum', sourceReference: 'https://canadianpmx.com/product/546846-rcm-privy-1oz-silver-maple-leaf-cougar-2017' }),
    sourceReferences: Object.freeze([
      'https://coinweek.com/royal-canadian-mint-sells-out-first-coin-in-wild-canada-silver-maple-leaf-series/',
      'https://canadiancoinnews.com/mint-sells-out-of-new-grizzly-sml/',
      'https://canadianpmx.com/product/546846-rcm-privy-1oz-silver-maple-leaf-cougar-2017',
      'https://www.pcgs.com/coinfacts/coin/629245',
    ]),
    verificationDate: '2026-09-03',
  }),
  Object.freeze({
    issueId: 'rcm.sml.2017.moose.1oz.reverse-proof',
    markId: 'rcm.maple.moose.2017',
    canonicalName: 'Moose',
    aliases: Object.freeze(['Moose', 'Moose Privy']),
    issuer: 'Royal Canadian Mint',
    programs: Object.freeze(['maple leaf', 'silver maple leaf']),
    kind: 'privy',
    location: 'reverse',
    years: Object.freeze([2017]),
    metals: Object.freeze(['silver']),
    weightsOz: Object.freeze([1]),
    denominations: Object.freeze([5]),
    finishes: Object.freeze(['reverse proof']),
    officialStatus: 'official',
    verificationStatus: 'issuer-authored-secondary-host',
    mintage: Object.freeze({ value: 50000, type: 'maximum', sourceReference: 'https://www.jmbullion.com/the-final-wild-canada-privy-coins-arrive-exclusively-at-jm-bullion/' }),
    sourceReferences: Object.freeze([
      'https://coinweek.com/royal-canadian-mint-sells-out-first-coin-in-wild-canada-silver-maple-leaf-series/',
      'https://canadiancoinnews.com/mint-sells-out-of-new-grizzly-sml/',
      'https://www.jmbullion.com/the-final-wild-canada-privy-coins-arrive-exclusively-at-jm-bullion/',
      'https://bullionest.com/2017-1-oz-moose-privy-canadian-silver-maple-leaf-reverse-proof-coin/',
    ]),
    verificationDate: '2026-09-03',
  }),
  Object.freeze({
    issueId: 'rcm.sml.2018.pronghorn-antelope.1oz.reverse-proof',
    markId: 'rcm.maple.pronghorn-antelope.2018',
    canonicalName: 'Pronghorn Antelope',
    aliases: Object.freeze(['Pronghorn Antelope', 'Antelope Privy', 'Pronghorn Privy']),
    issuer: 'Royal Canadian Mint',
    programs: Object.freeze(['maple leaf', 'silver maple leaf']),
    kind: 'privy',
    location: 'reverse',
    years: Object.freeze([2018]),
    metals: Object.freeze(['silver']),
    weightsOz: Object.freeze([1]),
    denominations: Object.freeze([5]),
    finishes: Object.freeze(['reverse proof']),
    officialStatus: 'official',
    verificationStatus: 'issuer-authored-secondary-host',
    mintage: Object.freeze({ value: 50000, type: 'maximum', sourceReference: 'https://www.jmbullion.com/2018-1-oz-antelope-privy-canadian-silver-maple-leaf-reverse-proof-coin/' }),
    sourceReferences: Object.freeze([
      'https://coinweek.com/royal-canadian-mint-sells-out-first-coin-in-wild-canada-silver-maple-leaf-series/',
      'https://canadiancoinnews.com/mint-sells-out-of-new-grizzly-sml/',
      'https://www.jmbullion.com/2018-1-oz-antelope-privy-canadian-silver-maple-leaf-reverse-proof-coin/',
      'https://www.apmex.com/product/242419/2018-canada-1-oz-silver-maple-leaf-pronghorn-antelope-privy-bu',
    ]),
    verificationDate: '2026-09-03',
  }),
  Object.freeze({
    issueId: 'rcm.sml.2018.wood-bison.1oz.reverse-proof',
    markId: 'rcm.maple.wood-bison.2018',
    canonicalName: 'Wood Bison',
    aliases: Object.freeze(['Wood Bison', 'Bison Privy']),
    issuer: 'Royal Canadian Mint',
    programs: Object.freeze(['maple leaf', 'silver maple leaf']),
    kind: 'privy',
    location: 'reverse',
    years: Object.freeze([2018]),
    metals: Object.freeze(['silver']),
    weightsOz: Object.freeze([1]),
    denominations: Object.freeze([5]),
    finishes: Object.freeze(['reverse proof']),
    officialStatus: 'official',
    verificationStatus: 'issuer-authored-secondary-host',
    mintage: Object.freeze({ value: 50000, type: 'maximum', sourceReference: 'https://www.jmbullion.com/2018-1-oz-wood-bison-privy-canadian-silver-maple-leaf-reverse-proof-coin/' }),
    sourceReferences: Object.freeze([
      'https://coinweek.com/royal-canadian-mint-sells-out-first-coin-in-wild-canada-silver-maple-leaf-series/',
      'https://canadiancoinnews.com/mint-sells-out-of-new-grizzly-sml/',
      'https://www.jmbullion.com/2018-1-oz-wood-bison-privy-canadian-silver-maple-leaf-reverse-proof-coin/',
      'https://www.herobullion.com/2018-1-oz-canadian-wood-bison-privy-reverse-proof-silver-maple-leaf-coin/',
    ]),
    verificationDate: '2026-09-03',
  }),
  Object.freeze({
    issueId: 'usmint.ase.2020.v75.1oz.proof',
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
    verificationStatus: 'issuer-verified',
    mintage: Object.freeze({ value: 75000, type: 'maximum', sourceReference: 'https://www.usmint.gov/end-of-world-war-ii-75th-anniversary-american-eagle-silver-proof-coin-20XF.html' }),
    sourceReferences: Object.freeze([
      'https://www.usmint.gov/end-of-world-war-ii-75th-anniversary-american-eagle-silver-proof-coin-20XF.html',
    ]),
    verificationDate: '2026-09-02',
  }),
  Object.freeze({
    issueId: 'usmint.age.2020.v75.1oz.proof',
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
    verificationStatus: 'issuer-verified',
    mintage: Object.freeze({ value: 1945, type: 'maximum', sourceReference: 'https://www.usmint.gov/end-of-world-war-ii-75th-anniversary-american-eagle-gold-proof-coin-20XE.html' }),
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

function inferProgramMetal(program) {
  const value = normalizeContextText(program);
  if (value.includes('silver maple leaf')) return 'silver';
  if (value.includes('gold maple leaf')) return 'gold';
  if (value.includes('silver eagle')) return 'silver';
  if (value.includes('gold eagle')) return 'gold';
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

const OFFICIAL_STATUSES = new Set(['official']);
const VERIFICATION_STATUSES = new Set(['issuer-verified', 'issuer-authored-secondary-host']);
const MINTAGE_TYPES = new Set(['maximum', 'declared', 'final']);
const ISSUER_DOMAINS = Object.freeze({
  'Royal Canadian Mint': Object.freeze(['mint.ca', 'www.mint.ca']),
  'United States Mint': Object.freeze(['usmint.gov', 'www.usmint.gov']),
});
const TRUSTED_ISSUER_AUTHORED_SECONDARY_SOURCES = new Set([
  'https://coinweek.com/royal-canadian-mint-sells-out-first-coin-in-wild-canada-silver-maple-leaf-series/',
]);

function hasIssuerEvidence(mark, sources) {
  if (mark.verificationStatus === 'issuer-authored-secondary-host') {
    return sources.some(source => TRUSTED_ISSUER_AUTHORED_SECONDARY_SOURCES.has(source));
  }
  const domains = ISSUER_DOMAINS[mark.issuer] || [];
  return sources.some(source => {
    try {
      return domains.includes(new URL(source).hostname.toLowerCase());
    } catch {
      return false;
    }
  });
}

function validateRegistry(records = SPECIAL_MARKS) {
  const errors = [];
  const ids = new Set();
  const issueIds = new Set();
  const aliases = new Map();
  for (const mark of records) {
    if (issueIds.has(mark.issueId)) errors.push(`Duplicate issueId: ${mark.issueId}`);
    issueIds.add(mark.issueId);
    if (ids.has(mark.markId)) errors.push(`Duplicate markId: ${mark.markId}`);
    ids.add(mark.markId);
    for (const field of ['issueId', 'canonicalName', 'issuer', 'kind', 'location', 'officialStatus', 'verificationStatus', 'verificationDate']) {
      if (!mark[field]) errors.push(`${mark.markId} is missing ${field}`);
    }
    if (!OFFICIAL_STATUSES.has(mark.officialStatus)) {
      errors.push(`${mark.markId} has unsupported officialStatus`);
    }
    if (!VERIFICATION_STATUSES.has(mark.verificationStatus)) {
      errors.push(`${mark.markId} lacks issuer-traceable verification`);
    }
    const sources = mark.sourceReferences;
    const hasValidSources = Array.isArray(sources) && sources.length > 0
      && sources.every(source => /^https:\/\//.test(source));
    const hasTrustedIssuerEvidence = hasValidSources && hasIssuerEvidence(mark, sources);
    const mintage = mark.mintage;
    const hasValidMintage = Number.isInteger(mintage?.value) && mintage.value > 0
      && MINTAGE_TYPES.has(mintage?.type)
      && /^https:\/\//.test(mintage?.sourceReference || '')
      && sources?.includes(mintage.sourceReference);
    if (!mark.programs?.length || !mark.years?.length || !mark.metals?.length
      || !mark.weightsOz?.length || !mark.finishes?.length || !mark.aliases?.length
      || !mark.denominations?.length || !hasValidSources || !hasTrustedIssuerEvidence || !hasValidMintage) {
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
    issueId: mark.issueId,
    markId: mark.markId,
    canonicalName: mark.canonicalName,
    kind: mark.kind,
    location: mark.location,
    issuer: mark.issuer,
    officialStatus: mark.officialStatus,
    verificationStatus: mark.verificationStatus,
    mintage: mark.mintage ? { ...mark.mintage } : null,
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
  inferProgramMetal,
};

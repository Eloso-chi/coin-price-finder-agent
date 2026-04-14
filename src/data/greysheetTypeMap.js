// src/data/greysheetTypeMap.js -- Greysheet [Type] GSID lookup for generic / yearless coins
// Maps series + weight keys to the Greysheet catalog GSID for the
// series-level "Type" entry (IsType: true, no specific year).
// These are used when a coin query has no year, so the normal
// PCGS-number-based Greysheet lookup cannot resolve.
//
// Built by walking the Greysheet CDN Public API V2 catalog tree.
// Last refreshed: 2026-04-07
'use strict';

// ── Type GSID Map ───────────────────────────────────────────
// Keys are lowercase series identifiers that match the patterns
// used in BULLION_1OZ_DEFAULT and terapeakService dataset naming.
// Format: "series|weight|metal" or "series|metal" for classics.
//
// When multiple sub-types exist (e.g. Morgan pre-1921 vs 1921),
// we use the most common variant.

const TYPE_GSID_MAP = {
  // ── US Eagles ──────────────────────────────────────────────
  'silver eagle|1':        72469,   // ASE $1 One Ounce MS [Type]
  'gold eagle|0.1':        74227,   // AGE $5 1/10 Ounce MS [Type]
  'gold eagle|0.25':       74228,   // AGE $10 1/4 Ounce MS [Type]
  'gold eagle|0.5':        74229,   // AGE $25 1/2 Ounce MS [Type]
  'gold eagle|1':          74237,   // AGE G$50 One Ounce MS [Type]
  'platinum eagle|0.1':    74263,   // APE $10 1/10 Ounce MS [Type]
  'platinum eagle|0.25':   74265,   // APE $25 1/4 Ounce MS [Type]
  'platinum eagle|0.5':    74266,   // APE P$50 1/2 Ounce MS [Type]
  'platinum eagle|1':      74270,   // APE P$100 One Ounce MS [Type]
  'palladium eagle|1':     376573,  // Palladium Eagle $25 One Ounce MS [Type]
  'gold buffalo|1':        74456,   // Gold Buffalo One Ounce G$50 MS [Type]

  // ── Canada ─────────────────────────────────────────────────
  'maple leaf|1|silver':   373777,  // Silver Maple Leaf S$5 One Ounce MS [Type]
  'maple leaf|1|gold':     213178,  // Gold Maple Leaf G$50 One Ounce MS [Type]
  'maple leaf|0.5|gold':   373780,  // Gold Maple Leaf G$20 Half Ounce MS [Type]
  'maple leaf|0.25|gold':  373787,  // Gold Maple Leaf G$10 Quarter Ounce MS [Type]
  'maple leaf|0.1|gold':   373793,  // Gold Maple Leaf G$5 One-Tenth Ounce MS [Type]
  'maple leaf|1|platinum': 320561,  // Platinum Maple Leaf P$50 One Ounce MS [Type]
  // Note: Canadian Gold Maple Leaf 1/20 oz and Silver Polar Bear have no Greysheet Type entries.

  // ── Australia ──────────────────────────────────────────────
  'kookaburra|1':          393577,  // Kookaburra S$1 1oz Silver MS [Type]
  'kangaroo|1|silver':     393506,  // Kangaroo S$1 1oz Silver MS [Type]
  'lunar|1|silver':        393681,  // Lunar Series S$1 Silver, One Ounce MS [Type]
  'lunar|0.5|silver':      395570,  // Lunar 1/2 oz Silver MS [Type]
  'lunar|1|gold':          393627,  // Lunar G$100 Gold, 1996- MS [Type]
  // Note: AU Gold Kangaroo weights, Gold Lunar 1/10 and 1/20 have no separate Type entries.

  // ── Austria ────────────────────────────────────────────────
  'philharmonic|1|silver': 374302,  // Vienna Philharmonic Silver 1 Ounce MS [Type]
  'philharmonic|1|gold':   395557,  // Vienna Philharmonic Gold 1 Ounce MS [Type]
  // Note: Gold Phil fractional (1/10, 1/4, 1/2) only have Schilling-era entries, no Euro-era Type.

  // ── South Africa ───────────────────────────────────────────
  'krugerrand|1|gold':     373711,  // Gold KR 1 Ounce MS [Type]
  'krugerrand|0.5|gold':   395941,  // Gold KR 1/2 Ounce MS [Type]
  'krugerrand|0.25|gold':  395932,  // Gold KR 1/4 Ounce MS [Type]
  'krugerrand|0.1|gold':   396050,  // Gold KR 1/10 Ounce MS [Type]
  // Note: Silver Krugerrand and Gold KR 1/20 oz have no Type entries.

  // ── China ──────────────────────────────────────────────────
  'panda|1|gold':          395439,  // Panda Gold G100Y 1982-2016 1oz MS [Type]
  'panda|1|silver':        373776,  // Panda Silver S10Y 1989- 1oz MS [Type]

  // ── Mexico: Silver Libertad ────────────────────────────────
  'libertad|1|silver':     393495,  // Libertad 1 Onza Silver 31.1g MS [Type]
  'libertad|0.5|silver':   393819,  // Libertad 1/2 Onza Silver 15.6g MS [Type]
  'libertad|0.25|silver':  393815,  // Libertad 1/4 Onza Silver 7.78g MS [Type]
  'libertad|0.1|silver':   393739,  // Libertad 1/10 Onza Silver 3.1g MS [Type]
  'libertad|0.05|silver':  374245,  // Libertad 1/20 Onza Silver 1.56g MS [Type]

  // ── Mexico: Gold Libertad ──────────────────────────────────
  'libertad|1|gold':       393496,  // Libertad 1 Onza Gold 31.1g MS [Type]
  'libertad|0.5|gold':     393956,  // Libertad 1/2 Onza Gold 15.6g MS [Type]
  'libertad|0.25|gold':    393912,  // Libertad 1/4 Onza Gold 7.78g MS [Type]
  'libertad|0.1|gold':     393931,  // Libertad 1/10 Onza Gold 3.1g MS [Type]
  'libertad|0.05|gold':    393932,  // Libertad 1/20 Onza Gold 1.56g MS [Type]

  // ── US Classic: Dollars ────────────────────────────────────
  'morgan|silver':         72404,   // Morgan $1 Pre-1921 MS [Type]
  'peace|silver':          72407,   // Peace Dollar $1 1921-1935 MS [Type]
  'eisenhower|clad':       376575,  // Eisenhower $1 Clad MS [Type]

  // ── US Classic: Half Dollars ───────────────────────────────
  'barber half|silver':    72413,   // Barber Half Dollar 50c MS [Type]
  'walking liberty|silver': 72414,  // Walking Liberty Half Dollar 50c MS [Type]
  'franklin|silver':       76527,   // Franklin Half Dollar 50c MS [Type]
  'kennedy|silver':        24983,   // Kennedy Half Dollar 50c 90% Silver MS [Type]
  'kennedy|clad':          24985,   // Kennedy Half Dollar 50c Clad, 1971-Present MS [Type]

  // ── US Classic: Dimes ──────────────────────────────────────
  'barber dime|silver':    72463,   // Barber Dime 10c MS [Type]
  'mercury|silver':        72464,   // Mercury Dime 10c MS [Type]
  'roosevelt|silver':      76246,   // Roosevelt Dime 10c Silver MS [Type]

  // ── US Classic: Quarters ───────────────────────────────────
  'barber quarter|silver': 72438,   // Barber Quarter 25c MS [Type]
  'standing liberty|silver': 72441, // Standing Liberty Quarter 25c Type 2 MS [Type]
  'washington quarter|silver': 72443, // Washington Quarter 25c Silver MS [Type]

  // ── US Classic: Nickels ────────────────────────────────────
  'buffalo nickel|nickel': 72361,   // Buffalo Nickel 5c Type 2 Reverse MS [Type]
  // Note: Jefferson War Nickel has no Greysheet Type entry.

  // ── Series not in Greysheet Type catalog ───────────────────
  // The following Generic series have NO Greysheet [Type] entries:
  // - British Gold/Silver Britannia (all weights)
  // - Canadian Silver Polar Bear (all weights)
  // - Canadian Gold Maple Leaf 1/20 oz
  // - Silver Krugerrand 1 oz
  // - Gold Krugerrand 1/20 oz
  // - Austrian Gold Philharmonic fractional (Euro-era)
  // - Australian Gold Kangaroo (weight-specific)
  // - Australian Gold/Silver Lunar 2oz, 1/4oz (gold)
  // - Indian Head Cent
  // - Lincoln Wheat Cent
  // - Jefferson War Nickel
};

// ── Series-name alias resolution ─────────────────────────────
// Normalizes the series/query text to the lookup key format above.
// Returns { seriesKey, weight, metal } or null if no match.

const SERIES_PATTERNS = [
  // Bullion: the series keyword, default metal, optional metal override
  // defaultWeight: used when query text has no explicit weight (e.g. "Silver Eagle" → 1 oz)
  { re: /\bsilver\s*eagle\b/i,     series: 'silver eagle',     metal: 'silver',    defaultWeight: 1 },
  { re: /\bgold\s*eagle\b/i,       series: 'gold eagle',       metal: 'gold'   },
  { re: /\bplatinum\s*eagle\b/i,   series: 'platinum eagle',   metal: 'platinum',  defaultWeight: 1 },
  { re: /\bpalladium\s*eagle\b/i,  series: 'palladium eagle',  metal: 'palladium', defaultWeight: 1 },
  { re: /\bgold\s*buffalo\b/i,     series: 'gold buffalo',     metal: 'gold',      defaultWeight: 1 },
  { re: /\bmaple\s*leaf\b/i,       series: 'maple leaf',       metal: null     },  // need metal from context
  { re: /\bkookaburra\b/i,         series: 'kookaburra',       metal: 'silver',    defaultWeight: 1 },
  { re: /\bkangaroo\b/i,           series: 'kangaroo',         metal: null     },
  { re: /\blunar\b/i,              series: 'lunar',            metal: null     },
  { re: /\bphilharmonic\b/i,       series: 'philharmonic',     metal: null     },
  { re: /\bkrugerrand\b/i,         series: 'krugerrand',       metal: 'gold',      defaultWeight: 1 },
  { re: /\bpanda\b/i,              series: 'panda',            metal: null     },
  { re: /\blibertad\b/i,           series: 'libertad',         metal: null     },
  // US Classics
  { re: /\bmorgan\b/i,             series: 'morgan',           metal: 'silver' },
  { re: /\bpeace\b/i,              series: 'peace',            metal: 'silver' },
  { re: /\beisenhower\b|\bike\b/i, series: 'eisenhower',       metal: 'clad'   },
  { re: /\bbarber\b.*\bhalf\b|\bhalf\b.*\bbarber\b/i, series: 'barber half', metal: 'silver' },
  { re: /\bwalking\s*liberty\b/i,  series: 'walking liberty',  metal: 'silver' },
  { re: /\bfranklin\b/i,           series: 'franklin',         metal: 'silver' },
  { re: /\bkennedy\b/i,            series: 'kennedy',          metal: null     },  // silver or clad
  { re: /\bbarber\b.*\bdime\b|\bdime\b.*\bbarber\b/i, series: 'barber dime', metal: 'silver' },
  { re: /\bmercury\b/i,            series: 'mercury',          metal: 'silver' },
  { re: /\broosevelt\b/i,          series: 'roosevelt',        metal: 'silver' },
  { re: /\bbarber\b.*\bquarter\b|\bquarter\b.*\bbarber\b/i, series: 'barber quarter', metal: 'silver' },
  { re: /\bstanding\s*liberty\b/i, series: 'standing liberty', metal: 'silver' },
  { re: /\bwashington\b.*\bquarter\b/i, series: 'washington quarter', metal: 'silver' },
  { re: /\bbuffalo\s*nickel\b/i,   series: 'buffalo nickel',   metal: 'nickel' },
];

// Metal detection from text
function _detectMetal(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\bsilver\b/.test(t))    return 'silver';
  if (/\bgold\b/.test(t))      return 'gold';
  if (/\bplatinum\b/.test(t))  return 'platinum';
  if (/\bpalladium\b/.test(t)) return 'palladium';
  return null;
}

// Weight detection from text
function _detectWeight(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  // Explicit fractional patterns
  if (/\b(?:1\/20|twentieth|\.05)\s*(?:oz|ounce)?\b/.test(t)) return 0.05;
  if (/\b(?:1\/10|tenth|\.1)\s*(?:oz|ounce)?\b/.test(t))      return 0.1;
  if (/\b(?:1\/4|quarter|\.25)\s*(?:oz|ounce)?\b/.test(t))     return 0.25;
  if (/\b(?:1\/2|half|\.5)\s*(?:oz|ounce)?\b/.test(t))         return 0.5;
  if (/\b(?:1\s*oz|one\s*ounce|1\s*ounce)\b/.test(t))          return 1;
  return null;
}

/**
 * Look up the Greysheet Type GSID for a yearless / generic coin query.
 *
 * @param {string} queryText   -- free-text coin description (e.g. "Mexican Silver Libertad 1 oz")
 * @param {object} [hints]     -- optional { series, metal, weight } from prior parsing
 * @returns {{ gsid: number, lookupKey: string }|null}
 */
function lookupTypeGsid(queryText, hints = {}) {
  const text = String(queryText || '');
  const allText = `${text} ${hints.series || ''}`.toLowerCase();

  // Find matching series
  let matched = null;
  for (const pat of SERIES_PATTERNS) {
    if (pat.re.test(allText)) {
      matched = pat;
      break;
    }
  }
  if (!matched) return null;

  const metal  = hints.metal || _detectMetal(text) || matched.metal;
  const weight = hints.weight || _detectWeight(text) || matched.defaultWeight || null;

  // Build lookup key(s) -- try most specific to least specific
  const candidates = [];

  // "series|weight|metal" (bullion with weight + metal)
  if (weight && metal) candidates.push(`${matched.series}|${weight}|${metal}`);
  // "series|weight" (bullion with weight, implied metal like ASE)
  if (weight)          candidates.push(`${matched.series}|${weight}`);
  // "series|metal" (classic coins keyed by metal/composition)
  if (metal)           candidates.push(`${matched.series}|${metal}`);

  for (const key of candidates) {
    if (TYPE_GSID_MAP[key] !== undefined) {
      return { gsid: TYPE_GSID_MAP[key], lookupKey: key };
    }
  }

  return null;
}

module.exports = {
  lookupTypeGsid,
  TYPE_GSID_MAP,
  // Exposed for testing
  _detectMetal,
  _detectWeight,
};

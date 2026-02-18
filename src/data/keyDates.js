// src/data/keyDates.js — Key-date / semi-key / key-issue lookup table
// Used by the pricing route to auto-flag coins that command premiums.
//
// Format:
//   series  — canonical short name used in matching (lower-cased during lookup)
//   year    — issue year (number)
//   mint    — mint mark (string, '' = Philadelphia / no mark)
//   tier    — 'key' | 'semi-key' | 'condition-rarity' | 'variety' | 'low-mintage'
//   note    — human-readable explanation
//
// This is NOT exhaustive — it covers the most commonly traded US coin key dates
// that a dealer would need flagged automatically.

'use strict';

const KEY_DATES = [
  // ═══════════════════════════════════════════════════════════
  // MORGAN DOLLARS
  // ═══════════════════════════════════════════════════════════
  { series: 'morgan dollar', year: 1878, mint: 'CC', tier: 'semi-key', note: 'First Carson City Morgan; low mintage (2.2M)' },
  { series: 'morgan dollar', year: 1879, mint: 'CC', tier: 'key',      note: 'Very low mintage (756K); key date' },
  { series: 'morgan dollar', year: 1880, mint: 'CC', tier: 'semi-key', note: 'Low CC mintage (591K)' },
  { series: 'morgan dollar', year: 1881, mint: 'CC', tier: 'semi-key', note: 'Low CC mintage (296K)' },
  { series: 'morgan dollar', year: 1882, mint: 'CC', tier: 'semi-key', note: 'Low CC mintage (1.1M); popular date' },
  { series: 'morgan dollar', year: 1883, mint: 'CC', tier: 'semi-key', note: 'Carson City issue (1.2M)' },
  { series: 'morgan dollar', year: 1884, mint: 'CC', tier: 'semi-key', note: 'Carson City issue (1.1M)' },
  { series: 'morgan dollar', year: 1885, mint: 'CC', tier: 'semi-key', note: 'Low mintage CC (228K)' },
  { series: 'morgan dollar', year: 1889, mint: 'CC', tier: 'key',      note: 'Major key date (350K mintage)' },
  { series: 'morgan dollar', year: 1890, mint: 'CC', tier: 'semi-key', note: 'Carson City issue (2.3M)' },
  { series: 'morgan dollar', year: 1891, mint: 'CC', tier: 'semi-key', note: 'Last CC Morgan (1.6M)' },
  { series: 'morgan dollar', year: 1893, mint: 'S',  tier: 'key',      note: 'King of Morgans — only 100K minted; rarest regular-issue Morgan' },
  { series: 'morgan dollar', year: 1893, mint: 'CC', tier: 'key',      note: 'Low mintage CC (677K)' },
  { series: 'morgan dollar', year: 1893, mint: '',   tier: 'semi-key', note: 'Philadelphia low mintage (378K)' },
  { series: 'morgan dollar', year: 1894, mint: '',   tier: 'key',      note: 'Very low mintage (110K)' },
  { series: 'morgan dollar', year: 1895, mint: '',   tier: 'key',      note: '"King of the Morgan Proofs" — no business strikes; only proofs (880)' },
  { series: 'morgan dollar', year: 1895, mint: 'O',  tier: 'semi-key', note: 'Low surviving population' },
  { series: 'morgan dollar', year: 1895, mint: 'S',  tier: 'semi-key', note: 'Lower mintage (400K)' },
  { series: 'morgan dollar', year: 1892, mint: 'S',  tier: 'semi-key', note: 'Low mintage (1.2M)' },
  { series: 'morgan dollar', year: 1896, mint: 'S',  tier: 'semi-key', note: 'Low mintage (5M but elusive in high grade)' },
  { series: 'morgan dollar', year: 1899, mint: '',   tier: 'semi-key', note: 'Philadelphia low mintage (330K)' },
  { series: 'morgan dollar', year: 1901, mint: '',   tier: 'semi-key', note: 'Low mintage (6.9M) but condition rarity in MS' },
  { series: 'morgan dollar', year: 1903, mint: 'O',  tier: 'semi-key', note: 'Low mintage (4.4M); scarce in high grade' },
  { series: 'morgan dollar', year: 1904, mint: 'S',  tier: 'semi-key', note: 'Low mintage (2.3M)' },
  { series: 'morgan dollar', year: 1921, mint: '',   tier: 'low-mintage', note: 'Last year Morgan; high mintage but very popular' },

  // ═══════════════════════════════════════════════════════════
  // PEACE DOLLARS
  // ═══════════════════════════════════════════════════════════
  { series: 'peace dollar', year: 1921, mint: '',  tier: 'semi-key', note: 'First year; high-relief design; lower mintage' },
  { series: 'peace dollar', year: 1928, mint: '',  tier: 'key',      note: 'Only 360K minted; key date of the series' },
  { series: 'peace dollar', year: 1934, mint: 'S', tier: 'semi-key', note: 'Low mintage (1M)' },
  { series: 'peace dollar', year: 1935, mint: 'S', tier: 'semi-key', note: 'Last Peace dollar until 2021; lower mintage' },

  // ═══════════════════════════════════════════════════════════
  // WALKING LIBERTY HALF DOLLARS
  // ═══════════════════════════════════════════════════════════
  { series: 'walking liberty half', year: 1916, mint: '',  tier: 'semi-key', note: 'First year issue' },
  { series: 'walking liberty half', year: 1916, mint: 'D', tier: 'semi-key', note: 'First year D mint (1M)' },
  { series: 'walking liberty half', year: 1916, mint: 'S', tier: 'key',      note: 'Only 508K minted; key date' },
  { series: 'walking liberty half', year: 1917, mint: 'S', tier: 'semi-key', note: 'Obverse & reverse mintmark varieties' },
  { series: 'walking liberty half', year: 1919, mint: '',  tier: 'semi-key', note: 'Low mintage (962K)' },
  { series: 'walking liberty half', year: 1919, mint: 'D', tier: 'semi-key', note: 'Low mintage (1.1M)' },
  { series: 'walking liberty half', year: 1919, mint: 'S', tier: 'semi-key', note: 'Low mintage (1.5M)' },
  { series: 'walking liberty half', year: 1921, mint: '',  tier: 'key',      note: 'Only 246K minted; key date' },
  { series: 'walking liberty half', year: 1921, mint: 'D', tier: 'key',      note: 'Only 208K minted; major key date' },
  { series: 'walking liberty half', year: 1921, mint: 'S', tier: 'key',      note: 'Only 548K minted; key date' },
  { series: 'walking liberty half', year: 1938, mint: 'D', tier: 'semi-key', note: 'Low mintage (491K)' },

  // ═══════════════════════════════════════════════════════════
  // FRANKLIN HALF DOLLARS
  // ═══════════════════════════════════════════════════════════
  { series: 'franklin half', year: 1948, mint: '',  tier: 'semi-key', note: 'First year issue' },
  { series: 'franklin half', year: 1949, mint: 'S', tier: 'semi-key', note: 'Low mintage (3.7M)' },
  { series: 'franklin half', year: 1953, mint: '',  tier: 'semi-key', note: 'Low mintage (2.7M)' },
  { series: 'franklin half', year: 1955, mint: '',  tier: 'semi-key', note: 'Lowest regular mintage (2.4M); premium in FBL' },
  // Full Bell Lines (FBL) condition rarity for any Franklin
  { series: 'franklin half', year: 0, mint: '*', tier: 'condition-rarity', note: 'Full Bell Lines (FBL) designation commands a premium on any date' },

  // ═══════════════════════════════════════════════════════════
  // MERCURY DIMES
  // ═══════════════════════════════════════════════════════════
  { series: 'mercury dime', year: 1916, mint: 'D', tier: 'key',      note: 'Only 264K minted; THE key date of the series' },
  { series: 'mercury dime', year: 1921, mint: '',  tier: 'semi-key', note: 'Low mintage (1.2M)' },
  { series: 'mercury dime', year: 1921, mint: 'D', tier: 'semi-key', note: 'Low mintage (1M)' },
  { series: 'mercury dime', year: 1926, mint: 'S', tier: 'semi-key', note: 'Low mintage (1.5M)' },
  { series: 'mercury dime', year: 1931, mint: 'D', tier: 'semi-key', note: 'Low mintage (1.3M)' },
  { series: 'mercury dime', year: 1942, mint: '', tier: 'variety',    note: '1942/1 overdate is a major variety error; extremely rare' },

  // ═══════════════════════════════════════════════════════════
  // STANDING LIBERTY QUARTERS
  // ═══════════════════════════════════════════════════════════
  { series: 'standing liberty quarter', year: 1916, mint: '',  tier: 'key',      note: 'Only 52K minted; key date' },
  { series: 'standing liberty quarter', year: 1918, mint: 'S', tier: 'semi-key', note: '1918/7-S overdate is a major rarity' },
  { series: 'standing liberty quarter', year: 1919, mint: 'D', tier: 'semi-key', note: 'Low mintage (1.9M)' },
  { series: 'standing liberty quarter', year: 1919, mint: 'S', tier: 'semi-key', note: 'Low mintage (1.8M)' },
  { series: 'standing liberty quarter', year: 1921, mint: '',  tier: 'key',      note: 'Only 1.9M minted; scarce in all grades' },
  { series: 'standing liberty quarter', year: 1923, mint: 'S', tier: 'semi-key', note: 'Low mintage (1.4M)' },
  { series: 'standing liberty quarter', year: 1927, mint: 'S', tier: 'semi-key', note: 'Low mintage (396K)' },

  // ═══════════════════════════════════════════════════════════
  // WASHINGTON QUARTERS
  // ═══════════════════════════════════════════════════════════
  { series: 'washington quarter', year: 1932, mint: 'D', tier: 'key',      note: 'Only 436K minted; key date of series' },
  { series: 'washington quarter', year: 1932, mint: 'S', tier: 'key',      note: 'Only 408K minted; key date' },
  { series: 'washington quarter', year: 1936, mint: 'D', tier: 'semi-key', note: 'Low mintage (5.3M)' },
  { series: 'washington quarter', year: 1937, mint: 'S', tier: 'semi-key', note: 'Low mintage (1.6M)' },
  { series: 'washington quarter', year: 1940, mint: 'D', tier: 'semi-key', note: 'Low mintage (2.7M)' },
  { series: 'washington quarter', year: 1950, mint: 'D', tier: 'semi-key', note: 'Low-population; condition rarity in high grade' },
  { series: 'washington quarter', year: 1950, mint: 'S', tier: 'semi-key', note: 'Low-population over Denver' },

  // ═══════════════════════════════════════════════════════════
  // BARBER COINS (shared between dime, quarter, half)
  // ═══════════════════════════════════════════════════════════
  { series: 'barber dime',    year: 1894, mint: 'S', tier: 'key',      note: 'Only 24 minted; one of the rarest US coins' },
  { series: 'barber dime',    year: 1895, mint: 'O', tier: 'semi-key', note: 'Low mintage (440K)' },
  { series: 'barber dime',    year: 1901, mint: 'S', tier: 'semi-key', note: 'Low mintage (593K)' },
  { series: 'barber dime',    year: 1903, mint: 'S', tier: 'semi-key', note: 'Low mintage (613K)' },
  { series: 'barber quarter', year: 1896, mint: 'S', tier: 'semi-key', note: 'Low mintage (188K)' },
  { series: 'barber quarter', year: 1901, mint: 'S', tier: 'key',      note: 'Only 72K minted; major key' },
  { series: 'barber quarter', year: 1913, mint: 'S', tier: 'semi-key', note: 'Low mintage (40K)' },
  { series: 'barber half',    year: 1892, mint: 'O', tier: 'semi-key', note: 'Micro O variety; first year issue' },
  { series: 'barber half',    year: 1897, mint: 'S', tier: 'semi-key', note: 'Low mintage (933K)' },
  { series: 'barber half',    year: 1904, mint: 'S', tier: 'semi-key', note: 'Low mintage (553K)' },
  { series: 'barber half',    year: 1913, mint: '',  tier: 'semi-key', note: 'Low mintage (188K)' },
  { series: 'barber half',    year: 1914, mint: '',  tier: 'semi-key', note: 'Low mintage (124K)' },
  { series: 'barber half',    year: 1915, mint: '',  tier: 'semi-key', note: 'Low mintage (138K)' },

  // ═══════════════════════════════════════════════════════════
  // SEATED LIBERTY
  // ═══════════════════════════════════════════════════════════
  { series: 'seated liberty dollar', year: 1870, mint: 'S', tier: 'key', note: 'Major key date; very few known' },
  { series: 'seated liberty dollar', year: 1871, mint: 'CC', tier: 'key', note: 'Only 1,376 minted; Carson City key' },
  { series: 'seated liberty dollar', year: 1873, mint: 'CC', tier: 'key', note: 'Only 2,300 minted' },

  // ═══════════════════════════════════════════════════════════
  // TRADE DOLLARS
  // ═══════════════════════════════════════════════════════════
  { series: 'trade dollar', year: 1878, mint: 'CC', tier: 'key',      note: 'Only 97K minted business strike' },
  { series: 'trade dollar', year: 1884, mint: '',  tier: 'key',      note: 'Proof only; only 10 known' },
  { series: 'trade dollar', year: 1885, mint: '',  tier: 'key',      note: 'Proof only; only 5 known' },

  // ═══════════════════════════════════════════════════════════
  // AMERICAN SILVER EAGLES (low mintage / key issues)
  // ═══════════════════════════════════════════════════════════
  { series: 'american silver eagle', year: 1986, mint: '',  tier: 'semi-key', note: 'First year issue; collector premium' },
  { series: 'american silver eagle', year: 1994, mint: '',  tier: 'semi-key', note: 'Low mintage (4.2M); condition rarity in MS69/70' },
  { series: 'american silver eagle', year: 1995, mint: 'W', tier: 'key',      note: 'Proof only; lowest mintage ASE proof (30K)' },
  { series: 'american silver eagle', year: 1996, mint: '',  tier: 'key',      note: 'Lowest regular mintage (3.6M)' },
  { series: 'american silver eagle', year: 2008, mint: 'W', tier: 'semi-key', note: 'Burnished — low mintage; popular' },
  { series: 'american silver eagle', year: 2011, mint: 'S', tier: 'semi-key', note: '25th Anniversary set only; limited' },
  { series: 'american silver eagle', year: 2019, mint: 'S', tier: 'semi-key', note: 'Enhanced Reverse Proof; 30K mintage' },
  { series: 'american silver eagle', year: 2021, mint: '',  tier: 'semi-key', note: 'Type 1 / Type 2 transition year; both collected' },

  // ═══════════════════════════════════════════════════════════
  // CANADIAN SILVER MAPLE LEAF (key / semi-key issues)
  // ═══════════════════════════════════════════════════════════
  { series: 'canadian silver maple leaf', year: 1988, mint: '', tier: 'semi-key', note: 'First year issue; collector premium' },
  { series: 'canadian silver maple leaf', year: 1989, mint: '', tier: 'semi-key', note: 'Second year; low mintage (1.1M)' },
  { series: 'canadian silver maple leaf', year: 1998, mint: '', tier: 'semi-key', note: '10th anniversary; Titanic privy mark variety' },
  { series: 'canadian silver maple leaf', year: 2003, mint: '', tier: 'semi-key', note: 'Low mintage year (684K)' },
  { series: 'canadian silver maple leaf', year: 2014, mint: '', tier: 'semi-key', note: 'First year with micro-engraved security mark' },

  // ═══════════════════════════════════════════════════════════
  // SOUTH AFRICAN KRUGERRAND — SILVER (key issues)
  // ═══════════════════════════════════════════════════════════
  { series: 'silver krugerrand', year: 2017, mint: '', tier: 'semi-key', note: 'First year silver Krugerrand; 50th anniversary; 1M mintage' },
  { series: 'silver krugerrand', year: 2018, mint: '', tier: 'semi-key', note: 'Second year; lower mintage (500K)' },

  // ═══════════════════════════════════════════════════════════
  // MEXICAN SILVER LIBERTAD (key / semi-key issues)
  // ═══════════════════════════════════════════════════════════
  { series: 'mexican silver libertad', year: 1982, mint: '', tier: 'semi-key', note: 'First year issue' },
  { series: 'mexican silver libertad', year: 1996, mint: '', tier: 'semi-key', note: 'New design (Winged Victory); first year redesign' },
  { series: 'mexican silver libertad', year: 1998, mint: '', tier: 'semi-key', note: 'Low mintage year' },
  { series: 'mexican silver libertad', year: 2019, mint: '', tier: 'semi-key', note: 'Reverse proof variety; very limited' },
  { series: 'mexican silver libertad', year: 2020, mint: '', tier: 'semi-key', note: 'Low mintage (450K); pandemic year' },
  { series: 'mexican silver libertad', year: 2023, mint: '', tier: 'semi-key', note: 'Lowest mintage year (350K)' },

  // ═══════════════════════════════════════════════════════════
  // AUSTRIAN SILVER PHILHARMONIC (key issues)
  // ═══════════════════════════════════════════════════════════
  { series: 'austrian silver philharmonic', year: 2008, mint: '', tier: 'semi-key', note: 'First year issue; collector premium' },
  { series: 'austrian silver philharmonic', year: 2009, mint: '', tier: 'semi-key', note: 'Second year; still relatively low mintage (7.6M)' },

  // ═══════════════════════════════════════════════════════════
  // BRITISH SILVER BRITANNIA (key / semi-key issues)
  // ═══════════════════════════════════════════════════════════
  { series: 'british silver britannia', year: 1997, mint: '', tier: 'semi-key', note: 'First year issue; only 80K minted' },
  { series: 'british silver britannia', year: 1998, mint: '', tier: 'semi-key', note: 'Second year; low mintage (88K)' },
  { series: 'british silver britannia', year: 1999, mint: '', tier: 'semi-key', note: 'Low mintage (69,913)' },
  { series: 'british silver britannia', year: 2001, mint: '', tier: 'semi-key', note: 'Lowest mintage year (44,816)' },
  { series: 'british silver britannia', year: 2002, mint: '', tier: 'semi-key', note: 'Low mintage (49,816)' },
  { series: 'british silver britannia', year: 2011, mint: '', tier: 'semi-key', note: 'Last year .958 Britannia silver (before .999 switch)' },
  { series: 'british silver britannia', year: 2013, mint: '', tier: 'semi-key', note: 'First year .999 fine silver; snake privy mark' },

  // ═══════════════════════════════════════════════════════════
  // CHINESE SILVER PANDA (key / semi-key issues)
  // ═══════════════════════════════════════════════════════════
  { series: 'chinese silver panda', year: 1983, mint: '', tier: 'key',      note: 'First year silver Panda; only 10K minted' },
  { series: 'chinese silver panda', year: 1984, mint: '', tier: 'key',      note: 'Second year; only 10K minted' },
  { series: 'chinese silver panda', year: 1985, mint: '', tier: 'key',      note: 'Only 10K minted' },
  { series: 'chinese silver panda', year: 1986, mint: '', tier: 'key',      note: 'Only 10K minted' },
  { series: 'chinese silver panda', year: 1987, mint: '', tier: 'key',      note: 'Only 10K minted; last of ultra-low mintage run' },
  { series: 'chinese silver panda', year: 1995, mint: '', tier: 'semi-key', note: 'Low mintage (60K); micro-date variety is key' },
  { series: 'chinese silver panda', year: 1996, mint: '', tier: 'semi-key', note: 'Low mintage (80K)' },
  { series: 'chinese silver panda', year: 2000, mint: '', tier: 'semi-key', note: 'Millennium year; frosted ring variety' },
  { series: 'chinese silver panda', year: 2016, mint: '', tier: 'semi-key', note: 'First year metric weight (30g instead of 1 oz)' },

  // ═══════════════════════════════════════════════════════════
  // AUSTRALIAN SILVER KOOKABURRA (key / semi-key issues)
  // ═══════════════════════════════════════════════════════════
  { series: 'australian silver kookaburra', year: 1990, mint: '', tier: 'semi-key', note: 'First year issue' },
  { series: 'australian silver kookaburra', year: 1995, mint: '', tier: 'semi-key', note: 'Low mintage (107K)' },
  { series: 'australian silver kookaburra', year: 2000, mint: '', tier: 'semi-key', note: 'Millennium year; low mintage (156K)' },
  { series: 'australian silver kookaburra', year: 2001, mint: '', tier: 'semi-key', note: 'Low mintage (100K)' },
  { series: 'australian silver kookaburra', year: 2003, mint: '', tier: 'semi-key', note: 'Low mintage (100K)' },

  // ═══════════════════════════════════════════════════════════
  // PERTH MINT AUSTRALIAN LUNAR — SILVER (key issues)
  // Series I (1999–2010), Series II (2008–2019), Series III (2020–present)
  // ═══════════════════════════════════════════════════════════
  { series: 'australian lunar silver', year: 2020, mint: '', tier: 'semi-key', note: 'First year Series III; Year of the Mouse' },

  // ═══════════════════════════════════════════════════════════
  // BRITANNIA LUNAR — SILVER (Royal Mint, key issues)
  // ═══════════════════════════════════════════════════════════
  { series: 'britannia lunar silver', year: 2014, mint: '', tier: 'semi-key', note: 'First year issue; Year of the Horse; 88,880 mintage' },
  { series: 'britannia lunar silver', year: 2024, mint: '', tier: 'semi-key', note: 'Year of the Dragon; popular design; high mintage' },

  // ═══════════════════════════════════════════════════════════
  // GOLD — ST. GAUDENS DOUBLE EAGLES
  // ═══════════════════════════════════════════════════════════
  { series: 'st. gaudens',                  year: 1907, mint: '',  tier: 'semi-key', note: 'High relief variety (11,250 minted) is major key' },
  { series: 'st gaudens',                   year: 1907, mint: '',  tier: 'semi-key', note: 'High relief variety (11,250 minted) is major key' },
  { series: 'saint gaudens',                year: 1907, mint: '',  tier: 'semi-key', note: 'High relief variety (11,250 minted) is major key' },
  { series: 'saint-gaudens',                year: 1907, mint: '',  tier: 'semi-key', note: 'High relief variety (11,250 minted) is major key' },
  { series: 'saint gaudens double eagle',   year: 1907, mint: '',  tier: 'semi-key', note: 'High relief variety (11,250 minted) is major key' },
  { series: 'st. gaudens',                  year: 1908, mint: '',  tier: 'semi-key', note: 'No Motto / With Motto varieties' },
  { series: 'st gaudens',                   year: 1908, mint: '',  tier: 'semi-key', note: 'No Motto / With Motto varieties' },
  { series: 'saint gaudens',                year: 1908, mint: '',  tier: 'semi-key', note: 'No Motto / With Motto varieties' },
  { series: 'saint-gaudens',                year: 1908, mint: '',  tier: 'semi-key', note: 'No Motto / With Motto varieties' },
  { series: 'saint gaudens double eagle',   year: 1908, mint: '',  tier: 'semi-key', note: 'No Motto / With Motto varieties' },
  { series: 'st. gaudens',                  year: 1927, mint: 'D', tier: 'key',      note: 'Extremely rare; multi-million dollar coin' },
  { series: 'st gaudens',                   year: 1927, mint: 'D', tier: 'key',      note: 'Extremely rare; multi-million dollar coin' },
  { series: 'saint gaudens',                year: 1927, mint: 'D', tier: 'key',      note: 'Extremely rare; multi-million dollar coin' },
  { series: 'saint-gaudens',                year: 1927, mint: 'D', tier: 'key',      note: 'Extremely rare; multi-million dollar coin' },
  { series: 'saint gaudens double eagle',   year: 1927, mint: 'D', tier: 'key',      note: 'Extremely rare; multi-million dollar coin' },
  { series: 'st. gaudens',                  year: 1933, mint: '',  tier: 'key',      note: 'Recalled; only 1 legally owned; sold for $18.9M' },
  { series: 'st gaudens',                   year: 1933, mint: '',  tier: 'key',      note: 'Recalled; only 1 legally owned; sold for $18.9M' },
  { series: 'saint gaudens',                year: 1933, mint: '',  tier: 'key',      note: 'Recalled; only 1 legally owned; sold for $18.9M' },
  { series: 'saint-gaudens',                year: 1933, mint: '',  tier: 'key',      note: 'Recalled; only 1 legally owned; sold for $18.9M' },
  { series: 'saint gaudens double eagle',   year: 1933, mint: '',  tier: 'key',      note: 'Recalled; only 1 legally owned; sold for $18.9M' },

  // ═══════════════════════════════════════════════════════════
  // GOLD — LIBERTY HEAD DOUBLE EAGLES
  // ═══════════════════════════════════════════════════════════
  { series: 'liberty head double eagle', year: 1849, mint: '',  tier: 'key', note: 'Only 1 known (Smithsonian); unique' },
  { series: 'liberty double eagle',      year: 1849, mint: '',  tier: 'key', note: 'Only 1 known (Smithsonian); unique' },
  { series: 'liberty head double eagle', year: 1854, mint: 'O', tier: 'key', note: 'Very rare; under 10 known' },
  { series: 'liberty double eagle',      year: 1854, mint: 'O', tier: 'key', note: 'Very rare; under 10 known' },
  { series: 'liberty head double eagle', year: 1856, mint: 'O', tier: 'semi-key', note: 'Low mintage (2,250)' },
  { series: 'liberty double eagle',      year: 1856, mint: 'O', tier: 'semi-key', note: 'Low mintage (2,250)' },
  { series: 'liberty head double eagle', year: 1861, mint: 'S', tier: 'semi-key', note: 'Civil War era; Paquet reverse variety is major key' },
  { series: 'liberty double eagle',      year: 1861, mint: 'S', tier: 'semi-key', note: 'Civil War era; Paquet reverse variety is major key' },
  { series: 'liberty head double eagle', year: 1870, mint: 'CC', tier: 'key', note: 'First CC $20; only 3,789 minted' },
  { series: 'liberty double eagle',      year: 1870, mint: 'CC', tier: 'key', note: 'First CC $20; only 3,789 minted' },

  // ═══════════════════════════════════════════════════════════
  // GOLD — INDIAN HEAD EAGLES
  // ═══════════════════════════════════════════════════════════
  { series: 'indian head eagle', year: 1907, mint: '',  tier: 'semi-key', note: 'First year issue; wire rim & rolled rim varieties' },
  { series: 'indian eagle',      year: 1907, mint: '',  tier: 'semi-key', note: 'First year issue; wire rim & rolled rim varieties' },
  { series: 'indian head eagle', year: 1911, mint: 'D', tier: 'semi-key', note: 'Low mintage (30K)' },
  { series: 'indian eagle',      year: 1911, mint: 'D', tier: 'semi-key', note: 'Low mintage (30K)' },
  { series: 'indian head eagle', year: 1933, mint: '',  tier: 'key',      note: 'Last year; low mintage (312K); key date' },
  { series: 'indian eagle',      year: 1933, mint: '',  tier: 'key',      note: 'Last year; low mintage (312K); key date' },

  // ═══════════════════════════════════════════════════════════
  // GOLD — INDIAN HEAD QUARTER EAGLES ($2.50)
  // ═══════════════════════════════════════════════════════════
  { series: 'indian quarter eagle', year: 1911, mint: 'D', tier: 'key',      note: 'Only 55K minted; key date of Indian $2.50 series' },
  { series: 'indian quarter eagle', year: 1914, mint: 'D', tier: 'semi-key', note: 'Low mintage (240K)' },

  // ═══════════════════════════════════════════════════════════
  // GOLD — LIBERTY HALF EAGLES ($5)
  // ═══════════════════════════════════════════════════════════
  { series: 'liberty half eagle', year: 1909, mint: 'O', tier: 'semi-key', note: 'Last year New Orleans $5; low mintage' },
  { series: 'liberty half eagle', year: 1875, mint: '',  tier: 'key',      note: 'Very low mintage (200 business strikes)' },
  { series: 'liberty half eagle', year: 1875, mint: 'CC', tier: 'semi-key', note: 'Low mintage (11,828)' },

  // ═══════════════════════════════════════════════════════════
  // AMERICAN GOLD EAGLES (modern bullion key issues)
  // ═══════════════════════════════════════════════════════════
  { series: 'american gold eagle', year: 1986, mint: '',  tier: 'semi-key', note: 'First year issue' },
  { series: 'american gold eagle', year: 1991, mint: '',  tier: 'semi-key', note: 'Low mintage year for 1 oz (243K)' },
  { series: 'american gold eagle', year: 1999, mint: 'W', tier: 'semi-key', note: 'Unfinished proof dies error' },
  { series: 'american gold eagle', year: 2021, mint: '',  tier: 'semi-key', note: 'Type 1 / Type 2 transition year' },

  // ═══════════════════════════════════════════════════════════
  // AMERICAN GOLD BUFFALO
  // ═══════════════════════════════════════════════════════════
  { series: 'american gold buffalo', year: 2006, mint: '', tier: 'semi-key', note: 'First year .9999 gold bullion' },
  { series: 'gold buffalo',          year: 2006, mint: '', tier: 'semi-key', note: 'First year .9999 gold bullion' },

  // ═══════════════════════════════════════════════════════════
  // KENNEDY HALVES
  // ═══════════════════════════════════════════════════════════
  { series: 'kennedy half', year: 1964, mint: '',  tier: 'semi-key', note: 'First year; 90% silver; hugely popular' },
  { series: 'kennedy half', year: 1970, mint: 'D', tier: 'key',      note: 'Only in mint sets; not released for circulation; 40% silver' },
  { series: 'kennedy half', year: 1998, mint: 'S', tier: 'semi-key', note: 'Matte finish; low mintage special issue' },

  // ═══════════════════════════════════════════════════════════
  // 2026 U.S. SEMIQUINCENTENNIAL (250th Anniversary) COINS
  // One-year-only special designs celebrating 250 years of
  // American independence. Circulating & numismatic issues.
  // ═══════════════════════════════════════════════════════════

  // ── Circulating denominations with unique 2026 designs ──
  { series: 'jefferson nickel',  year: 2026, mint: '',  tier: 'semi-key', note: '2026 Semiquincentennial issue; unique one-year-only reverse design celebrating 250th anniversary of American independence' },
  { series: 'jefferson nickel',  year: 2026, mint: 'D', tier: 'semi-key', note: '2026 Semiquincentennial issue; unique one-year-only reverse design' },
  { series: 'jefferson nickel',  year: 2026, mint: 'P', tier: 'semi-key', note: '2026 Semiquincentennial issue; unique one-year-only reverse design' },
  { series: 'roosevelt dime',    year: 2026, mint: '',  tier: 'semi-key', note: '2026 Semiquincentennial issue; unique one-year-only reverse design celebrating 250th anniversary' },
  { series: 'roosevelt dime',    year: 2026, mint: 'D', tier: 'semi-key', note: '2026 Semiquincentennial issue; unique one-year-only reverse design' },
  { series: 'roosevelt dime',    year: 2026, mint: 'P', tier: 'semi-key', note: '2026 Semiquincentennial issue; unique one-year-only reverse design' },
  { series: 'washington quarter', year: 2026, mint: '',  tier: 'semi-key', note: '2026 Semiquincentennial issue; unique one-year-only reverse design celebrating 250th anniversary' },
  { series: 'washington quarter', year: 2026, mint: 'D', tier: 'semi-key', note: '2026 Semiquincentennial issue; unique one-year-only reverse design' },
  { series: 'washington quarter', year: 2026, mint: 'P', tier: 'semi-key', note: '2026 Semiquincentennial issue; unique one-year-only reverse design' },
  { series: 'kennedy half',      year: 2026, mint: '',  tier: 'semi-key', note: '2026 Semiquincentennial issue; unique one-year-only reverse design celebrating 250th anniversary' },
  { series: 'kennedy half',      year: 2026, mint: 'D', tier: 'semi-key', note: '2026 Semiquincentennial issue; unique one-year-only reverse design' },
  { series: 'kennedy half',      year: 2026, mint: 'P', tier: 'semi-key', note: '2026 Semiquincentennial issue; unique one-year-only reverse design' },

  // ── Collectible / numismatic-only denominations (via U.S. Mint) ──
  { series: 'lincoln cent',       year: 2026, mint: '',  tier: 'semi-key', note: '2026 Semiquincentennial collectible cent; special design available through U.S. Mint only' },
  { series: 'lincoln cent',       year: 2026, mint: 'S', tier: 'semi-key', note: '2026 Semiquincentennial proof cent; available through U.S. Mint' },
  { series: 'lincoln cent',       year: 2026, mint: 'W', tier: 'semi-key', note: '2026 Semiquincentennial West Point cent; limited mintage' },
  { series: 'jefferson nickel',   year: 2026, mint: 'S', tier: 'semi-key', note: '2026 Semiquincentennial proof nickel; available through U.S. Mint only' },
  { series: 'jefferson nickel',   year: 2026, mint: 'W', tier: 'semi-key', note: '2026 Semiquincentennial West Point nickel; limited mintage' },

  // ── Special numismatic coins & medals (one-year-only) ──
  { series: '2026 semiquincentennial gold coin',   year: 2026, mint: 'W', tier: 'key', note: '2026 Semiquincentennial $2.50 Gold Coin; one-year-only commemorative; West Point mintage' },
  { series: '2026 semiquincentennial silver medal', year: 2026, mint: 'P', tier: 'semi-key', note: '2026 Semiquincentennial Silver Medal; one-year-only numismatic issue' },
  { series: '2026 semiquincentennial clad half',    year: 2026, mint: 'P', tier: 'semi-key', note: '2026 Semiquincentennial Enhanced Clad Half Dollar; special collector finish' },
  { series: '2026 semiquincentennial silver dollar', year: 2026, mint: 'P', tier: 'semi-key', note: '2026 Semiquincentennial Commemorative Silver Dollar' },
  { series: '2026 semiquincentennial gold $5',       year: 2026, mint: 'W', tier: 'key', note: '2026 Semiquincentennial Commemorative $5 Gold Coin; limited mintage' },
];

// ── Build index for O(1) lookup ──────────────────────────────
const _index = new Map();

for (const entry of KEY_DATES) {
  // Normalize series aliases
  const s = entry.series.toLowerCase().trim();
  // year=0 means "any year" (condition rarity), mint='*' means "any mint"
  const key = `${s}|${entry.year}|${entry.mint.toLowerCase()}`;
  _index.set(key, entry);
}

/**
 * Looks up a coin against the key-dates table.
 * @param {string} series  — Coin series / name (e.g. "Morgan Dollar")
 * @param {number} year    — Year (e.g. 1893)
 * @param {string} mint    — Mint mark (e.g. "S", "CC", "" for Philly)
 * @returns {{ isKeyDate: boolean, tier?: string, note?: string }}
 */
function lookupKeyDate(series, year, mint) {
  if (!series) return { isKeyDate: false };

  const s = series.toLowerCase().trim();
  const m = (mint || '').toLowerCase().trim();

  // 1. Exact match on series + year + mint
  const exact = _index.get(`${s}|${year}|${m}`);
  if (exact) {
    return { isKeyDate: true, tier: exact.tier, note: exact.note };
  }

  // 2. Wildcard mint (e.g. "any Franklin in FBL")
  const wildMint = _index.get(`${s}|${year}|*`);
  if (wildMint) {
    return { isKeyDate: true, tier: wildMint.tier, note: wildMint.note };
  }

  // 3. Wildcard year (condition rarity for entire series)
  const wildYear = _index.get(`${s}|0|*`);
  if (wildYear) {
    return { isKeyDate: true, tier: wildYear.tier, note: wildYear.note };
  }

  // 4. Fuzzy series matching — handle common name variations
  //    e.g. "standing liberty" matches "standing liberty quarter"
  for (const [key, entry] of _index) {
    const [entryS, entryY, entryM] = key.split('|');
    const yearMatch = (parseInt(entryY) === 0) || (parseInt(entryY) === year);
    const mintMatch = (entryM === '*') || entryM === m;
    if (yearMatch && mintMatch) {
      // Check if either contains the other
      if (entryS.includes(s) || s.includes(entryS)) {
        return { isKeyDate: true, tier: entry.tier, note: entry.note };
      }
    }
  }

  return { isKeyDate: false };
}

module.exports = { KEY_DATES, lookupKeyDate };

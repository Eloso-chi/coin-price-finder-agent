#!/usr/bin/env python3
"""Create placeholder CSVs + meta files for Terapeak export backlog."""
import os

TERAPEAK_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'terapeak')

created_csv = 0
created_meta = 0
skipped = 0

def make(filename, search_term):
    """Create empty CSV + meta file if CSV doesn't exist."""
    global created_csv, created_meta, skipped
    csv_path = os.path.join(TERAPEAK_DIR, filename + '.csv')
    meta_path = os.path.join(TERAPEAK_DIR, filename + '.meta')
    if os.path.exists(csv_path):
        skipped += 1
        return
    open(csv_path, 'w').close()
    created_csv += 1
    if not os.path.exists(meta_path):
        with open(meta_path, 'w') as f:
            f.write(search_term)
        created_meta += 1

# ═══════════════════════════════════════════════════════════
# 1. MERCURY DIME  1916-1945  (P, D, S — not all combos every year)
# ═══════════════════════════════════════════════════════════
mercury_mints = {
    1916: ['', 'D', 'S'], 1917: ['', 'D', 'S'], 1918: ['', 'D', 'S'],
    1919: ['', 'D', 'S'], 1920: ['', 'D', 'S'], 1921: ['', 'D'],
    # No Mercury dimes 1922-1930
    1923: ['', 'S'], 1924: ['', 'D', 'S'], 1925: ['', 'D', 'S'],
    1926: ['', 'D', 'S'], 1927: ['', 'D', 'S'], 1928: ['', 'D', 'S'],
    1929: ['', 'D', 'S'], 1930: ['', 'S'],
    1931: ['', 'D', 'S'], 1934: ['', 'D'], 1935: ['', 'D', 'S'],
    1936: ['', 'D', 'S'], 1937: ['', 'D', 'S'], 1938: ['', 'D', 'S'],
    1939: ['', 'D', 'S'], 1940: ['', 'D', 'S'], 1941: ['', 'D', 'S'],
    1942: ['', 'D', 'S'], 1943: ['', 'D', 'S'], 1944: ['', 'D', 'S'],
    1945: ['', 'D', 'S'],
}
print("=== Mercury Dime ===")
for year, mints in sorted(mercury_mints.items()):
    for m in mints:
        suffix = f"-{m}" if m else ""
        make(f"{year}{suffix}_Mercury_Dime", f"{year}{suffix} Mercury Dime")
print(f"  Created: {created_csv} CSVs")
merc_count = created_csv

# ═══════════════════════════════════════════════════════════
# 2. WALKING LIBERTY HALF  1916-1947
# ═══════════════════════════════════════════════════════════
walker_mints = {
    1916: ['', 'D', 'S'], 1917: ['', 'D', 'S'], 1918: ['', 'D', 'S'],
    1919: ['', 'D', 'S'], 1920: ['', 'D', 'S'], 1921: ['', 'D', 'S'],
    # No Walkers 1922-1932
    1933: ['S'], 1934: ['', 'D', 'S'], 1935: ['', 'D', 'S'],
    1936: ['', 'D', 'S'], 1937: ['', 'D', 'S'], 1938: ['', 'D'],
    1939: ['', 'D', 'S'], 1940: ['', 'S'], 1941: ['', 'D', 'S'],
    1942: ['', 'D', 'S'], 1943: ['', 'D', 'S'], 1944: ['', 'D', 'S'],
    1945: ['', 'D', 'S'], 1946: ['', 'D', 'S'], 1947: ['', 'D'],
}
prev = created_csv
print("=== Walking Liberty Half ===")
for year, mints in sorted(walker_mints.items()):
    for m in mints:
        suffix = f"-{m}" if m else ""
        make(f"{year}{suffix}_Walking_Liberty_Half", f"{year}{suffix} Walking Liberty Half Dollar")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# 3. STANDING LIBERTY QUARTER  1916-1930
# ═══════════════════════════════════════════════════════════
slq_mints = {
    1916: [''], 1917: ['', 'D', 'S'], 1918: ['', 'D', 'S'],
    1919: ['', 'D', 'S'], 1920: ['', 'D', 'S'], 1921: [''],
    1923: ['', 'S'], 1924: ['', 'D', 'S'], 1925: [''],
    1926: ['', 'D', 'S'], 1927: ['', 'D', 'S'], 1928: ['', 'D', 'S'],
    1929: ['', 'D', 'S'], 1930: ['', 'S'],
}
prev = created_csv
print("=== Standing Liberty Quarter ===")
for year, mints in sorted(slq_mints.items()):
    for m in mints:
        suffix = f"-{m}" if m else ""
        make(f"{year}{suffix}_Standing_Liberty_Quarter", f"{year}{suffix} Standing Liberty Quarter")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# 4. BUFFALO NICKEL  1913-1938
# ═══════════════════════════════════════════════════════════
buffalo_mints = {
    1913: ['', 'D', 'S'], 1914: ['', 'D', 'S'], 1915: ['', 'D', 'S'],
    1916: ['', 'D', 'S'], 1917: ['', 'D', 'S'], 1918: ['', 'D', 'S'],
    1919: ['', 'D', 'S'], 1920: ['', 'D', 'S'], 1921: ['', 'S'],
    1923: ['', 'S'], 1924: ['', 'D', 'S'], 1925: ['', 'D', 'S'],
    1926: ['', 'D', 'S'], 1927: ['', 'D', 'S'], 1928: ['', 'D', 'S'],
    1929: ['', 'D', 'S'], 1930: ['', 'S'], 1931: ['S'],
    1934: ['', 'D'], 1935: ['', 'D', 'S'], 1936: ['', 'D', 'S'],
    1937: ['', 'D', 'S'], 1938: ['D'],
}
prev = created_csv
print("=== Buffalo Nickel ===")
for year, mints in sorted(buffalo_mints.items()):
    for m in mints:
        suffix = f"-{m}" if m else ""
        make(f"{year}{suffix}_Buffalo_Nickel", f"{year}{suffix} Buffalo Nickel")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# 5. BARBER DIME  1892-1916 (fill gaps beyond what we have)
# ═══════════════════════════════════════════════════════════
barber_dime_mints = {
    1892: ['', 'O', 'S'], 1893: ['', 'O', 'S'], 1894: ['', 'O', 'S'],
    1895: ['', 'O', 'S'], 1896: ['', 'O', 'S'], 1897: ['', 'O', 'S'],
    1898: ['', 'O', 'S'], 1899: ['', 'O', 'S'], 1900: ['', 'O', 'S'],
    1901: ['', 'O', 'S'], 1902: ['', 'O', 'S'], 1903: ['', 'O', 'S'],
    1904: ['', 'S'], 1905: ['', 'O', 'S'], 1906: ['', 'D', 'O', 'S'],
    1907: ['', 'D', 'O', 'S'], 1908: ['', 'D', 'O', 'S'],
    1909: ['', 'D', 'O', 'S'], 1910: ['', 'D', 'S'], 1911: ['', 'D', 'S'],
    1912: ['', 'D', 'S'], 1913: ['', 'S'], 1914: ['', 'D', 'S'],
    1915: ['', 'S'], 1916: ['', 'S'],
}
prev = created_csv
print("=== Barber Dime ===")
for year, mints in sorted(barber_dime_mints.items()):
    for m in mints:
        suffix = f"-{m}" if m else ""
        make(f"{year}{suffix}_Barber_Dime", f"{year}{suffix} Barber Dime")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# 6. BARBER QUARTER  1892-1916
# ═══════════════════════════════════════════════════════════
barber_q_mints = {
    1892: ['', 'O', 'S'], 1893: ['', 'O', 'S'], 1894: ['', 'O', 'S'],
    1895: ['', 'O', 'S'], 1896: ['', 'O', 'S'], 1897: ['', 'O', 'S'],
    1898: ['', 'O', 'S'], 1899: ['', 'O', 'S'], 1900: ['', 'O', 'S'],
    1901: ['', 'O', 'S'], 1902: ['', 'O', 'S'], 1903: ['', 'O', 'S'],
    1904: ['', 'O'], 1905: ['', 'O', 'S'], 1906: ['', 'D', 'O'],
    1907: ['', 'D', 'O', 'S'], 1908: ['', 'D', 'O', 'S'],
    1909: ['', 'D', 'O', 'S'], 1910: ['', 'D'], 1911: ['', 'D', 'S'],
    1912: ['', 'S'], 1913: ['', 'D', 'S'], 1914: ['', 'D', 'S'],
    1915: ['', 'D', 'S'], 1916: ['', 'D'],
}
prev = created_csv
print("=== Barber Quarter ===")
for year, mints in sorted(barber_q_mints.items()):
    for m in mints:
        suffix = f"-{m}" if m else ""
        make(f"{year}{suffix}_Barber_Quarter", f"{year}{suffix} Barber Quarter")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# 7. BARBER HALF DOLLAR  1892-1915
# ═══════════════════════════════════════════════════════════
barber_h_mints = {
    1892: ['', 'O', 'S'], 1893: ['', 'O', 'S'], 1894: ['', 'O', 'S'],
    1895: ['', 'O', 'S'], 1896: ['', 'O', 'S'], 1897: ['', 'O', 'S'],
    1898: ['', 'O', 'S'], 1899: ['', 'O', 'S'], 1900: ['', 'O', 'S'],
    1901: ['', 'O', 'S'], 1902: ['', 'O', 'S'], 1903: ['', 'O', 'S'],
    1904: ['', 'O', 'S'], 1905: ['', 'O', 'S'], 1906: ['', 'D', 'O', 'S'],
    1907: ['', 'D', 'O', 'S'], 1908: ['', 'D', 'O', 'S'],
    1909: ['', 'O', 'S'], 1910: ['', 'S'], 1911: ['', 'D', 'S'],
    1912: ['', 'D', 'S'], 1913: ['', 'D', 'S'], 1914: ['', 'S'],
    1915: ['', 'D', 'S'],
}
prev = created_csv
print("=== Barber Half Dollar ===")
for year, mints in sorted(barber_h_mints.items()):
    for m in mints:
        suffix = f"-{m}" if m else ""
        make(f"{year}{suffix}_Barber_Half_Dollar", f"{year}{suffix} Barber Half Dollar")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# 8. INDIAN HEAD CENT  key dates 1859-1909
# ═══════════════════════════════════════════════════════════
indian_cents = [
    (1859, ''), (1860, ''), (1861, ''), (1864, ''), (1866, ''), (1867, ''),
    (1868, ''), (1869, ''), (1870, ''), (1871, ''), (1872, ''), (1873, ''),
    (1874, ''), (1875, ''), (1876, ''), (1877, ''), (1878, ''),
    (1879, ''), (1880, ''), (1881, ''), (1882, ''), (1883, ''),
    (1884, ''), (1885, ''), (1886, ''), (1887, ''), (1888, ''),
    (1889, ''), (1890, ''), (1891, ''), (1892, ''), (1893, ''),
    (1894, ''), (1895, ''), (1896, ''), (1897, ''), (1898, ''),
    (1899, ''), (1900, ''), (1901, ''), (1902, ''), (1903, ''),
    (1904, ''), (1905, ''), (1906, ''), (1907, ''), (1908, ''), (1908, 'S'),
    (1909, ''), (1909, 'S'),
]
prev = created_csv
print("=== Indian Head Cent ===")
for year, m in indian_cents:
    suffix = f"-{m}" if m else ""
    make(f"{year}{suffix}_Indian_Head_Cent", f"{year}{suffix} Indian Head Cent")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# 9. EISENHOWER DOLLAR  1971-1978
# ═══════════════════════════════════════════════════════════
ike_mints = {
    1971: ['', 'D', 'S'], 1972: ['', 'D', 'S'], 1973: ['', 'D', 'S'],
    1974: ['', 'D', 'S'], 1976: ['', 'D', 'S'], # Bicentennial
    1977: ['', 'D'], 1978: ['', 'D'],
}
prev = created_csv
print("=== Eisenhower Dollar ===")
for year, mints in sorted(ike_mints.items()):
    for m in mints:
        suffix = f"-{m}" if m else ""
        make(f"{year}{suffix}_Eisenhower_Dollar", f"{year}{suffix} Eisenhower Dollar")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# 10. LINCOLN CENT KEY DATES
# ═══════════════════════════════════════════════════════════
lincoln_keys = [
    (1909, 'S', 'VDB'), (1909, 'S', ''), (1909, '', 'VDB'),
    (1910, 'S', ''), (1911, 'S', ''), (1911, 'D', ''),
    (1912, 'S', ''), (1912, 'D', ''), (1913, 'S', ''), (1914, 'D', ''),
    (1914, 'S', ''), (1915, 'S', ''),
    (1922, '', 'No_D'), (1924, 'D', ''), (1926, 'S', ''),
    (1931, 'S', ''), (1933, 'D', ''),
    (1943, '', 'Steel'), (1943, 'D', 'Steel'), (1943, 'S', 'Steel'),
    (1944, '', ''), (1944, 'D', ''), (1944, 'S', ''),
    (1955, '', 'DDO'),
]
prev = created_csv
print("=== Lincoln Cent Keys ===")
for year, m, var in lincoln_keys:
    suffix = f"-{m}" if m else ""
    var_suffix = f"_{var}" if var else ""
    name = f"{year}{suffix}_Lincoln_Wheat_Cent{var_suffix}"
    search = f"{year}{suffix} Lincoln Wheat Cent {var}".strip()
    make(name, search)
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# 11. JEFFERSON NICKEL SILVER WAR  1942-1945
# ═══════════════════════════════════════════════════════════
jeff_war = [
    (1942, 'P'), (1942, 'S'),
    (1943, 'P'), (1943, 'D'), (1943, 'S'),
    (1944, 'P'), (1944, 'D'), (1944, 'S'),
    (1945, 'P'), (1945, 'D'), (1945, 'S'),
]
prev = created_csv
print("=== Jefferson Silver War Nickel ===")
for year, m in jeff_war:
    make(f"{year}-{m}_Jefferson_War_Nickel", f"{year}-{m} Jefferson Silver War Nickel")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# 12. SEATED LIBERTY KEY DATES (Dollar, Half, Quarter, Dime)
# ═══════════════════════════════════════════════════════════
seated_keys = [
    # Dollars
    ('Seated_Liberty_Dollar', 'Seated Liberty Dollar', [
        (1840, ''), (1846, 'O'), (1850, ''), (1850, 'O'),
        (1854, ''), (1855, ''), (1859, 'S'), (1860, 'O'),
        (1866, ''), (1870, 'CC'), (1870, 'S'), (1871, 'CC'),
        (1872, 'CC'), (1873, 'CC'),
    ]),
    # Halves
    ('Seated_Liberty_Half_Dollar', 'Seated Liberty Half Dollar', [
        (1839, 'O'), (1844, 'O'), (1846, 'O'), (1853, 'O'),
        (1855, 'S'), (1861, 'O'), (1866, 'S'), (1870, 'CC'),
        (1871, 'CC'), (1872, 'CC'), (1873, 'CC'), (1874, 'CC'),
        (1878, 'CC'),
    ]),
    # Quarters
    ('Seated_Liberty_Quarter', 'Seated Liberty Quarter', [
        (1849, 'O'), (1851, 'O'), (1852, 'O'), (1854, 'O'),
        (1855, 'S'), (1860, 'S'), (1864, 'S'), (1870, 'CC'),
        (1871, 'CC'), (1872, 'CC'), (1873, 'CC'),
    ]),
    # Dimes
    ('Seated_Liberty_Dime', 'Seated Liberty Dime', [
        (1844, ''), (1846, ''), (1849, 'O'), (1859, 'S'),
        (1860, 'S'), (1863, 'S'), (1864, 'S'), (1871, 'CC'),
        (1872, 'CC'), (1873, 'CC'),
    ]),
]
prev = created_csv
print("=== Seated Liberty Keys ===")
for file_series, search_series, dates in seated_keys:
    for year, m in dates:
        suffix = f"-{m}" if m else ""
        make(f"{year}{suffix}_{file_series}", f"{year}{suffix} {search_series}")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# 13. TRADE DOLLAR  1873-1885 key dates
# ═══════════════════════════════════════════════════════════
trade_mints = {
    1873: ['', 'CC', 'S'], 1874: ['', 'CC', 'S'], 1875: ['', 'CC', 'S'],
    1876: ['', 'CC', 'S'], 1877: ['', 'CC', 'S'], 1878: ['', 'CC', 'S'],
    1879: [''], 1880: [''], 1881: [''], 1882: [''], 1883: [''],
    # 1884-1885 are proof-only, very rare
}
prev = created_csv
print("=== Trade Dollar ===")
for year, mints in sorted(trade_mints.items()):
    for m in mints:
        suffix = f"-{m}" if m else ""
        make(f"{year}{suffix}_Trade_Dollar", f"{year}{suffix} Trade Dollar")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# 14. LIBERTY NICKEL  1883-1912 (key dates + common)
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== Liberty V Nickel ===")
for year in range(1883, 1913):
    if year in (1884, 1886, 1894, 1895, 1896, 1897, 1898, 1899, 1900,
                1901, 1902, 1903, 1904, 1905, 1906, 1907, 1908, 1909, 1910, 1911, 1912):
        # Common dates -- still worth scraping
        make(f"{year}_Liberty_V_Nickel", f"{year} Liberty V Nickel")
    elif year == 1885:
        make(f"{year}_Liberty_V_Nickel", f"{year} Liberty V Nickel")  # semi-key
    elif year == 1883:
        make(f"1883_Liberty_V_Nickel_No_Cents", f"1883 Liberty V Nickel No Cents")
        make(f"1883_Liberty_V_Nickel_With_Cents", f"1883 Liberty V Nickel With Cents")
    elif year == 1886:
        make(f"{year}_Liberty_V_Nickel", f"{year} Liberty V Nickel")
    elif year in (1893,):
        make(f"{year}_Liberty_V_Nickel", f"{year} Liberty V Nickel")
    else:
        make(f"{year}_Liberty_V_Nickel", f"{year} Liberty V Nickel")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# 15. SHIELD NICKEL key dates  1866-1883
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== Shield Nickel ===")
for year in [1866, 1867, 1868, 1869, 1870, 1871, 1872, 1873, 1874, 1875, 1876, 1877, 1878, 1879, 1880, 1881, 1882, 1883]:
    make(f"{year}_Shield_Nickel", f"{year} Shield Nickel")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# 16. CAPPED BUST HALF DOLLAR key dates  1807-1839
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== Capped Bust Half Dollar ===")
for year in [1807, 1808, 1809, 1810, 1811, 1812, 1813, 1814, 1815,
             1817, 1818, 1819, 1820, 1821, 1822, 1823, 1824, 1825,
             1826, 1827, 1828, 1829, 1830, 1831, 1832, 1833, 1834,
             1835, 1836, 1837, 1838, 1839]:
    make(f"{year}_Capped_Bust_Half_Dollar", f"{year} Capped Bust Half Dollar")
print(f"  Created: {created_csv - prev} CSVs")

type_coin_total = created_csv
print(f"\n{'='*50}")
print(f"US TYPE COINS TOTAL: {type_coin_total} new CSVs, {created_meta} new metas, {skipped} skipped (already existed)")
print(f"{'='*50}\n")

# ═══════════════════════════════════════════════════════════════
# BULLION YEAR-BY-YEAR
# ═══════════════════════════════════════════════════════════════

bullion_start = created_csv

# ═══════════════════════════════════════════════════════════
# B1. AMERICAN GOLD EAGLE 1oz  1986-2025
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== American Gold Eagle 1oz ===")
for year in range(1986, 2026):
    make(f"{year}_American_Gold_Eagle_1oz", f"{year} American Gold Eagle 1 oz")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# B2. AMERICAN GOLD BUFFALO  2006-2025
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== American Gold Buffalo ===")
for year in range(2006, 2026):
    make(f"{year}_American_Gold_Buffalo", f"{year} American Gold Buffalo 1 oz")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# B3. CHINESE SILVER PANDA  1983-2025
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== Chinese Silver Panda ===")
for year in range(1983, 2026):
    if year <= 2015:
        make(f"{year}_Chinese_Silver_Panda_1oz", f"{year} China 1 oz Silver Panda")
    else:
        make(f"{year}_Chinese_Silver_Panda_30g", f"{year} China 30g Silver Panda")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# B4. CHINESE GOLD PANDA  1982-2025
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== Chinese Gold Panda ===")
for year in range(1982, 2026):
    if year <= 2015:
        make(f"{year}_Chinese_Gold_Panda_1oz", f"{year} China 1 oz Gold Panda")
    else:
        make(f"{year}_Chinese_Gold_Panda_30g", f"{year} China 30g Gold Panda")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# B5. CANADIAN SILVER MAPLE LEAF  1988-2025
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== Canadian Silver Maple Leaf ===")
for year in range(1988, 2026):
    make(f"{year}_Canadian_Silver_Maple_Leaf_1oz", f"{year} Canada 1 oz Silver Maple Leaf")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# B6. CANADIAN GOLD MAPLE LEAF  1979-2025
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== Canadian Gold Maple Leaf ===")
for year in range(1979, 2026):
    make(f"{year}_Canadian_Gold_Maple_Leaf_1oz", f"{year} Canada 1 oz Gold Maple Leaf")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# B7. GOLD KRUGERRAND  1967-2025 (focus on 1970+)
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== Gold Krugerrand ===")
# Canonical form per #246 PR A: drop "South Africa" prefix (Krugerrand is implicitly
# South African), collapse "1 oz" -> "1oz", reorder to match CSV filename convention.
for year in range(1967, 2026):
    make(f"{year}_Gold_Krugerrand_1oz", f"{year} Gold Krugerrand 1oz")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# B8. BRITISH SILVER BRITANNIA  1997-2025
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== British Silver Britannia ===")
# Canonical form per #246 PR A: "Great Britain" -> "British", collapse "1 oz" -> "1oz",
# reorder to match CSV filename convention.
for year in range(1997, 2026):
    make(f"{year}_British_Silver_Britannia_1oz", f"{year} British Silver Britannia 1oz")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# B9. BRITISH GOLD BRITANNIA  1987-2025
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== British Gold Britannia ===")
# Canonical form per #246 PR A: "Great Britain" -> "British", collapse "1 oz" -> "1oz",
# reorder to match CSV filename convention.
for year in range(1987, 2026):
    make(f"{year}_British_Gold_Britannia_1oz", f"{year} British Gold Britannia 1oz")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# B10. AUSTRIAN SILVER PHILHARMONIC  2008-2025
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== Austrian Silver Philharmonic ===")
for year in range(2008, 2026):
    make(f"{year}_Austrian_Silver_Philharmonic_1oz", f"{year} Austria 1 oz Silver Philharmonic")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# B11. AUSTRIAN GOLD PHILHARMONIC  1989-2025
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== Austrian Gold Philharmonic ===")
for year in range(1989, 2026):
    make(f"{year}_Austrian_Gold_Philharmonic_1oz", f"{year} Austria 1 oz Gold Philharmonic")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# B12. AUSTRALIAN GOLD KANGAROO  1986-2025
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== Australian Gold Kangaroo ===")
for year in range(1986, 2026):
    make(f"{year}_Australian_Gold_Kangaroo_1oz", f"{year} Australia 1 oz Gold Kangaroo")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# B13. AUSTRALIAN SILVER KOOKABURRA  1990-2025
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== Australian Silver Kookaburra ===")
for year in range(1990, 2026):
    make(f"{year}_Australian_Silver_Kookaburra_1oz", f"{year} Australia 1 oz Silver Kookaburra")
print(f"  Created: {created_csv - prev} CSVs")

# ═══════════════════════════════════════════════════════════
# B14. MEXICAN GOLD LIBERTAD  1981-2025
# ═══════════════════════════════════════════════════════════
prev = created_csv
print("=== Mexican Gold Libertad ===")
for year in range(1981, 2026):
    make(f"{year}_Mexican_Gold_Libertad_1oz", f"{year} Mexico 1 oz Gold Libertad")
print(f"  Created: {created_csv - prev} CSVs")

bullion_total = created_csv - bullion_start
print(f"\n{'='*50}")
print(f"BULLION YEAR-BY-YEAR TOTAL: {bullion_total} new CSVs")
print(f"{'='*50}\n")

print(f"GRAND TOTAL: {created_csv} new CSVs, {created_meta} new metas, {skipped} skipped")

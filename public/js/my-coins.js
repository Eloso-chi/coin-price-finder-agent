// my-coins.js — "My Coins" tab: decrypt inventory, fetch pricing, render table
// Depends on: CoinCrypto, CoinStorage, CoinAuth, _esc (from index.html)

'use strict';

const MyCoins = (() => {
  const MAX_BATCH = 25;
  const CONCURRENCY = 3;
  const STAGGER_MS = 400;

  let _container = null;
  let _loading = false;
  let _lastPriced = null;   // cached priced items for re-sort/re-filter without re-fetch
  let _sortCol = 'coin';
  let _sortAsc = true;
  let _filterText = '';

  function init() {
    _container = document.getElementById('mycoins-content');
  }

  /**
   * Load, decrypt, price, and render the My Coins table.
   */
  async function render() {
    if (!_container) init();
    if (!_container) return;

    const user = CoinAuth.currentUser();
    if (!user) {
      _container.innerHTML =
        '<div class="mycoins-empty">' +
        '<p>Log in to view your coin collection.</p>' +
        '</div>';
      return;
    }

    if (_loading) return;
    _loading = true;
    _container.innerHTML = '<p class="mycoins-loading">Decrypting inventory\u2026</p>';

    try {
      const coins = await CoinStorage.getAllDecrypted(user.userId, user.key);
      if (!coins.length) {
        _lastPriced = null;
        _container.innerHTML =
          '<div class="mycoins-empty">' +
          '<p>No coins in your collection yet.</p>' +
          '<p style="color:var(--text-muted);font-size:0.85rem">Use the "I have this coin" button on any Price Discovery result to add coins.</p>' +
          '</div>';
        _loading = false;
        return;
      }

      _container.innerHTML = '<p class="mycoins-loading">Fetching pricing for ' + coins.length + ' coin(s)\u2026</p>';

      // Fetch pricing in parallel with throttling
      const priced = await _fetchPricing(coins);
      _lastPriced = priced;
      _renderTable(priced);
    } catch (err) {
      _container.innerHTML = '<div class="mycoins-error">Error: ' + _esc(err.message) + '</div>';
    } finally {
      _loading = false;
    }
  }

  /**
   * Fetch pricing for an array of decrypted coins.
   * Uses POST /api/price individually (same as normal search), throttled.
   */
  async function _fetchPricing(coins) {
    const results = new Array(coins.length);
    let idx = 0;

    async function worker() {
      while (idx < coins.length) {
        const i = idx++;
        const coin = coins[i];
        try {
          const query = coin.query || _buildQuery(coin);
          const resp = await fetch('/api/price', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query,
              coinData: {
                name: coin.series || '',
                year: coin.year ? Number(coin.year) : undefined,
                mintMark: coin.mint || '',
                grade: coin.grade || '',
                weight: coin.weight || null,
              },
              options: { timeWindowDays: 90, usMinComps: 3, maxPages: 1 },
            }),
          });
          if (resp.ok) {
            const data = await resp.json();
            results[i] = {
              coin,
              fmv: data.valuation?.fmvCore || null,
              rangeLow: data.valuation?.rangeLow || null,
              rangeHigh: data.valuation?.rangeHigh || null,
              avgEbay: data.ebay?.us?.stats?.median || data.ebay?.us?.stats?.mean || null,
              confidence: data.valuation?.confidence || null,
            };
          } else {
            results[i] = { coin, fmv: null, avgEbay: null, confidence: null, pricingError: 'Server returned ' + resp.status };
          }
        } catch (e) {
          results[i] = { coin, fmv: null, avgEbay: null, confidence: null, pricingError: e.message || 'Network error' };
        }
        // Stagger to avoid hammering
        if (idx < coins.length) await _sleep(STAGGER_MS);
      }
    }

    // Launch workers
    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, coins.length); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results.filter(Boolean);
  }

  function _buildQuery(coin) {
    const parts = [];
    if (coin.year) parts.push(String(coin.year));
    if (coin.mint && coin.mint !== 'P') parts.push(coin.mint);
    if (coin.series) parts.push(coin.series);
    if (coin.grade) parts.push(coin.grade);
    return parts.join(' ');
  }

  function _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function _$(v) {
    if (v == null || isNaN(v)) return '\u2014';
    return '$' + Number(v).toFixed(2);
  }

  function _coinLabel(c) {
    return [c.year, c.mint && c.mint !== 'P' ? c.mint : '', c.series].filter(Boolean).join(' ');
  }

  /** Filter items by search text (matches coin label, grade, year) */
  function _applyFilter(items) {
    if (!_filterText) return items;
    const q = _filterText.toLowerCase();
    return items.filter(it => {
      const c = it.coin;
      const text = (_coinLabel(c) + ' ' + (c.grade || '') + ' ' + (c.year || '')).toLowerCase();
      return text.includes(q);
    });
  }

  /** Sort items by current _sortCol / _sortAsc */
  function _applySort(items) {
    const sorted = items.slice();
    sorted.sort((a, b) => {
      let va, vb;
      switch (_sortCol) {
        case 'coin':
          va = _coinLabel(a.coin).toLowerCase(); vb = _coinLabel(b.coin).toLowerCase();
          return va < vb ? -1 : va > vb ? 1 : 0;
        case 'grade':
          va = (a.coin.grade || '').toLowerCase(); vb = (b.coin.grade || '').toLowerCase();
          return va < vb ? -1 : va > vb ? 1 : 0;
        case 'qty':
          va = a.coin.count || 1; vb = b.coin.count || 1; return va - vb;
        case 'fmv':
          va = a.fmv || 0; vb = b.fmv || 0; return va - vb;
        case 'total':
          va = (a.fmv || 0) * (a.coin.count || 1);
          vb = (b.fmv || 0) * (b.coin.count || 1);
          return va - vb;
        case 'ebay':
          va = a.avgEbay || 0; vb = b.avgEbay || 0; return va - vb;
        case 'added':
          va = a.coin.dateAdded || ''; vb = b.coin.dateAdded || '';
          return va < vb ? -1 : va > vb ? 1 : 0;
        default: return 0;
      }
    });
    if (!_sortAsc) sorted.reverse();
    return sorted;
  }

  function _sortArrow(col) {
    if (_sortCol !== col) return '';
    return _sortAsc ? ' \u25B2' : ' \u25BC';
  }

  function _renderTable(items) {
    const filtered = _applySort(_applyFilter(items));

    // Compute totals over ALL items (not filtered)
    let totalFMV = 0;
    let totalUnits = 0;
    let pricedCount = 0;
    items.forEach(it => {
      const qty = it.coin.count || 1;
      totalUnits += qty;
      if (it.fmv != null && !isNaN(it.fmv)) { totalFMV += it.fmv * qty; pricedCount++; }
    });

    let html = '';

    // Portfolio summary
    html += '<div class="mycoins-summary">';
    html += '<div class="mycoins-total">';
    html += '<span class="mycoins-total-label">Portfolio Value</span>';
    html += '<span class="mycoins-total-value">' + _$(totalFMV) + '</span>';
    html += '</div>';
    html += '<div class="mycoins-count">';
    html += items.length + ' type(s), ' + totalUnits + ' coin(s)';
    if (pricedCount < items.length) html += ' &middot; ' + pricedCount + ' priced';
    html += '</div>';
    html += '</div>';

    // Search / filter bar
    html += '<div class="mycoins-filter-bar">';
    html += '<input type="text" class="mycoins-filter-input" placeholder="Search coins\u2026" value="' + _esc(_filterText) + '">';
    if (_filterText) html += '<span class="mycoins-filter-count">' + filtered.length + ' of ' + items.length + '</span>';
    html += '</div>';

    // Table
    html += '<div class="mycoins-table-wrap"><table class="mycoins-table">';
    html += '<thead><tr>';
    html += '<th class="mycoins-sortable" data-col="coin">Coin' + _sortArrow('coin') + '</th>';
    html += '<th class="mycoins-sortable" data-col="grade">Grade' + _sortArrow('grade') + '</th>';
    html += '<th class="mycoins-sortable mycoins-qty-col" data-col="qty">Qty' + _sortArrow('qty') + '</th>';
    html += '<th class="mycoins-sortable" data-col="fmv">FMV (ea)' + _sortArrow('fmv') + '</th>';
    html += '<th class="mycoins-sortable" data-col="total">Total' + _sortArrow('total') + '</th>';
    html += '<th class="mycoins-sortable" data-col="ebay">Avg eBay' + _sortArrow('ebay') + '</th>';
    html += '<th>Range</th>';
    html += '<th class="mycoins-sortable" data-col="added">Added' + _sortArrow('added') + '</th>';
    html += '<th></th>';
    html += '</tr></thead><tbody>';

    filtered.forEach(it => {
      const c = it.coin;
      const label = _coinLabel(c);
      const qty = c.count || 1;
      const added = c.dateAdded ? new Date(c.dateAdded).toLocaleDateString() : '\u2014';
      const range = (it.rangeLow != null && it.rangeHigh != null)
        ? _$(it.rangeLow) + ' \u2013 ' + _$(it.rangeHigh)
        : '\u2014';
      const lineTotal = (it.fmv != null && !isNaN(it.fmv)) ? it.fmv * qty : null;

      html += '<tr>';
      html += '<td>' + _esc(label) + '</td>';
      html += '<td>' + _esc(c.grade || '\u2014') + '</td>';

      // Qty cell with inline +/- controls
      html += '<td class="mycoins-qty-cell">';
      html += '<button class="mycoins-qty-btn" data-hash="' + _esc(c.coinHash) + '" data-delta="-1" title="Decrease quantity">&minus;</button>';
      html += '<span class="mycoins-qty-val">' + qty + '</span>';
      html += '<button class="mycoins-qty-btn" data-hash="' + _esc(c.coinHash) + '" data-delta="1" title="Increase quantity">+</button>';
      html += '</td>';

      const fmvCell = it.fmv != null ? _$(it.fmv) + (it.confidence ? ' <span style="opacity:0.6;font-size:0.85em">(' + _esc(it.confidence) + ')</span>' : '')
        : (it.pricingError ? '<span style="color:var(--text-muted);font-size:0.8em" title="' + _esc(it.pricingError) + '">No data</span>' : '\u2014');
      html += '<td class="mycoins-fmv">' + fmvCell + '</td>';
      html += '<td class="mycoins-fmv">' + _$(lineTotal) + '</td>';
      html += '<td>' + _$(it.avgEbay) + '</td>';
      html += '<td class="mycoins-range">' + range + '</td>';
      html += '<td class="mycoins-date">' + _esc(added) + '</td>';
      html += '<td><button class="mycoins-remove" data-hash="' + _esc(c.coinHash) + '" title="Remove from collection">&times;</button></td>';
      html += '</tr>';
    });

    html += '</tbody></table></div>';
    _container.innerHTML = html;

    // Bind search filter
    const filterInput = _container.querySelector('.mycoins-filter-input');
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        _filterText = filterInput.value;
        _renderTable(items);
      });
      // Restore focus to search input after re-render
      if (_filterText) {
        filterInput.focus();
        filterInput.setSelectionRange(filterInput.value.length, filterInput.value.length);
      }
    }

    // Bind sortable headers
    _container.querySelectorAll('.mycoins-sortable').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.getAttribute('data-col');
        if (_sortCol === col) { _sortAsc = !_sortAsc; }
        else { _sortCol = col; _sortAsc = true; }
        _renderTable(items);
      });
    });

    // Bind qty +/- buttons
    _container.querySelectorAll('.mycoins-qty-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const hash = btn.getAttribute('data-hash');
        const delta = parseInt(btn.getAttribute('data-delta'), 10);
        const user = CoinAuth.currentUser();
        if (!user || !hash) return;
        const item = items.find(it => it.coin.coinHash === hash);
        if (!item) return;
        const oldQty = item.coin.count || 1;
        const newQty = oldQty + delta;
        if (newQty < 1) return; // can't go below 1; use remove button
        btn.disabled = true;
        try {
          await CoinStorage.updateCount(user.userId, user.key, hash, newQty);
          item.coin.count = newQty;
          _renderTable(items);
        } catch { btn.disabled = false; }
      });
    });

    // Bind remove buttons
    _container.querySelectorAll('.mycoins-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const hash = btn.getAttribute('data-hash');
        const user = CoinAuth.currentUser();
        if (!user || !hash) return;
        const item = items.find(it => it.coin.coinHash === hash);
        const qty = item ? (item.coin.count || 1) : 1;
        const msg = qty > 1
          ? 'Remove all ' + qty + ' of this coin from your collection?'
          : 'Remove this coin from your collection?';
        if (!confirm(msg)) return;
        await CoinStorage.removeCoin(user.userId, hash);
        render();
      });
    });
  }

  return { init, render };
})();

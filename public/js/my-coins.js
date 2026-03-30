// my-coins.js — "My Coins" tab: decrypt inventory, fetch pricing, render table
// Depends on: CoinCrypto, CoinStorage, CoinAuth, _esc, _escAttr (from index.html)

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
  let _filterTimer = null;
  let _page = 0;
  const PAGE_SIZE = 50;

  // Spot price cache (fetched once per render)
  let _spotPrices = null;  // { silver: number, gold: number } | null

  /**
   * Dark-themed confirmation dialog (replaces native confirm()).
   * Returns a Promise<boolean>.
   */
  function _confirm(msg) {
    return new Promise(resolve => {
      const dlg = document.getElementById('confirm-dialog');
      if (!dlg) { resolve(confirm(msg)); return; }
      document.getElementById('confirm-dialog-msg').textContent = msg;
      const yesBtn = document.getElementById('confirm-dialog-yes');
      const noBtn  = document.getElementById('confirm-dialog-no');
      function cleanup(result) {
        yesBtn.removeEventListener('click', onYes);
        noBtn.removeEventListener('click', onNo);
        dlg.removeEventListener('close', onClose);
        if (dlg.open) dlg.close();
        resolve(result);
      }
      function onYes()  { cleanup(true); }
      function onNo()   { cleanup(false); }
      function onClose() { cleanup(false); }
      yesBtn.addEventListener('click', onYes);
      noBtn.addEventListener('click', onNo);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      noBtn.focus();
    });
  }

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

      _container.innerHTML = '<p class="mycoins-loading" role="status" aria-live="polite">Fetching pricing for ' + coins.length + ' coin(s)\u2026</p>';

      // Fetch spot prices (for melt value) and pricing in parallel
      _spotPrices = await _fetchSpotPrices();
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
        // Update progress
        var done = results.filter(Boolean).length;
        var el = _container && _container.querySelector('.mycoins-loading');
        if (el) el.textContent = 'Pricing: ' + done + ' / ' + coins.length + ' complete\u2026';
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

  async function _fetchSpotPrices() {
    try {
      const [sResp, gResp] = await Promise.all([
        fetch('/api/metals/XAG'), fetch('/api/metals/XAU'),
      ]);
      const s = sResp.ok ? await sResp.json() : null;
      const g = gResp.ok ? await gResp.json() : null;
      return {
        silver: s && Number.isFinite(s.price) ? s.price : null,
        gold: g && Number.isFinite(g.price) ? g.price : null,
      };
    } catch { return { silver: null, gold: null }; }
  }

  function _melt(coin) {
    if (!_spotPrices || !coin.weight) return null;
    var w = Number(coin.weight);
    if (!Number.isFinite(w) || w <= 0) return null;
    var metal = (coin.baseMetal || '').toLowerCase();
    var spot = null;
    if (metal === 'silver') spot = _spotPrices.silver;
    else if (metal === 'gold') spot = _spotPrices.gold;
    if (!spot) return null;
    var f = Number(coin.fineness);
    var fineness = Number.isFinite(f) && f > 0 ? f : 1;
    return w * fineness * spot;
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
      const text = (_coinLabel(c) + ' ' + (c.grade || '') + ' ' + (c.label || '') + ' ' + (c.year || '') + ' ' + (c.costPer != null ? '$' + c.costPer : '')).toLowerCase();
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
        case 'label':
          va = (a.coin.label || '').toLowerCase(); vb = (b.coin.label || '').toLowerCase();
          return va < vb ? -1 : va > vb ? 1 : 0;
        case 'qty':
          va = a.coin.count || 1; vb = b.coin.count || 1; return va - vb;
        case 'toz':
          va = a.coin.weight || 0; vb = b.coin.weight || 0; return va - vb;
        case 'fmv':
          va = a.fmv || 0; vb = b.fmv || 0; return va - vb;
        case 'total':
          va = (a.fmv || 0) * (a.coin.count || 1);
          vb = (b.fmv || 0) * (b.coin.count || 1);
          return va - vb;
        case 'cost':
          va = a.coin.costPer != null ? a.coin.costPer : -1;
          vb = b.coin.costPer != null ? b.coin.costPer : -1;
          return va - vb;
        case 'pl':
          va = (a.fmv != null && a.coin.costPer != null) ? (a.fmv - a.coin.costPer) * (a.coin.count || 1) : -Infinity;
          vb = (b.fmv != null && b.coin.costPer != null) ? (b.fmv - b.coin.costPer) * (b.coin.count || 1) : -Infinity;
          return va - vb;
        case 'melt':
          va = _melt(a.coin) || 0; vb = _melt(b.coin) || 0; return va - vb;
        case 'ebay':
          va = a.avgEbay || 0; vb = b.avgEbay || 0; return va - vb;
        case 'notes':
          va = (a.coin.notes || '').toLowerCase(); vb = (b.coin.notes || '').toLowerCase();
          return va < vb ? -1 : va > vb ? 1 : 0;
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

  function _ariaSortAttr(col) {
    if (_sortCol !== col) return ' aria-sort="none"';
    return _sortAsc ? ' aria-sort="ascending"' : ' aria-sort="descending"';
  }

  function _renderTable(items) {
    const filtered = _applySort(_applyFilter(items));

    // Pagination
    const totalFiltered = filtered.length;
    const pageCount = Math.ceil(totalFiltered / PAGE_SIZE) || 1;
    if (_page >= pageCount) _page = pageCount - 1;
    if (_page < 0) _page = 0;
    const pageStart = _page * PAGE_SIZE;
    const pageSlice = filtered.slice(pageStart, pageStart + PAGE_SIZE);

    // Compute totals over ALL items (not filtered)
    let totalFMV = 0;
    let totalCost = 0;
    let totalUnits = 0;
    let pricedCount = 0;
    let costCount = 0;
    items.forEach(it => {
      const qty = it.coin.count || 1;
      totalUnits += qty;
      if (it.fmv != null && !isNaN(it.fmv)) { totalFMV += it.fmv * qty; pricedCount++; }
      if (it.coin.costPer != null && !isNaN(it.coin.costPer)) { totalCost += it.coin.costPer * qty; costCount++; }
    });
    const totalPL = (costCount > 0) ? totalFMV - totalCost : null;

    let html = '';

    // Portfolio summary (aria-live announces updates to screen readers)
    html += '<div class="mycoins-summary" aria-live="polite">';
    html += '<div class="mycoins-total">';
    html += '<span class="mycoins-total-label">Portfolio Value</span>';
    html += '<span class="mycoins-total-value">' + _$(totalFMV) + '</span>';
    html += '</div>';
    if (costCount > 0) {
      html += '<div class="mycoins-total">';
      html += '<span class="mycoins-total-label">Total Cost</span>';
      html += '<span class="mycoins-total-value">' + _$(totalCost) + '</span>';
      html += '</div>';
      html += '<div class="mycoins-total">';
      html += '<span class="mycoins-total-label">Unrealized P/L</span>';
      html += '<span class="mycoins-total-value" style="color:' + (totalPL >= 0 ? 'var(--green)' : 'var(--red, #e74c3c)') + '">' + (totalPL >= 0 ? '\u25B2 +' : '\u25BC ') + _$(totalPL) + '</span>';
      html += '</div>';
    }
    html += '<div class="mycoins-count">';
    html += items.length + ' type(s), ' + totalUnits + ' coin(s)';
    if (pricedCount < items.length) html += ' &middot; ' + pricedCount + ' priced';
    html += '</div>';
    html += '</div>';

    // Search / filter bar
    html += '<div class="mycoins-filter-bar">';
    html += '<input type="text" class="mycoins-filter-input" placeholder="Search coins\u2026" aria-label="Search coins" value="' + _escAttr(_filterText) + '">';
    if (_filterText) html += '<span class="mycoins-filter-count">' + filtered.length + ' of ' + items.length + '</span>';
    html += '</div>';

    // Bulk delete bar (hidden until checkboxes selected)
    html += '<div class="mycoins-bulk-bar" style="display:none">';
    html += '<button class="mycoins-delete-selected btn-sm-danger" disabled>Delete Selected (<span class="mycoins-sel-count">0</span>)</button>';
    html += '</div>';

    // Table
    html += '<div class="mycoins-table-wrap"><table class="mycoins-table" aria-label="My coin collection">';
    html += '<thead><tr>';
    html += '<th class="mycoins-select-col"><input type="checkbox" class="mycoins-select-all" title="Select all" aria-label="Select all coins"></th>';
    html += '<th class="mycoins-sortable" data-col="coin"' + _ariaSortAttr('coin') + '>Coin' + _sortArrow('coin') + '</th>';
    html += '<th class="mycoins-sortable" data-col="grade"' + _ariaSortAttr('grade') + '>Grade' + _sortArrow('grade') + '</th>';
    html += '<th class="mycoins-sortable" data-col="label"' + _ariaSortAttr('label') + '>Label' + _sortArrow('label') + '</th>';
    html += '<th class="mycoins-sortable mycoins-qty-col" data-col="qty"' + _ariaSortAttr('qty') + '>Qty' + _sortArrow('qty') + '</th>';
    html += '<th class="mycoins-sortable" data-col="toz"' + _ariaSortAttr('toz') + '>Troy Oz' + _sortArrow('toz') + '</th>';
    html += '<th class="mycoins-sortable" data-col="fmv"' + _ariaSortAttr('fmv') + '>FMV (ea)' + _sortArrow('fmv') + '</th>';
    html += '<th class="mycoins-sortable" data-col="total"' + _ariaSortAttr('total') + '>Total' + _sortArrow('total') + '</th>';
    html += '<th class="mycoins-sortable" data-col="cost"' + _ariaSortAttr('cost') + '>Cost (ea)' + _sortArrow('cost') + '</th>';
    html += '<th class="mycoins-sortable" data-col="pl"' + _ariaSortAttr('pl') + '>P/L' + _sortArrow('pl') + '</th>';
    html += '<th class="mycoins-sortable" data-col="melt"' + _ariaSortAttr('melt') + '>Melt' + _sortArrow('melt') + '</th>';
    html += '<th class="mycoins-sortable" data-col="ebay"' + _ariaSortAttr('ebay') + '>Avg eBay' + _sortArrow('ebay') + '</th>';
    html += '<th>Range</th>';
    html += '<th class="mycoins-sortable" data-col="notes"' + _ariaSortAttr('notes') + '>Notes' + _sortArrow('notes') + '</th>';
    html += '<th class="mycoins-sortable" data-col="added"' + _ariaSortAttr('added') + '>Added' + _sortArrow('added') + '</th>';
    html += '<th></th>';
    html += '</tr></thead><tbody>';

    pageSlice.forEach(it => {
      const c = it.coin;
      const label = _coinLabel(c);
      const qty = c.count || 1;
      const added = c.dateAdded ? new Date(c.dateAdded).toLocaleDateString() : '\u2014';
      const range = (it.rangeLow != null && it.rangeHigh != null)
        ? _$(it.rangeLow) + ' \u2013 ' + _$(it.rangeHigh)
        : '\u2014';
      const lineTotal = (it.fmv != null && !isNaN(it.fmv)) ? it.fmv * qty : null;
      const meltVal = _melt(c);

      html += '<tr>';

      // Checkbox
      html += '<td class="mycoins-select-col"><input type="checkbox" class="mycoins-row-check" data-hash="' + _escAttr(c.coinHash) + '" aria-label="Select ' + _escAttr(label) + '"></td>';

      html += '<td>' + _esc(label) + '</td>';
      html += '<td>' + _esc(c.grade || '\u2014') + '</td>';
      html += '<td>' + _esc(c.label || '') + '</td>';

      // Qty cell with inline +/- controls
      html += '<td class="mycoins-qty-cell">';
      html += '<button class="mycoins-qty-btn" data-hash="' + _escAttr(c.coinHash) + '" data-delta="-1" title="Decrease quantity">&minus;</button>';
      html += '<span class="mycoins-qty-val">' + qty + '</span>';
      html += '<button class="mycoins-qty-btn" data-hash="' + _escAttr(c.coinHash) + '" data-delta="1" title="Increase quantity">+</button>';
      html += '</td>';

      // Troy Oz
      html += '<td class="mycoins-toz">' + (c.weight ? Number(c.weight).toFixed(4) : '\u2014') + '</td>';

      const fmvCell = it.fmv != null ? _$(it.fmv) + (it.confidence ? ' <span style="opacity:0.6;font-size:0.85em">(' + _esc(it.confidence) + ')</span>' : '')
        : (it.pricingError ? '<span style="color:var(--text-muted);font-size:0.8em" title="' + _escAttr(it.pricingError) + '">No data</span>' : '\u2014');
      html += '<td class="mycoins-fmv">' + fmvCell + '</td>';
      html += '<td class="mycoins-fmv">' + _$(lineTotal) + '</td>';

      // Cost (ea) — inline editable
      const costVal = c.costPer != null ? c.costPer.toFixed(2) : '';
      html += '<td class="mycoins-cost-cell" data-hash="' + _escAttr(c.coinHash) + '">';
      html += '<input type="text" class="mycoins-cost-input" value="' + _escAttr(costVal) + '" placeholder="\u2014" inputmode="decimal" aria-label="Cost per coin for ' + _escAttr(label) + '">';
      html += '</td>';

      // P/L column
      const pl = (it.fmv != null && c.costPer != null) ? (it.fmv - c.costPer) * qty : null;
      if (pl != null) {
        const plColor = pl >= 0 ? 'var(--green)' : 'var(--red, #e74c3c)';
        const plArrow = pl >= 0 ? '\u25B2 +' : '\u25BC ';
        const plLabel = (pl >= 0 ? 'Profit of ' : 'Loss of ') + _$(Math.abs(pl));
        html += '<td style="color:' + plColor + ';font-weight:600" aria-label="' + _escAttr(plLabel) + '">' + plArrow + _$(pl) + '</td>';
      } else {
        html += '<td>\u2014</td>';
      }

      // Melt value
      html += '<td class="mycoins-melt">' + _$(meltVal) + '</td>';

      html += '<td>' + _$(it.avgEbay) + '</td>';
      html += '<td class="mycoins-range">' + range + '</td>';

      // Notes
      html += '<td class="mycoins-notes">' + _esc(c.notes || '') + '</td>';

      html += '<td class="mycoins-date">' + _esc(added) + '</td>';
      html += '<td><button class="mycoins-remove" data-hash="' + _escAttr(c.coinHash) + '" title="Remove from collection">&times;</button></td>';
      html += '</tr>';
    });

    html += '</tbody></table></div>';

    // Pagination controls
    if (pageCount > 1) {
      html += '<div class="mycoins-pagination" style="display:flex;justify-content:center;align-items:center;gap:12px;margin-top:12px;font-size:0.85rem">';
      html += '<button class="mycoins-page-btn btn-sm" data-page="prev"' + (_page === 0 ? ' disabled' : '') + '>&laquo; Prev</button>';
      html += '<span style="color:var(--text-secondary)">Page ' + (_page + 1) + ' of ' + pageCount + ' (' + totalFiltered + ' coins)</span>';
      html += '<button class="mycoins-page-btn btn-sm" data-page="next"' + (_page >= pageCount - 1 ? ' disabled' : '') + '>Next &raquo;</button>';
      html += '</div>';
    }

    _container.innerHTML = html;

    // Bind search filter
    const filterInput = _container.querySelector('.mycoins-filter-input');
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        _filterText = filterInput.value;
        _page = 0;
        clearTimeout(_filterTimer);
        _filterTimer = setTimeout(() => _renderTable(items), 180);
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
        _page = 0;
        _renderTable(items);
      });
    });

    // Bind pagination buttons
    _container.querySelectorAll('.mycoins-page-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const dir = btn.getAttribute('data-page');
        if (dir === 'prev' && _page > 0) _page--;
        if (dir === 'next') _page++;
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
        if (!(await _confirm(msg))) return;
        await CoinStorage.removeCoin(user.userId, hash);
        render();
      });
    });

    // ── Checkbox / bulk-delete bindings ──
    const bulkBar = _container.querySelector('.mycoins-bulk-bar');
    const delBtn = _container.querySelector('.mycoins-delete-selected');
    const selCount = _container.querySelector('.mycoins-sel-count');
    const selectAll = _container.querySelector('.mycoins-select-all');
    const rowChecks = _container.querySelectorAll('.mycoins-row-check');

    function _updateBulkBar() {
      const checked = _container.querySelectorAll('.mycoins-row-check:checked');
      const n = checked.length;
      if (bulkBar) bulkBar.style.display = n > 0 ? 'flex' : 'none';
      if (selCount) selCount.textContent = String(n);
      if (delBtn) delBtn.disabled = n === 0;
      if (selectAll) selectAll.checked = n > 0 && n === rowChecks.length;
    }

    if (selectAll) {
      selectAll.addEventListener('change', () => {
        rowChecks.forEach(cb => { cb.checked = selectAll.checked; });
        _updateBulkBar();
      });
    }
    rowChecks.forEach(cb => cb.addEventListener('change', _updateBulkBar));

    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        const checked = _container.querySelectorAll('.mycoins-row-check:checked');
        const hashes = Array.from(checked).map(cb => cb.getAttribute('data-hash'));
        if (!hashes.length) return;
        if (!(await _confirm('Delete ' + hashes.length + ' selected coin(s)? This cannot be undone.'))) return;
        const user = CoinAuth.currentUser();
        if (!user) return;
        delBtn.disabled = true;
        delBtn.textContent = 'Deleting: 0 / ' + hashes.length + '\u2026';
        for (let di = 0; di < hashes.length; di++) {
          await CoinStorage.removeCoin(user.userId, hashes[di]);
          delBtn.textContent = 'Deleting: ' + (di + 1) + ' / ' + hashes.length + '\u2026';
        }
        render();
      });
    }

    // Bind inline cost editing (blur or Enter saves)
    _container.querySelectorAll('.mycoins-cost-input').forEach(input => {
      const cell = input.closest('.mycoins-cost-cell');
      const hash = cell ? cell.getAttribute('data-hash') : null;

      async function saveCost() {
        const user = CoinAuth.currentUser();
        if (!user || !hash) return;
        const raw = input.value.trim().replace(/^\$/, '');
        const val = raw === '' ? null : parseFloat(raw);
        if (raw !== '' && (isNaN(val) || val < 0)) {
          input.style.borderColor = 'var(--red, #e74c3c)';
          return;
        }
        input.style.borderColor = '';
        const item = items.find(it => it.coin.coinHash === hash);
        if (!item) return;
        const oldVal = item.coin.costPer;
        if (val === oldVal || (val == null && oldVal == null)) return;
        try {
          await CoinStorage.updateCostPer(user.userId, user.key, hash, val);
          item.coin.costPer = val;
          _renderTable(items);
        } catch { /* silent */ }
      }

      input.addEventListener('blur', saveCost);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.blur(); }
      });
    });
  }

  return { init, render };
})();

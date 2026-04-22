// my-coins.js — "My Coins" tab: fetch inventory, price, render table
// Depends on: CoinStorage, CoinAuth, _esc, _escAttr (from index.html)

'use strict';

const MyCoins = (() => {
  const MAX_BATCH = 25;
  const CONCURRENCY = 3;
  const STAGGER_MS = 400;

  let _container = null;
  let _delegated = false;  // true once event delegation is wired up
  let _loading = false;
  let _lastPriced = null;   // cached priced items for re-sort/re-filter without re-fetch
  let _lastRenderedAt = 0;  // timestamp of last successful render
  const RENDER_CACHE_TTL = 2 * 60 * 1000; // 2 minutes -- skip re-fetch on tab switch if fresh
  let _sortCol = 'coin';
  let _sortAsc = true;
  let _filterText = '';
  let _filterTimer = null;
  let _page = 0;
  const PAGE_SIZE = 50;

  // Spot price cache (reused across renders for 5 minutes)
  let _spotPrices = null;  // { silver: number, gold: number } | null
  let _spotPricesFetchedAt = 0;
  let _spotFetchFailed = false;
  const SPOT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
    if (_container && !_delegated) {
      _setupDelegation();
      _delegated = true;
    }
  }

  // ── Single delegated event handler (wired once, survives re-renders) ──
  // items reference is captured in closure via _lastPriced
  function _setupDelegation() {
    // Click delegation: sort headers, pagination, qty +/-, remove, bulk delete
    _container.addEventListener('click', async (e) => {
      const target = e.target;

      // Sortable headers
      const th = target.closest('.mycoins-sortable');
      if (th) {
        const col = th.getAttribute('data-col');
        if (_sortCol === col) { _sortAsc = !_sortAsc; }
        else { _sortCol = col; _sortAsc = true; }
        _page = 0;
        if (_lastPriced) _renderTable(_lastPriced);
        return;
      }

      // Pagination buttons
      const pageBtn = target.closest('.mycoins-page-btn');
      if (pageBtn && !pageBtn.disabled) {
        const dir = pageBtn.getAttribute('data-page');
        if (dir === 'prev' && _page > 0) _page--;
        if (dir === 'next') _page++;
        if (_lastPriced) _renderTable(_lastPriced);
        return;
      }

      // Qty +/- buttons
      const qtyBtn = target.closest('.mycoins-qty-btn');
      if (qtyBtn) {
        const cell = qtyBtn.closest('.mycoins-qty-cell');
        const input = cell ? cell.querySelector('.mycoins-qty-input') : null;
        if (!input) return;
        const delta = parseInt(qtyBtn.getAttribute('data-delta'), 10);
        const cur = parseInt(input.value, 10) || 1;
        const next = cur + delta;
        if (next < 1) return;
        input.value = next;
        _saveQty(input);
        return;
      }

      // Remove buttons
      const removeBtn = target.closest('.mycoins-remove');
      if (removeBtn) {
        const hash = removeBtn.getAttribute('data-hash');
        const user = CoinAuth.currentUser();
        if (!user || !hash || !_lastPriced) return;
        const item = _lastPriced.find(it => it.coin.coinHash === hash);
        const qty = item ? (item.coin.count || 1) : 1;
        const msg = qty > 1
          ? 'Remove all ' + qty + ' of this coin from your collection?'
          : 'Remove this coin from your collection?';
        if (!(await _confirm(msg))) return;
        await CoinStorage.removeCoin(user.userId, hash);
        render(true);
        return;
      }

      // Bulk delete button
      const delBtn = target.closest('.mycoins-delete-selected');
      if (delBtn && !delBtn.disabled) {
        const checked = _container.querySelectorAll('.mycoins-row-check:checked');
        const hashes = Array.from(checked).map(cb => cb.getAttribute('data-hash'));
        if (!hashes.length) return;
        if (!(await _confirm('Delete ' + hashes.length + ' selected coin(s)?'))) return;
        const user = CoinAuth.currentUser();
        if (!user) return;

        // Hide rows immediately, show undo toast for 5s
        hashes.forEach(h => {
          var row = _container.querySelector('tr:has(.mycoins-row-check[data-hash="' + h + '"])');
          if (row) row.style.display = 'none';
        });
        delBtn.disabled = true;
        var undone = false;
        var toast = document.createElement('div');
        toast.className = 'mycoins-undo-toast';
        toast.setAttribute('role', 'status');
        toast.innerHTML = hashes.length + ' coin(s) removed. <button class="mycoins-undo-btn">Undo</button>';
        _container.prepend(toast);
        var undoBtn = toast.querySelector('.mycoins-undo-btn');
        undoBtn.addEventListener('click', function() {
          undone = true;
          toast.remove();
          hashes.forEach(h => {
            var row = _container.querySelector('tr:has(.mycoins-row-check[data-hash="' + h + '"])');
            if (row) row.style.display = '';
          });
          delBtn.disabled = false;
          _updateBulkBar();
        });
        await new Promise(r => setTimeout(r, 5000));
        toast.remove();
        if (undone) return;
        for (let di = 0; di < hashes.length; di++) {
          await CoinStorage.removeCoin(user.userId, hashes[di]);
        }
        render(true);
        return;
      }
    });

    // Change delegation: checkboxes (select-all and row checks)
    _container.addEventListener('change', (e) => {
      const target = e.target;

      if (target.classList.contains('mycoins-select-all')) {
        const rowChecks = _container.querySelectorAll('.mycoins-row-check');
        rowChecks.forEach(cb => { cb.checked = target.checked; });
        _updateBulkBar();
        return;
      }

      if (target.classList.contains('mycoins-row-check')) {
        _updateBulkBar();
        return;
      }
    });

    // Input delegation: filter search (debounced)
    _container.addEventListener('input', (e) => {
      if (e.target.classList.contains('mycoins-filter-input')) {
        _filterText = e.target.value;
        _page = 0;
        clearTimeout(_filterTimer);
        _filterTimer = setTimeout(() => {
          if (_lastPriced) _renderTable(_lastPriced);
        }, 180);
      }
    });

    // Blur delegation: inline cost & qty editing
    _container.addEventListener('blur', (e) => {
      if (e.target.classList.contains('mycoins-cost-input')) {
        _saveCost(e.target);
      }
      if (e.target.classList.contains('mycoins-qty-input')) {
        _saveQty(e.target);
      }
    }, true); // useCapture for blur (doesn't bubble)

    // Keydown delegation: inline cost & qty editing (Enter/Escape) + sortable headers
    _container.addEventListener('keydown', (e) => {
      if (e.target.classList.contains('mycoins-cost-input') || e.target.classList.contains('mycoins-qty-input')) {
        if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
        if (e.key === 'Escape') { e.target.blur(); }
      }
      // Sortable column headers: Enter/Space triggers sort
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.mycoins-sortable')) {
        e.preventDefault();
        e.target.closest('.mycoins-sortable').click();
      }
    });
  }

  function _updateBulkBar() {
    const bulkBar = _container.querySelector('.mycoins-bulk-bar');
    const delBtn = _container.querySelector('.mycoins-delete-selected');
    const selCount = _container.querySelector('.mycoins-sel-count');
    const selectAll = _container.querySelector('.mycoins-select-all');
    const rowChecks = _container.querySelectorAll('.mycoins-row-check');
    const checked = _container.querySelectorAll('.mycoins-row-check:checked');
    const n = checked.length;
    if (bulkBar) bulkBar.style.display = n > 0 ? 'flex' : 'none';
    if (selCount) selCount.textContent = String(n);
    if (delBtn) delBtn.disabled = n === 0;
    if (selectAll) selectAll.checked = n > 0 && n === rowChecks.length;
  }

  async function _saveQty(input) {
    const cell = input.closest('.mycoins-qty-cell');
    const hash = cell ? cell.getAttribute('data-hash') : null;
    const user = CoinAuth.currentUser();
    if (!user || !hash || !_lastPriced) return;
    const val = parseInt(input.value, 10);
    if (isNaN(val) || val < 1 || val > 9999) {
      input.style.borderColor = 'var(--red, #e74c3c)';
      return;
    }
    input.style.borderColor = '';
    const item = _lastPriced.find(it => it.coin.coinHash === hash);
    if (!item) return;
    const oldQty = item.coin.count || 1;
    if (val === oldQty) return;
    try {
      await CoinStorage.updateCount(user.userId, user.key, hash, val);
      item.coin.count = val;
      const scrollY = window.scrollY;
      _renderTable(_lastPriced);
      window.scrollTo(0, scrollY);
    } catch {
      input.value = oldQty;
      input.style.borderColor = 'var(--red, #e74c3c)';
      setTimeout(() => { input.style.borderColor = ''; }, 2000);
    }
  }

  async function _saveCost(input) {
    const cell = input.closest('.mycoins-cost-cell');
    const hash = cell ? cell.getAttribute('data-hash') : null;
    const user = CoinAuth.currentUser();
    if (!user || !hash || !_lastPriced) return;
    const raw = input.value.trim().replace(/^\$/, '');
    const val = raw === '' ? null : parseFloat(raw);
    if (raw !== '' && (isNaN(val) || val < 0)) {
      input.style.borderColor = 'var(--red, #e74c3c)';
      return;
    }
    input.style.borderColor = '';
    const item = _lastPriced.find(it => it.coin.coinHash === hash);
    if (!item) return;
    const oldVal = item.coin.costPer;
    if (val === oldVal || (val == null && oldVal == null)) return;
    try {
      await CoinStorage.updateCostPer(user.userId, user.key, hash, val);
      item.coin.costPer = val;
      const scrollY = window.scrollY;
      _renderTable(_lastPriced);
      window.scrollTo(0, scrollY);
    } catch {
      input.value = oldVal != null ? oldVal.toFixed(2) : '';
      input.style.borderColor = 'var(--red, #e74c3c)';
      setTimeout(() => { input.style.borderColor = ''; }, 2000);
    }
  }

  /**
   * Load, decrypt, price, and render the My Coins table.
   */
  async function render(force) {
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

    // If data is fresh and not forced, re-render from cache (no API calls)
    if (!force && _lastPriced && (Date.now() - _lastRenderedAt < RENDER_CACHE_TTL)) {
      _renderTable(_lastPriced);
      return;
    }

    if (_loading) return;
    _loading = true;
    _container.innerHTML = '<p class="mycoins-loading">Loading inventory\u2026</p>';

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
      _lastRenderedAt = Date.now();
      _renderTable(priced);
      if (_spotFetchFailed) {
        var warn = document.createElement('div');
        warn.className = 'mycoins-spot-warn';
        warn.setAttribute('role', 'alert');
        warn.textContent = 'Spot prices unavailable \u2014 melt values may be stale or missing.';
        _container.prepend(warn);
      }
    } catch (err) {
      _container.innerHTML = '<div class="mycoins-error">Error: ' + _esc(err.message) + '</div>';
    } finally {
      _loading = false;
    }
  }

  /**
   * Fetch pricing for an array of decrypted coins.
   * Uses POST /api/pricing-batch in chunks of MAX_BATCH (25).
   */
  async function _fetchPricing(coins) {
    const results = [];

    // Build batch items
    const batchItems = coins.map(coin => ({
      query: coin.query || _buildQuery(coin),
      coinData: {
        name: coin.series || '',
        year: coin.year ? Number(coin.year) : undefined,
        mintMark: coin.mint || '',
        grade: coin.grade || '',
        weight: coin.weight || null,
      },
    }));

    // Send in chunks of MAX_BATCH
    for (let start = 0; start < batchItems.length; start += MAX_BATCH) {
      const chunk = batchItems.slice(start, start + MAX_BATCH);
      const chunkCoins = coins.slice(start, start + MAX_BATCH);
      try {
        const resp = await fetch('/api/pricing-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: chunk }),
        });
        if (resp.ok) {
          const data = await resp.json();
          const batchResults = data.results || [];
          for (let j = 0; j < chunkCoins.length; j++) {
            const r = batchResults[j] || {};
            results.push({
              coin: chunkCoins[j],
              fmv: r.fmv || null,
              rangeLow: r.rangeLow || null,
              rangeHigh: r.rangeHigh || null,
              avgEbay: r.avgEbay || null,
              confidence: r.confidence || null,
              pricingError: r.error || null,
            });
          }
        } else {
          // Batch failed — mark all coins in chunk as errors
          for (let j = 0; j < chunkCoins.length; j++) {
            results.push({ coin: chunkCoins[j], fmv: null, avgEbay: null, confidence: null, pricingError: 'Server returned ' + resp.status });
          }
        }
      } catch (e) {
        for (let j = 0; j < chunkCoins.length; j++) {
          results.push({ coin: chunkCoins[j], fmv: null, avgEbay: null, confidence: null, pricingError: e.message || 'Network error' });
        }
      }
      // Update progress
      var el = _container && _container.querySelector('.mycoins-loading');
      if (el) el.textContent = 'Pricing: ' + results.length + ' / ' + coins.length + ' complete\u2026';
    }

    return results;
  }

  async function _fetchSpotPrices() {
    // Return cached prices if still fresh
    if (_spotPrices && (Date.now() - _spotPricesFetchedAt) < SPOT_CACHE_TTL) {
      return _spotPrices;
    }
    try {
      const [sResp, gResp] = await Promise.all([
        fetch('/api/metals/XAG'), fetch('/api/metals/XAU'),
      ]);
      const s = sResp.ok ? await sResp.json() : null;
      const g = gResp.ok ? await gResp.json() : null;
      _spotPrices = {
        silver: s && Number.isFinite(s.price) ? s.price : null,
        gold: g && Number.isFinite(g.price) ? g.price : null,
      };
      _spotPricesFetchedAt = Date.now();
      _spotFetchFailed = false;
      return _spotPrices;
    } catch { _spotFetchFailed = true; return _spotPrices || { silver: null, gold: null }; }
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
          // Sort by series first, then year — matches typical spreadsheet order
          va = (a.coin.series || '').toLowerCase(); vb = (b.coin.series || '').toLowerCase();
          if (va !== vb) return va < vb ? -1 : 1;
          va = a.coin.year || ''; vb = b.coin.year || '';
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
    const base = ' tabindex="0" role="columnheader button"';
    if (_sortCol !== col) return base + ' aria-sort="none"';
    return base + (_sortAsc ? ' aria-sort="ascending"' : ' aria-sort="descending"');
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
      html += '<span class="mycoins-total-value" style="color:' + (totalPL >= 0 ? 'var(--green)' : 'var(--red, #e74c3c)') + '">' + (totalPL >= 0 ? '\u25B2 +' : '\u25BC \u2212') + _$(Math.abs(totalPL)) + '</span>';
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

    // Column legend (collapsible)
    html += '<details class="mycoins-legend">';
    html += '<summary class="mycoins-legend-toggle">\u2139\uFE0F Column Guide</summary>';
    html += '<dl class="mycoins-legend-list">';
    html += '<div><dt>Coin</dt><dd>Series, year, and mint mark</dd></div>';
    html += '<div><dt>Grade</dt><dd>PCGS / NGC numeric or descriptive grade</dd></div>';
    html += '<div><dt>Label</dt><dd>Slab variant (e.g. First Strike, Proof)</dd></div>';
    html += '<div><dt>Qty</dt><dd>Number of coins you own</dd></div>';
    html += '<div><dt>Troy Oz</dt><dd>Total precious-metal weight (Qty x pure ozt per coin)</dd></div>';
    html += '<div><dt>FMV (ea)</dt><dd>Fair market value per coin with confidence indicator</dd></div>';
    html += '<div><dt>Total</dt><dd>FMV x Qty</dd></div>';
    html += '<div><dt>Cost (ea)</dt><dd>Your acquisition cost per coin (editable)</dd></div>';
    html += '<div><dt>P/L</dt><dd>Unrealized profit or loss (FMV - Cost)</dd></div>';
    html += '<div><dt>Melt</dt><dd>Intrinsic metal value at current spot price</dd></div>';
    html += '<div><dt>Avg eBay</dt><dd>Median recent sold price on eBay</dd></div>';
    html += '<div><dt>Range</dt><dd>Low -- high of recent eBay sold comps</dd></div>';
    html += '<div><dt>Notes</dt><dd>Your personal notes for this coin</dd></div>';
    html += '<div><dt>Added</dt><dd>Date the coin was added to your collection</dd></div>';
    html += '</dl>';
    html += '</details>';

    // Table
    html += '<div class="mycoins-table-wrap"><table class="mycoins-table" aria-label="My coin collection">';
    html += '<thead><tr>';
    html += '<th class="mycoins-select-col"><input type="checkbox" class="mycoins-select-all" title="Select all" aria-label="Select all coins"></th>';
    html += '<th class="mycoins-sortable" data-col="coin"' + _ariaSortAttr('coin') + '>Coin' + _sortArrow('coin') + '</th>';
    html += '<th class="mycoins-sortable" data-col="grade"' + _ariaSortAttr('grade') + '>Grade' + _sortArrow('grade') + '</th>';
    html += '<th class="mycoins-sortable" data-col="label"' + _ariaSortAttr('label') + '>Label' + _sortArrow('label') + '</th>';
    html += '<th class="mycoins-sortable mycoins-qty-col" data-col="qty"' + _ariaSortAttr('qty') + '>Qty' + _sortArrow('qty') + '</th>';
    html += '<th class="mycoins-sortable mycoins-col-hide" data-col="toz"' + _ariaSortAttr('toz') + '>Troy Oz' + _sortArrow('toz') + '</th>';
    html += '<th class="mycoins-sortable" data-col="fmv"' + _ariaSortAttr('fmv') + '>FMV (ea)' + _sortArrow('fmv') + '</th>';
    html += '<th class="mycoins-sortable" data-col="total"' + _ariaSortAttr('total') + '>Total' + _sortArrow('total') + '</th>';
    html += '<th class="mycoins-sortable" data-col="cost"' + _ariaSortAttr('cost') + '>Cost (ea)' + _sortArrow('cost') + '</th>';
    html += '<th class="mycoins-sortable" data-col="pl"' + _ariaSortAttr('pl') + '>P/L' + _sortArrow('pl') + '</th>';
    html += '<th class="mycoins-sortable mycoins-col-hide" data-col="melt"' + _ariaSortAttr('melt') + '>Melt' + _sortArrow('melt') + '</th>';
    html += '<th class="mycoins-sortable mycoins-col-hide" data-col="ebay"' + _ariaSortAttr('ebay') + '>Avg eBay' + _sortArrow('ebay') + '</th>';
    html += '<th class="mycoins-col-hide">Range</th>';
    html += '<th class="mycoins-sortable mycoins-col-hide" data-col="notes"' + _ariaSortAttr('notes') + '>Notes' + _sortArrow('notes') + '</th>';
    html += '<th class="mycoins-sortable mycoins-col-hide" data-col="added"' + _ariaSortAttr('added') + '>Added' + _sortArrow('added') + '</th>';
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

      // Qty cell with inline +/- controls and editable input
      html += '<td class="mycoins-qty-cell" data-hash="' + _escAttr(c.coinHash) + '">';
      html += '<button class="mycoins-qty-btn" data-hash="' + _escAttr(c.coinHash) + '" data-delta="-1" title="Decrease quantity">&minus;</button>';
      html += '<input type="number" class="mycoins-qty-input" value="' + qty + '" min="1" max="9999" inputmode="numeric" aria-label="Quantity for ' + _escAttr(label) + '">';
      html += '<button class="mycoins-qty-btn" data-hash="' + _escAttr(c.coinHash) + '" data-delta="1" title="Increase quantity">+</button>';
      html += '</td>';

      // Troy Oz
      html += '<td class="mycoins-toz mycoins-col-hide">' + (c.weight ? Number(c.weight).toFixed(4) : '\u2014') + '</td>';

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
        const plArrow = pl >= 0 ? '\u25B2 +' : '\u25BC \u2212';
        const plLabel = (pl >= 0 ? 'Profit of ' : 'Loss of ') + _$(Math.abs(pl));
        html += '<td style="color:' + plColor + ';font-weight:600" aria-label="' + _escAttr(plLabel) + '">' + plArrow + _$(Math.abs(pl)) + '</td>';
      } else {
        html += '<td>\u2014</td>';
      }

      // Melt value
      html += '<td class="mycoins-melt mycoins-col-hide">' + _$(meltVal) + '</td>';

      html += '<td class="mycoins-col-hide">' + _$(it.avgEbay) + '</td>';
      html += '<td class="mycoins-range mycoins-col-hide">' + range + '</td>';

      // Notes
      html += '<td class="mycoins-notes mycoins-col-hide" title="' + _escAttr(c.notes || '') + '">' + _esc(c.notes || '') + '</td>';

      html += '<td class="mycoins-date mycoins-col-hide">' + _esc(added) + '</td>';
      html += '<td><button class="mycoins-remove" data-hash="' + _escAttr(c.coinHash) + '" title="Remove from collection">&times;</button></td>';
      html += '</tr>';
    });

    if (!pageSlice.length && _filterText) {
      html += '<tr><td colspan="16" style="text-align:center;padding:24px;color:var(--text-muted)">No coins match \u201c' + _esc(_filterText) + '\u201d. Try a broader search.</td></tr>';
    }

    html += '</tbody></table></div>';

    // Pagination controls
    if (pageCount > 1) {
      html += '<div class="mycoins-pagination" style="display:flex;justify-content:center;align-items:center;gap:12px;margin-top:12px;font-size:0.85rem">';
      html += '<button class="mycoins-page-btn btn-sm" data-page="prev"' + (_page === 0 ? ' disabled' : '') + '>&laquo; Prev</button>';
      html += '<span style="color:var(--text-secondary)">Page ' + (_page + 1) + ' of ' + pageCount + ' (' + totalFiltered + ' coins)</span>';
      html += '<button class="mycoins-page-btn btn-sm" data-page="next"' + (_page >= pageCount - 1 ? ' disabled' : '') + '>Next &raquo;</button>';
      html += '</div>';
    }

    // Save focus state before re-render
    var _focusHash = null, _focusClass = null, _focusSelStart = null, _focusSelEnd = null;
    var ae = document.activeElement;
    if (ae && _container.contains(ae)) {
      _focusClass = ae.classList.contains('mycoins-cost-input') ? 'mycoins-cost-input'
        : ae.classList.contains('mycoins-qty-input') ? 'mycoins-qty-input'
        : ae.classList.contains('mycoins-filter-input') ? 'mycoins-filter-input' : null;
      if (_focusClass && _focusClass !== 'mycoins-filter-input') {
        var fc = ae.closest('[data-hash]');
        _focusHash = fc ? fc.getAttribute('data-hash') : null;
      }
      _focusSelStart = ae.selectionStart;
      _focusSelEnd = ae.selectionEnd;
    }

    _container.innerHTML = html;

    // Restore focus after re-render
    var toFocus = null;
    if (_focusClass === 'mycoins-filter-input') {
      toFocus = _container.querySelector('.mycoins-filter-input');
    } else if (_focusClass && _focusHash) {
      var cell = _container.querySelector('[data-hash="' + _focusHash + '"]');
      if (cell) toFocus = cell.querySelector('.' + _focusClass);
    }
    if (toFocus) {
      toFocus.focus();
      if (_focusSelStart != null) toFocus.setSelectionRange(_focusSelStart, _focusSelEnd);
    }
  }

  /** Invalidate the render cache so the next tab-switch re-fetches. */
  function invalidate() { _lastRenderedAt = 0; }

  return { init, render, invalidate };
})();

// my-coins.js — "My Coins" tab: decrypt inventory, fetch pricing, render table
// Depends on: CoinCrypto, CoinStorage, CoinAuth, _esc (from index.html)

'use strict';

const MyCoins = (() => {
  const MAX_BATCH = 25;
  const CONCURRENCY = 3;
  const STAGGER_MS = 400;

  let _container = null;
  let _loading = false;

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
            results[i] = { coin, fmv: null, avgEbay: null, confidence: null };
          }
        } catch {
          results[i] = { coin, fmv: null, avgEbay: null, confidence: null };
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

  function _renderTable(items) {
    let totalFMV = 0;
    let pricedCount = 0;
    items.forEach(it => {
      if (it.fmv != null && !isNaN(it.fmv)) { totalFMV += it.fmv; pricedCount++; }
    });

    let html = '';

    // Portfolio summary
    html += '<div class="mycoins-summary">';
    html += '<div class="mycoins-total">';
    html += '<span class="mycoins-total-label">Portfolio Value</span>';
    html += '<span class="mycoins-total-value">' + _$(totalFMV) + '</span>';
    html += '</div>';
    html += '<div class="mycoins-count">' + items.length + ' coin(s)';
    if (pricedCount < items.length) html += ' &middot; ' + pricedCount + ' priced';
    html += '</div>';
    html += '</div>';

    // Table
    html += '<div class="mycoins-table-wrap"><table class="mycoins-table">';
    html += '<thead><tr>';
    html += '<th>Coin</th><th>Grade</th><th>FMV</th><th>Avg eBay</th><th>Range</th><th>Added</th><th></th>';
    html += '</tr></thead><tbody>';

    items.forEach(it => {
      const c = it.coin;
      const label = [c.year, c.mint && c.mint !== 'P' ? c.mint : '', c.series].filter(Boolean).join(' ');
      const added = c.dateAdded ? new Date(c.dateAdded).toLocaleDateString() : '\u2014';
      const range = (it.rangeLow != null && it.rangeHigh != null)
        ? _$(it.rangeLow) + ' \u2013 ' + _$(it.rangeHigh)
        : '\u2014';

      html += '<tr>';
      html += '<td>' + _esc(label) + '</td>';
      html += '<td>' + _esc(c.grade || '\u2014') + '</td>';
      html += '<td class="mycoins-fmv">' + _$(it.fmv) + (it.confidence ? ' <span style="opacity:0.6;font-size:0.85em">(' + _esc(it.confidence) + ')</span>' : '') + '</td>';
      html += '<td>' + _$(it.avgEbay) + '</td>';
      html += '<td class="mycoins-range">' + range + '</td>';
      html += '<td class="mycoins-date">' + _esc(added) + '</td>';
      html += '<td><button class="mycoins-remove" data-hash="' + _esc(c.coinHash) + '" title="Remove from collection">&times;</button></td>';
      html += '</tr>';
    });

    html += '</tbody></table></div>';
    _container.innerHTML = html;

    // Bind remove buttons
    _container.querySelectorAll('.mycoins-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const hash = btn.getAttribute('data-hash');
        const user = CoinAuth.currentUser();
        if (!user || !hash) return;
        if (!confirm('Remove this coin from your collection?')) return;
        await CoinStorage.removeCoin(user.userId, hash);
        render();
      });
    });
  }

  return { init, render };
})();

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

  let _statusEl = null;     // persistent status region (outside the re-rendered container)
  let _statusTimer = null;
  const STATUS_CLEAR_MS = 4000;

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

  // -- Failure and progress feedback --
  // The status region lives outside _container so it survives table re-renders.
  // It has a polite channel (progress/saved) and an alert channel (failures).
  const _inFlight = new Set();   // 'qty:<hash>' / 'cost:<hash>' while that save is running
  const _queued = new Map();     // key -> latest value typed while that save was running
  let _authListening = false;

  function _statusRegion() {
    if (_statusEl && _statusEl.isConnected) return _statusEl;
    if (!_container || !_container.parentNode) return null;
    let el = document.getElementById('mycoins-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mycoins-status';
      el.className = 'mycoins-status';
      el.innerHTML = '<div class="mycoins-status-polite" role="status" aria-live="polite"></div>' +
        '<div class="mycoins-status-alert" role="alert"></div>';
      _container.parentNode.insertBefore(el, _container);
    }
    if (el.getAttribute('data-bound') !== '1') {
      el.setAttribute('data-bound', '1');
      el.addEventListener('click', _onStatusClick);
    }
    _statusEl = el;
    return el;
  }

  function _actionButtons(actions) {
    return (actions || []).map(a =>
      '<button type="button" class="btn-sm ' + a.cls + '"' +
      (a.hashes ? ' data-hashes="' + _escAttr(a.hashes.join(',')) + '"' : '') + '>' + _esc(a.label) + '</button>'
    ).join('');
  }

  /**
   * kind: 'success' (polite, auto-clears), 'info' (polite, stays until replaced),
   * 'error' (alert, stays until dismissed or replaced). Success and info never touch the alert.
   */
  function _setStatus(kind, text, actions) {
    const el = _statusRegion();
    if (!el) return;
    clearTimeout(_statusTimer);
    const polite = el.querySelector('.mycoins-status-polite');
    const alertBox = el.querySelector('.mycoins-status-alert');
    if (kind === 'error') {
      polite.textContent = '';
      alertBox.innerHTML = '<span class="mycoins-status-text">' + _esc(text) + '</span>' +
        _actionButtons(actions) +
        '<button type="button" class="btn-sm mycoins-status-dismiss">Dismiss</button>';
    } else {
      polite.textContent = text;
      if (kind === 'success') {
        _statusTimer = setTimeout(() => { if (_statusEl) polite.textContent = ''; }, STATUS_CLEAR_MS);
      }
    }
  }

  function _clearStatus() {
    clearTimeout(_statusTimer);
    if (!_statusEl) return;
    _statusEl.querySelector('.mycoins-status-polite').textContent = '';
    _statusEl.querySelector('.mycoins-status-alert').textContent = '';
  }

  // Recovery actions replace the control that had focus; park it on the container.
  function _restoreFocusIfLost() {
    const ae = document.activeElement;
    if ((!ae || ae === document.body) && _container) _container.focus({ preventScroll: true });
  }

  function _openLogin() {
    if (typeof window._openAuthDialog === 'function') window._openAuthDialog();
  }

  async function _onStatusClick(e) {
    const t = e.target;
    if (t.closest('.mycoins-status-dismiss')) { _clearStatus(); _restoreFocusIfLost(); return; }
    if (t.closest('.mycoins-relogin')) { _openLogin(); return; }
    if (t.closest('.mycoins-retry-load')) {
      _clearStatus();
      await render(true);
      _restoreFocusIfLost();
      return;
    }
    const retryRemove = t.closest('.mycoins-retry-remove');
    if (retryRemove) {
      const hashes = (retryRemove.getAttribute('data-hashes') || '').split(',').filter(Boolean);
      if (hashes.length) {
        await _removeHashes(hashes);
        _restoreFocusIfLost();
      }
    }
  }

  // After a login the expired-session view and any log-in alert are stale: reload.
  function _onAuthChange(e) {
    if (!_container) return;
    if (!e || !e.detail) {
      _clearStatus();
      _lastPriced = null;
      _lastRenderedAt = 0;
      return;
    }
    const stale = _container.querySelector('.mycoins-error') ||
      (_statusEl && _statusEl.querySelector('.mycoins-relogin'));
    if (stale) {
      _clearStatus();
      render(true);
    }
  }

  /**
   * Map a CollectionError (or anything thrown) to user-facing text and flags.
   * indeterminate: the request may have been applied (timeout, network, 5xx);
   * reload: the on-screen list is out of date; unexpected: not a CollectionError.
   */
  function _describeFailure(err) {
    const base = { login: false, retry: false, indeterminate: false, reload: false, unexpected: false };
    switch (err && err.code) {
      case 'auth-expired':
        return { ...base, text: 'Your session has expired. Log in again to continue.', login: true };
      case 'forbidden':
        return { ...base, text: 'You do not have access to this collection with the current login. Log in again to continue.', login: true };
      case 'rate-limited':
        return { ...base, text: 'Too many requests right now. Wait a moment, then try again.', retry: true };
      case 'timeout':
        return { ...base, text: 'The server took too long to respond.', retry: true, indeterminate: true };
      case 'network':
        return { ...base, text: 'The server could not be reached. Check your connection.', retry: true, indeterminate: true };
      case 'malformed':
        return { ...base, text: 'The server sent a response that could not be read.', retry: true };
      case 'not-found':
        return { ...base, text: 'This coin no longer exists.', reload: true };
      default:
        if (err && err.code && err.status && err.status < 500 && err.message) {
          return { ...base, text: err.message };
        }
        if (err && err.code) {
          return { ...base, text: 'The service is unavailable right now.', retry: true, indeterminate: true };
        }
        return { ...base, text: 'Something went wrong.', retry: true, indeterminate: true, unexpected: true };
    }
  }

  function _renderLoadError(err) {
    const d = _describeFailure(err);
    if (d.unexpected) console.error('[my-coins] unexpected load failure', err);
    // Drop cached rows so a failed load can never be acted on or re-shown as current.
    _lastPriced = null;
    _lastRenderedAt = 0;
    _container.innerHTML = '<div class="mycoins-error" role="alert">' +
      '<p>' + _esc(d.text) + ' Your collection has not been changed.</p>' +
      '<div class="mycoins-error-actions">' +
      (d.login ? '<button type="button" class="btn-sm mycoins-relogin">Log in again</button>' : '') +
      '<button type="button" class="btn-sm mycoins-retry">Try again</button>' +
      '</div></div>';
  }

  function _requireUser(text) {
    const user = CoinAuth.currentUser();
    if (user) return user;
    _setStatus('error', text || 'Your session has expired. Log in again to continue.',
      [{ cls: 'mycoins-relogin', label: 'Log in again' }]);
    return null;
  }

  function _itemFor(hash) {
    return _lastPriced ? _lastPriced.find(it => it.coin.coinHash === hash) : null;
  }

  /**
   * Short adjacent message for an inline editor. kind: 'error' | 'info'; empty text clears it.
   * announce adds role=alert (validation only; failed saves are announced by the status region).
   */
  function _fieldMsg(input, text, kind, announce) {
    const cell = input.closest('td');
    if (!cell) return;
    let msg = cell.querySelector('.mycoins-field-msg');
    if (!text) {
      if (msg) msg.remove();
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
      return;
    }
    if (!msg) {
      msg = document.createElement('span');
      cell.appendChild(msg);
    }
    const id = 'mycoins-msg-' + (cell.getAttribute('data-hash') || '').slice(0, 12) +
      (input.classList.contains('mycoins-qty-input') ? '-qty' : '-cost');
    msg.id = id;
    msg.className = 'mycoins-field-msg mycoins-field-msg-' + kind;
    if (announce) msg.setAttribute('role', 'alert');
    else msg.removeAttribute('role');
    msg.textContent = text;
    input.setAttribute('aria-describedby', id);
    if (kind === 'error') input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function _reportSaveFailure(item, what, err) {
    const d = _describeFailure(err);
    const label = item ? _coinLabel(item.coin) : 'This coin';
    const actions = [];
    if (d.login) actions.push({ cls: 'mycoins-relogin', label: 'Log in again' });
    if (d.indeterminate || d.reload) actions.push({ cls: 'mycoins-retry-load', label: 'Reload list' });
    const outcome = d.indeterminate
      ? ' The change may have been saved. Reload the list to check.'
      : (d.reload ? ' The list is out of date. Reload it.' : ' The previous value is shown.');
    _setStatus('error', label + ': the ' + what + ' could not be saved. ' + d.text + outcome, actions);
  }

  /**
   * Save one inline edit. Edits typed while a save is running are coalesced: only the
   * latest value is sent once the running save finishes, so rapid +/- clicks are not lost.
   */
  async function _commitEdit(spec) {
    const { key, input, item, what } = spec;
    _inFlight.add(key);
    input.setAttribute('aria-busy', 'true');
    _fieldMsg(input, 'Saving\u2026', 'info', false);
    let failure = null;
    try {
      let next = spec.val;
      for (;;) {
        await spec.write(next);
        spec.apply(next);
        const queued = _queued.get(key);
        _queued.delete(key);
        if (queued === undefined || spec.isCurrent(queued)) break;
        next = queued;
      }
    } catch (err) {
      failure = err;
      _queued.delete(key);
    } finally {
      _inFlight.delete(key);
      input.removeAttribute('aria-busy');
    }
    if (failure) {
      spec.restore();
      const d = _describeFailure(failure);
      _fieldMsg(input, d.indeterminate ? 'Not confirmed. Reload the list.' : 'Not saved. Previous value shown.', 'error', false);
      _reportSaveFailure(item, what, failure);
      return;
    }
    if (_lastPriced) {
      const scrollY = window.scrollY;
      _renderTable(_lastPriced);
      window.scrollTo(0, scrollY);
    }
    _setStatus('success', spec.saved);
  }

  /**
   * Remove coins one by one, tolerating failures. Returns the hashes that could not be removed.
   * The list is reloaded when anything was (or may have been) removed; when nothing changed
   * the cached rows are re-rendered so hidden rows come back without another load.
   */
  async function _removeHashes(hashes) {
    const user = _requireUser('Your session has expired. Nothing was removed.');
    if (!user) {
      await render(true);
      return hashes.slice();
    }
    const total = hashes.length;
    const failures = [];
    let removed = 0;
    for (let i = 0; i < total; i++) {
      if (total > 1) _setStatus('info', 'Removing ' + (i + 1) + ' of ' + total + '\u2026');
      try {
        await CoinStorage.removeCoin(user.userId, hashes[i]);
        removed++;
      } catch (err) {
        failures.push({ hash: hashes[i], err });
        if (err && (err.code === 'auth-expired' || err.code === 'forbidden')) {
          hashes.slice(i + 1).forEach(h => failures.push({ hash: h, err }));
          break;
        }
      }
    }
    const failed = failures.map(f => f.hash);
    const firstError = failures.length ? failures[0].err : null;
    const d = firstError ? _describeFailure(firstError) : null;
    const uncertain = failures.some(f => _describeFailure(f.err).indeterminate);
    let refreshed = true;
    if (removed > 0 || uncertain) {
      refreshed = await render(true);
    } else if (_lastPriced) {
      _renderTable(_lastPriced);
    }
    if (!failed.length) {
      if (refreshed) {
        _setStatus('success', total === 1 ? 'Coin removed.' : total + ' coins removed.');
      } else {
        _setStatus('error', (total === 1 ? 'The coin was' : total + ' coins were') + ' removed, but the list could not be refreshed.',
          [{ cls: 'mycoins-retry-load', label: 'Reload list' }]);
      }
      return failed;
    }
    let outcome;
    if (uncertain) {
      outcome = failed.length + (failed.length === 1 ? ' coin' : ' coins') + ' may not have been removed' +
        (refreshed ? '; the list shows what is saved.' : '. Reload the list to check.');
    } else if (removed === 0) {
      outcome = total === 1 ? 'The coin was not removed.' : 'None of the ' + total + ' coins were removed.';
    } else {
      outcome = removed + ' removed; ' + failed.length + ' not removed.' + (refreshed ? '' : ' The list could not be refreshed.');
    }
    const actions = [];
    if (d.login) actions.push({ cls: 'mycoins-relogin', label: 'Log in again' });
    if (d.retry) actions.push({ cls: 'mycoins-retry-remove', label: 'Retry removal', hashes: failed });
    if (!refreshed) actions.push({ cls: 'mycoins-retry-load', label: 'Reload list' });
    _setStatus('error', d.text + ' ' + outcome, actions);
    return failed;
  }

  function init() {
    _container = document.getElementById('mycoins-content');
    if (_container) _container.setAttribute('tabindex', '-1');
    if (!_authListening) {
      window.addEventListener('coinauth:change', _onAuthChange);
      _authListening = true;
    }
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

      // Load-failure recovery buttons (inside the error view)
      if (target.closest('.mycoins-retry')) {
        await render(true);
        _restoreFocusIfLost();
        return;
      }
      if (target.closest('.mycoins-relogin')) { _openLogin(); return; }

      // Sortable headers use native buttons inside semantic column headers.
      const sortButton = target.closest('.mycoins-sort-button');
      const th = sortButton ? sortButton.closest('.mycoins-sortable') : null;
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
        if (!hash || !_lastPriced) return;
        if (!_requireUser('Your session has expired. Nothing was removed.')) return;
        const item = _lastPriced.find(it => it.coin.coinHash === hash);
        const qty = item ? (item.coin.count || 1) : 1;
        const msg = qty > 1
          ? 'Remove all ' + qty + ' of this coin from your collection?'
          : 'Remove this coin from your collection?';
        if (!(await _confirm(msg))) return;
        await _removeHashes([hash]);
        _restoreFocusIfLost();
        return;
      }

      // Bulk delete button
      const delBtn = target.closest('.mycoins-delete-selected');
      if (delBtn && !delBtn.disabled) {
        const checked = _container.querySelectorAll('.mycoins-row-check:checked');
        const hashes = Array.from(checked).map(cb => cb.getAttribute('data-hash'));
        if (!hashes.length) return;
        if (!(await _confirm('Delete ' + hashes.length + ' selected coin(s)?'))) return;
        if (!_requireUser('Your session has expired. Nothing was removed.')) return;

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
        toast.innerHTML = '<span id="mycoins-undo-text">Removing ' + hashes.length + ' coin(s) in 5 seconds.</span> ' +
          '<button class="mycoins-undo-btn" aria-describedby="mycoins-undo-text">Undo</button>';
        _container.prepend(toast);
        var undoBtn = toast.querySelector('.mycoins-undo-btn');
        undoBtn.focus();
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
        await _removeHashes(hashes);
        _restoreFocusIfLost();
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

    // Keydown delegation: inline cost & qty editing (Enter/Escape).
    // Sort buttons use native keyboard activation.
    _container.addEventListener('keydown', (e) => {
      if (e.target.classList.contains('mycoins-cost-input') || e.target.classList.contains('mycoins-qty-input')) {
        if (e.key === 'Enter') {
          e.preventDefault();
          const field = e.target;
          field.blur();
          // A validation error keeps the user in the field they need to fix.
          if (field.isConnected && field.getAttribute('aria-invalid') === 'true') field.focus();
        }
        if (e.key === 'Escape') { e.target.blur(); }
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
    if (!hash || !_lastPriced) return;
    const user = _requireUser('Your session has expired. Your last change was not saved.');
    if (!user) return;
    const val = parseInt(input.value, 10);
    if (isNaN(val) || val < 1 || val > 9999) {
      _fieldMsg(input, 'Whole number, 1 to 9999.', 'error', true);
      return;
    }
    const item = _itemFor(hash);
    if (!item) return;
    const key = 'qty:' + hash;
    if (_inFlight.has(key)) { _queued.set(key, val); return; }
    _fieldMsg(input, '', 'info', false);
    if (val === (item.coin.count || 1)) return;
    await _commitEdit({
      key, input, item, val, what: 'quantity', saved: 'Quantity saved.',
      write: (v) => CoinStorage.updateCount(user.userId, user.key, hash, v),
      apply: (v) => { item.coin.count = v; },
      isCurrent: (v) => v === (item.coin.count || 1),
      restore: () => { input.value = item.coin.count || 1; },
    });
  }

  async function _saveCost(input) {
    const cell = input.closest('.mycoins-cost-cell');
    const hash = cell ? cell.getAttribute('data-hash') : null;
    if (!hash || !_lastPriced) return;
    const user = _requireUser('Your session has expired. Your last change was not saved.');
    if (!user) return;
    const raw = input.value.trim().replace(/^\$/, '');
    const val = raw === '' ? null : parseFloat(raw);
    if (raw !== '' && (isNaN(val) || val < 0)) {
      _fieldMsg(input, 'Enter 0 or more, or leave blank.', 'error', true);
      return;
    }
    const item = _itemFor(hash);
    if (!item) return;
    const key = 'cost:' + hash;
    if (_inFlight.has(key)) { _queued.set(key, val); return; }
    _fieldMsg(input, '', 'info', false);
    const same = (v) => v === item.coin.costPer || (v == null && item.coin.costPer == null);
    if (same(val)) return;
    await _commitEdit({
      key, input, item, val, what: 'cost', saved: 'Cost saved.',
      write: (v) => CoinStorage.updateCostPer(user.userId, user.key, hash, v),
      apply: (v) => { item.coin.costPer = v; },
      isCurrent: same,
      restore: () => { input.value = item.coin.costPer != null ? item.coin.costPer.toFixed(2) : ''; },
    });
  }

  /**
   * Load, decrypt, price, and render the My Coins table.
   * Resolves true when the collection loaded (table or empty message shown), false when
   * the load failed or was skipped (no session, or another load already running).
   */
  async function render(force) {
    if (!_container) init();
    if (!_container) return false;

    const user = CoinAuth.currentUser();
    if (!user) {
      _container.innerHTML =
        '<div class="mycoins-empty">' +
        '<p>Log in to view your coin collection.</p>' +
        '</div>';
      return false;
    }

    // If data is fresh and not forced, re-render from cache (no API calls)
    if (!force && _lastPriced && (Date.now() - _lastRenderedAt < RENDER_CACHE_TTL)) {
      _renderTable(_lastPriced);
      return true;
    }

    if (_loading) return false;
    _loading = true;
    _container.innerHTML = '<p class="mycoins-loading">Loading inventory\u2026</p>';

    try {
      const coins = await CoinStorage.getAllDecrypted(user.userId, user.key);
      _clearStatus();
      if (!coins.length) {
        _lastPriced = null;
        _container.innerHTML =
          '<div class="mycoins-empty">' +
          '<p>No coins in your collection yet.</p>' +
          '<p style="color:var(--text-muted);font-size:0.85rem">Use the "I have this coin" button on any Price Discovery result to add coins.</p>' +
          '</div>';
        return true;
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
      return true;
    } catch (err) {
      _renderLoadError(err);
      return false;
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
        label: coin.label || undefined,
        finish: coin.finish || undefined,
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
              rollQty: r.rollQty || null,
              perCoinFmv: r.perCoinFmv || null,
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
    if (_sortCol !== col) return ' aria-sort="none"';
    return _sortAsc ? ' aria-sort="ascending"' : ' aria-sort="descending"';
  }

  function _sortHeader(label, col, classNames) {
    const classes = 'mycoins-sortable' + (classNames ? ' ' + classNames : '');
    return '<th class="' + classes + '" data-col="' + col + '"' + _ariaSortAttr(col) + '>'
      + '<button type="button" class="mycoins-sort-button" data-col="' + col + '" aria-label="Sort by ' + label + '">'
      + label + '<span aria-hidden="true">' + _sortArrow(col) + '</span></button></th>';
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
    html += _sortHeader('Coin', 'coin');
    html += _sortHeader('Grade', 'grade');
    html += _sortHeader('Label', 'label');
    html += _sortHeader('Qty', 'qty', 'mycoins-qty-col');
    html += _sortHeader('Troy Oz', 'toz', 'mycoins-col-hide');
    html += _sortHeader('FMV (ea)', 'fmv');
    html += _sortHeader('Total', 'total');
    html += _sortHeader('Cost (ea)', 'cost');
    html += _sortHeader('P/L', 'pl');
    html += _sortHeader('Melt', 'melt', 'mycoins-col-hide');
    html += _sortHeader('Avg eBay', 'ebay', 'mycoins-col-hide');
    html += '<th class="mycoins-col-hide">Range</th>';
    html += _sortHeader('Notes', 'notes', 'mycoins-col-hide');
    html += _sortHeader('Added', 'added', 'mycoins-col-hide');
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

      const fmvCell = it.fmv != null ? _$(it.fmv) + (it.rollQty ? ' <span style="opacity:0.6;font-size:0.8em" title="Roll of ' + it.rollQty + ' -- per coin: ' + _$(it.perCoinFmv) + '">\uD83D\uDCE6' + it.rollQty + 'pc</span>' : '') + (it.confidence ? ' <span style="opacity:0.6;font-size:0.85em">(' + _esc(it.confidence) + ')</span>' : '')
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
    var _focusHash = null, _focusClass = null, _focusSortCol = null, _focusSelStart = null, _focusSelEnd = null;
    var ae = document.activeElement;
    if (ae && _container.contains(ae)) {
      _focusClass = ae.classList.contains('mycoins-cost-input') ? 'mycoins-cost-input'
        : ae.classList.contains('mycoins-qty-input') ? 'mycoins-qty-input'
        : ae.classList.contains('mycoins-filter-input') ? 'mycoins-filter-input'
        : ae.classList.contains('mycoins-sort-button') ? 'mycoins-sort-button' : null;
      if (_focusClass === 'mycoins-sort-button') _focusSortCol = ae.getAttribute('data-col');
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
    } else if (_focusClass === 'mycoins-sort-button' && _focusSortCol) {
      toFocus = _container.querySelector('.mycoins-sort-button[data-col="' + _focusSortCol + '"]');
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

  return {
    init,
    render,
    invalidate,
    // ── Test seam ──
    // Exposes IIFE-internal functions and constants so jest (jsdom) tests can
    // exercise them without DOM-driven UI flows. Browser code never reads this.
    // Keep additions minimal and reviewed — anything here becomes a public API
    // surface for tests.
    __testing: {
      MAX_BATCH,
      CONCURRENCY,
      STAGGER_MS,
      SPOT_CACHE_TTL,
      RENDER_CACHE_TTL,
      PAGE_SIZE,
      _renderTable,
      _fetchPricing,
      _fetchSpotPrices,
      _resetSpotCache() {
        _spotPrices = null;
        _spotPricesFetchedAt = 0;
        _spotFetchFailed = false;
      },
      _setContainer(c) { _container = c; },
      _getDelegated() { return _delegated; },
      _resetUiState() {
        _container = null;
        _delegated = false;
        _lastPriced = null;
        _sortCol = 'coin';
        _sortAsc = true;
        _page = 0;
        _filterText = '';
        _loading = false;
        _lastRenderedAt = 0;
        clearTimeout(_statusTimer);
        _statusEl = null;
        _inFlight.clear();
        _queued.clear();
        window.removeEventListener('coinauth:change', _onAuthChange);
        _authListening = false;
      },
      STATUS_CLEAR_MS,
      _saveQty,
      _saveCost,
      _removeHashes,
      _setStatus,
      _setLastPriced(items) { _lastPriced = items; },
    },
  };
})();

// CommonJS shim for jest. No-op in the browser (no `module` global there).
// Tests can: `const MyCoins = require('../../public/js/my-coins');`
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MyCoins;
}

/**
 * @jest-environment @stryker-mutator/jest-runner/jest-env/jsdom
 *
 * myCoinsFailureStates.test.js -- BACKLOG #306H
 *
 * My Coins must never present a failed load as an empty collection, and every
 * failed edit or deletion must leave persistent, actionable text while keeping
 * or restoring the prior UI state.
 */

/* global window, document, KeyboardEvent, CoinStorage */

'use strict';

let currentUser = { userId: 'u1', key: 'k' };
global.CoinAuth = { currentUser: () => currentUser };
global.CoinStorage = {
  getAllDecrypted: jest.fn(),
  removeCoin: jest.fn(),
  updateCount: jest.fn(),
  updateCostPer: jest.fn(),
};
global._esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
global._escAttr = global._esc;

const { CollectionError } = require('../../public/js/storage');
const MyCoins = require('../../public/js/my-coins');

const coin = (over) => ({
  coinHash: 'h1', series: 'Morgan Dollar', year: 1881, mint: 'S', grade: 'MS63', count: 2, costPer: 10, ...over,
});

let container;

async function microflush() {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

async function flush() {
  await microflush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await microflush();
}

const polite = () => document.querySelector('#mycoins-status .mycoins-status-polite');
const alertBox = () => document.querySelector('#mycoins-status .mycoins-status-alert');

function showTable(coins) {
  const items = coins.map((c) => ({ coin: c, fmv: 50 }));
  MyCoins.__testing._setLastPriced(items);
  MyCoins.__testing._renderTable(items);
  return items;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.resetAllMocks();
  currentUser = { userId: 'u1', key: 'k' };
  document.body.innerHTML = '<div id="mycoins-content"></div>';
  container = document.getElementById('mycoins-content');
  MyCoins.__testing._resetUiState();
  MyCoins.__testing._resetSpotCache();
  MyCoins.init();
  window.scrollTo = jest.fn();
  window._openAuthDialog = jest.fn();
  window.confirm = jest.fn(() => true);
  global.fetch = jest.fn(async (url, opts) => {
    if (String(url).startsWith('/api/metals')) return { ok: true, json: async () => ({ price: 30 }) };
    if (url === '/api/pricing-batch') {
      const { items } = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ results: items.map(() => ({ fmv: 50 })) }) };
    }
    throw new Error('unexpected fetch ' + url);
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('loading the collection (#306H)', () => {
  test('a genuinely empty collection shows the empty message and no error', async () => {
    CoinStorage.getAllDecrypted.mockResolvedValue([]);
    await expect(MyCoins.render(true)).resolves.toBe(true);
    expect(container.textContent).toContain('No coins in your collection yet.');
    expect(container.querySelector('.mycoins-error')).toBeNull();
  });

  test.each([
    ['auth-expired', 401, true, 'Your session has expired'],
    ['forbidden', 403, true, 'do not have access'],
    ['rate-limited', 429, false, 'Too many requests'],
    ['timeout', undefined, false, 'took too long'],
    ['malformed', 200, false, 'could not be read'],
    ['server', 500, false, 'unavailable'],
    ['network', undefined, false, 'could not be reached'],
  ])('%s load failure shows a recovery state, never the empty-collection message', async (code, status, login, text) => {
    CoinStorage.getAllDecrypted.mockRejectedValue(new CollectionError(code, 'raw', status));
    await expect(MyCoins.render(true)).resolves.toBe(false);
    const box = container.querySelector('.mycoins-error');
    expect(box).not.toBeNull();
    expect(box.getAttribute('role')).toBe('alert');
    expect(box.textContent).toContain(text);
    expect(container.textContent).not.toContain('No coins in your collection yet.');
    expect(!!container.querySelector('.mycoins-relogin')).toBe(login);
    expect(container.querySelector('.mycoins-retry')).not.toBeNull();
  });

  test('a load failure says the collection was not changed', async () => {
    CoinStorage.getAllDecrypted.mockRejectedValue(new CollectionError('auth-expired', 'x', 401));
    await MyCoins.render(true);
    expect(container.textContent).toContain('Your collection has not been changed.');
  });

  test('an unexpected non-storage error is reported generically and logged', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    CoinStorage.getAllDecrypted.mockRejectedValue(new TypeError('boom'));
    await MyCoins.render(true);
    expect(container.querySelector('.mycoins-error').textContent).toContain('Something went wrong.');
    expect(container.textContent).not.toContain('No coins in your collection yet.');
    expect(spy).toHaveBeenCalled();
  });

  test('the retry button reloads the collection and keeps keyboard focus in the panel', async () => {
    CoinStorage.getAllDecrypted
      .mockRejectedValueOnce(new CollectionError('server', 'x', 500))
      .mockResolvedValueOnce([]);
    await MyCoins.render(true);
    const retry = container.querySelector('.mycoins-retry');
    retry.focus();
    retry.click();
    await flush();
    expect(CoinStorage.getAllDecrypted).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('No coins in your collection yet.');
    expect(document.activeElement).toBe(container);
  });

  test('the log in again button opens the login dialog', async () => {
    CoinStorage.getAllDecrypted.mockRejectedValue(new CollectionError('auth-expired', 'x', 401));
    await MyCoins.render(true);
    container.querySelector('.mycoins-relogin').click();
    await flush();
    expect(window._openAuthDialog).toHaveBeenCalledTimes(1);
  });

  test('a failed reload drops the previously rendered rows', async () => {
    CoinStorage.getAllDecrypted.mockResolvedValueOnce([coin()]);
    await MyCoins.render(true);
    expect(container.querySelector('.mycoins-remove')).not.toBeNull();
    CoinStorage.getAllDecrypted.mockRejectedValueOnce(new CollectionError('server', 'x', 500));
    await MyCoins.render(true);
    expect(container.querySelector('.mycoins-remove')).toBeNull();
    expect(container.querySelector('.mycoins-error')).not.toBeNull();
  });

  test('server-provided text is escaped in the error view', async () => {
    CoinStorage.getAllDecrypted.mockRejectedValue(new CollectionError('server', '<b>hi</b>', 400));
    await MyCoins.render(true);
    expect(container.querySelector('.mycoins-error b')).toBeNull();
    expect(container.querySelector('.mycoins-error').textContent).toContain('<b>hi</b>');
  });

  test('a second load while one is running is skipped', async () => {
    const gate = deferred();
    CoinStorage.getAllDecrypted.mockReturnValue(gate.promise);
    const first = MyCoins.render(true);
    await expect(MyCoins.render(true)).resolves.toBe(false);
    gate.resolve([]);
    await expect(first).resolves.toBe(true);
  });
});

describe('re-login recovery (#306H)', () => {
  test('logging in again reloads the collection when the expired-session view is showing', async () => {
    CoinStorage.getAllDecrypted
      .mockRejectedValueOnce(new CollectionError('auth-expired', 'x', 401))
      .mockResolvedValueOnce([]);
    await MyCoins.render(true);
    window.dispatchEvent(new CustomEvent('coinauth:change', { detail: { username: 'u1' } }));
    await flush();
    expect(CoinStorage.getAllDecrypted).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('No coins in your collection yet.');
  });

  test('logging in does not reload when nothing is stale', async () => {
    CoinStorage.getAllDecrypted.mockResolvedValue([coin()]);
    await MyCoins.render(true);
    window.dispatchEvent(new CustomEvent('coinauth:change', { detail: { username: 'u1' } }));
    await flush();
    expect(CoinStorage.getAllDecrypted).toHaveBeenCalledTimes(1);
  });

  test('logging out clears any previous alert', () => {
    MyCoins.__testing._setStatus('error', 'Old problem.');
    window.dispatchEvent(new CustomEvent('coinauth:change', { detail: null }));
    expect(alertBox().textContent).toBe('');
  });
});

describe('inline quantity edits (#306H)', () => {
  beforeEach(() => showTable([coin()]));

  test('a successful save announces Quantity saved and shows the new value', async () => {
    CoinStorage.updateCount.mockResolvedValue(undefined);
    const input = container.querySelector('.mycoins-qty-input');
    input.value = '5';
    await MyCoins.__testing._saveQty(input);
    expect(CoinStorage.updateCount).toHaveBeenCalledWith('u1', 'k', 'h1', 5);
    expect(polite().textContent).toBe('Quantity saved.');
    expect(container.querySelector('.mycoins-qty-input').value).toBe('5');
  });

  test('a server failure restores the value and keeps persistent text that does not claim certainty', async () => {
    jest.useFakeTimers();
    CoinStorage.updateCount.mockRejectedValue(new CollectionError('server', 'boom', 500));
    const input = container.querySelector('.mycoins-qty-input');
    input.value = '5';
    await MyCoins.__testing._saveQty(input);
    expect(input.value).toBe('2');
    const msg = input.closest('td').querySelector('.mycoins-field-msg');
    expect(msg.textContent).toBe('Not confirmed. Reload the list.');
    expect(msg.hasAttribute('role')).toBe(false);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(msg.id);
    expect(alertBox().textContent).toContain('Morgan Dollar');
    expect(alertBox().textContent).toContain('the quantity could not be saved');
    expect(alertBox().textContent).toContain('may have been saved');
    expect(alertBox().querySelector('.mycoins-retry-load')).not.toBeNull();
    jest.advanceTimersByTime(60000);
    expect(msg.isConnected).toBe(true);
    expect(alertBox().textContent).toContain('could not be saved');
  });

  test('the reload button after an uncertain failure reloads the collection', async () => {
    CoinStorage.updateCount.mockRejectedValue(new CollectionError('timeout', 'x'));
    CoinStorage.getAllDecrypted.mockResolvedValue([coin({ count: 5 })]);
    const input = container.querySelector('.mycoins-qty-input');
    input.value = '5';
    await MyCoins.__testing._saveQty(input);
    alertBox().querySelector('.mycoins-retry-load').click();
    await flush();
    expect(CoinStorage.getAllDecrypted).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.mycoins-qty-input').value).toBe('5');
    expect(alertBox().textContent).toBe('');
  });

  test('a definitive failure says the previous value is shown and offers no reload', async () => {
    CoinStorage.updateCount.mockRejectedValue(new CollectionError('rate-limited', 'x', 429));
    const input = container.querySelector('.mycoins-qty-input');
    input.value = '5';
    await MyCoins.__testing._saveQty(input);
    expect(input.closest('td').querySelector('.mycoins-field-msg').textContent).toBe('Not saved. Previous value shown.');
    expect(alertBox().textContent).toContain('Too many requests');
    expect(alertBox().textContent).toContain('The previous value is shown.');
    expect(alertBox().querySelector('.mycoins-retry-load')).toBeNull();
  });

  test('an expired session raises one alert with a log in again action', async () => {
    CoinStorage.updateCount.mockRejectedValue(new CollectionError('auth-expired', 'x', 401));
    const input = container.querySelector('.mycoins-qty-input');
    input.value = '5';
    await MyCoins.__testing._saveQty(input);
    expect(input.value).toBe('2');
    expect(alertBox().textContent).toContain('Your session has expired');
    const relogin = alertBox().querySelector('.mycoins-relogin');
    expect(relogin).not.toBeNull();
    relogin.click();
    expect(window._openAuthDialog).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  test('a coin that no longer exists asks for a reload', async () => {
    CoinStorage.updateCount.mockRejectedValue(new CollectionError('not-found', 'Coin not found', 404));
    const input = container.querySelector('.mycoins-qty-input');
    input.value = '5';
    await MyCoins.__testing._saveQty(input);
    expect(alertBox().textContent).toContain('This coin no longer exists.');
    expect(alertBox().querySelector('.mycoins-retry-load')).not.toBeNull();
  });

  test('a validation error blocks the save and explains the rule', async () => {
    const input = container.querySelector('.mycoins-qty-input');
    input.value = '0';
    await MyCoins.__testing._saveQty(input);
    expect(CoinStorage.updateCount).not.toHaveBeenCalled();
    const msg = input.closest('td').querySelector('.mycoins-field-msg');
    expect(msg.textContent).toBe('Whole number, 1 to 9999.');
    expect(msg.getAttribute('role')).toBe('alert');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.value).toBe('0');
  });

  test('fixing a validation error clears the message on the next successful save', async () => {
    CoinStorage.updateCount.mockResolvedValue(undefined);
    const input = container.querySelector('.mycoins-qty-input');
    input.value = '0';
    await MyCoins.__testing._saveQty(input);
    input.value = '3';
    await MyCoins.__testing._saveQty(input);
    expect(CoinStorage.updateCount).toHaveBeenCalledWith('u1', 'k', 'h1', 3);
    expect(container.querySelector('.mycoins-field-msg')).toBeNull();
    expect(polite().textContent).toBe('Quantity saved.');
  });

  test('pressing Enter on an invalid value keeps focus in the field', () => {
    const input = container.querySelector('.mycoins-qty-input');
    input.focus();
    input.value = '0';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input);
  });

  test('shows a saving state and coalesces edits typed while the save runs', async () => {
    const first = deferred();
    const second = deferred();
    CoinStorage.updateCount
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const input = container.querySelector('.mycoins-qty-input');
    input.value = '4';
    const firstSave = MyCoins.__testing._saveQty(input);
    expect(input.getAttribute('aria-busy')).toBe('true');
    const msg = input.closest('td').querySelector('.mycoins-field-msg');
    expect(msg.textContent).toContain('Saving');

    input.value = '6';
    await MyCoins.__testing._saveQty(input);
    expect(CoinStorage.updateCount).toHaveBeenCalledTimes(1);
    expect(input.closest('td').querySelector('.mycoins-field-msg').textContent).toContain('Saving');

    first.resolve();
    await microflush();
    expect(CoinStorage.updateCount).toHaveBeenCalledTimes(2);
    expect(CoinStorage.updateCount).toHaveBeenLastCalledWith('u1', 'k', 'h1', 6);
    second.resolve();
    await firstSave;
    expect(polite().textContent).toBe('Quantity saved.');
    expect(container.querySelector('.mycoins-qty-input').value).toBe('6');
  });

  test('an edit that returns to the saved value is not sent again', async () => {
    const first = deferred();
    CoinStorage.updateCount.mockReturnValueOnce(first.promise);
    const input = container.querySelector('.mycoins-qty-input');
    input.value = '4';
    const firstSave = MyCoins.__testing._saveQty(input);
    await MyCoins.__testing._saveQty(input);
    first.resolve();
    await firstSave;
    expect(CoinStorage.updateCount).toHaveBeenCalledTimes(1);
  });

  test('a failed save discards edits queued behind it', async () => {
    const first = deferred();
    CoinStorage.updateCount.mockReturnValueOnce(first.promise);
    const input = container.querySelector('.mycoins-qty-input');
    input.value = '4';
    const firstSave = MyCoins.__testing._saveQty(input);
    input.value = '6';
    await MyCoins.__testing._saveQty(input);
    first.reject(new CollectionError('rate-limited', 'x', 429));
    await firstSave;
    expect(CoinStorage.updateCount).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('2');
  });

  test('a failure still raises an alert when a re-render replaced the input mid-save', async () => {
    const gate = deferred();
    CoinStorage.updateCount.mockReturnValueOnce(gate.promise);
    const input = container.querySelector('.mycoins-qty-input');
    input.value = '5';
    const save = MyCoins.__testing._saveQty(input);
    showTable([coin()]);
    expect(input.isConnected).toBe(false);
    gate.reject(new CollectionError('rate-limited', 'x', 429));
    await save;
    expect(alertBox().textContent).toContain('the quantity could not be saved');
  });

  test('a later successful save does not erase an earlier failure alert', async () => {
    MyCoins.__testing._setStatus('error', 'Earlier problem.');
    CoinStorage.updateCount.mockResolvedValue(undefined);
    const input = container.querySelector('.mycoins-qty-input');
    input.value = '5';
    await MyCoins.__testing._saveQty(input);
    expect(polite().textContent).toBe('Quantity saved.');
    expect(alertBox().textContent).toContain('Earlier problem.');
  });

  test('server-provided failure text cannot inject markup', async () => {
    CoinStorage.updateCount.mockRejectedValue(new CollectionError('server', '<img src=x onerror=1>', 400));
    const input = container.querySelector('.mycoins-qty-input');
    input.value = '5';
    await MyCoins.__testing._saveQty(input);
    expect(alertBox().querySelector('img')).toBeNull();
    expect(alertBox().textContent).toContain('<img src=x onerror=1>');
  });

  test('without a session the user is told the change was not saved', async () => {
    currentUser = null;
    const input = container.querySelector('.mycoins-qty-input');
    input.value = '5';
    await MyCoins.__testing._saveQty(input);
    expect(CoinStorage.updateCount).not.toHaveBeenCalled();
    expect(alertBox().textContent).toContain('Your last change was not saved.');
    expect(alertBox().querySelector('.mycoins-relogin')).not.toBeNull();
  });
});

describe('inline cost edits (#306H)', () => {
  beforeEach(() => showTable([coin()]));

  test('a successful save announces Cost saved', async () => {
    CoinStorage.updateCostPer.mockResolvedValue(undefined);
    const input = container.querySelector('.mycoins-cost-input');
    input.value = '12.5';
    await MyCoins.__testing._saveCost(input);
    expect(CoinStorage.updateCostPer).toHaveBeenCalledWith('u1', 'k', 'h1', 12.5);
    expect(polite().textContent).toBe('Cost saved.');
  });

  test('clearing the field saves a null cost', async () => {
    CoinStorage.updateCostPer.mockResolvedValue(undefined);
    const input = container.querySelector('.mycoins-cost-input');
    input.value = '';
    await MyCoins.__testing._saveCost(input);
    expect(CoinStorage.updateCostPer).toHaveBeenCalledWith('u1', 'k', 'h1', null);
  });

  test('a negative cost is rejected with adjacent text and no request', async () => {
    const input = container.querySelector('.mycoins-cost-input');
    input.value = '-5';
    await MyCoins.__testing._saveCost(input);
    expect(CoinStorage.updateCostPer).not.toHaveBeenCalled();
    const msg = input.closest('td').querySelector('.mycoins-field-msg');
    expect(msg.textContent).toBe('Enter 0 or more, or leave blank.');
    expect(msg.getAttribute('role')).toBe('alert');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  test('a failed save restores the previous cost and explains why', async () => {
    CoinStorage.updateCostPer.mockRejectedValue(new CollectionError('rate-limited', 'x', 429));
    const input = container.querySelector('.mycoins-cost-input');
    input.value = '99';
    await MyCoins.__testing._saveCost(input);
    expect(input.value).toBe('10.00');
    expect(input.closest('td').querySelector('.mycoins-field-msg').textContent).toBe('Not saved. Previous value shown.');
    expect(alertBox().textContent).toContain('the cost could not be saved');
    expect(alertBox().textContent).toContain('Too many requests');
  });

  test('a failed save of a previously blank cost restores a blank field', async () => {
    showTable([coin({ costPer: null })]);
    CoinStorage.updateCostPer.mockRejectedValue(new CollectionError('server', 'x', 500));
    const input = container.querySelector('.mycoins-cost-input');
    input.value = '7';
    await MyCoins.__testing._saveCost(input);
    expect(input.value).toBe('');
  });

  test('cost edits typed while a save runs are coalesced', async () => {
    const first = deferred();
    CoinStorage.updateCostPer
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined);
    const input = container.querySelector('.mycoins-cost-input');
    input.value = '11';
    const firstSave = MyCoins.__testing._saveCost(input);
    input.value = '12';
    await MyCoins.__testing._saveCost(input);
    first.resolve();
    await firstSave;
    expect(CoinStorage.updateCostPer).toHaveBeenCalledTimes(2);
    expect(CoinStorage.updateCostPer).toHaveBeenLastCalledWith('u1', 'k', 'h1', 12);
  });
});

describe('removing coins (#306H)', () => {
  test('a successful removal reloads the collection and confirms', async () => {
    showTable([coin()]);
    CoinStorage.removeCoin.mockResolvedValue(undefined);
    CoinStorage.getAllDecrypted.mockResolvedValue([]);
    const failed = await MyCoins.__testing._removeHashes(['h1']);
    expect(failed).toEqual([]);
    expect(container.textContent).toContain('No coins in your collection yet.');
    expect(polite().textContent).toBe('Coin removed.');
  });

  test('a definitive failure keeps the table without reloading and offers a retry', async () => {
    showTable([coin()]);
    CoinStorage.removeCoin.mockRejectedValue(new CollectionError('rate-limited', 'x', 429));
    const failed = await MyCoins.__testing._removeHashes(['h1']);
    expect(failed).toEqual(['h1']);
    expect(CoinStorage.getAllDecrypted).not.toHaveBeenCalled();
    expect(container.querySelector('.mycoins-remove[data-hash="h1"]')).not.toBeNull();
    expect(alertBox().textContent).toContain('The coin was not removed.');
    const retry = alertBox().querySelector('.mycoins-retry-remove');
    expect(retry.textContent).toBe('Retry removal');
    expect(retry.getAttribute('data-hashes')).toBe('h1');

    CoinStorage.removeCoin.mockResolvedValueOnce(undefined);
    CoinStorage.getAllDecrypted.mockResolvedValue([]);
    retry.click();
    await flush();
    expect(container.textContent).toContain('No coins in your collection yet.');
    expect(polite().textContent).toBe('Coin removed.');
    expect(alertBox().textContent).toBe('');
  });

  test('an uncertain failure reloads and says the coin may not have been removed', async () => {
    showTable([coin()]);
    CoinStorage.removeCoin.mockRejectedValue(new CollectionError('timeout', 'x'));
    CoinStorage.getAllDecrypted.mockResolvedValue([coin()]);
    const failed = await MyCoins.__testing._removeHashes(['h1']);
    expect(failed).toEqual(['h1']);
    expect(CoinStorage.getAllDecrypted).toHaveBeenCalledTimes(1);
    expect(alertBox().textContent).toContain('1 coin may not have been removed; the list shows what is saved.');
    expect(alertBox().querySelector('.mycoins-retry-remove')).not.toBeNull();
  });

  test('a removal whose reload fails says so instead of claiming the list is current', async () => {
    showTable([coin()]);
    CoinStorage.removeCoin.mockResolvedValue(undefined);
    CoinStorage.getAllDecrypted.mockRejectedValue(new CollectionError('server', 'x', 500));
    const failed = await MyCoins.__testing._removeHashes(['h1']);
    expect(failed).toEqual([]);
    expect(polite().textContent).toBe('');
    expect(alertBox().textContent).toContain('The coin was removed, but the list could not be refreshed.');
    expect(alertBox().querySelector('.mycoins-retry-load')).not.toBeNull();
  });

  test('an expired session stops the batch and offers log in again', async () => {
    showTable([coin({ coinHash: 'h1' }), coin({ coinHash: 'h2' }), coin({ coinHash: 'h3' })]);
    CoinStorage.removeCoin
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new CollectionError('auth-expired', 'x', 401));
    CoinStorage.getAllDecrypted.mockRejectedValue(new CollectionError('auth-expired', 'x', 401));
    const failed = await MyCoins.__testing._removeHashes(['h1', 'h2', 'h3']);
    expect(failed).toEqual(['h2', 'h3']);
    expect(CoinStorage.removeCoin).toHaveBeenCalledTimes(2);
    expect(alertBox().textContent).toContain('Your session has expired');
    expect(alertBox().textContent).toContain('1 removed; 2 not removed.');
    expect(alertBox().querySelector('.mycoins-relogin')).not.toBeNull();
    expect(alertBox().querySelector('.mycoins-retry-remove')).toBeNull();
  });

  test('a partial definitive failure reports the counts and retries only the failures', async () => {
    showTable([coin({ coinHash: 'h1' }), coin({ coinHash: 'h2' }), coin({ coinHash: 'h3' })]);
    CoinStorage.removeCoin
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new CollectionError('rate-limited', 'x', 429))
      .mockResolvedValueOnce(undefined);
    CoinStorage.getAllDecrypted.mockResolvedValue([coin({ coinHash: 'h2' })]);
    const failed = await MyCoins.__testing._removeHashes(['h1', 'h2', 'h3']);
    expect(failed).toEqual(['h2']);
    expect(CoinStorage.removeCoin).toHaveBeenCalledTimes(3);
    expect(alertBox().textContent).toContain('2 removed; 1 not removed.');
    expect(alertBox().querySelector('.mycoins-retry-remove').getAttribute('data-hashes')).toBe('h2');
  });

  test('without a session it asks the user to log in, removes nothing, and shows the login prompt', async () => {
    showTable([coin()]);
    currentUser = null;
    const failed = await MyCoins.__testing._removeHashes(['h1']);
    expect(failed).toEqual(['h1']);
    expect(CoinStorage.removeCoin).not.toHaveBeenCalled();
    expect(alertBox().textContent).toContain('Your session has expired. Nothing was removed.');
    expect(alertBox().querySelector('.mycoins-relogin')).not.toBeNull();
    expect(container.textContent).toContain('Log in to view your coin collection.');
  });

  test('the remove button routes through the safe removal flow and keeps focus in the panel', async () => {
    showTable([coin()]);
    CoinStorage.removeCoin.mockRejectedValue(new CollectionError('rate-limited', 'x', 429));
    container.querySelector('.mycoins-remove').click();
    await flush();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(CoinStorage.removeCoin).toHaveBeenCalledWith('u1', 'h1');
    expect(container.querySelector('.mycoins-remove[data-hash="h1"]')).not.toBeNull();
    expect(alertBox().textContent).toContain('The coin was not removed.');
    expect(document.activeElement).toBe(container);
  });

  test('declining the confirmation removes nothing', async () => {
    showTable([coin()]);
    window.confirm = jest.fn(() => false);
    container.querySelector('.mycoins-remove').click();
    await flush();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(CoinStorage.removeCoin).not.toHaveBeenCalled();
  });

  test('without a session the remove button explains instead of doing nothing', async () => {
    showTable([coin()]);
    currentUser = null;
    container.querySelector('.mycoins-remove').click();
    await flush();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(alertBox().textContent).toContain('Your session has expired. Nothing was removed.');
  });

  describe('bulk delete', () => {
    function selectAll() {
      container.querySelectorAll('.mycoins-row-check').forEach((box) => {
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    test('announces the pending removal, focuses Undo, and keeps failed rows after the undo window', async () => {
      jest.useFakeTimers();
      showTable([coin({ coinHash: 'h1' }), coin({ coinHash: 'h2' })]);
      CoinStorage.removeCoin
        .mockRejectedValueOnce(new CollectionError('rate-limited', 'x', 429))
        .mockResolvedValueOnce(undefined);
      CoinStorage.getAllDecrypted.mockResolvedValue([coin({ coinHash: 'h1' })]);
      selectAll();
      container.querySelector('.mycoins-delete-selected').click();
      await microflush();
      const toast = container.querySelector('.mycoins-undo-toast');
      expect(toast.textContent).toContain('Removing 2 coin(s) in 5 seconds.');
      expect(document.activeElement.classList.contains('mycoins-undo-btn')).toBe(true);
      jest.advanceTimersByTime(5000);
      await microflush();
      await microflush();
      expect(CoinStorage.removeCoin).toHaveBeenCalledTimes(2);
      const box = container.querySelector('.mycoins-row-check[data-hash="h1"]');
      expect(box).not.toBeNull();
      expect(box.closest('tr').style.display).not.toBe('none');
      expect(alertBox().textContent).toContain('1 removed; 1 not removed.');
    });

    test('Undo cancels the removal', async () => {
      jest.useFakeTimers();
      showTable([coin({ coinHash: 'h1' })]);
      selectAll();
      container.querySelector('.mycoins-delete-selected').click();
      await microflush();
      container.querySelector('.mycoins-undo-btn').click();
      jest.advanceTimersByTime(5000);
      await microflush();
      expect(CoinStorage.removeCoin).not.toHaveBeenCalled();
      expect(container.querySelector('.mycoins-undo-toast')).toBeNull();
    });

    test('losing the session during the undo window restores the view instead of leaving rows hidden', async () => {
      jest.useFakeTimers();
      showTable([coin({ coinHash: 'h1' })]);
      selectAll();
      container.querySelector('.mycoins-delete-selected').click();
      await microflush();
      currentUser = null;
      jest.advanceTimersByTime(5000);
      await microflush();
      await microflush();
      expect(CoinStorage.removeCoin).not.toHaveBeenCalled();
      expect(alertBox().textContent).toContain('Your session has expired. Nothing was removed.');
      expect(container.textContent).toContain('Log in to view your coin collection.');
      expect(container.querySelector('.mycoins-row-check')).toBeNull();
    });

    test('without a session the bulk button explains instead of hiding rows', async () => {
      showTable([coin({ coinHash: 'h1' })]);
      selectAll();
      currentUser = null;
      container.querySelector('.mycoins-delete-selected').click();
      await flush();
      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(alertBox().textContent).toContain('Your session has expired. Nothing was removed.');
      expect(container.querySelector('.mycoins-undo-toast')).toBeNull();
    });
  });
});

describe('status region (#306H)', () => {
  test('success messages clear themselves after the timeout', () => {
    jest.useFakeTimers();
    MyCoins.__testing._setStatus('success', 'Saved.');
    expect(polite().textContent).toBe('Saved.');
    jest.advanceTimersByTime(MyCoins.__testing.STATUS_CLEAR_MS);
    expect(polite().textContent).toBe('');
  });

  test('progress messages stay until replaced', () => {
    jest.useFakeTimers();
    MyCoins.__testing._setStatus('info', 'Removing 1 of 3\u2026');
    jest.advanceTimersByTime(60000);
    expect(polite().textContent).toContain('Removing 1 of 3');
  });

  test('error messages persist and can be dismissed, returning focus to the panel', () => {
    jest.useFakeTimers();
    MyCoins.__testing._setStatus('error', 'Something failed.');
    jest.advanceTimersByTime(60000);
    expect(alertBox().textContent).toContain('Something failed.');
    const dismiss = alertBox().querySelector('.mycoins-status-dismiss');
    dismiss.focus();
    dismiss.click();
    expect(alertBox().textContent).toBe('');
    expect(document.activeElement).toBe(container);
  });

  test('an error replaces a pending success message', () => {
    MyCoins.__testing._setStatus('success', 'Saved.');
    MyCoins.__testing._setStatus('error', 'Failed.');
    expect(polite().textContent).toBe('');
    expect(alertBox().textContent).toContain('Failed.');
  });

  test('success and progress messages leave an existing alert alone', () => {
    MyCoins.__testing._setStatus('error', 'Failed.');
    MyCoins.__testing._setStatus('success', 'Saved.');
    MyCoins.__testing._setStatus('info', 'Working\u2026');
    expect(alertBox().textContent).toContain('Failed.');
  });

  test('the region sits outside the re-rendered container so table renders keep it', () => {
    MyCoins.__testing._setStatus('error', 'Failed.');
    showTable([coin()]);
    expect(document.getElementById('mycoins-status')).not.toBeNull();
    expect(container.contains(document.getElementById('mycoins-status'))).toBe(false);
    expect(alertBox().textContent).toContain('Failed.');
  });

  test('static markup from the page is reused and bound once', () => {
    document.body.innerHTML = '<div id="mycoins-status" class="mycoins-status">' +
      '<div class="mycoins-status-polite" role="status" aria-live="polite"></div>' +
      '<div class="mycoins-status-alert" role="alert"></div></div>' +
      '<div id="mycoins-content"></div>';
    container = document.getElementById('mycoins-content');
    MyCoins.__testing._resetUiState();
    MyCoins.init();
    MyCoins.__testing._setStatus('error', 'Failed.');
    MyCoins.__testing._setStatus('error', 'Failed again.');
    expect(document.querySelectorAll('#mycoins-status')).toHaveLength(1);
    alertBox().querySelector('.mycoins-status-dismiss').click();
    expect(alertBox().textContent).toBe('');
  });

  test('a successful reload clears an old error', async () => {
    MyCoins.__testing._setStatus('error', 'Old problem.');
    CoinStorage.getAllDecrypted.mockResolvedValue([]);
    await MyCoins.render(true);
    expect(alertBox().textContent).toBe('');
  });
});

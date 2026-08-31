/**
 * @jest-environment jsdom
 *
 * myCoinsDelegation.test.js — BACKLOG #22 / #238
 *
 * Verifies that MyCoins.init() wires the single delegated event handler
 * exactly once on the container (idempotent) and that subsequent re-renders
 * do not double-bind listeners.
 */

'use strict';

global.CoinAuth = { currentUser: () => null };
global.CoinStorage = {
  getAllDecrypted: jest.fn(),
  removeCoin: jest.fn(),
  updateCount: jest.fn(),
  updateCostPer: jest.fn(),
};
global._esc = (s) => String(s == null ? '' : s);
global._escAttr = (s) => String(s == null ? '' : s);

const MyCoins = require('../../public/js/my-coins');

describe('MyCoins delegation wiring (#22)', () => {
  let container;
  let listenerCounts;

  beforeEach(() => {
    MyCoins.__testing._resetUiState();
    document.body.innerHTML = '<div id="mycoins-content"></div>';
    container = document.getElementById('mycoins-content');

    // Count how many times addEventListener is called on the container, by event.
    listenerCounts = {};
    const real = container.addEventListener.bind(container);
    container.addEventListener = (type, fn, opts) => {
      listenerCounts[type] = (listenerCounts[type] || 0) + 1;
      return real(type, fn, opts);
    };
  });

  test('init() wires delegated listeners exactly once', () => {
    MyCoins.init();
    const after1 = { ...listenerCounts };
    // Expect at least click, change, input, blur, keydown bound exactly once.
    expect(after1.click).toBe(1);
    expect(after1.change).toBe(1);
    expect(after1.input).toBe(1);
    expect(after1.blur).toBe(1);
    expect(after1.keydown).toBe(1);
  });

  test('init() is idempotent — calling it twice does not double-bind', () => {
    MyCoins.init();
    const after1 = { ...listenerCounts };
    MyCoins.init();
    expect(listenerCounts).toEqual(after1);
    expect(MyCoins.__testing._getDelegated()).toBe(true);
  });

  test('clicking a native sort button inside a semantic header is dispatched without throwing', () => {
    MyCoins.init();
    container.innerHTML = '<table><thead><tr><th class="mycoins-sortable" data-col="fmv" aria-sort="none"><button type="button" class="mycoins-sort-button" data-col="fmv">FMV</button></th></tr></thead></table>';
    const button = container.querySelector('.mycoins-sort-button');
    // A no-op event flow when there is no cached pricing; should not throw.
    expect(() => button.click()).not.toThrow();
  });

  test('rendered sortable columns keep columnheader semantics and use native buttons', () => {
    MyCoins.__testing._setContainer(container);
    MyCoins.__testing._renderTable([]);

    const header = container.querySelector('.mycoins-sortable[data-col="coin"]');
    const button = header.querySelector('.mycoins-sort-button');
    expect(header.tagName).toBe('TH');
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(header.hasAttribute('role')).toBe(false);
    expect(header.hasAttribute('tabindex')).toBe(false);
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Sort by Coin');
    expect(button.querySelector('[aria-hidden="true"]').textContent).toBe(' ' + String.fromCharCode(0x25B2));
  });

  test('sorting updates aria-sort and restores focus to the activated button', () => {
    MyCoins.init();
    MyCoins.__testing._setLastPriced([]);
    MyCoins.__testing._renderTable([]);

    const button = container.querySelector('.mycoins-sort-button[data-col="coin"]');
    button.focus();
    button.click();

    const updatedHeader = container.querySelector('.mycoins-sortable[data-col="coin"]');
    const updatedButton = updatedHeader.querySelector('.mycoins-sort-button');
    expect(updatedHeader.getAttribute('aria-sort')).toBe('descending');
    expect(document.activeElement).toBe(updatedButton);
    expect(updatedButton.querySelector('[aria-hidden="true"]').textContent).toBe(' ' + String.fromCharCode(0x25BC));
  });
});

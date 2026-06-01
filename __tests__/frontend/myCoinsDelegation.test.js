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

  test('clicking a sortable header inside the container is dispatched without throwing', () => {
    MyCoins.init();
    container.innerHTML = '<table><thead><tr><th class="mycoins-sortable" data-col="fmv"></th></tr></thead></table>';
    const th = container.querySelector('.mycoins-sortable');
    // A no-op event flow when there is no cached pricing; should not throw.
    expect(() => th.click()).not.toThrow();
  });
});

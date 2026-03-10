// test-my-coins.js — Browser console test utility
// Paste this into the browser dev console at http://localhost:3000
// It will: sign up a test user, add 10 coins, then open the My Coins tab.
//
// Test credentials:
//   Username: testcollector
//   Password: Coins2026!

(async function testMyCoins() {
  'use strict';

  const USERNAME = 'testcollector';
  const PASSWORD = 'Coins2026!';

  // ── Test coin collection (10 coins spanning different series) ──
  const TEST_COINS = [
    { series: 'Morgan Dollar',             year: '1921', mint: 'D', grade: 'MS-65', weight: null, count: 3,  query: '1921-D Morgan Dollar MS-65' },
    { series: 'Morgan Dollar',             year: '1878', mint: 'S', grade: 'VF-30', weight: null, count: 1,  query: '1878-S Morgan Dollar VF-30' },
    { series: 'Peace Dollar',              year: '1923', mint: 'P', grade: 'MS-63', weight: null, count: 2,  query: '1923 Peace Dollar MS-63' },
    { series: 'Kennedy Half Dollar',       year: '1964', mint: 'P', grade: 'PR-69', weight: null, count: 1,  query: '1964 Kennedy Half Dollar PR-69' },
    { series: 'Walking Liberty Half Dollar',year:'1941', mint: 'S', grade: 'VF-25', weight: null, count: 1,  query: '1941-S Walking Liberty Half Dollar VF-25' },
    { series: 'American Silver Eagle',     year: '2024', mint: 'P', grade: 'MS-70', weight: 1,    count: 20, query: '2024 American Silver Eagle MS-70' },
    { series: 'Washington Quarter',        year: '1932', mint: 'D', grade: 'VG-10', weight: null, count: 1,  query: '1932-D Washington Quarter VG-10' },
    { series: 'Roosevelt Dime',            year: '1946', mint: 'P', grade: 'MS-66', weight: null, count: 5,  query: '1946 Roosevelt Dime MS-66' },
    { series: 'Buffalo Nickel',            year: '1937', mint: 'D', grade: 'MS-64', weight: null, count: 1,  query: '1937-D Buffalo Nickel MS-64' },
    { series: 'Lincoln Cent',              year: '1909', mint: 'S', grade: 'VF-20', weight: null, count: 1,  query: '1909-S Lincoln Cent VF-20' },
  ];

  console.log('=== My Coins Test Utility ===\n');

  // Step 1: Sign up (or log in if account exists)
  try {
    if (typeof CoinAuth === 'undefined') {
      console.error('CoinAuth not loaded. Make sure you are on http://localhost:3000');
      return;
    }

    let user;
    try {
      user = await CoinAuth.signup(USERNAME, PASSWORD);
      console.log('✅ Created account: ' + user.username + ' (userId: ' + user.userId + ')');
    } catch (e) {
      if (e.message.includes('already exists')) {
        user = await CoinAuth.login(USERNAME, PASSWORD);
        console.log('✅ Logged into existing account: ' + user.username);
      } else {
        throw e;
      }
    }

    // Step 2: Add coins
    const session = CoinAuth.currentUser();
    console.log('\nAdding ' + TEST_COINS.length + ' coins to collection...\n');

    for (const coin of TEST_COINS) {
      const hash = await CoinStorage.addCoin(session.userId, session.key, coin);
      console.log('  + ' + coin.query + '  [hash: ' + hash.slice(0, 12) + '...]');
    }

    // Step 3: Verify count
    const count = await CoinStorage.count(session.userId);
    console.log('\n✅ Collection now has ' + count + ' coin(s)\n');

    // Step 4: Test decryption round-trip
    console.log('Testing decryption...');
    const decrypted = await CoinStorage.getAllDecrypted(session.userId, session.key);
    console.log('  Decrypted ' + decrypted.length + ' records');
    decrypted.forEach(c => {
      console.log('  ✓ ' + [c.year, c.mint, c.series, c.grade].filter(Boolean).join(' '));
    });

    // Step 5: Update auth badge
    const badge = document.getElementById('user-badge');
    if (badge) {
      badge.innerHTML = '<span class="user-badge-name">' + session.username + '</span>' +
        '<button id="auth-logout" onclick="CoinAuth.logout();location.reload()">Log Out</button>';
    }

    // Step 6: Switch to My Coins tab
    console.log('\nSwitching to My Coins tab...');
    const tab = document.getElementById('tab-mycoins');
    if (tab) tab.click();

    console.log('\n=== Test Complete ===');
    console.log('Username: ' + USERNAME);
    console.log('Password: ' + PASSWORD);
    console.log('Coins: ' + count);
    console.log('\nYou can now:');
    console.log('  • View the My Coins tab with portfolio totals');
    console.log('  • Search for a coin in Price Discovery and click "I have this coin"');
    console.log('  • Reload the page and log in with the same credentials');
    console.log('  • Remove coins from the My Coins table');

  } catch (err) {
    console.error('Test failed:', err);
  }
})();

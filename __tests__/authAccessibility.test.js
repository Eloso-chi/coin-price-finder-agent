/**
 * @jest-environment jsdom
 */
/* global document */

'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function tagWithId(id) {
  const match = source.match(new RegExp(`<[^>]+id=["']${id}["'][^>]*>`));
  expect(match).not.toBeNull();
  return match[0];
}

describe('critical authentication accessibility contract (#303H)', () => {
  test.each([
    'auth-switch',
    'auth-use-recovery',
    'recovery-back-to-login',
  ])('%s is a native keyboard-operable button', (id) => {
    const tag = tagWithId(id);
    expect(tag).toMatch(/^<button\b/);
    expect(tag).toContain('type="button"');
    expect(tag).toContain('class="auth-link-button"');
    expect(source).not.toMatch(new RegExp(`<a[^>]+id=["']${id}["']`));
  });

  test('administrator credentials have persistent labels and shared error context', () => {
    expect(source).toContain('<label for="admin-user-input"');
    expect(source).toContain('<label for="admin-key-input"');

    for (const id of ['admin-user-input', 'admin-key-input']) {
      expect(tagWithId(id)).toContain('aria-describedby="admin-key-error"');
    }

    const error = tagWithId('admin-key-error');
    expect(error).toContain('role="alert"');
    expect(error).toContain('aria-live="assertive"');
    expect(error).toContain('aria-atomic="true"');
  });

  test.each([
    ['auth-username', 'auth-error'],
    ['auth-password', 'auth-error'],
    ['recovery-username', 'recovery-error'],
    ['recovery-phrase-input', 'recovery-error'],
    ['recovery-new-pw', 'recovery-newpw-error'],
    ['recovery-confirm-pw', 'recovery-newpw-error'],
    ['changepw-current', 'changepw-error'],
    ['changepw-new', 'changepw-error'],
    ['changepw-confirm', 'changepw-error'],
    ['coinName', 'coinName-error'],
    ['coinYear', 'coinYear-error'],
  ])('%s is associated with its error container', (inputId, errorId) => {
    expect(tagWithId(inputId)).toContain(`aria-describedby="${errorId}"`);
    expect(tagWithId(errorId)).toContain('role="alert"');
  });

  test('invalid states are programmatic, cleared on input, and focused for recovery', () => {
    expect(source).toContain("field.setAttribute('aria-invalid', 'true')");
    expect(source).toContain("username.removeAttribute('aria-invalid')");
    expect(source).toContain("password.removeAttribute('aria-invalid')");
    expect(source).toContain("userInput.addEventListener('input', _clearCredentialError)");
    expect(source).toContain("keyInput.addEventListener('input', _clearCredentialError)");
    expect(source).toContain('if (firstInvalid) firstInvalid.focus()');
  });
});

describe('authentication interaction behavior (#303H)', () => {
  let coinAuth;

  function installAuthUI() {
    document.body.innerHTML = `
      <div id="user-badge"><button id="auth-trigger">Log In</button></div>
      <dialog id="auth-dialog">
        <h2 id="auth-dialog-title">Log In</h2>
        <input id="auth-username" aria-describedby="auth-error">
        <input id="auth-password" type="password" autocomplete="current-password" aria-describedby="auth-error">
        <div id="auth-error" tabindex="-1"></div>
        <button id="auth-submit">Log In</button>
        <button id="auth-cancel">Cancel</button>
        <div id="auth-toggle"><span id="auth-toggle-prompt">Don't have an account?</span><button id="auth-switch">Sign Up</button></div>
      </dialog>`;

    const dialog = document.getElementById('auth-dialog');
    dialog.showModal = function showModal() { this.open = true; };
    dialog.close = function close() {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };

    coinAuth = {
      currentUser: jest.fn(() => null),
      pendingReauth: jest.fn(() => null),
      login: jest.fn(() => Promise.resolve()),
      signup: jest.fn(() => Promise.resolve()),
      logout: jest.fn(),
    };

    const start = source.indexOf('(function initAuthUI() {');
    const finalBadgeMatch = source.slice(start).match(/\r?\n {4}updateBadge\(\);\r?\n\r?\n {4}\/\*/);
    const finalBadge = finalBadgeMatch ? start + finalBadgeMatch.index : -1;
    expect(start).toBeGreaterThan(-1);
    expect(finalBadge).toBeGreaterThan(start);
    const finalInvocation = source.indexOf('updateBadge();', finalBadge);
    const script = source.slice(start, finalInvocation + 'updateBadge();'.length) + '\n  })();';
    Function('CoinAuth', '_esc', script)(coinAuth, String);
  }

  beforeEach(() => {
    installAuthUI();
  });

  test('switches login to signup and back with stable native control semantics', () => {
    const switchButton = document.getElementById('auth-switch');
    const title = document.getElementById('auth-dialog-title');
    const submit = document.getElementById('auth-submit');
    const password = document.getElementById('auth-password');

    expect(switchButton.tagName).toBe('BUTTON');
    switchButton.click();
    expect(title.textContent).toBe('Sign Up');
    expect(submit.textContent).toBe('Create Account');
    expect(password.autocomplete).toBe('new-password');

    switchButton.click();
    expect(title.textContent).toBe('Log In');
    expect(submit.textContent).toBe('Log In');
    expect(password.autocomplete).toBe('current-password');
  });

  test('focuses and marks only the first missing login field', () => {
    const username = document.getElementById('auth-username');
    const password = document.getElementById('auth-password');
    const submit = document.getElementById('auth-submit');

    submit.click();
    expect(username.getAttribute('aria-invalid')).toBe('true');
    expect(password.hasAttribute('aria-invalid')).toBe(false);
    expect(document.activeElement).toBe(username);

    username.value = 'collector';
    username.dispatchEvent(new Event('input', { bubbles: true }));
    submit.click();
    expect(username.hasAttribute('aria-invalid')).toBe(false);
    expect(password.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(password);
  });

  test('clears a corrected field error on input', () => {
    const username = document.getElementById('auth-username');
    document.getElementById('auth-submit').click();
    expect(username.getAttribute('aria-invalid')).toBe('true');

    username.value = 'collector';
    username.dispatchEvent(new Event('input', { bubbles: true }));
    expect(username.hasAttribute('aria-invalid')).toBe(false);
    expect(document.getElementById('auth-error').textContent).toBe('');
  });

  test('uses a form-level alert without false field invalidation for rejected credentials', async () => {
    coinAuth.login.mockRejectedValueOnce(new Error('Invalid credentials'));
    const username = document.getElementById('auth-username');
    const password = document.getElementById('auth-password');
    const error = document.getElementById('auth-error');
    username.value = 'collector';
    password.value = 'wrong-password';

    document.getElementById('auth-submit').click();
    await Promise.resolve();
    await Promise.resolve();

    expect(error.textContent).toBe('Invalid credentials');
    expect(document.activeElement).toBe(error);
    expect(username.hasAttribute('aria-invalid')).toBe(false);
    expect(password.hasAttribute('aria-invalid')).toBe(false);
  });
});

// crypto.js — Client-side cryptography module (WebCrypto only)
// PBKDF2 key derivation + AES-256-GCM encrypt/decrypt + SHA-256 hashing
// No dependencies. Never sends data to the server.

'use strict';

const CoinCrypto = (() => {
  const PBKDF2_ITERATIONS = 600_000;
  const SALT_BYTES = 16;
  const IV_BYTES = 12;
  const KEY_LENGTH = 256; // AES-256
  const VERIFY_PLAINTEXT = 'COINVAULT_VERIFY_TOKEN_V1';

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ── Helpers ──────────────────────────────────────────────

  function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  }

  function bufToHex(buf) {
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function hexToBuf(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  }

  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBuf(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ── Key Derivation ──────────────────────────────────────

  /**
   * Derive an AES-256-GCM CryptoKey from password + salt via PBKDF2.
   * The returned key is non-extractable.
   * @param {string} password
   * @param {Uint8Array} salt - 16 bytes
   * @returns {Promise<CryptoKey>}
   */
  async function deriveKey(password, salt) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false, // non-extractable
      ['encrypt', 'decrypt']
    );
  }

  // ── AES-GCM Encrypt / Decrypt ──────────────────────────

  /**
   * Encrypt plaintext string with AES-256-GCM.
   * Returns { iv (base64), ciphertext (base64) }.
   * @param {CryptoKey} key
   * @param {string} plaintext
   * @returns {Promise<{iv: string, ciphertext: string}>}
   */
  async function encrypt(key, plaintext) {
    const iv = randomBytes(IV_BYTES);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      enc.encode(plaintext)
    );
    return {
      iv: bufToBase64(iv),
      ciphertext: bufToBase64(ct),
    };
  }

  /**
   * Decrypt ciphertext with AES-256-GCM.
   * Returns plaintext string, or throws on wrong key / tampered data.
   * @param {CryptoKey} key
   * @param {string} ivB64 - base64-encoded IV
   * @param {string} ciphertextB64 - base64-encoded ciphertext
   * @returns {Promise<string>}
   */
  async function decrypt(key, ivB64, ciphertextB64) {
    const iv = base64ToBuf(ivB64);
    const ct = base64ToBuf(ciphertextB64);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ct
    );
    return dec.decode(pt);
  }

  // ── SHA-256 Hashing ─────────────────────────────────────

  /**
   * Compute SHA-256 hex digest of an arbitrary string.
   * Used to build deterministic, non-reversible coinHash values.
   * @param {string} input
   * @returns {Promise<string>} hex digest
   */
  async function sha256(input) {
    const hash = await crypto.subtle.digest('SHA-256', enc.encode(input));
    return bufToHex(hash);
  }

  /**
   * Build a deterministic coin hash from its identifying fields.
   * @param {object} coin - { series, year, mint, grade }
   * @returns {Promise<string>} hex digest
   */
  async function coinHash(coin) {
    const canonical = [
      (coin.series || '').trim().toLowerCase(),
      String(coin.year || ''),
      (coin.mint || '').trim().toUpperCase(),
      (coin.grade || '').trim().toUpperCase(),
    ].join('|');
    return sha256(canonical);
  }

  // ── Verification Token ──────────────────────────────────

  /**
   * Create an encrypted verification token (used to test password correctness
   * on login without storing the password).
   * @param {CryptoKey} key
   * @returns {Promise<{iv: string, ciphertext: string}>}
   */
  async function createVerifier(key) {
    return encrypt(key, VERIFY_PLAINTEXT);
  }

  /**
   * Check whether the given key can decrypt the verifier token.
   * @param {CryptoKey} key
   * @param {{iv: string, ciphertext: string}} verifier
   * @returns {Promise<boolean>}
   */
  async function checkVerifier(key, verifier) {
    try {
      const pt = await decrypt(key, verifier.iv, verifier.ciphertext);
      return pt === VERIFY_PLAINTEXT;
    } catch {
      return false;
    }
  }

  // ── Public API ──────────────────────────────────────────

  return {
    SALT_BYTES,
    randomBytes,
    bufToHex,
    hexToBuf,
    bufToBase64,
    base64ToBuf,
    deriveKey,
    encrypt,
    decrypt,
    sha256,
    coinHash,
    createVerifier,
    checkVerifier,
  };
})();

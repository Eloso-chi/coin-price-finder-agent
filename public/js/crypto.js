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

  // ── BIP39-inspired word list (2048 words, first 2048 from english BIP39) ──
  // Subset of 256 common English words for compact 8-word recovery phrases.
  // 256 words = 8 bits per word × 8 words = 64 bits of user-visible entropy.
  // Actual security comes from 128-bit random seed stored as hex alongside.
  const RECOVERY_WORDS = [
    'abandon','able','about','above','absent','absorb','abstract','absurd',
    'abuse','access','accident','account','accuse','achieve','acid','acoustic',
    'acquire','across','act','action','actor','actress','actual','adapt',
    'add','addict','address','adjust','admit','adult','advance','advice',
    'aerobic','affair','afford','afraid','again','age','agent','agree',
    'ahead','aim','air','airport','aisle','alarm','album','alcohol',
    'alert','alien','all','alley','allow','almost','alone','alpha',
    'already','also','alter','always','amateur','amazing','among','amount',
    'amused','analyst','anchor','ancient','anger','angle','angry','animal',
    'ankle','announce','annual','another','answer','antenna','antique','anxiety',
    'any','apart','apology','appear','apple','approve','april','arch',
    'arctic','area','arena','argue','arm','armed','armor','army',
    'around','arrange','arrest','arrive','arrow','art','artefact','artist',
    'artwork','ask','aspect','assault','asset','assist','assume','asthma',
    'athlete','atom','attack','attend','attitude','attract','auction','audit',
    'august','aunt','author','auto','autumn','average','avocado','avoid',
    'awake','aware','awesome','awful','awkward','axis','baby','bachelor',
    'bacon','badge','bag','balance','balcony','ball','bamboo','banana',
    'banner','bar','barely','bargain','barrel','base','basic','basket',
    'battle','beach','bean','beauty','because','become','beef','before',
    'begin','behave','behind','believe','below','belt','bench','benefit',
    'best','betray','better','between','beyond','bicycle','bid','bike',
    'bind','biology','bird','birth','bitter','black','blade','blame',
    'blanket','blast','bleak','bless','blind','blood','blossom','blow',
    'blue','blur','blush','board','boat','body','boil','bomb',
    'bone','bonus','book','boost','border','boring','borrow','boss',
    'bottom','bounce','box','boy','bracket','brain','brand','brass',
    'brave','bread','breeze','brick','bridge','brief','bright','bring',
    'brisk','broccoli','broken','bronze','broom','brother','brown','brush',
  ];

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
      (coin.notes || '').trim().toLowerCase(),
      (coin.label || '').trim().toLowerCase(),
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

  // ── Recovery Phrase ───────────────────────────────────────

  /**
   * Generate an 8-word recovery phrase from 128 bits of cryptographic randomness.
   * Returns both the human-readable phrase and the underlying hex seed.
   * The hex seed is what actually gets used for key derivation (full 128-bit entropy).
   * @returns {{ phrase: string, seed: string }}
   */
  function generateRecoveryPhrase() {
    const bytes = randomBytes(16); // 128 bits
    const seed = bufToHex(bytes);
    // Pick 8 words: each byte selects from 256-word list
    const words = Array.from(bytes.slice(0, 8))
      .map(b => RECOVERY_WORDS[b]);
    return { phrase: words.join(' '), seed };
  }

  /**
   * Derive an AES-256-GCM key from a recovery seed (hex) + salt.
   * Uses the same PBKDF2 parameters as password-based derivation.
   * @param {string} seed - 32-char hex string (128 bits)
   * @param {Uint8Array} salt
   * @returns {Promise<CryptoKey>}
   */
  async function deriveKeyFromRecovery(seed, salt) {
    return deriveKey(seed, salt);
  }

  // ── Data Key Wrapping ─────────────────────────────────────

  /**
   * Generate a random AES-256-GCM data key (extractable).
   * This is the key that actually encrypts coin data. It gets "wrapped"
   * (encrypted) by both the password-derived key and the recovery-derived key
   * so that either can unlock it.
   * @returns {Promise<CryptoKey>}
   */
  async function generateDataKey() {
    return crypto.subtle.generateKey(
      { name: 'AES-GCM', length: KEY_LENGTH },
      true, // extractable — so we can wrap/unwrap it
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Wrap (encrypt) a data key using a wrapping key (password- or recovery-derived).
   * Returns { iv, wrappedKey } both as base64 strings.
   * @param {CryptoKey} wrappingKey - the PBKDF2-derived key
   * @param {CryptoKey} dataKey - the extractable data key
   * @returns {Promise<{iv: string, wrappedKey: string}>}
   */
  async function wrapDataKey(wrappingKey, dataKey) {
    const iv = randomBytes(IV_BYTES);
    const rawKey = await crypto.subtle.exportKey('raw', dataKey);
    const wrapped = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      rawKey
    );
    return {
      iv: bufToBase64(iv),
      wrappedKey: bufToBase64(wrapped),
    };
  }

  /**
   * Unwrap (decrypt) a data key using a wrapping key.
   * Returns the AES-GCM CryptoKey ready for encrypt/decrypt operations.
   * The returned key is extractable so it can be re-wrapped with a new password.
   * @param {CryptoKey} wrappingKey - password- or recovery-derived key
   * @param {string} ivB64 - base64-encoded IV
   * @param {string} wrappedKeyB64 - base64-encoded wrapped key
   * @returns {Promise<CryptoKey>}
   */
  async function unwrapDataKey(wrappingKey, ivB64, wrappedKeyB64) {
    const iv = base64ToBuf(ivB64);
    const wrapped = base64ToBuf(wrappedKeyB64);
    const rawKey = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      wrapped
    );
    return crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM', length: KEY_LENGTH },
      true, // extractable for future re-wrapping
      ['encrypt', 'decrypt']
    );
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
    generateRecoveryPhrase,
    deriveKeyFromRecovery,
    generateDataKey,
    wrapDataKey,
    unwrapDataKey,
  };
})();

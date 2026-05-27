#!/usr/bin/env node
// scripts/grant-admin.js -- CLI admin management
//
// Usage:
//   node scripts/grant-admin.js <username>                Grant admin
//   node scripts/grant-admin.js --revoke <username>       Revoke admin
//   node scripts/grant-admin.js --reset-password <user>   Reset password (random 16 chars, printed once)
//   node scripts/grant-admin.js --list                    List admins
//   node scripts/grant-admin.js --bootstrap               Grant from ADMIN_BOOTSTRAP_USERNAME env (no-op if no env)
//
// MUST be run with the same CACHE_DIR / COSMOS_* env as the server, otherwise
// reads/writes will land in the wrong store. Source `.env` first if needed.
//
// Exits 0 on success, 1 on usage error, 2 on operational failure.

'use strict';

require('dotenv').config();

const crypto = require('crypto');
const authService = require('../src/services/authService');
const auditService = require('../src/services/auditService');

function usage(code) {
  console.error('Usage:');
  console.error('  node scripts/grant-admin.js <username>');
  console.error('  node scripts/grant-admin.js --revoke <username>');
  console.error('  node scripts/grant-admin.js --reset-password <username>');
  console.error('  node scripts/grant-admin.js --list');
  console.error('  node scripts/grant-admin.js --bootstrap');
  process.exit(code);
}

function randomPassword(len) {
  // URL-safe base64; drop padding. ~6 bits/char -> ceil(len * 6 / 8) bytes.
  const bytes = crypto.randomBytes(Math.ceil((len * 6) / 8));
  return bytes.toString('base64')
    .replace(/\+/g, 'A')
    .replace(/\//g, 'B')
    .replace(/=+$/g, '')
    .slice(0, len);
}

async function cmdGrant(username) {
  const result = await authService.grantAdmin(username);
  await auditService.audit({
    action: 'admin-granted',
    actor: { userId: 'cli', username: 'cli' },
    target: result.username,
    meta: { source: 'scripts/grant-admin.js' },
  });
  console.log(`Granted admin to '${result.username}' (userId=${result.userId}).`);
  console.log('They must sign in again for the admin claim to appear in their JWT.');
}

async function cmdRevoke(username) {
  const result = await authService.revokeAdmin(username);
  await auditService.audit({
    action: 'admin-revoked',
    actor: { userId: 'cli', username: 'cli' },
    target: result.username,
    meta: { source: 'scripts/grant-admin.js' },
  });
  console.log(`Revoked admin from '${result.username}'.`);
  console.log('All outstanding JWTs for this user have been invalidated (tokenVersion bumped).');
}

async function cmdResetPassword(username) {
  // Default to a strong random 16-char password unless one is supplied via
  // env (RESET_PASSWORD=...) -- avoids putting plaintext on the argv list.
  const provided = process.env.RESET_PASSWORD;
  const newPassword = provided || randomPassword(16);
  await authService.resetPassword(username, newPassword);
  await auditService.audit({
    action: 'password-reset',
    actor: { userId: 'cli', username: 'cli' },
    target: (username || '').trim().toLowerCase(),
    meta: { source: 'scripts/grant-admin.js', supplied: !!provided },
  });
  console.log(`Reset password for '${username}'.`);
  if (!provided) {
    console.log('');
    console.log(`  New password (shown once):  ${newPassword}`);
    console.log('');
    console.log('Share this securely with the user. tokenVersion was bumped --');
    console.log('all outstanding JWTs for this account are now invalid.');
  }
}

async function cmdList() {
  const admins = await authService.listAdmins();
  if (admins.length === 0) {
    console.log('No admins configured.');
    return;
  }
  console.log(`Admins (${admins.length}):`);
  for (const a of admins) {
    console.log(`  ${a.username}  (userId=${a.userId}, grantedAt=${a.adminGrantedAt || 'unknown'})`);
  }
}

async function cmdBootstrap() {
  const user = (process.env.ADMIN_BOOTSTRAP_USERNAME || '').trim().toLowerCase();
  if (!user) {
    console.error('ADMIN_BOOTSTRAP_USERNAME is not set. Nothing to do.');
    process.exit(1);
  }
  const existing = await authService.getUser(user);
  if (!existing) {
    console.error(`User '${user}' does not exist. Sign them up first.`);
    process.exit(2);
  }
  if (existing.isAdmin === true) {
    console.log(`'${user}' is already an admin. No-op.`);
    return;
  }
  await authService.grantAdmin(user);
  await auditService.audit({
    action: 'bootstrap-admin',
    actor: { userId: 'cli', username: 'cli' },
    target: user,
    meta: { source: 'scripts/grant-admin.js --bootstrap' },
  });
  console.log(`Granted admin to '${user}' via bootstrap.`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) return usage(1);

  try {
    if (argv[0] === '--list') return await cmdList();
    if (argv[0] === '--bootstrap') return await cmdBootstrap();
    if (argv[0] === '--revoke') {
      if (!argv[1]) return usage(1);
      return await cmdRevoke(argv[1]);
    }
    if (argv[0] === '--reset-password') {
      if (!argv[1]) return usage(1);
      return await cmdResetPassword(argv[1]);
    }
    if (argv[0].startsWith('--')) return usage(1);
    // Positional: grant
    return await cmdGrant(argv[0]);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(2);
  }
}

main();

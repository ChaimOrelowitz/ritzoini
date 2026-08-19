#!/usr/bin/env node
// Generates the secrets the private contact routes need, and prints them as
// env lines to paste into Render. Nothing is written to disk or to Supabase.
//
//   node scripts/make-contact-credentials.js
//
// The CardDAV password is shown ONCE — it is what you type into the iPhone's
// account setup. Only its scrypt verifier is stored server-side, so a leaked
// environment cannot be replayed as a login without a brute force.

const crypto = require('crypto');
const { scryptHex, SCRYPT_KEYLEN } = require('../utils/privateAccess');

// 24 random bytes → 32 base64url chars. Long enough that the fixed-window rate
// limiter, not the entropy, is the thing an attacker gives up on.
const token = n => crypto.randomBytes(n).toString('base64url');

const username = 'ritzoini';
const password = token(24);
const salt     = crypto.randomBytes(16).toString('hex');
const hash     = scryptHex(password, salt);
const shortcut = token(32);

console.log(`
Add these to the backend environment (Render → Environment):

CARDDAV_USERNAME=${username}
CARDDAV_PASSWORD_SALT=${salt}
CARDDAV_PASSWORD_HASH=${hash}
DSC_SHORTCUT_TOKEN=${shortcut}

iPhone → Settings → Apps → Contacts → Contacts Accounts → Add Account →
Other → Add CardDAV Account:

  Server:      ritzoini.onrender.com
  User Name:   ${username}
  Password:    ${password}
  Description: Ritzoini

Apple Shortcut "Message DSC" — Authorization header value:

  Bearer ${shortcut}

The password and the bearer token are not recoverable from the stored values.
Re-run this script to rotate them; the iPhone account and the Shortcut both
need updating when you do. Store them in a password manager, not in chat.
(scrypt keylen ${SCRYPT_KEYLEN} bytes)
`);

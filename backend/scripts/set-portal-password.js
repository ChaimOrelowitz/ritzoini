#!/usr/bin/env node
//
// Set a password directly for an account, so they can just sign in.
//
//   node scripts/set-portal-password.js <email> <password>
//   node scripts/set-portal-password.js <email> --random
//
// Skips the invite / reset-email round trip entirely, which is the fastest way
// to unblock someone when email delivery or the Supabase redirect allowlist is
// getting in the way.
//
// Pass the password as an argument only on a machine you trust — it lands in
// your shell history. `--random` generates one and prints it once instead.
//
// The account's role and access flags are untouched: this only sets a password.

require('dotenv').config();
const crypto = require('crypto');
const supabase = require('../db/supabase');

// Ambiguity-free alphabet: no O/0, l/1/I. Someone is going to read this aloud.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomPassword(len = 16) {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
}

async function main() {
  const email = process.argv[2];
  const arg = process.argv[3];
  if (!email || !arg) {
    console.error('Usage: node scripts/set-portal-password.js <email> <password|--random>');
    process.exit(1);
  }

  const password = arg === '--random' ? randomPassword() : arg;
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  // No admin lookup-by-email in the JS client, so page through.
  let user = null;
  for (let page = 1; page <= 20 && !user; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    if (!data.users.length) break;
    user = data.users.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
  }
  if (!user) { console.error(`No account for ${email}`); process.exit(1); }

  const { error } = await supabase.auth.admin.updateUserById(user.id, {
    password,
    // An account created by invite can sit unconfirmed; a password is useless
    // until the address is confirmed, so confirm it in the same breath.
    email_confirm: true,
  });
  if (error) throw new Error(error.message);

  const { data: profile } = await supabase
    .from('profiles').select('first_name, last_name, role, portal_only, ps_payroll_only')
    .eq('id', user.id).maybeSingle();

  const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || email;
  console.log(`\nPassword set for ${name} <${email}>`);
  console.log(`  role   : ${profile?.role}${profile?.portal_only ? ' (Portal POC only)' : ''}${profile?.ps_payroll_only ? ' (payroll only)' : ''}`);
  if (arg === '--random') {
    console.log(`  password: ${password}`);
    console.log('\n  Shown once. Hand it over out of band and have them change it.');
  } else {
    console.log('  password: (the one you supplied)');
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });

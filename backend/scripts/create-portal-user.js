#!/usr/bin/env node
//
// Provision (or convert) an account restricted to the Portal POC screen.
//
//   node scripts/create-portal-user.js <email> [First] [Last]
//   node scripts/create-portal-user.js <email> --revoke
//
// Sends a Supabase invite if the account does not exist yet, then sets
// profiles.portal_only = true. That one flag is the whole fence: requireAuth
// blocks every API path outside /api/portal, and the frontend hides every other
// nav item, section and route. It overrides `role`, so the account can stay a
// plain 'supervisor'.

require('dotenv').config();
const supabase = require('../db/supabase');

async function findProfile(email) {
  const { data } = await supabase.from('profiles').select('*').ilike('email', email).maybeSingle();
  return data;
}

async function main() {
  const email = process.argv[2];
  const revoke = process.argv.includes('--revoke');
  const first = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
  const last  = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : null;

  if (!email) {
    console.error('Usage: node scripts/create-portal-user.js <email> [First] [Last] [--revoke]');
    process.exit(1);
  }

  let profile = await findProfile(email);

  if (revoke) {
    if (!profile) { console.error(`No account for ${email}`); process.exit(1); }
    const { error } = await supabase.from('profiles').update({ portal_only: false }).eq('id', profile.id);
    if (error) throw new Error(error.message);
    console.log(`Removed Portal POC restriction from ${email}. The account now follows its role (${profile.role}).`);
    return;
  }

  if (!profile) {
    // Same fallback as routes/users.js, so an invite and a later password reset
    // never point at different hosts. Set FRONTEND_URL and neither is guessed.
    const frontendUrl = process.env.FRONTEND_URL || 'https://ritzoini.vercel.app';
    console.log(`No account for ${email} — sending an invite…`);
    const { error } = await supabase.auth.admin.inviteUserByEmail(email, {
      data: { first_name: first || '', last_name: last || '', role: 'supervisor' },
      redirectTo: `${frontendUrl}/set-password`,
    });
    if (error) throw new Error(error.message);
    console.log('Invite sent. Waiting for the profile row…');
    for (let i = 0; i < 10 && !profile; i++) {
      await new Promise(r => setTimeout(r, 1000));
      profile = await findProfile(email);
    }
    if (!profile) {
      console.error('The profile row has not appeared yet. Re-run this script once the invite is accepted.');
      process.exit(1);
    }
  }

  const patch = { portal_only: true };
  if (first) patch.first_name = first;
  if (last) patch.last_name = last;
  const { error } = await supabase.from('profiles').update(patch).eq('id', profile.id);
  if (error) throw new Error(error.message);

  console.log(`\n${email} is now restricted to the Portal POC screen.`);
  console.log(`  profile id : ${profile.id}`);
  console.log(`  role       : ${profile.role} (overridden by portal_only)`);
  console.log(`  reachable  : /portalPOC and /api/portal/* only`);
}

main().catch(e => { console.error(e.message); process.exit(1); });

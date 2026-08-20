// Portal POC access-fence test — does `profiles.portal_only` actually restrict
// an account to the one screen?
//
// Run: node test/portalAccess.test.js
//
// Supabase is stubbed through require.cache, so this exercises the REAL
// requireAuth middleware against fixed profiles — no network, no database.
// The same probe set runs for an admin, an ordinary supervisor and a
// payroll-only account, so a change that widens the portal fence, or that
// accidentally narrows somebody else's, fails here.

const path = require('path');

const PROFILES = {
  'tok-bella': { id: 'u-bella', email: 'b@x', role: 'supervisor', portal_only: true },
  'tok-admin': { id: 'u-admin', email: 'a@x', role: 'admin' },
  'tok-sup':   { id: 'u-sup',   email: 's@x', role: 'supervisor' },
  'tok-pay':   { id: 'u-pay',   email: 'p@x', role: 'supervisor', ps_payroll_only: true },
};

require.cache[require.resolve('../db/supabase')] = {
  id: 'supabase-stub', filename: 'supabase-stub', loaded: true,
  exports: {
    auth: {
      getUser: async t => PROFILES[t]
        ? { data: { user: { id: PROFILES[t].id } }, error: null }
        : { data: { user: null }, error: 'bad token' },
    },
    from: () => ({ select: () => ({ eq: (_c, id) => ({ single: async () => ({ data: Object.values(PROFILES).find(p => p.id === id) }) }) }) }),
  },
};

const express = require('express');
const { requireAuth } = require('../middleware/auth');

const app = express();
app.use(express.json());
app.use(requireAuth);
app.all(/.*/, (req, res) => res.json({ reached: req.originalUrl }));

// [method, path, reachable-by]  — 'portal' means a portal_only account may reach it.
const PROBES = [
  ['GET',   '/api/portal/status',        true],
  ['GET',   '/api/portal/runs',          true],
  ['POST',  '/api/portal/runs',          true],
  ['POST',  '/api/portal/runs/1/execute',true],
  ['PATCH', '/api/portal/peers/1',       true],
  ['DELETE','/api/portal/clients/1',     true],
  ['GET',   '/api/users/me',             true],
  ['GET',   '/api/users',                false],
  ['POST',  '/api/users/invite',         false],
  ['PATCH', '/api/users/u-admin',        false],
  ['GET',   '/api/oo/clients',           false],
  ['GET',   '/api/sessions/all',         false],
  ['GET',   '/api/ps/payroll/periods',   false],
  ['POST',  '/api/payments/confirm',     false],
  ['GET',   '/api/groups',               false],
  ['GET',   '/api/config/zoho-roster',   false],
  // A route whose name merely starts with the same letters must not slip through.
  ['GET',   '/api/portalx/leak',         false],
];

const server = app.listen(0, async () => {
  const port = server.address().port;
  let passed = 0, failed = 0;

  async function probe(token, method, p) {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: ['POST', 'PATCH', 'PUT'].includes(method) ? '{}' : undefined,
    });
    return res.status !== 403;
  }

  function check(name, actual, expected) {
    if (actual === expected) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ ${name} — expected ${expected ? 'allow' : 'BLOCK'}, got ${actual ? 'allow' : 'BLOCK'}`); }
  }

  console.log('\nportal_only account (Bella)');
  for (const [method, p, portalMay] of PROBES) {
    check(`${portalMay ? 'reaches ' : 'blocked from'} ${method} ${p}`, await probe('tok-bella', method, p), portalMay);
  }

  console.log('\nthe fence does not leak onto other accounts');
  for (const [method, p] of PROBES) {
    if (p === '/api/portalx/leak') continue;
    check(`admin reaches ${method} ${p}`, await probe('tok-admin', method, p), true);
    check(`supervisor reaches ${method} ${p}`, await probe('tok-sup', method, p), true);
  }

  console.log('\nthe existing payroll fence still holds');
  check('payroll-only reaches GET /api/ps/payroll/periods', await probe('tok-pay', 'GET', '/api/ps/payroll/periods'), true);
  check('payroll-only blocked from GET /api/portal/runs', await probe('tok-pay', 'GET', '/api/portal/runs'), false);
  check('payroll-only blocked from GET /api/groups', await probe('tok-pay', 'GET', '/api/groups'), false);

  console.log('\nunauthenticated');
  const anon = await fetch(`http://127.0.0.1:${port}/api/portal/status`);
  check('no token is 401', anon.status === 401, true);

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
});

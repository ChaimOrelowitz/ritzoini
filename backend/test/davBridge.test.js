// Signed DAV bridge tests.
//
// Run: node test/davBridge.test.js
//
// Covers the relay that carries PROPFIND/REPORT from the Cloudflare Worker to
// this backend, because Render's edge answers 405 to those methods before Node
// sees them. Supabase is stubbed through require.cache; the real Express route,
// the real envelope verification and the real CardDAV handler all run.
//
// The property that matters most is the LAST group: the bridge is a transport,
// never an authorisation. A perfectly signed envelope with no CardDAV
// credentials must still get a 401.

const assert = require('assert');
const express = require('express');
const crypto = require('crypto');

// ── stub Supabase ────────────────────────────────────────────────────────────

const FIXTURES = {
  ps_peers: [
    { airtable_id: 'recA', peer_name: 'Alpha, Ann', status: 'Active', cohort: '["A"]',
      email: 'ann@example.test', phone: '(555) 100-0001', updated_at: '2026-08-01T00:00:00Z' },
  ],
  ps_caseload_periods: [
    { peer_airtable_id: 'recA', peer_name: 'Alpha, Ann', supervisor_airtable_id: 'supX',
      entered_on: '2026-01-01', left_on: null },
  ],
  instructors: [
    { id: 'ins-1', first_name: 'Adam', last_name: 'Abbot', phone: '5552000001',
      created_at: '2026-01-01T00:00:00Z' },
  ],
};

function supabaseStub(tables) {
  return {
    from(table) {
      const q = {
        _filters: [],
        select() { return q; }, order() { return q; }, in() { return q; }, limit() { return q; },
        is(c, v) { q._filters.push(r => r[c] === v); return q; },
        eq(c, v) { q._filters.push(r => r[c] === v); return q; },
        then(resolve, reject) {
          const rows = (tables[table] || []).filter(r => q._filters.every(f => f(r)));
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

const supabasePath = require.resolve('../db/supabase');
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true, children: [], paths: [],
  exports: supabaseStub(FIXTURES),
};

// ── configuration ────────────────────────────────────────────────────────────

const CARDDAV_USER = 'testuser';
const CARDDAV_PASS = 'test-password-not-a-real-secret';
const BRIDGE_SECRET = 'test-bridge-secret-not-a-real-one';

process.env.SUPABASE_URL = 'http://stub.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub';
process.env.AIRTABLE_SUPERVISOR_RECORD_ID = 'supX';
process.env.CARDDAV_USERNAME = CARDDAV_USER;
process.env.DAV_BRIDGE_SECRET = BRIDGE_SECRET;

const { scryptHex } = require('../utils/privateAccess');
process.env.CARDDAV_PASSWORD_SALT = crypto.randomBytes(16).toString('hex');
process.env.CARDDAV_PASSWORD_HASH = scryptHex(CARDDAV_PASS, process.env.CARDDAV_PASSWORD_SALT);

const env = require('../utils/davEnvelope');
const davBridge = require('../routes/davBridge');
const { matchRoute, isCarddavPath } = require('../utils/carddavCore');

// ── harness ──────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failed++; failures.push(name); console.log(`  FAIL ${name}\n       ${err.message}`); }
}

const app = express();
app.set('trust proxy', 1);
app.use('/internal/dav-bridge', davBridge);

let base;
const AUTH_OK = 'Basic ' + Buffer.from(`${CARDDAV_USER}:${CARDDAV_PASS}`).toString('base64');
const AUTH_BAD = 'Basic ' + Buffer.from(`${CARDDAV_USER}:wrong`).toString('base64');

const PROPFIND_ALL = '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>';

// Builds a correctly signed envelope, exactly as the Worker does.
function makeEnvelope({
  method = 'PROPFIND',
  path = '/carddav/addressbooks/dsc/dsc-peers/',
  query = '',
  body = PROPFIND_ALL,
  davHeaders = { depth: '1', 'content-type': 'text/xml' },
  authorization = AUTH_OK,
  timestamp = Math.floor(Date.now() / 1000),
  nonce = crypto.randomBytes(24).toString('hex'),
  secret = BRIDGE_SECRET,
} = {}) {
  const raw = Buffer.from(body, 'utf8');
  const bodyHash = env.sha256(raw);
  const authHash = env.sha256(authorization);
  const signature = env.sign(env.canonicalString({
    method, path, query, timestamp, nonce, bodyHash, authHash, davHeaders,
  }), secret);

  return {
    signature,
    authorization,
    envelope: {
      v: 'v1', method, path, query, timestamp, nonce,
      body_sha256: bodyHash,
      authorization_sha256: authHash,
      dav_headers: davHeaders,
      body_b64: raw.toString('base64'),
    },
  };
}

async function post({ envelope, signature, authorization }) {
  const headers = { 'Content-Type': 'application/json' };
  if (signature !== undefined && signature !== null) headers['X-Dav-Signature'] = signature;
  if (authorization !== undefined && authorization !== null) headers['X-Dav-Authorization'] = authorization;

  const res = await fetch(`${base}/internal/dav-bridge`, {
    method: 'POST', headers, body: JSON.stringify(envelope),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON refusal body */ }
  return { status: res.status, text, json };
}

// Unwraps the DAV response the bridge returns on behalf of the origin.
const dav = r => ({
  status: r.json?.status,
  headers: r.json?.headers || {},
  body: r.json?.body_b64 ? Buffer.from(r.json.body_b64, 'base64').toString('utf8') : '',
});

const SECRETS = ['BEGIN:VCARD', 'Alpha', '5551000001', 'ann@example.test', 'Abbot'];
const leaks = text => SECRETS.filter(s => text.includes(s));

// ── tests ────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\nsuccessful forwarding');

  await test('a signed PROPFIND reaches the handler and returns 207', async () => {
    const r = await post(makeEnvelope());
    assert.strictEqual(r.status, 200, 'bridge envelope accepted');
    const d = dav(r);
    assert.strictEqual(d.status, 207);
    assert.ok(d.body.includes('ritzoini-peer-recA.vcf'), 'card should be listed');
  });

  await test('a signed REPORT reaches the handler', async () => {
    const r = await post(makeEnvelope({
      method: 'REPORT',
      body: '<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token/>' +
            '<D:prop><D:getetag/></D:prop></D:sync-collection>',
    }));
    const d = dav(r);
    assert.strictEqual(d.status, 207);
    assert.ok(d.body.includes('<D:sync-token>'), 'sync-token must survive the hop');
  });

  await test('OPTIONS is relayed with the read-only Allow header', async () => {
    const d = dav(await post(makeEnvelope({ method: 'OPTIONS', body: '', davHeaders: {} })));
    assert.strictEqual(d.status, 200);
    assert.match(d.headers.Allow, /PROPFIND/);
    assert.ok(!/PUT|DELETE/.test(d.headers.Allow));
  });

  await test('discovery paths route correctly through the bridge', async () => {
    for (const path of ['/', '/.well-known/carddav', '/carddav/', '/carddav/principals/dsc/']) {
      const d = dav(await post(makeEnvelope({ path, davHeaders: { depth: '0' } })));
      assert.strictEqual(d.status, 207, `${path} answered ${d.status}`);
      assert.ok(d.body.includes('/carddav/principals/dsc/'), `${path} missing principal`);
    }
  });

  console.log('\nDAV response propagation');

  await test('required DAV response headers survive the hop', async () => {
    const d = dav(await post(makeEnvelope()));
    assert.strictEqual(d.headers.DAV, '1, 3, addressbook');
    assert.match(d.headers['Content-Type'], /application\/xml/);
    assert.match(d.headers['Cache-Control'], /no-store/);
    assert.match(d.headers['Cache-Control'], /private/);
  });

  await test('a card GET relayed through the bridge carries its ETag', async () => {
    const d = dav(await post(makeEnvelope({
      method: 'GET', path: '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf',
      body: '', davHeaders: {},
    })));
    assert.strictEqual(d.status, 200);
    assert.ok(d.headers.ETag, 'ETag must be propagated');
    assert.match(d.headers['Content-Type'], /text\/vcard/);
    assert.ok(d.body.startsWith('BEGIN:VCARD'));
  });

  await test('a 404 from the handler is propagated as 404, not as a bridge error', async () => {
    const d = dav(await post(makeEnvelope({
      path: '/carddav/addressbooks/dsc/nope/', davHeaders: { depth: '1' },
    })));
    assert.strictEqual(d.status, 404);
  });

  console.log('\nauthentication is NOT bypassable');

  await test('a valid signature with NO credentials still gets 401', async () => {
    const r = await post(makeEnvelope({ authorization: '' }));
    assert.strictEqual(r.status, 200, 'envelope itself is valid');
    const d = dav(r);
    assert.strictEqual(d.status, 401, 'the bridge must not authenticate anyone');
    assert.deepStrictEqual(leaks(d.body), []);
  });

  await test('a valid signature with WRONG credentials still gets 401', async () => {
    const d = dav(await post(makeEnvelope({ authorization: AUTH_BAD })));
    assert.strictEqual(d.status, 401);
    assert.deepStrictEqual(leaks(d.body), []);
  });

  await test('the 401 keeps its WWW-Authenticate challenge', async () => {
    const d = dav(await post(makeEnvelope({ authorization: '' })));
    assert.match(d.headers['WWW-Authenticate'] || '', /^Basic realm=/,
      'without this header iOS never prompts for a password');
  });

  await test('swapping in different credentials invalidates the envelope', async () => {
    // Signature covers a hash of the Authorization header, so a captured
    // envelope cannot be replayed with someone else's credentials attached.
    const built = makeEnvelope({ authorization: AUTH_OK });
    built.authorization = AUTH_BAD;
    const r = await post(built);
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(leaks(r.text), []);
  });

  console.log('\nsignature verification');

  await test('a missing signature is refused', async () => {
    const built = makeEnvelope();
    built.signature = null;
    assert.strictEqual((await post(built)).status, 401);
  });

  await test('a wrong signature is refused', async () => {
    const built = makeEnvelope();
    built.signature = 'f'.repeat(64);
    assert.strictEqual((await post(built)).status, 401);
  });

  await test('a signature from the wrong secret is refused', async () => {
    assert.strictEqual((await post(makeEnvelope({ secret: 'a-different-secret-entirely' }))).status, 401);
  });

  await test('tampering with any signed field is refused', async () => {
    const mutations = {
      method:      e => { e.method = 'REPORT'; },
      path:        e => { e.path = '/carddav/addressbooks/dsc/instructors/'; },
      query:       e => { e.query = 'x=1'; },
      timestamp:   e => { e.timestamp = e.timestamp - 1; },
      nonce:       e => { e.nonce = crypto.randomBytes(24).toString('hex'); },
      dav_headers: e => { e.dav_headers = { depth: '0' }; },
    };
    for (const [field, mutate] of Object.entries(mutations)) {
      const built = makeEnvelope();
      mutate(built.envelope);
      const r = await post(built);
      assert.strictEqual(r.status, 401, `tampering with ${field} was accepted`);
    }
  });

  await test('tampering with the body is caught by the body hash', async () => {
    const built = makeEnvelope();
    built.envelope.body_b64 = Buffer.from('<D:evil/>', 'utf8').toString('base64');
    assert.strictEqual((await post(built)).status, 401);
  });

  await test('a missing bridge secret fails closed with 503', async () => {
    const saved = process.env.DAV_BRIDGE_SECRET;
    delete process.env.DAV_BRIDGE_SECRET;
    try {
      const r = await post(makeEnvelope());
      assert.strictEqual(r.status, 503);
      assert.deepStrictEqual(leaks(r.text), []);
    } finally { process.env.DAV_BRIDGE_SECRET = saved; }
  });

  console.log('\nfreshness and replay');

  await test('a stale timestamp is refused', async () => {
    const old = Math.floor(Date.now() / 1000) - 400;
    assert.strictEqual((await post(makeEnvelope({ timestamp: old }))).status, 401);
  });

  await test('a far-future timestamp is refused', async () => {
    const future = Math.floor(Date.now() / 1000) + 400;
    assert.strictEqual((await post(makeEnvelope({ timestamp: future }))).status, 401);
  });

  await test('a replayed envelope is refused the second time', async () => {
    const built = makeEnvelope();
    const first = await post(built);
    assert.strictEqual(first.status, 200, 'first use should succeed');
    const second = await post(built);
    assert.strictEqual(second.status, 401, 'replay must be refused');
    assert.deepStrictEqual(leaks(second.text), []);
  });

  await test('a failed signature does not burn the nonce', async () => {
    // Otherwise an attacker could pre-claim nonces and lock out the Worker.
    const built = makeEnvelope();
    const forged = JSON.parse(JSON.stringify(built));
    forged.signature = 'e'.repeat(64);
    assert.strictEqual((await post(forged)).status, 401);
    assert.strictEqual((await post(built)).status, 200, 'the genuine request must still work');
  });

  console.log('\nmethod and path restrictions');

  await test('every write method is refused by the bridge independently', async () => {
    for (const method of ['PUT', 'POST', 'DELETE', 'PATCH', 'PROPPATCH', 'MKCOL',
                          'MKCALENDAR', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'ACL']) {
      const r = await post(makeEnvelope({ method, body: '', davHeaders: {} }));
      assert.strictEqual(r.status, 403, `${method} answered ${r.status}`);
    }
  });

  await test('an unknown method is refused', async () => {
    assert.strictEqual((await post(makeEnvelope({ method: 'FROBNICATE', body: '', davHeaders: {} }))).status, 405);
  });

  await test('paths outside the CardDAV prefix are refused', async () => {
    for (const path of ['/api/ps/caseload', '/api/dsc/recipients', '/internal/dav-bridge', '/api/health']) {
      const r = await post(makeEnvelope({ path, davHeaders: { depth: '0' } }));
      assert.strictEqual(r.status, 403, `${path} answered ${r.status}`);
      assert.deepStrictEqual(leaks(r.text), []);
    }
  });

  await test('path traversal is refused', async () => {
    for (const path of [
      '/carddav/../api/ps/caseload',
      '/carddav/addressbooks/dsc/dsc-peers/../../../../etc/passwd',
      '/carddav//addressbooks/dsc/dsc-peers/',
      '/carddav/addressbooks/dsc/dsc-peers/..%2f..%2fapi',
    ]) {
      const d = dav(await post(makeEnvelope({ path, davHeaders: { depth: '0' } })));
      const outer = (await post(makeEnvelope({ path, davHeaders: { depth: '0' } }))).status;
      assert.ok(outer === 403 || d.status === 404,
        `${path} should be refused or 404, got outer=${outer} inner=${d.status}`);
    }
  });

  await test('matchRoute rejects traversal directly', () => {
    assert.strictEqual(matchRoute('/carddav/../secret'), null);
    assert.strictEqual(matchRoute('/carddav//addressbooks/dsc/dsc-peers/'), null);
    assert.strictEqual(matchRoute('/carddav\\addressbooks'), null);
    assert.ok(matchRoute('/carddav/addressbooks/dsc/dsc-peers/'));
  });

  // Regression: /carddav/../api/health starts with the CardDAV prefix, so a
  // naive startsWith() admitted it and left matchRoute as the only guard.
  await test('isCarddavPath rejects traversal, not just foreign prefixes', () => {
    for (const p of [
      '/carddav/../api/health',
      '/carddav/../../etc/passwd',
      '/carddav//addressbooks/dsc/dsc-peers/',
      '/carddav\\addressbooks',
      '/carddav/addressbooks/dsc/../../../api',
    ]) {
      assert.ok(!isCarddavPath(p), `${p} must be rejected at the bridge, not merely 404 later`);
    }
  });

  await test('the bridge refuses traversal outright rather than 404ing inside', async () => {
    for (const path of ['/carddav/../api/health', '/carddav//addressbooks/dsc/dsc-peers/']) {
      const r = await post(makeEnvelope({ path, davHeaders: { depth: '0' } }));
      assert.strictEqual(r.status, 403, `${path} answered ${r.status}`);
    }
  });

  await test('isCarddavPath admits only the CardDAV tree', () => {
    for (const p of ['/', '/carddav', '/carddav/', '/carddav/addressbooks/dsc/', '/.well-known/carddav']) {
      assert.ok(isCarddavPath(p), `${p} should be allowed`);
    }
    for (const p of ['/api/health', '/internal/dav-bridge', '/carddavX', '/api/dsc/recipients']) {
      assert.ok(!isCarddavPath(p), `${p} should be rejected`);
    }
  });

  await test('an oversized body is refused', async () => {
    const big = '<D:x>' + 'a'.repeat(300 * 1024) + '</D:x>';
    const r = await post(makeEnvelope({ body: big }));
    assert.ok([413, 401].includes(r.status), `answered ${r.status}`);
  });

  console.log('\nmalformed input');

  await test('a malformed envelope is refused without a stack trace', async () => {
    for (const bad of [{}, { v: 'v2' }, { v: 'v1', nonce: 'short' },
                       { v: 'v1', nonce: 'a'.repeat(48), timestamp: 'not-a-number' }]) {
      const res = await fetch(`${base}/internal/dav-bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dav-Signature': 'f'.repeat(64) },
        body: JSON.stringify(bad),
      });
      assert.ok([400, 401].includes(res.status), `answered ${res.status}`);
    }
  });

  await test('the bridge answers nothing but POST', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await fetch(`${base}/internal/dav-bridge`, { method });
      assert.strictEqual(res.status, 405, `${method} answered ${res.status}`);
      assert.deepStrictEqual(leaks(await res.text()), []);
    }
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  console.log('Signed DAV bridge');
  try { await run(); } finally { server.close(); }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('failing: ' + failures.join(', ')); process.exit(1); }
})();

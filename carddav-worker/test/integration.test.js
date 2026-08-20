// End-to-end: the real Worker source against a real backend, in one process.
//
// Run: node test/integration.test.js   (from carddav-worker/)
//
// The Worker is written for Cloudflare but uses only Web Crypto, fetch, Request
// and Response — all of which Node provides — so its fetch() handler can be
// invoked directly. That exercises the genuine chain:
//
//   Request(PROPFIND) → worker.fetch → signed envelope → POST /internal/dav-bridge
//     → verifyEnvelope → handleDav → response → unwrapped back to the client
//
// which is exactly what a phone will do, minus Cloudflare and Render.

import assert from 'node:assert';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

// Resolve from the backend package, so express and the backend's own modules
// come from backend/node_modules — the Worker itself has no runtime deps.
const require = createRequire(new URL('../../backend/package.json', import.meta.url));

// ── stub Supabase before the backend loads ───────────────────────────────────

const FIXTURES = {
  ps_peers: [
    { airtable_id: 'recA', peer_name: 'Alpha, Ann', status: 'Active', cohort: '["A"]',
      email: 'ann@example.test', phone: '(555) 100-0001', updated_at: '2026-08-01T00:00:00Z' },
    { airtable_id: 'recB', peer_name: 'Bravo, Ben', status: 'Active', cohort: '["B"]',
      email: null, phone: '(555) 100-0002', updated_at: '2026-08-02T00:00:00Z' },
  ],
  ps_caseload_periods: [
    { peer_airtable_id: 'recA', supervisor_airtable_id: 'supX', entered_on: '2026-01-01', left_on: null },
    { peer_airtable_id: 'recB', supervisor_airtable_id: 'supX', entered_on: '2026-01-01', left_on: null },
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
        _f: [],
        select() { return q; }, order() { return q; }, in() { return q; }, limit() { return q; },
        is(c, v) { q._f.push(r => r[c] === v); return q; },
        eq(c, v) { q._f.push(r => r[c] === v); return q; },
        then(res, rej) {
          const rows = (tables[table] || []).filter(r => q._f.every(f => f(r)));
          return Promise.resolve({ data: rows, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

const supabasePath = require.resolve('./db/supabase.js');
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true, children: [], paths: [],
  exports: supabaseStub(FIXTURES),
};

const CARDDAV_USER = 'testuser';
const CARDDAV_PASS = 'test-password-not-a-real-secret';
const BRIDGE_SECRET = 'test-bridge-secret-not-a-real-one';

process.env.SUPABASE_URL = 'http://stub.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub';
process.env.AIRTABLE_SUPERVISOR_RECORD_ID = 'supX';
process.env.CARDDAV_USERNAME = CARDDAV_USER;
process.env.DAV_BRIDGE_SECRET = BRIDGE_SECRET;

const { scryptHex } = require('./utils/privateAccess.js');
process.env.CARDDAV_PASSWORD_SALT = crypto.randomBytes(16).toString('hex');
process.env.CARDDAV_PASSWORD_HASH = scryptHex(CARDDAV_PASS, process.env.CARDDAV_PASSWORD_SALT);

const express = require('express');
const carddav = require('./routes/carddav.js');
const davBridge = require('./routes/davBridge.js');
const worker = (await import('../src/worker.js')).default;

// ── harness ──────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failed++; failures.push(name); console.log(`  FAIL ${name}\n       ${err.message}`); }
}

const app = express();
app.set('trust proxy', 1);
app.use('/.well-known/carddav', carddav);
app.use('/carddav', carddav);
app.propfind('/', carddav.discovery);
app.use('/internal/dav-bridge', davBridge);

const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const ENV = { DAV_BRIDGE_SECRET: BRIDGE_SECRET, ORIGIN_BASE_URL: ORIGIN };

const AUTH = 'Basic ' + Buffer.from(`${CARDDAV_USER}:${CARDDAV_PASS}`).toString('base64');
const PROPFIND_ALL = '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>';

// Calls the Worker exactly as Cloudflare would.
const call = (method, path, { headers = {}, body, env = ENV } = {}) =>
  worker.fetch(new Request(`https://contacts.example.test${path}`, { method, headers, body }), env);

const SECRETS = ['BEGIN:VCARD', 'Alpha', '5551000001', 'ann@example.test', 'Abbot'];
const leaks = t => SECRETS.filter(s => t.includes(s));

console.log('Worker → bridge → CardDAV handler, end to end\n');

console.log('the full chain');

await test('PROPFIND on the peers book comes back 207 with both cards', async () => {
  const res = await call('PROPFIND', '/carddav/addressbooks/dsc/dsc-peers/', {
    headers: { Authorization: AUTH, Depth: '1', 'Content-Type': 'text/xml' },
    body: PROPFIND_ALL,
  });
  assert.strictEqual(res.status, 207);
  const text = await res.text();
  assert.ok(text.includes('ritzoini-peer-recA.vcf'));
  assert.ok(text.includes('ritzoini-peer-recB.vcf'));
  assert.strictEqual(res.headers.get('DAV'), '1, 3, addressbook');
});

await test('the discovery chain a phone walks works end to end', async () => {
  const wk = await call('PROPFIND', '/.well-known/carddav', {
    headers: { Authorization: AUTH, Depth: '0' }, body: PROPFIND_ALL,
  });
  assert.strictEqual(wk.status, 207, 'well-known must answer directly');
  assert.ok(!wk.headers.get('location'), 'no redirect: iOS handles them poorly when authenticated');
  assert.ok((await wk.text()).includes('/carddav/principals/dsc/'));

  const pr = await call('PROPFIND', '/carddav/principals/dsc/', {
    headers: { Authorization: AUTH, Depth: '0' }, body: PROPFIND_ALL,
  });
  assert.ok((await pr.text()).includes('/carddav/addressbooks/dsc/'));

  const home = await call('PROPFIND', '/carddav/addressbooks/dsc/', {
    headers: { Authorization: AUTH, Depth: '1' }, body: PROPFIND_ALL,
  });
  const homeText = await home.text();
  assert.ok(homeText.includes('DSC Peers'));
  assert.ok(homeText.includes('Ritzoini Instructors'));
});

await test('REPORT sync-collection round-trips its token', async () => {
  const body = '<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token/>' +
               '<D:prop><D:getetag/></D:prop></D:sync-collection>';
  const first = await call('REPORT', '/carddav/addressbooks/dsc/dsc-peers/', {
    headers: { Authorization: AUTH, Depth: '1' }, body,
  });
  assert.strictEqual(first.status, 207);
  const token = (await first.text()).match(/<D:sync-token>([^<]+)<\/D:sync-token>/)[1];

  const second = await call('REPORT', '/carddav/addressbooks/dsc/dsc-peers/', {
    headers: { Authorization: AUTH, Depth: '1' },
    body: body.replace('<D:sync-token/>', `<D:sync-token>${token}</D:sync-token>`),
  });
  assert.strictEqual(second.status, 207);
  assert.ok(!(await second.text()).includes('.vcf'), 'unchanged sync reports no members');
});

await test('GET passes through and serves the vCard with its ETag', async () => {
  const res = await call('GET', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf', {
    headers: { Authorization: AUTH },
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/vcard/);
  assert.ok(res.headers.get('etag'));
  assert.ok((await res.text()).startsWith('BEGIN:VCARD'));
});

console.log('\nauthentication through the Worker');

await test('no credentials produce 401 WITH the WWW-Authenticate challenge', async () => {
  const res = await call('PROPFIND', '/carddav/addressbooks/dsc/dsc-peers/', {
    headers: { Depth: '1' }, body: PROPFIND_ALL,
  });
  assert.strictEqual(res.status, 401);
  assert.match(res.headers.get('www-authenticate') || '', /^Basic realm=/,
    'iOS never prompts for a password without this');
  assert.deepStrictEqual(leaks(await res.text()), []);
});

await test('wrong credentials produce 401 and leak nothing', async () => {
  const bad = 'Basic ' + Buffer.from(`${CARDDAV_USER}:wrong`).toString('base64');
  const res = await call('PROPFIND', '/carddav/', { headers: { Authorization: bad }, body: PROPFIND_ALL });
  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(leaks(await res.text()), []);
});

await test('an unauthenticated GET is challenged too', async () => {
  const res = await call('GET', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf');
  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(leaks(await res.text()), []);
});

console.log('\nread-only at the edge');

await test('the Worker refuses every write method before contacting the origin', async () => {
  for (const method of ['PUT', 'POST', 'DELETE', 'PATCH', 'PROPPATCH', 'MKCOL',
                        'MKCALENDAR', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'ACL']) {
    const res = await call(method, '/carddav/addressbooks/dsc/dsc-peers/x.vcf', {
      headers: { Authorization: AUTH }, body: method === 'PUT' ? 'BEGIN:VCARD' : undefined,
    });
    assert.strictEqual(res.status, 403, `${method} answered ${res.status}`);
    assert.match(res.headers.get('allow') || '', /PROPFIND/);
  }
});

await test('a PUT changes nothing that is subsequently served', async () => {
  const before = await (await call('GET', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf',
    { headers: { Authorization: AUTH } })).text();
  await call('PUT', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf', {
    headers: { Authorization: AUTH }, body: 'BEGIN:VCARD\r\nFN:Hacked\r\nEND:VCARD\r\n',
  });
  const after = await (await call('GET', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf',
    { headers: { Authorization: AUTH } })).text();
  assert.strictEqual(before, after);
  assert.ok(!after.includes('Hacked'));
});

await test('paths outside the CardDAV tree are refused at the edge', async () => {
  for (const path of ['/api/health', '/api/ps/caseload', '/internal/dav-bridge', '/api/dsc/recipients']) {
    const res = await call('PROPFIND', path, { headers: { Authorization: AUTH }, body: PROPFIND_ALL });
    assert.strictEqual(res.status, 404, `${path} answered ${res.status}`);
    assert.deepStrictEqual(leaks(await res.text()), []);
  }
});

await test('the Worker never reaches the origin for a refused method', async () => {
  const res = await call('DELETE', '/carddav/addressbooks/dsc/dsc-peers/x.vcf', {
    headers: { Authorization: AUTH },
    env: { DAV_BRIDGE_SECRET: BRIDGE_SECRET, ORIGIN_BASE_URL: 'http://127.0.0.1:1' },
  });
  assert.strictEqual(res.status, 403);
});

console.log('\nWorker fails closed');

await test('a Worker with no secret refuses everything with 503', async () => {
  const res = await call('PROPFIND', '/carddav/', {
    headers: { Authorization: AUTH }, body: PROPFIND_ALL,
    env: { ORIGIN_BASE_URL: ORIGIN },
  });
  assert.strictEqual(res.status, 503);
  assert.deepStrictEqual(leaks(await res.text()), []);
});

await test('a Worker with no origin refuses everything with 503', async () => {
  const res = await call('PROPFIND', '/carddav/', {
    headers: { Authorization: AUTH }, body: PROPFIND_ALL,
    env: { DAV_BRIDGE_SECRET: BRIDGE_SECRET },
  });
  assert.strictEqual(res.status, 503);
});

await test('a Worker signing with the wrong secret gets nothing back', async () => {
  const res = await call('PROPFIND', '/carddav/addressbooks/dsc/dsc-peers/', {
    headers: { Authorization: AUTH, Depth: '1' }, body: PROPFIND_ALL,
    env: { DAV_BRIDGE_SECRET: 'mismatched-secret-value', ORIGIN_BASE_URL: ORIGIN },
  });
  assert.ok(res.status >= 400, `answered ${res.status}`);
  assert.deepStrictEqual(leaks(await res.text()), []);
});

await test('an unreachable origin surfaces as 502, not a crash', async () => {
  const res = await call('PROPFIND', '/carddav/', {
    headers: { Authorization: AUTH }, body: PROPFIND_ALL,
    env: { DAV_BRIDGE_SECRET: BRIDGE_SECRET, ORIGIN_BASE_URL: 'http://127.0.0.1:1' },
  });
  assert.strictEqual(res.status, 502);
});

console.log('\nprivacy of responses');

await test('every response is private and no-store', async () => {
  const res = await call('PROPFIND', '/carddav/addressbooks/dsc/dsc-peers/', {
    headers: { Authorization: AUTH, Depth: '1' }, body: PROPFIND_ALL,
  });
  const cc = res.headers.get('cache-control');
  assert.match(cc, /no-store/);
  assert.match(cc, /private/);
});

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('failing: ' + failures.join(', ')); process.exit(1); }

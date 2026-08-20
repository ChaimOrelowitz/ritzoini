// Cross-implementation test: the Worker's envelope.js and the backend's
// davEnvelope.js must produce byte-identical canonical strings and signatures.
//
// This is the single highest-risk seam in the bridge. If the two drift, every
// request fails with a signature mismatch — safe, but completely broken — and
// the cause would be invisible from either side alone. So they are compared
// here directly, over inputs chosen to break naive implementations: unicode,
// delimiter characters inside values, shuffled header order, headers outside
// the signed set, empty vs absent bodies.
//
// Run: node test/envelope.test.js   (from carddav-worker/)

import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const back = require('../../backend/utils/davEnvelope.js');
const fore = await import('../src/envelope.js');

let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failed++; failures.push(name); console.log(`  FAIL ${name}\n       ${err.message}`); }
}

const SECRET = 'test-bridge-secret-not-a-real-one';

const CASES = [
  {
    name: 'PROPFIND with allprop body',
    method: 'PROPFIND', path: '/carddav/addressbooks/dsc/dsc-peers/', query: '',
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
    davHeaders: { depth: '1', 'content-type': 'text/xml' },
  },
  {
    name: 'REPORT with sync-collection and no depth',
    method: 'REPORT', path: '/carddav/addressbooks/dsc/instructors/', query: '',
    body: '<D:sync-collection xmlns:D="DAV:"/>',
    davHeaders: { 'content-type': 'application/xml' },
  },
  {
    name: 'empty body, no headers',
    method: 'OPTIONS', path: '/carddav/', query: '', body: '', davHeaders: {},
  },
  {
    name: 'query string present',
    method: 'PROPFIND', path: '/carddav/addressbooks/dsc/dsc-peers/', query: 'a=1&b=2',
    body: '', davHeaders: { depth: '0' },
  },
  {
    name: 'unicode in body',
    method: 'REPORT', path: '/carddav/addressbooks/dsc/dsc-peers/', query: '',
    body: '<D:x>Ωméga — “quoted” 日本語</D:x>', davHeaders: { depth: '1' },
  },
  {
    name: 'delimiter characters inside a header value',
    method: 'PROPFIND', path: '/carddav/', query: '',
    body: '', davHeaders: { depth: '1', 'if-none-match': '"a","b"\n:x:' },
  },
  {
    name: 'root discovery path',
    method: 'PROPFIND', path: '/', query: '', body: '<D:propfind/>', davHeaders: { depth: '0' },
  },
];

console.log('Envelope parity — Worker vs backend\n');

for (const c of CASES) {
  await test(`canonical string matches: ${c.name}`, async () => {
    const bodyHash = back.sha256(Buffer.from(c.body, 'utf8'));
    const authHash = back.sha256('Basic dGVzdDp0ZXN0');

    // Both implementations must agree on the body digest first.
    const foreBodyHash = await fore.sha256(new TextEncoder().encode(c.body));
    assert.strictEqual(foreBodyHash, bodyHash, 'sha256 of body differs between implementations');

    const args = {
      method: c.method, path: c.path, query: c.query,
      timestamp: 1755648000, nonce: 'a'.repeat(48),
      bodyHash, authHash, davHeaders: c.davHeaders,
    };

    assert.strictEqual(fore.canonicalString(args), back.canonicalString(args));
  });

  await test(`signature matches: ${c.name}`, async () => {
    const bodyHash = back.sha256(Buffer.from(c.body, 'utf8'));
    const authHash = back.sha256('Basic dGVzdDp0ZXN0');
    const args = {
      method: c.method, path: c.path, query: c.query,
      timestamp: 1755648000, nonce: 'b'.repeat(48),
      bodyHash, authHash, davHeaders: c.davHeaders,
    };
    const canonical = back.canonicalString(args);
    assert.strictEqual(await fore.sign(canonical, SECRET), back.sign(canonical, SECRET));
  });
}

await test('header order does not change the signature', async () => {
  const common = {
    method: 'PROPFIND', path: '/carddav/', query: '',
    timestamp: 1755648000, nonce: 'c'.repeat(48),
    bodyHash: back.sha256(''), authHash: back.sha256(''),
  };
  const a = back.canonicalString({ ...common, davHeaders: { depth: '1', 'content-type': 'text/xml' } });
  const b = back.canonicalString({ ...common, davHeaders: { 'content-type': 'text/xml', depth: '1' } });
  assert.strictEqual(a, b, 'canonical form must sort headers');
  assert.strictEqual(await fore.sign(a, SECRET), back.sign(b, SECRET));
});

await test('headers outside the signed set are dropped by both sides', async () => {
  const common = {
    method: 'PROPFIND', path: '/carddav/', query: '',
    timestamp: 1755648000, nonce: 'd'.repeat(48),
    bodyHash: back.sha256(''), authHash: back.sha256(''),
  };
  const withJunk = { depth: '1', cookie: 'session=secret', 'x-forwarded-for': '1.2.3.4', authorization: 'Basic x' };
  const clean    = { depth: '1' };

  assert.strictEqual(
    back.canonicalString({ ...common, davHeaders: withJunk }),
    back.canonicalString({ ...common, davHeaders: clean }),
    'cookies/auth/forwarding headers must never enter the canonical form');
  assert.strictEqual(
    fore.canonicalString({ ...common, davHeaders: withJunk }),
    fore.canonicalString({ ...common, davHeaders: clean }));
});

await test('a one-character change anywhere changes the signature', async () => {
  const base = {
    method: 'PROPFIND', path: '/carddav/addressbooks/dsc/dsc-peers/', query: '',
    timestamp: 1755648000, nonce: 'e'.repeat(48),
    bodyHash: back.sha256('x'), authHash: back.sha256('y'), davHeaders: { depth: '1' },
  };
  const sig = back.sign(back.canonicalString(base), SECRET);

  const mutations = [
    { ...base, method: 'REPORT' },
    { ...base, path: '/carddav/addressbooks/dsc/instructors/' },
    { ...base, query: 'a=1' },
    { ...base, timestamp: 1755648001 },
    { ...base, nonce: 'f'.repeat(48) },
    { ...base, bodyHash: back.sha256('x2') },
    { ...base, authHash: back.sha256('y2') },
    { ...base, davHeaders: { depth: '0' } },
  ];
  for (const m of mutations) {
    assert.notStrictEqual(back.sign(back.canonicalString(m), SECRET), sig);
  }
});

await test('the shared header allowlist is identical', () => {
  assert.deepStrictEqual(fore.SIGNED_DAV_HEADERS, back.SIGNED_DAV_HEADERS);
  assert.strictEqual(fore.VERSION, back.VERSION);
  assert.strictEqual(fore.MAX_BODY_BYTES, back.MAX_BODY_BYTES);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('failing: ' + failures.join(', ')); process.exit(1); }

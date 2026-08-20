// Private contacts tests — the read-only CardDAV books and the DSC recipient
// API for the Message DSC Shortcut.
//
// Run: node test/dscContacts.test.js
//
// Supabase is stubbed through require.cache, so this exercises the real Express
// routers, the real auth middleware and the real vCard serialiser against fixed
// rows — no network, no database, no credentials.

const assert = require('assert');
const express = require('express');
const crypto = require('crypto');

// ── stub Supabase before anything requires it ────────────────────────────────

const TODAY = '2026-08-19';

// Mirrors production shapes exactly: peer_name is "Last, First", cohort is a
// JSON-encoded array in a text column, phones are formatted inconsistently.
const FIXTURES = {
  ps_peers: [
    { airtable_id: 'recA', peer_name: 'Alpha, Ann',   status: 'Active',   cohort: '["A"]', email: 'ann@example.test',  phone: '(555) 100-0001', updated_at: '2026-08-01T00:00:00Z' },
    { airtable_id: 'recB', peer_name: 'Bravo, Ben',   status: 'Active',   cohort: '["B"]', email: 'ben@example.test',  phone: '15551000002',    updated_at: '2026-08-02T00:00:00Z' },
    { airtable_id: 'recC', peer_name: 'Charlie, Cal', status: 'Active',   cohort: 'C',     email: null,                phone: '555-100-0003',   updated_at: '2026-08-03T00:00:00Z' },
    { airtable_id: 'recI', peer_name: 'India, Ida',   status: 'Inactive', cohort: '["A"]', email: null,                phone: '(555) 100-0009', updated_at: '2026-08-04T00:00:00Z' },
    { airtable_id: 'recX', peer_name: 'Xray, Xan',    status: 'Active',   cohort: '["A"]', email: null,                phone: '(555) 100-0010', updated_at: '2026-08-05T00:00:00Z' },
    { airtable_id: 'recT', peer_name: 'Tango, Tom',   status: 'Active',   cohort: '["A"]', email: null,                phone: '(555) 100-0011', updated_at: '2026-08-06T00:00:00Z' },
    { airtable_id: 'recF', peer_name: 'Foxtrot, Fay', status: 'Active',   cohort: '["B"]', email: null,                phone: '(555) 100-0012', updated_at: '2026-08-07T00:00:00Z' },
    { airtable_id: 'recN', peer_name: 'November, Ned',status: 'Active',   cohort: '["B"]', email: 'ned@example.test',  phone: null,             updated_at: '2026-08-08T00:00:00Z' },
    { airtable_id: 'recD', peer_name: 'Delta, Dee',   status: 'Active',   cohort: '["A"]', email: null,                phone: '+1 555 100 0001', updated_at: '2026-08-09T00:00:00Z' },
  ],
  ps_caseload_periods: [
    { peer_airtable_id: 'recA', peer_name: 'Alpha, Ann',    supervisor_airtable_id: 'supX', entered_on: '2026-01-01', left_on: null },
    { peer_airtable_id: 'recB', peer_name: 'Bravo, Ben',    supervisor_airtable_id: 'supX', entered_on: '2026-02-01', left_on: null },
    { peer_airtable_id: 'recC', peer_name: 'Charlie, Cal',  supervisor_airtable_id: 'supX', entered_on: '2026-03-01', left_on: null },
    { peer_airtable_id: 'recI', peer_name: 'India, Ida',    supervisor_airtable_id: 'supX', entered_on: '2026-03-01', left_on: null },
    { peer_airtable_id: 'recX', peer_name: 'Xray, Xan',     supervisor_airtable_id: 'supX', entered_on: '2026-01-01', left_on: '2026-08-01' },
    { peer_airtable_id: 'recT', peer_name: 'Tango, Tom',    supervisor_airtable_id: 'supX', entered_on: '2026-01-01', left_on: TODAY },
    { peer_airtable_id: 'recF', peer_name: 'Foxtrot, Fay',  supervisor_airtable_id: 'supX', entered_on: '2026-12-01', left_on: null },
    { peer_airtable_id: 'recN', peer_name: 'November, Ned', supervisor_airtable_id: 'supX', entered_on: '2026-04-01', left_on: null },
    { peer_airtable_id: 'recD', peer_name: 'Delta, Dee',    supervisor_airtable_id: 'supX', entered_on: '2026-04-01', left_on: null },
    { peer_airtable_id: 'recO', peer_name: 'Orphan, Otto',  supervisor_airtable_id: 'supX', entered_on: '2026-04-01', left_on: null },
    { peer_airtable_id: 'recA', peer_name: 'Alpha, Ann',    supervisor_airtable_id: 'other', entered_on: '2026-01-01', left_on: null },
  ],
  instructors: [
    { id: 'ins-2', first_name: 'Zoe',  last_name: 'Zimmer', phone: '5552000002', created_at: '2026-01-02T00:00:00Z' },
    { id: 'ins-1', first_name: 'Adam', last_name: 'Abbot',  phone: '5552000001', created_at: '2026-01-01T00:00:00Z' },
    { id: 'ins-3', first_name: 'Nora', last_name: 'Null',   phone: '',           created_at: '2026-01-03T00:00:00Z' },
  ],
};

function supabaseStub(tables) {
  return {
    from(table) {
      const q = {
        _filters: [],
        select() { return q; },
        order()  { return q; },
        in()     { return q; },
        limit()  { return q; },
        is(col, val)  { q._filters.push(r => r[col] === val); return q; },
        eq(col, val)  { q._filters.push(r => r[col] === val); return q; },
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

// ── credentials for the run ──────────────────────────────────────────────────

const CARDDAV_USER = 'testuser';
const CARDDAV_PASS = 'test-password-not-a-real-secret';
const SHORTCUT_TOKEN = 'test-shortcut-token-0123456789abcdef';

process.env.SUPABASE_URL = 'http://stub.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub';
process.env.AIRTABLE_SUPERVISOR_RECORD_ID = 'supX';
process.env.CARDDAV_USERNAME = CARDDAV_USER;
process.env.DSC_SHORTCUT_TOKEN = SHORTCUT_TOKEN;

const { scryptHex } = require('../utils/privateAccess');
process.env.CARDDAV_PASSWORD_SALT = crypto.randomBytes(16).toString('hex');
process.env.CARDDAV_PASSWORD_HASH = scryptHex(CARDDAV_PASS, process.env.CARDDAV_PASSWORD_SALT);

const {
  normalizePhone, parseCohort, splitPeerName, dedupeByPhone,
} = require('../utils/contactDirectory');
const { isCurrentPeriod, selectActiveCaseload } = require('../utils/psCaseload');
const { buildVCard, renderBook, etagFor, fold } = require('../utils/vcard');
const carddav = require('../routes/carddav');
const dscRoutes = require('../routes/dscRecipients');

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
app.use('/api/dsc', dscRoutes);

let base;
const basic = (u = CARDDAV_USER, p = CARDDAV_PASS) =>
  'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const bearer = (t = SHORTCUT_TOKEN) => `Bearer ${t}`;

async function req(method, path, { headers = {}, body, auth } = {}) {
  const h = { ...headers };
  if (auth) h.Authorization = auth;
  const res = await fetch(`${base}${path}`, { method, headers: h, body, redirect: 'manual' });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const PROPFIND_ALL = '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>';

// Every string that must never appear in an unauthenticated response.
const SECRETS = ['BEGIN:VCARD', 'Alpha', '5551000001', 'ann@example.test', 'Zimmer'];
const leaks = text => SECRETS.filter(s => text.includes(s));

// ── unit: normalisation ──────────────────────────────────────────────────────

async function unitTests() {
  console.log('\nnormalisation');

  await test('normalizePhone handles every production format', () => {
    assert.strictEqual(normalizePhone('(555) 100-0001'), '+15551000001');
    assert.strictEqual(normalizePhone('5551000001'),     '+15551000001');
    assert.strictEqual(normalizePhone('15551000002'),    '+15551000002');
    assert.strictEqual(normalizePhone('+1 555 100 0001'),'+15551000001');
  });

  await test('normalizePhone rejects unusable numbers', () => {
    for (const bad of [null, '', '   ', 'n/a', '12345', '000']) {
      assert.strictEqual(normalizePhone(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });

  await test('parseCohort unwraps the JSON-array text column', () => {
    assert.strictEqual(parseCohort('["A"]'), 'A');
    assert.strictEqual(parseCohort('["B"]'), 'B');
    assert.strictEqual(parseCohort(['C']),   'C');
    assert.strictEqual(parseCohort('D'),     'D');
    assert.strictEqual(parseCohort(null),    null);
    assert.strictEqual(parseCohort(''),      null);
  });

  await test('splitPeerName reads "Last, First"', () => {
    assert.deepStrictEqual(splitPeerName('Alpha, Ann'),
      { first: 'Ann', last: 'Alpha', display: 'Ann Alpha' });
    assert.deepStrictEqual(splitPeerName('Cher'),
      { first: '', last: 'Cher', display: 'Cher' });
  });

  console.log('\ncaseload window');

  await test('isCurrentPeriod: open period counts', () => {
    assert.ok(isCurrentPeriod({ entered_on: '2026-01-01', left_on: null }, TODAY));
  });

  await test('isCurrentPeriod: expired period does not', () => {
    assert.ok(!isCurrentPeriod({ entered_on: '2026-01-01', left_on: '2026-08-01' }, TODAY));
  });

  await test('isCurrentPeriod: a period closed today is already over', () => {
    assert.ok(!isCurrentPeriod({ entered_on: '2026-01-01', left_on: TODAY }, TODAY));
  });

  await test('isCurrentPeriod: a future entry has not started', () => {
    assert.ok(!isCurrentPeriod({ entered_on: '2026-12-01', left_on: null }, TODAY));
  });

  await test('selectActiveCaseload applies the whole rule', () => {
    const got = selectActiveCaseload({
      periods: FIXTURES.ps_caseload_periods.filter(p => p.supervisor_airtable_id === 'supX'),
      peers: FIXTURES.ps_peers, asOf: TODAY,
    }).map(c => c.sourceId);

    assert.deepStrictEqual(got.sort(), ['recA', 'recB', 'recC', 'recD', 'recI', 'recN'],
      `got ${JSON.stringify(got)}`);
  });

  await test('ps_peers.status is not a membership rule', () => {
    const got = selectActiveCaseload({
      periods: FIXTURES.ps_caseload_periods.filter(p => p.supervisor_airtable_id === 'supX'),
      peers: FIXTURES.ps_peers, asOf: TODAY,
    }).map(c => c.sourceId);

    // recI is marked Inactive in Airtable but is still on the caseload, so the
    // supervisor still needs them in their phone.
    assert.ok(got.includes('recI'), 'an Inactive-status peer on the caseload must be included');
  });

  await test('selectActiveCaseload sorts by last name, deterministically', () => {
    const names = selectActiveCaseload({
      periods: FIXTURES.ps_caseload_periods, peers: FIXTURES.ps_peers, asOf: TODAY,
    }).map(c => c.last);
    assert.deepStrictEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  });

  await test('a period with no mirrored peer row is skipped', () => {
    const ids = selectActiveCaseload({
      periods: FIXTURES.ps_caseload_periods, peers: FIXTURES.ps_peers, asOf: TODAY,
    }).map(c => c.sourceId);
    assert.ok(!ids.includes('recO'));
  });

  await test('a peer on two supervisors\' lists appears once', () => {
    const ids = selectActiveCaseload({
      periods: FIXTURES.ps_caseload_periods, peers: FIXTURES.ps_peers, asOf: TODAY,
    }).map(c => c.sourceId);
    assert.strictEqual(ids.filter(i => i === 'recA').length, 1);
  });

  await test('dedupeByPhone keeps one record per handset and drops the phoneless', () => {
    const out = dedupeByPhone([
      { uid: 'u1', last: 'Alpha', first: 'Ann', phone: '+15551000001' },
      { uid: 'u2', last: 'Delta', first: 'Dee', phone: '+15551000001' },
      { uid: 'u3', last: 'Echo',  first: 'Eve', phone: null },
      { uid: 'u4', last: 'Foxy',  first: 'Fay', phone: '+15551000004' },
    ]);
    assert.deepStrictEqual(out.map(c => c.uid), ['u1', 'u4']);
  });

  console.log('\nvCard');

  const sample = {
    uid: 'ritzoini-peer-recA', first: 'Ann', last: 'Alpha', display: 'Ann Alpha',
    phone: '+15551000001', email: 'ann@example.test', cohort: 'A',
    org: ['DSC Peer Supervision', 'Cohort A'], categories: ['DSC Peer', 'Cohort A'],
    rev: '2026-08-01T00:00:00Z',
  };

  await test('vCard carries name, mobile, email and cohort', () => {
    const v = buildVCard(sample);
    assert.ok(v.includes('UID:ritzoini-peer-recA'));
    assert.ok(v.includes('N:Alpha;Ann;;;'));
    assert.ok(v.includes('FN:Ann Alpha'));
    assert.ok(v.includes('TEL;TYPE=CELL,VOICE:+15551000001'));
    assert.ok(v.includes('EMAIL;TYPE=INTERNET:ann@example.test'));
    assert.ok(v.includes('X-RITZOINI-COHORT:A'), 'X-RITZOINI-COHORT missing');
    assert.ok(/CATEGORIES:DSC Peer\\?,?.*Cohort A/.test(v), `CATEGORIES missing: ${v}`);
    assert.ok(v.includes('ORG:DSC Peer Supervision;Cohort A'));
    assert.ok(v.endsWith('END:VCARD\r\n'));
  });

  await test('vCard bytes and ETag are stable across renders', () => {
    const a = buildVCard(sample);
    const b = buildVCard({ ...sample });
    assert.strictEqual(a, b, 'vCard body drifted between identical renders');
    assert.strictEqual(etagFor(a), etagFor(b));
  });

  await test('REV comes from stored data, never the clock', () => {
    assert.ok(buildVCard(sample).includes('REV:20260801T000000Z'));
    assert.ok(!buildVCard({ ...sample, rev: null }).includes('REV:'));
  });

  await test('a peer with no mobile still yields a valid card without TEL', () => {
    const v = buildVCard({ ...sample, phone: null });
    assert.ok(!v.includes('TEL'));
    assert.ok(v.includes('END:VCARD'));
  });

  await test('special characters are escaped, not injected', () => {
    const v = buildVCard({ ...sample, display: 'O\'Brien, Sean; "x", y\\z', org: ['A;B'] });
    assert.ok(v.includes('FN:O\'Brien\\, Sean\\; "x"\\, y\\\\z'), v);
    assert.ok(v.includes('ORG:A\\;B'));
  });

  await test('long lines fold at 75 octets with a leading space', () => {
    const folded = fold('FN:' + 'x'.repeat(200)).split('\r\n');
    assert.ok(folded.length > 1);
    assert.ok(folded.slice(1).every(l => l.startsWith(' ')));
    assert.ok(Buffer.byteLength(folded[0]) <= 75);
  });

  await test('renderBook gives stable filenames and a content-derived ctag', () => {
    const one = renderBook([sample]);
    const two = renderBook([sample]);
    assert.strictEqual(one.cards[0].filename, 'ritzoini-peer-recA.vcf');
    assert.strictEqual(one.ctag, two.ctag);
    const changed = renderBook([{ ...sample, phone: '+15559999999' }]);
    assert.notStrictEqual(one.ctag, changed.ctag, 'ctag must move when a card changes');
  });
}

// ── DSC recipient API ────────────────────────────────────────────────────────

async function dscTests() {
  console.log('\nDSC recipient API — auth');

  await test('no Authorization header is rejected and leaks nothing', async () => {
    const r = await req('GET', '/api/dsc/recipients');
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(leaks(r.text), []);
  });

  await test('a wrong bearer token is rejected', async () => {
    const r = await req('GET', '/api/dsc/recipients', { auth: bearer('wrong-token-wrong-token-wrong') });
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(leaks(r.text), []);
  });

  await test('Basic auth is not accepted here', async () => {
    const r = await req('GET', '/api/dsc/recipients', { auth: basic() });
    assert.strictEqual(r.status, 401);
  });

  await test('a token in the query string does not authenticate', async () => {
    const r = await req('GET', `/api/dsc/recipients?token=${SHORTCUT_TOKEN}`);
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(leaks(r.text), []);
  });

  await test('missing DSC_SHORTCUT_TOKEN fails closed with 503', async () => {
    const saved = process.env.DSC_SHORTCUT_TOKEN;
    delete process.env.DSC_SHORTCUT_TOKEN;
    try {
      const r = await req('GET', '/api/dsc/recipients', { auth: bearer(saved) });
      assert.strictEqual(r.status, 503);
      assert.deepStrictEqual(leaks(r.text), []);
    } finally { process.env.DSC_SHORTCUT_TOKEN = saved; }
  });

  await test('a too-short token is treated as unconfigured, not as a secret', async () => {
    const saved = process.env.DSC_SHORTCUT_TOKEN;
    process.env.DSC_SHORTCUT_TOKEN = 'short';
    try {
      const r = await req('GET', '/api/dsc/recipients', { auth: bearer('short') });
      assert.strictEqual(r.status, 503);
    } finally { process.env.DSC_SHORTCUT_TOKEN = saved; }
  });

  await test('missing Supabase configuration fails closed with 503', async () => {
    const saved = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    try {
      const r = await req('GET', '/api/dsc/audiences', { auth: bearer() });
      assert.strictEqual(r.status, 503);
    } finally { process.env.SUPABASE_URL = saved; }
  });

  console.log('\nDSC recipient API — payload');

  await test('audiences lists All plus one entry per live cohort, with counts', async () => {
    const r = await req('GET', '/api/dsc/audiences', { auth: bearer() });
    assert.strictEqual(r.status, 200);
    const body = JSON.parse(r.text);
    const keys = body.audiences.map(a => a.key);
    assert.deepStrictEqual(keys, ['all', 'cohort:A', 'cohort:B', 'cohort:C']);
    // Sendable: recA, recB, recC, recI. recD shares recA's handset; recN has no
    // mobile; recX/recT/recF/recO are off the caseload.
    assert.strictEqual(body.audiences.find(a => a.key === 'all').count, 4);
    assert.strictEqual(body.audiences.find(a => a.key === 'cohort:A').count, 2);
    assert.strictEqual(body.audiences.find(a => a.key === 'cohort:B').count, 1);
    assert.strictEqual(body.audiences.find(a => a.key === 'cohort:C').count, 1);
  });

  await test('audiences ship a ready-made menu and a label to key map', async () => {
    const r = await req('GET', '/api/dsc/audiences', { auth: bearer() });
    const body = JSON.parse(r.text);
    assert.deepStrictEqual(body.labels,
      ['All active DSC peers (4)', 'Cohort A (2)', 'Cohort B (1)', 'Cohort C (1)']);
    // Every menu line must resolve to a key the recipients route accepts.
    for (const label of body.labels) {
      const key = body.keys_by_label[label];
      assert.ok(key, `no key for ${label}`);
      const rec = await req('GET', `/api/dsc/recipients?audience=${encodeURIComponent(key)}`,
        { auth: bearer() });
      assert.strictEqual(rec.status, 200, `${key} was not accepted`);
    }
  });

  await test('recipients default to the full active list', async () => {
    const r = await req('GET', '/api/dsc/recipients', { auth: bearer() });
    assert.strictEqual(r.status, 200);
    const body = JSON.parse(r.text);
    assert.strictEqual(body.audience, 'all');
    assert.strictEqual(body.count, body.recipients.length);
  });

  await test('recipients without a usable mobile are excluded', async () => {
    const r = await req('GET', '/api/dsc/recipients?audience=all', { auth: bearer() });
    const body = JSON.parse(r.text);
    assert.ok(body.recipients.every(x => /^\+\d{8,15}$/.test(x.phone)), 'unnormalised number present');
    assert.ok(!body.recipients.some(x => x.id === 'ritzoini-peer-recN'), 'phoneless peer included');
  });

  await test('two peers sharing a mobile produce one recipient', async () => {
    const r = await req('GET', '/api/dsc/recipients?audience=all', { auth: bearer() });
    const phones = JSON.parse(r.text).recipients.map(x => x.phone);
    assert.strictEqual(new Set(phones).size, phones.length, 'duplicate handset in send list');
    assert.strictEqual(phones.filter(p => p === '+15551000001').length, 1);
  });

  await test('cohort filtering returns only that cohort', async () => {
    const r = await req('GET', '/api/dsc/recipients?audience=cohort:B', { auth: bearer() });
    const body = JSON.parse(r.text);
    assert.strictEqual(body.audience, 'cohort:B');
    assert.ok(body.recipients.length > 0);
    assert.ok(body.recipients.every(x => x.cohort === 'B'));
  });

  await test('expired, future and unmirrored peers never reach the send list', async () => {
    const r = await req('GET', '/api/dsc/recipients?audience=all', { auth: bearer() });
    const ids = JSON.parse(r.text).recipients.map(x => x.id);
    for (const gone of ['recX', 'recT', 'recF', 'recO']) {
      assert.ok(!ids.includes(`ritzoini-peer-${gone}`), `${gone} should not be a recipient`);
    }
    assert.ok(ids.includes('ritzoini-peer-recI'), 'an Inactive peer on the caseload must be messageable');
  });

  // Regression: the menu counts and the send loop are built from the same
  // de-duplicated list. Deriving the menu from an un-deduplicated one made the
  // confirmation promise more messages than the loop would actually send.
  await test('every audience count equals the recipients that audience returns', async () => {
    const menu = JSON.parse((await req('GET', '/api/dsc/audiences', { auth: bearer() })).text);
    for (const a of menu.audiences) {
      const r = await req('GET', `/api/dsc/recipients?audience=${encodeURIComponent(a.key)}`,
        { auth: bearer() });
      const body = JSON.parse(r.text);
      assert.strictEqual(a.count, body.recipients.length,
        `${a.key}: menu promised ${a.count}, send list has ${body.recipients.length}`);
      assert.strictEqual(body.count, body.recipients.length);
    }
  });

  await test('recipient records carry only id, name, phone and cohort', async () => {
    const r = await req('GET', '/api/dsc/recipients', { auth: bearer() });
    for (const x of JSON.parse(r.text).recipients) {
      assert.deepStrictEqual(Object.keys(x).sort(), ['cohort', 'id', 'name', 'phone']);
    }
  });

  await test('ordering is deterministic across calls', async () => {
    const a = await req('GET', '/api/dsc/recipients', { auth: bearer() });
    const b = await req('GET', '/api/dsc/recipients', { auth: bearer() });
    assert.deepStrictEqual(
      JSON.parse(a.text).recipients.map(x => x.id),
      JSON.parse(b.text).recipients.map(x => x.id));
  });

  await test('an unknown cohort is refused, not silently treated as All', async () => {
    for (const bad of ['cohort:ZZ', 'cohort:', 'cohort:%', 'everyone', 'cohort:A%27']) {
      const r = await req('GET', `/api/dsc/recipients?audience=${encodeURIComponent(bad)}`, { auth: bearer() });
      assert.strictEqual(r.status, 400, `${bad} should be rejected`);
      assert.deepStrictEqual(leaks(r.text), [], `${bad} leaked contact data`);
    }
  });

  // Regression: "cohort:A " once trimmed to "A" and returned that cohort, which
  // is lenient matching wearing an exact-matching label.
  await test('audience keys must match byte for byte', async () => {
    for (const bad of ['cohort:A ', ' cohort:A', 'cohort: A', 'COHORT:A', 'Cohort:A', 'all ', ' all']) {
      const r = await req('GET', `/api/dsc/recipients?audience=${encodeURIComponent(bad)}`, { auth: bearer() });
      assert.strictEqual(r.status, 400, `${JSON.stringify(bad)} was accepted`);
      assert.deepStrictEqual(leaks(r.text), []);
    }
  });

  await test('every published menu key still resolves exactly', async () => {
    const menu = JSON.parse((await req('GET', '/api/dsc/audiences', { auth: bearer() })).text);
    for (const label of menu.labels) {
      const key = menu.keys_by_label[label];
      const r = await req('GET', `/api/dsc/recipients?audience=${encodeURIComponent(key)}`, { auth: bearer() });
      assert.strictEqual(r.status, 200, `published key ${key} was rejected`);
    }
  });

  await test('a repeated audience parameter is refused', async () => {
    const r = await req('GET', '/api/dsc/recipients?audience=all&audience=cohort:A', { auth: bearer() });
    assert.strictEqual(r.status, 400);
  });

  await test('responses are marked private and no-store', async () => {
    const r = await req('GET', '/api/dsc/recipients', { auth: bearer() });
    assert.match(r.headers.get('cache-control'), /no-store/);
    assert.match(r.headers.get('cache-control'), /private/);
  });

  await test('the server exposes no send endpoint', async () => {
    for (const [m, p] of [['POST', '/api/dsc/send'], ['POST', '/api/dsc/recipients'], ['POST', '/api/dsc/messages']]) {
      const r = await req(m, p, { auth: bearer() });
      assert.ok(r.status === 404 || r.status === 405, `${m} ${p} answered ${r.status}`);
    }
  });
}

// ── CardDAV ──────────────────────────────────────────────────────────────────

async function carddavTests() {
  console.log('\nCardDAV — auth');

  await test('unauthenticated PROPFIND is challenged and leaks nothing', async () => {
    const r = await req('PROPFIND', '/carddav/addressbooks/dsc/dsc-peers/',
      { headers: { Depth: '1', 'Content-Type': 'text/xml' }, body: PROPFIND_ALL });
    assert.strictEqual(r.status, 401);
    assert.match(r.headers.get('www-authenticate') || '', /^Basic realm=/);
    assert.deepStrictEqual(leaks(r.text), []);
  });

  await test('unauthenticated GET of a card leaks nothing', async () => {
    const r = await req('GET', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf');
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(leaks(r.text), []);
  });

  await test('a wrong password is rejected', async () => {
    const r = await req('PROPFIND', '/carddav/addressbooks/dsc/dsc-peers/',
      { auth: basic(CARDDAV_USER, 'wrong'), headers: { Depth: '1' }, body: PROPFIND_ALL });
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(leaks(r.text), []);
  });

  await test('a wrong username is rejected', async () => {
    const r = await req('PROPFIND', '/carddav/addressbooks/dsc/dsc-peers/',
      { auth: basic('someoneelse', CARDDAV_PASS), headers: { Depth: '1' }, body: PROPFIND_ALL });
    assert.strictEqual(r.status, 401);
  });

  await test('a malformed Authorization header is rejected', async () => {
    for (const bad of ['Basic', 'Basic !!!!', 'Bearer abc', 'Basic ' + Buffer.from('nocolon').toString('base64')]) {
      const r = await req('PROPFIND', '/carddav/', { auth: bad, body: PROPFIND_ALL });
      assert.strictEqual(r.status, 401, `${bad} should be rejected`);
    }
  });

  await test('missing CardDAV credentials fail closed with 503', async () => {
    const saved = process.env.CARDDAV_PASSWORD_HASH;
    delete process.env.CARDDAV_PASSWORD_HASH;
    try {
      const r = await req('PROPFIND', '/carddav/addressbooks/dsc/dsc-peers/',
        { auth: basic(), headers: { Depth: '1' }, body: PROPFIND_ALL });
      assert.strictEqual(r.status, 503);
      assert.deepStrictEqual(leaks(r.text), []);
    } finally { process.env.CARDDAV_PASSWORD_HASH = saved; }
  });

  await test('plain HTTP is refused in production', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const r = await req('PROPFIND', '/carddav/', { auth: basic(), body: PROPFIND_ALL });
      assert.strictEqual(r.status, 403);
      const ok = await req('PROPFIND', '/carddav/',
        { auth: basic(), headers: { 'X-Forwarded-Proto': 'https' }, body: PROPFIND_ALL });
      assert.strictEqual(ok.status, 207, 'https should still be served');
    } finally { process.env.NODE_ENV = saved; }
  });

  console.log('\nCardDAV — discovery');

  await test('/.well-known/carddav answers directly, without a redirect', async () => {
    const r = await req('PROPFIND', '/.well-known/carddav', { auth: basic(), body: PROPFIND_ALL });
    assert.strictEqual(r.status, 207, 'must not redirect — iOS handles authenticated redirects poorly');
    assert.ok(!r.headers.get('location'), 'no Location header should be sent');
    assert.ok(r.text.includes('/carddav/principals/dsc/'));
    assert.deepStrictEqual(leaks(r.text), []);
  });

  await test('/.well-known/carddav still requires credentials', async () => {
    const r = await req('PROPFIND', '/.well-known/carddav', { body: PROPFIND_ALL });
    assert.strictEqual(r.status, 401);
  });

  await test('PROPFIND / advertises the principal', async () => {
    const r = await req('PROPFIND', '/', { auth: basic(), body: PROPFIND_ALL });
    assert.strictEqual(r.status, 207);
    assert.ok(r.text.includes('<D:current-user-principal>'));
    assert.ok(r.text.includes('/carddav/principals/dsc/'));
    assert.deepStrictEqual(leaks(r.text), [], 'discovery must not carry contacts');
  });

  await test('the principal advertises the addressbook home set', async () => {
    const r = await req('PROPFIND', '/carddav/principals/dsc/', { auth: basic(), body: PROPFIND_ALL });
    assert.strictEqual(r.status, 207);
    assert.ok(r.text.includes('<C:addressbook-home-set>'));
    assert.ok(r.text.includes('/carddav/addressbooks/dsc/'));
  });

  await test('the home set lists exactly the two books at Depth 1', async () => {
    const r = await req('PROPFIND', '/carddav/addressbooks/dsc/',
      { auth: basic(), headers: { Depth: '1' }, body: PROPFIND_ALL });
    assert.strictEqual(r.status, 207);
    assert.ok(r.text.includes('/carddav/addressbooks/dsc/dsc-peers/'));
    assert.ok(r.text.includes('/carddav/addressbooks/dsc/instructors/'));
    assert.ok(r.text.includes('DSC Peers'));
    assert.ok(r.text.includes('Ritzoini Instructors'));
    assert.ok(r.text.includes('<C:addressbook/>'), 'books must declare the addressbook resourcetype');
  });

  await test('OPTIONS advertises addressbook support and read-only methods', async () => {
    const r = await req('OPTIONS', '/carddav/addressbooks/dsc/dsc-peers/', { auth: basic() });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('dav') || '', /addressbook/);
    const allow = r.headers.get('allow') || '';
    assert.match(allow, /PROPFIND/);
    assert.match(allow, /REPORT/);
    assert.ok(!/PUT|DELETE/.test(allow), `Allow advertises writes: ${allow}`);
  });

  console.log('\nCardDAV — contents');

  await test('the peers book lists only the active caseload', async () => {
    const r = await req('PROPFIND', '/carddav/addressbooks/dsc/dsc-peers/',
      { auth: basic(), headers: { Depth: '1' }, body: PROPFIND_ALL });
    assert.strictEqual(r.status, 207);
    for (const live of ['recA', 'recB', 'recC', 'recD', 'recI', 'recN']) {
      assert.ok(r.text.includes(`ritzoini-peer-${live}.vcf`), `${live} missing`);
    }
    for (const gone of ['recX', 'recT', 'recF', 'recO']) {
      assert.ok(!r.text.includes(`ritzoini-peer-${gone}.vcf`), `${gone} should not be in the book`);
    }
  });

  await test('two peers sharing a handset are still two contacts', async () => {
    // The send list collapses them; the address book must not — they are two
    // different people who happen to share a phone.
    const r = await req('PROPFIND', '/carddav/addressbooks/dsc/dsc-peers/',
      { auth: basic(), headers: { Depth: '1' }, body: PROPFIND_ALL });
    assert.ok(r.text.includes('ritzoini-peer-recA.vcf'));
    assert.ok(r.text.includes('ritzoini-peer-recD.vcf'));
  });

  await test('a peer with no mobile is still a contact', async () => {
    const r = await req('PROPFIND', '/carddav/addressbooks/dsc/dsc-peers/',
      { auth: basic(), headers: { Depth: '1' }, body: PROPFIND_ALL });
    assert.ok(r.text.includes('ritzoini-peer-recN.vcf'),
      'a phoneless peer belongs in Contacts even though it cannot be texted');
  });

  await test('the instructors book comes from the instructors table', async () => {
    const r = await req('PROPFIND', '/carddav/addressbooks/dsc/instructors/',
      { auth: basic(), headers: { Depth: '1' }, body: PROPFIND_ALL });
    assert.strictEqual(r.status, 207);
    assert.ok(r.text.includes('ritzoini-instructor-ins-1.vcf'));
    assert.ok(r.text.includes('ritzoini-instructor-ins-2.vcf'));
    assert.ok(r.text.indexOf('ins-1') < r.text.indexOf('ins-2'), 'should be ordered by last name');
  });

  await test('a card GET returns vCard with a matching ETag', async () => {
    const r = await req('GET', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf',
      { auth: basic() });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/vcard/);
    assert.ok(r.text.startsWith('BEGIN:VCARD'));
    assert.ok(r.text.includes('TEL;TYPE=CELL,VOICE:+15551000001'));
    assert.ok(r.text.includes('X-RITZOINI-COHORT:A'));
    assert.strictEqual(r.headers.get('etag'), etagFor(r.text));
  });

  await test('identifiers and ETags are stable across syncs', async () => {
    const a = await req('GET', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf', { auth: basic() });
    const b = await req('GET', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf', { auth: basic() });
    assert.strictEqual(a.text, b.text, 'card body drifted — iOS would duplicate the contact');
    assert.strictEqual(a.headers.get('etag'), b.headers.get('etag'));
    assert.ok(a.text.includes('UID:ritzoini-peer-recA'));
  });

  await test('If-None-Match short-circuits an unchanged card', async () => {
    const first = await req('GET', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf', { auth: basic() });
    const again = await req('GET', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf',
      { auth: basic(), headers: { 'If-None-Match': first.headers.get('etag') } });
    assert.strictEqual(again.status, 304);
  });

  await test('an unknown book or card is 404, not a blank success', async () => {
    const book = await req('PROPFIND', '/carddav/addressbooks/dsc/nope/',
      { auth: basic(), headers: { Depth: '1' }, body: PROPFIND_ALL });
    assert.strictEqual(book.status, 404);
    const card = await req('GET', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-nope.vcf', { auth: basic() });
    assert.strictEqual(card.status, 404);
  });

  await test('a collection GET does not dump the book', async () => {
    const r = await req('GET', '/carddav/addressbooks/dsc/dsc-peers/', { auth: basic() });
    assert.strictEqual(r.status, 405);
    assert.deepStrictEqual(leaks(r.text), []);
  });

  await test('private contact responses are no-store', async () => {
    const r = await req('GET', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf', { auth: basic() });
    assert.match(r.headers.get('cache-control'), /no-store/);
    assert.match(r.headers.get('cache-control'), /private/);
  });

  console.log('\nCardDAV — REPORT');

  await test('addressbook-multiget returns only the requested cards', async () => {
    const body = '<?xml version="1.0" encoding="utf-8"?>' +
      '<C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">' +
      '<D:prop><D:getetag/><C:address-data/></D:prop>' +
      '<D:href>/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf</D:href>' +
      '</C:addressbook-multiget>';
    const r = await req('REPORT', '/carddav/addressbooks/dsc/dsc-peers/',
      { auth: basic(), headers: { Depth: '1', 'Content-Type': 'text/xml' }, body });
    assert.strictEqual(r.status, 207);
    assert.ok(r.text.includes('ritzoini-peer-recA.vcf'));
    assert.ok(!r.text.includes('ritzoini-peer-recB.vcf'), 'multiget returned an unrequested card');
  });

  await test('addressbook-query returns the book', async () => {
    const body = '<?xml version="1.0" encoding="utf-8"?>' +
      '<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">' +
      '<D:prop><D:getetag/></D:prop></C:addressbook-query>';
    const r = await req('REPORT', '/carddav/addressbooks/dsc/dsc-peers/',
      { auth: basic(), headers: { Depth: '1' }, body });
    assert.strictEqual(r.status, 207);
    assert.ok(r.text.includes('ritzoini-peer-recA.vcf'));
  });

  await test('sync-collection issues a token, then reports no change', async () => {
    const initial = '<?xml version="1.0" encoding="utf-8"?>' +
      '<D:sync-collection xmlns:D="DAV:"><D:sync-token/><D:sync-level>1</D:sync-level>' +
      '<D:prop><D:getetag/></D:prop></D:sync-collection>';
    const first = await req('REPORT', '/carddav/addressbooks/dsc/dsc-peers/',
      { auth: basic(), headers: { Depth: '1' }, body: initial });
    assert.strictEqual(first.status, 207);
    const token = first.text.match(/<D:sync-token>([^<]+)<\/D:sync-token>/)[1];
    assert.ok(token);

    const followUp = initial.replace('<D:sync-token/>', `<D:sync-token>${token}</D:sync-token>`);
    const second = await req('REPORT', '/carddav/addressbooks/dsc/dsc-peers/',
      { auth: basic(), headers: { Depth: '1' }, body: followUp });
    assert.strictEqual(second.status, 207);
    assert.ok(!second.text.includes('.vcf'), 'unchanged sync should report no members');
  });

  await test('a stale sync token forces a full resync', async () => {
    const body = '<?xml version="1.0" encoding="utf-8"?>' +
      '<D:sync-collection xmlns:D="DAV:">' +
      '<D:sync-token>http://ritzoini.corsolutions.io/ns/sync/deadbeef</D:sync-token>' +
      '<D:prop><D:getetag/></D:prop></D:sync-collection>';
    const r = await req('REPORT', '/carddav/addressbooks/dsc/dsc-peers/',
      { auth: basic(), headers: { Depth: '1' }, body });
    assert.strictEqual(r.status, 403);
    assert.ok(r.text.includes('valid-sync-token'));
  });

  await test('REPORT requires credentials', async () => {
    const r = await req('REPORT', '/carddav/addressbooks/dsc/dsc-peers/',
      { headers: { Depth: '1' }, body: '<D:sync-collection xmlns:D="DAV:"/>' });
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(leaks(r.text), []);
  });

  console.log('\nCardDAV — read-only enforcement');

  const WRITES = [
    ['PUT',       '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf'],
    ['DELETE',    '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf'],
    ['POST',      '/carddav/addressbooks/dsc/dsc-peers/'],
    ['PATCH',     '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf'],
    ['PROPPATCH', '/carddav/addressbooks/dsc/dsc-peers/'],
    ['MKCOL',     '/carddav/addressbooks/dsc/newbook/'],
    ['MOVE',      '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf'],
    ['COPY',      '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf'],
    ['LOCK',      '/carddav/addressbooks/dsc/dsc-peers/'],
    ['ACL',       '/carddav/addressbooks/dsc/dsc-peers/'],
  ];

  await test('every write method is refused for an authenticated client', async () => {
    for (const [method, path] of WRITES) {
      const r = await req(method, path, { auth: basic(), body: 'BEGIN:VCARD\r\nEND:VCARD\r\n' });
      assert.strictEqual(r.status, 403, `${method} answered ${r.status}`);
    }
  });

  await test('write methods are rejected before authentication too', async () => {
    for (const [method, path] of WRITES) {
      const r = await req(method, path, { body: 'x' });
      assert.ok([401, 403].includes(r.status), `${method} answered ${r.status}`);
      assert.deepStrictEqual(leaks(r.text), []);
    }
  });

  await test('a PUT does not change what the book serves', async () => {
    const before = await req('GET', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf', { auth: basic() });
    await req('PUT', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf', {
      auth: basic(),
      headers: { 'Content-Type': 'text/vcard' },
      body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:ritzoini-peer-recA\r\nFN:Hacked\r\nEND:VCARD\r\n',
    });
    const after = await req('GET', '/carddav/addressbooks/dsc/dsc-peers/ritzoini-peer-recA.vcf', { auth: basic() });
    assert.strictEqual(before.text, after.text);
    assert.ok(!after.text.includes('Hacked'));
  });
}

// ── run ──────────────────────────────────────────────────────────────────────

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  console.log('Private contacts — CardDAV + DSC recipient API\n');
  try {
    await unitTests();
    await dscTests();
    await carddavTests();
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('failing: ' + failures.join(', '));
    process.exit(1);
  }
})();

// CRM note source tests — a CRM revision mapped onto the InSync note shape must
// come out of the same section parser, review payload and duplicate check intact.
//
// Run: NODE_ENV=test node test/crmSource.test.js
//
// No network and no database. The revision is synthetic, shaped like the
// supervisor-review detail response captured in `dsc crm notes.har`.

const assert = require('assert');

// The modules load the Supabase client; nothing here touches it.
process.env.SUPABASE_URL = 'http://stub.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub';

const { crmRevisionToNote, nameTokens, sourceOf, NO_CONTEXT_FLAG, isPublicHostname } = require('../utils/crmPortal');
const E = require('../utils/peerSupervisorEngine');
const { contentHash, machineChecks, decideAction, whereSource } = require('../utils/psIngest');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n${err.stack}`); process.exitCode = 1; }
}

const REV = {
  id: '11111111-1111-4111-8111-111111111111',
  sessionNoteId: '22222222-2222-4222-8222-222222222222',
  revisionOrdinal: 1,
  submittedAt: '2026-09-16T14:15:05.457Z',
  reviewState: 'PENDING',
  clientName: 'Test Client',
  peerName: 'Test Peer',
  snapshot: {
    sessionDate: '2026-09-15',
    sessionStartMinutes: 675,
    durationMinutes: 120,
    sessionLanguageCategory: 'NON_ENGLISH',
    sessionMode: 'IN_PERSON',
    locationCategory: 'OTHER_LOCATION',
    locationText: 'Public library study room',
    isOffsite: true,
    offsiteJustification: 'The client needed practice using the planner in the setting where he studies.',
    personsPresent: 'Client and peer',
    // "Plan:" starting a line inside a value must not be read as the Plan heading.
    focusOfMeeting: 'Reviewing how the weekly priority list worked during a school week that had several deadlines close together.\nPlan: the client wanted to see whether the list itself was the problem or how he used it.',
    activitiesSummary: 'First Hour: we went through a day when the list felt too full.\n\nSecond Hour: we practised trimming it to three tasks.',
    patientResponse: 'The client identified two tasks he could drop from the list and said the shorter list felt manageable for the rest of the week, and he asked to try it again tomorrow.',
    nextPlan: 'Next session the client will bring the planner and report which tasks he completed.',
    interventionDetails: null,
    derivedEncounterTypeLabel: 'Peer Support - Individual - Language other than English - In-person outside the clinic Offsite',
    interventions: [
      { id: 'a', label: 'Active Listening', details: 'Let the client explain where the plan helped.' },
      { id: 'b', label: 'Problem-Solving', details: null },
    ],
  },
  previousSnapshot: null,
  changedFieldKeys: [],
};

const CONTEXT = {
  pid: '123', mrn: 'MRN1', dobStr: '01/02/2010', fromEid: '999',
  diagnosis: 'F41.1 - Generalized anxiety disorder',
  treatmentPlan: 'Problem: Anxiety (Last Review Date: 01/01/2026, Next Review Date: 07/01/2026) Long Term Goal(s) 1: reduce anxiety',
};

const norm = v => String(v).replace(/\s+/g, ' ').trim();
const engine = new E.InsyncCoSignEngine({});
const quiet = fn => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

test('eid carries the source', () => {
  const n = crmRevisionToNote(REV);
  assert.strictEqual(n.eid, `crm:${REV.sessionNoteId}`);
  assert.strictEqual(sourceOf(n.eid), 'crm');
  assert.strictEqual(sourceOf('1036995'), 'insync');
});

test('times and dates use the InSync formats', () => {
  const n = crmRevisionToNote(REV);
  assert.strictEqual(n.visitDate, '09/15/2026');
  assert.strictEqual(n.visitDatetime, '09/15/2026 11:15 AM');
  assert.strictEqual(n.endTimeStr, '01:15 PM');
  assert.strictEqual(n.totalTime, '2 hr 0 min');
});

for (const [label, ctx] of [['without chart context', null], ['with chart context', CONTEXT]]) {
  test(`sections parse back exactly (${label})`, () => {
    const n = crmRevisionToNote(REV, ctx);
    const s = REV.snapshot;
    // The line-structured text is what the review and duplicate check read.
    assert.strictEqual(E.sectionSource(n), n.structuredText);
    {
      const secs = E.splitSections(n.structuredText);
      assert.strictEqual(secs.focus, norm(s.focusOfMeeting));
      assert.strictEqual(secs.activities, norm(s.activitiesSummary));
      assert.strictEqual(secs.response, norm(s.patientResponse));
      assert.strictEqual(secs.plan, norm(s.nextPlan));
      assert.ok(secs.interventions.startsWith('Active Listening'));
    }
  });

  test(`review payload builds under strict section checks (${label})`, () => {
    const p = E.buildReviewPayload(crmRevisionToNote(REV, ctx), []);
    assert.strictEqual(p.delivery_method, 'OFFSITE');
    assert.ok(/Off-site justification: The client needed/.test(p.other_session_narrative));
    assert.strictEqual(p.diagnoses.length, ctx ? 1 : 0);
    assert.strictEqual(p.treatment_plan.problems.length, ctx ? 1 : 0);
    assert.strictEqual(p.client_age, ctx ? E.InsyncCoSignEngine.prototype._age(ctx.dobStr) : null);
  });
}

test('no chart context is a machine flag; context removes it', () => {
  assert.ok(quiet(() => machineChecks(engine, crmRevisionToNote(REV))).includes(NO_CONTEXT_FLAG));
  assert.ok(!quiet(() => machineChecks(engine, crmRevisionToNote(REV, CONTEXT))).includes(NO_CONTEXT_FLAG));
});

test('hash ignores borrowed chart context but tracks the revision', () => {
  const h = contentHash(crmRevisionToNote(REV));
  assert.strictEqual(contentHash(crmRevisionToNote(REV, CONTEXT)), h);
  const resubmitted = { ...REV, id: '33333333-3333-4333-8333-333333333333', revisionOrdinal: 2 };
  const h2 = contentHash(crmRevisionToNote(resubmitted));
  assert.notStrictEqual(h2, h);
  assert.strictEqual(decideAction({ status: 'pending', content_hash: h }, h2), 'revised');
});

test('a copied CRM note is caught by the duplicate check', () => {
  const a = crmRevisionToNote(REV);
  const b = crmRevisionToNote({ ...REV, sessionNoteId: '44444444-4444-4444-8444-444444444444' });
  assert.ok(engine.findDupe(a, [engine.prepareDupeEntry(b)]));
});

test('duplicate pools never cross sources', () => {
  const calls = [];
  const q = { like: (...a) => { calls.push(['like', ...a]); return q; },
              not:  (...a) => { calls.push(['not', ...a]); return q; } };
  whereSource(q, 'crm');
  whereSource(q, 'insync');
  assert.deepStrictEqual(calls, [['like', 'eid', 'crm:%'], ['not', 'eid', 'like', 'crm:%']]);
});

test('client names match across "First Last" and "Last, First"', () => {
  assert.strictEqual(nameTokens('Test Client'), nameTokens('Client, Test'));
  assert.notStrictEqual(nameTokens('Test Client'), nameTokens('Client, Other'));
});

test('the pasted sign-in link can only reach public hostnames', () => {
  for (const h of ['portal.linksnetwork.com', 'click.mail.example.com']) assert.ok(isPublicHostname(h), h);
  for (const h of ['localhost', '127.0.0.1', '169.254.169.254', '[::1]', 'db.internal', 'printer.local', 'intranet'])
    assert.ok(!isPublicHostname(h), h);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);

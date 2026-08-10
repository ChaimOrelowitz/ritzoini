// Parser boundary tests — a recognised heading must END the previous section and
// never appear inside its text, while the same word used in ordinary narrative
// must never end anything.
//
// Run: node test/parser.headings.test.js
//
// Two input shapes are covered on purpose:
//   • markdown / multi-line — the shape in the acceptance tests
//   • FLAT single-line      — the shape that actually reaches the parser at
//     runtime, because _parseNote collapses all whitespace before parsing

const assert = require('assert');
const { splitSections, sectionByLabel, findHeadings } = require('../utils/peerSupervisorEngine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}

const PLAN_TEXT = 'The goal for tonight\'s session is to utilize a "Motivation Map" to identify activities that help improve his mood during depressive episodes.';

// ── TEST 1 — Plan / Diagnosis boundary ───────────────────────────────────────
test('1. Plan stops before the Diagnosis heading (markdown)', () => {
  const text = [
    '**Plan**',
    `* ${PLAN_TEXT}`,
    '**Diagnosis**',
    'F41.1 - Generalized anxiety disorder',
  ].join('\n');

  const secs = splitSections(text);
  assert.strictEqual(secs.plan, PLAN_TEXT, `plan was: ${JSON.stringify(secs.plan)}`);
  assert.ok(!/Diagnosis/i.test(secs.plan), 'plan must not contain "Diagnosis"');
  assert.ok(sectionByLabel(text, 'Diagnosis').includes('F41.1 - Generalized anxiety disorder'));
});

test('1b. Same boundary in FLAT text — the real runtime shape', () => {
  // No newlines, exactly as _parseNote produces after collapsing whitespace.
  const text = `Focus of the meeting: Mood support Plan: * ${PLAN_TEXT} Diagnosis F41.1 - Generalized anxiety disorder Plan / Visit Codes Visit Codes: H0038`;

  const secs = splitSections(text);
  assert.strictEqual(secs.plan, PLAN_TEXT, `plan was: ${JSON.stringify(secs.plan)}`);
  assert.ok(!/Diagnosis/.test(secs.plan), 'plan must not contain "Diagnosis"');
  assert.ok(sectionByLabel(text, 'Diagnosis').startsWith('F41.1'));
});

// ── TEST 2 — Diagnosis / Visit Codes boundary ────────────────────────────────
test('2. Diagnosis stops before Visit Codes', () => {
  const text = ['**Diagnosis**', 'F41.1 - Generalized anxiety disorder', '**Visit Codes**', 'H0038 - Peer Support'].join('\n');
  const dx = sectionByLabel(text, 'Diagnosis');
  assert.strictEqual(dx, 'F41.1 - Generalized anxiety disorder', `diagnosis was: ${JSON.stringify(dx)}`);
  assert.ok(!/Visit Codes/i.test(dx), 'diagnosis must not contain "Visit Codes"');
  assert.ok(!/H0038/.test(dx), 'diagnosis must not contain the visit code');
});

// ── TEST 3 — narrative use of a heading word ─────────────────────────────────
test('3. "diagnosis" inside a sentence does not end the section', () => {
  const text = [
    "**Patient's Response/Content**",
    'The client stated that receiving his diagnosis helped him understand his anxiety.',
    '**Plan**',
    'Continue discussing coping strategies.',
  ].join('\n');

  const secs = splitSections(text);
  assert.strictEqual(secs.response, 'The client stated that receiving his diagnosis helped him understand his anxiety.');
  assert.ok(/diagnosis helped him/.test(secs.response), 'the word must survive inside the sentence');
  assert.strictEqual(secs.plan, 'Continue discussing coping strategies.');
});

test('3b. Narrative "plan"/"problem"/"response" never act as headings (flat)', () => {
  const narrative = 'He adjusted his plan and finished the task. The main problem he identified was procrastination. His response improved as the activity continued. We discussed the plan for managing anxiety.';
  const text = `Patient's Response/Content: ${narrative} Plan: * Continue coping work. Diagnosis F41.1 - Generalized anxiety disorder`;
  const secs = splitSections(text);
  assert.strictEqual(secs.response, narrative, `response was truncated: ${JSON.stringify(secs.response)}`);
  assert.strictEqual(secs.plan, 'Continue coping work.');
});

// ── TEST 4 — markdown / whitespace variants ──────────────────────────────────
test('4. Diagnosis heading variants all parse identically', () => {
  const variants = ['Diagnosis', '**Diagnosis**', '  Diagnosis  ', '**Diagnosis:**', 'Diagnosis:'];
  for (const v of variants) {
    const text = ['**Plan**', 'Keep practising the breathing exercise.', v, 'F41.1 - Generalized anxiety disorder'].join('\n');
    const secs = splitSections(text);
    assert.strictEqual(secs.plan, 'Keep practising the breathing exercise.', `variant ${JSON.stringify(v)} → plan ${JSON.stringify(secs.plan)}`);
    assert.ok(!/Diagnosis/i.test(secs.plan), `variant ${JSON.stringify(v)} leaked the heading into plan`);
    assert.strictEqual(sectionByLabel(text, 'Diagnosis'), 'F41.1 - Generalized anxiety disorder', `variant ${JSON.stringify(v)} → diagnosis`);
  }
});

// ── TEST 5 — footer boundary ─────────────────────────────────────────────────
test('5. Treatment Plan stops before the signature block', () => {
  const text = [
    '**Treatment Plan**',
    'Problem: Anxiety [Date Started: 01/01/2026]',
    '**Electronically Signed**',
    'by Provider Name',
    '**Provider NPI**',
    '1111111111',
  ].join('\n');

  const tp = sectionByLabel(text, 'Treatment Plan');
  assert.strictEqual(tp, 'Problem: Anxiety [Date Started: 01/01/2026]', `treatment plan was: ${JSON.stringify(tp)}`);
  assert.ok(!/Electronically Signed/i.test(tp), 'must not contain "Electronically Signed"');
  assert.ok(!/Provider NPI/i.test(tp), 'must not contain "Provider NPI"');
  assert.ok(!/1111111111/.test(tp), 'must not contain the NPI number');
});

test('5b. Footer boundary in FLAT text', () => {
  const text = 'Total Time: 180 mins Treatment Plan Problem: Anxiety [Date Started: 01/01/2026] Electronically Signed by Chaim Paneth on 07/21/2026 Provider NPI 1111111111';
  const tp = sectionByLabel(text, 'Treatment Plan');
  assert.ok(tp.startsWith('Problem: Anxiety'), `treatment plan was: ${JSON.stringify(tp)}`);
  assert.ok(!/Electronically Signed/.test(tp), 'must not contain "Electronically Signed"');
  assert.ok(!/Provider NPI/.test(tp), 'must not contain "Provider NPI"');
});

// ── All five narrative sections, not just Plan ───────────────────────────────
test('6. Every narrative section ends at the next heading', () => {
  const text = [
    'Focus of the meeting: Building routine.',
    'What activities took place, and for how long: Reviewed the schedule for 45 minutes.',
    'Peer Support Interventions: Active Listening',
    "Patient's Response/Content: He engaged well throughout.",
    'Plan: Continue the routine work.',
    'Diagnosis F41.1 - Generalized anxiety disorder',
  ].join(' ');

  const secs = splitSections(text);
  assert.strictEqual(secs.focus, 'Building routine.');
  assert.strictEqual(secs.activities, 'Reviewed the schedule for 45 minutes.');
  assert.strictEqual(secs.interventions, 'Active Listening');
  assert.strictEqual(secs.response, 'He engaged well throughout.');
  assert.strictEqual(secs.plan, 'Continue the routine work.');
  for (const [k, v] of Object.entries(secs))
    assert.ok(!/^(Diagnosis|Plan|Visit Codes)$/i.test(v.split(' ').pop()), `${k} ends with a heading word: ${JSON.stringify(v)}`);
});

// ── Heading detection itself ─────────────────────────────────────────────────
test('7. findHeadings ignores heading words used mid-sentence', () => {
  const text = 'Plan: We discussed the plan for the week and his diagnosis anxiety. Diagnosis F41.1 - Generalized anxiety';
  const labels = findHeadings(text).map(h => h.label);
  assert.deepStrictEqual(labels, ['Plan', 'Diagnosis'], `got: ${JSON.stringify(labels)}`);
});

test('8. "Treatment Plan" wins over the "Plan" inside it', () => {
  const text = 'Total Time: 120 mins Treatment Plan Problem: Anxiety';
  const labels = findHeadings(text).map(h => h.label);
  assert.ok(labels.includes('Treatment Plan'), `got: ${JSON.stringify(labels)}`);
  assert.ok(!labels.includes('Plan'), 'bare "Plan" must not also match inside "Treatment Plan"');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

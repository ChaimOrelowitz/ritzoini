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
const {
  splitSections, sectionByLabel, findHeadings,
  htmlToStructuredText, InsyncCoSignEngine,
  buildReviewPayload, assertSectionsDerived, sectionSource,
} = require('../utils/peerSupervisorEngine');

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

// ── Structured (line-preserving) pipeline ────────────────────────────────────
// Fixture mirrors the real InSync markup: the Diagnosis heading is an <a> inside
// <b> inside a report_subheader <td>; Treatment Plan is <li><b>…</b>; the "Plan:"
// heading is a bold <span> inside a <label>; narrative sits in a plain <span> —
// and that narrative deliberately contains "Plan:" mid-sentence.
const NARRATIVE = 'The client stated: Plan: continue using the checklist when overwhelmed. We also reviewed his diagnosis and the plan for next week.';
const HTML = `<html><body>
<table><tr><td class='report_subheader'><b><a href='#'>Note of Session</a></b></td></tr>
<tr><td class='report_tbltext'>
  <label><span class="bold">Focus of the meeting:</span><span class="required">*</span></label>
  <span>Building routine.</span>
  <label><span class="bold">Patient's Response/Content:</span><span class="required">*</span></label>
  <span>${NARRATIVE}</span>
  <label><span class="bold">Plan:</span><span class="required">*</span></label>
  <span>Continue the routine work.</span>
</td></tr>
<tr><td class='report_subheader'><b><a href='#'>Diagnosis</a></b></td></tr>
<tr><td class='report_tbltext'><ul><li>F41.1 - Generalized anxiety disorder</li></ul></td></tr>
<tr><td class='report_subheader'><b><a href='#'>Plan / Visit Codes</a></b></td></tr>
<tr><td class='report_tbltext'><ul><li>Visit Codes: H0038 - Peer Support</li></ul></td></tr>
<ul><li><b>Treatment Plan</b><ul><li><b>Anxiety</b> (Last Review Date: 01/01/2026)</li></ul></li></ul>
<div>Electronically Signed by Chaim Paneth on 07/21/2026</div>
<div>Provider NPI 1111111111</div>
</body></html>`;

const engine = new InsyncCoSignEngine({ username: 'x', password: 'x', anthropicKey: 'x' });
const parsed = engine._parseNote(HTML, { eid: '1', pid: '1', visitDatetime: '08/10/2026 9:00 AM' });

test('9. Structured text puts every real heading on its own line', () => {
  const lines = htmlToStructuredText(HTML).split('\n');
  for (const h of ['Diagnosis', 'Treatment Plan']) {
    assert.ok(lines.some(l => l.trim() === h), `"${h}" should own a line; got ${JSON.stringify(lines.slice(0, 40))}`);
  }
  // …while the narrative — including its embedded "Plan:" — stays on one line.
  assert.ok(lines.some(l => l.includes('The client stated: Plan: continue')), 'narrative must not be split');
});

test('10. Flat text is exactly the structured text with whitespace collapsed', () => {
  assert.strictEqual(parsed.fullNoteText, parsed.structuredText.replace(/\s+/g, ' ').trim());
});

test('11. Mid-line "Plan:" in narrative is not a boundary (the follow-up case)', () => {
  const secs = splitSections(parsed.structuredText);
  assert.strictEqual(secs.response, NARRATIVE, `response was: ${JSON.stringify(secs.response)}`);
  assert.ok(/Plan: continue using the checklist/.test(secs.response), 'the embedded "Plan:" must survive');
  assert.strictEqual(secs.plan, 'Continue the routine work.', `plan was: ${JSON.stringify(secs.plan)}`);
});

test('12. Section values stay normalized — no line breaks leak out', () => {
  const secs = splitSections(parsed.structuredText);
  for (const [k, v] of Object.entries(secs)) assert.ok(!/[\n\r]/.test(v), `${k} contains a line break`);
  for (const v of [parsed.diagnosis, parsed.treatmentPlan, parsed.sessionContent, parsed.visitCodes])
    assert.ok(!/[\n\r]/.test(v), 'parsed field contains a line break');
});

test('13. Diagnosis / Treatment Plan boundaries hold through the HTML pipeline', () => {
  assert.strictEqual(parsed.diagnosis, 'F41.1 - Generalized anxiety disorder', `diagnosis: ${JSON.stringify(parsed.diagnosis)}`);
  assert.ok(!/Visit Codes/i.test(parsed.diagnosis), 'diagnosis must not absorb Visit Codes');
  assert.ok(parsed.treatmentPlan.startsWith('Problem: Anxiety'), `treatment plan: ${JSON.stringify(parsed.treatmentPlan)}`);
  assert.ok(!/Electronically Signed|Provider NPI/i.test(parsed.treatmentPlan), 'treatment plan must not absorb the footer');
  assert.ok(!/Diagnosis/i.test(splitSections(parsed.structuredText).plan), 'plan must not contain "Diagnosis"');
});

test('14. On an ordinary note, structured and flat parses agree', () => {
  // The safety property behind this change: for notes that look like real ones,
  // parsing from structure yields exactly what parsing flat text yielded — so
  // the ~1,000 notes stored before this change stay comparable to new ones.
  // (Verified the same way against six live InSync notes.)
  const plain = HTML.replace(NARRATIVE, 'He engaged well and practised the breathing exercise.');
  const p = engine._parseNote(plain, { eid: '2', pid: '1', visitDatetime: '08/10/2026 9:00 AM' });
  const A = splitSections(p.structuredText), B = splitSections(p.fullNoteText);
  for (const k of Object.keys(A)) assert.strictEqual(A[k], B[k], `${k} differs between structured and flat`);
  assert.strictEqual(sectionByLabel(p.structuredText, 'Diagnosis'), sectionByLabel(p.fullNoteText, 'Diagnosis'));
  assert.strictEqual(sectionByLabel(p.structuredText, 'Treatment Plan'), sectionByLabel(p.fullNoteText, 'Treatment Plan'));
});

test('15. Where they differ, structure is the correct one', () => {
  // This is the whole reason for the follow-up. Flat text has to guess from
  // capitalisation, so an embedded "Plan:" truncates the section; structure
  // knows it is mid-line and keeps going. If someone reverts to flat-only
  // parsing, this test fails.
  const fromStructure = splitSections(parsed.structuredText).response;
  const fromFlat      = splitSections(parsed.fullNoteText).response;
  assert.strictEqual(fromStructure, NARRATIVE, 'structure must keep the whole sentence');
  assert.ok(fromFlat.length < fromStructure.length, 'the flat heuristic truncates here — that is the bug being hardened against');
});

// ─────────────────────────────────────────────────────────────────────────────
// THE QUESTION-MARK HEADING
//
// InSync writes the activities label as a literal question and terminates it
// with "?", never a colon:
//
//   What activities took place, and for how long?</span></label>
//
// findHeadings only ever accepted ":" (or, for colonless labels, end-of-line),
// so this heading was never detected. The section was not lost — with no
// boundary, "Focus of the meeting" ran straight through it to the next
// recognised heading and swallowed the entire timed narrative. Every review
// payload ever built therefore carried a bloated focus and
// activities_and_duration: "" — 2,271 of 2,273 stored notes.
//
// The tests above never caught it because they all wrote the heading with a
// colon, a shape InSync does not produce. These use the real one.
// ─────────────────────────────────────────────────────────────────────────────

// A note in the shape InSync actually emits, de-identified. Line breaks fall
// where the block tags are, so this is what htmlToStructuredText produces; the
// flat form every pre-refactor note was stored as is the same string with its
// whitespace collapsed, which is exactly what _parseNote used to do.
const ACTIVITIES_NARRATIVE = '15 Minutes: The visit started with the client describing a difficult morning. '
  + '45 Minutes: We practised a grounding exercise and rehearsed it twice. '
  + "60 Minutes: We reviewed the week's schedule and set one target for the coming week.";

const REAL_SHAPE = [
  'Patient Details',
  'Name: Test Client',
  'Note of Session',
  'Persons Present: Peer and client',
  'Location of the Meeting: 1 Example St, Monroe NY 10950',
  'Focus of the meeting: *',
  'Building confidence using coping skills before anxiety becomes overwhelming.',
  'What activities took place, and for how long?',
  '15 Minutes:',
  'The visit started with the client describing a difficult morning.',
  '45 Minutes:',
  'We practised a grounding exercise and rehearsed it twice.',
  '60 Minutes:',
  "We reviewed the week's schedule and set one target for the coming week.",
  'Peer Support Interventions: *',
  'Active Listening, Goal Setting',
  "Patient's Response/Content: *",
  'The client engaged well and asked to repeat the grounding exercise.',
  'Plan: *',
  'Continue practising the grounding exercise daily.',
  'Diagnosis',
  'F41.1 - Generalized anxiety disorder',
  'Treatment Plan',
  'Problem: Anxiety (Last Review Date: 01/01/2026)',
  'Electronically Signed',
  'by Test Peer',
].join('\n');

const REAL_SHAPE_FLAT = REAL_SHAPE.replace(/\s+/g, ' ');

// The note object the pipeline passes around. sectionSource() prefers
// structuredText, then fullNoteText, then noteText.
const noteWith = extra => ({
  eid: 'TEST', visitDate: '07/21/2026', encounterType: 'Peer Support - Telehealth with video',
  totalTime: '2 hr 0 min', diagnosis: 'F41.1 - Generalized anxiety disorder', ...extra,
});
const activitiesOf = note => buildReviewPayload(note).note_sections.activities_and_duration;

// ── A. Initial ingest ────────────────────────────────────────────────────────
test('A. Initial ingest: real InSync HTML -> payload carries the full narrative', () => {
  const html = '<table><tr><td><b>Focus of the meeting:</b> * Building confidence using coping skills.</td></tr>'
    + '<tr><td><label><span>What activities took place, and for how long?</span></label></td></tr>'
    + '<tr><td><span>15 Minutes:</span></td></tr><tr><td><span>The visit started with the client describing a difficult morning.</span></td></tr>'
    + '<tr><td><span>45 Minutes:</span></td></tr><tr><td><span>We practised a grounding exercise and rehearsed it twice.</span></td></tr>'
    + '<tr><td><b>Peer Support Interventions:</b> Active Listening</td></tr></table>';
  const structured = htmlToStructuredText(html);
  assert.ok(/for how long\?/.test(structured), 'the "?" must survive into structuredText');

  const acts = activitiesOf(noteWith({ structuredText: structured }));
  assert.ok(acts.includes('15 Minutes'), 'activities lost the first block: ' + JSON.stringify(acts));
  assert.ok(acts.includes('45 Minutes'), 'activities lost the second block: ' + JSON.stringify(acts));
  assert.ok(acts.includes('rehearsed it twice'), 'activities lost its final sentence');
});

// ── B. Save + reload ─────────────────────────────────────────────────────────
test('B. Save + reload: same value after a jsonb round-trip', () => {
  const note = noteWith({ structuredText: REAL_SHAPE });
  const before = activitiesOf(note);
  // note_data is a jsonb column, so a reload is exactly a JSON round-trip.
  const reloaded = JSON.parse(JSON.stringify(note));
  assert.strictEqual(activitiesOf(reloaded), before);
  assert.strictEqual(before, ACTIVITIES_NARRATIVE);
});

// ── C. Rejudge ───────────────────────────────────────────────────────────────
test('C. Rejudge: rebuilding from the stored note gives the same value', () => {
  const stored = JSON.parse(JSON.stringify(noteWith({ structuredText: REAL_SHAPE })));
  assert.strictEqual(activitiesOf(stored), ACTIVITIES_NARRATIVE);
  assert.strictEqual(activitiesOf(stored), activitiesOf(stored), 'must be deterministic');
});

// ── D. Legacy stored note, no structuredText ─────────────────────────────────
test('D. Legacy note (fullNoteText only, flat) still populates activities', () => {
  const note = noteWith({ fullNoteText: REAL_SHAPE_FLAT });
  assert.ok(!note.structuredText, 'fixture must exercise the flat fallback');
  assert.strictEqual(sectionSource(note), REAL_SHAPE_FLAT);
  assert.strictEqual(activitiesOf(note), ACTIVITIES_NARRATIVE);
});

// ── E. Fresh note with structuredText ────────────────────────────────────────
test('E. Structured note populates activities', () => {
  assert.strictEqual(activitiesOf(noteWith({ structuredText: REAL_SHAPE })), ACTIVITIES_NARRATIVE);
});

// ── F. Stale stored value must not win ───────────────────────────────────────
test('F. A stale empty stored field never overrides the derived section', () => {
  // Sections are re-derived from text on every call — nothing reads a stored
  // section field. These decoys must be ignored entirely.
  const note = noteWith({
    structuredText: REAL_SHAPE,
    activities: '', activities_and_duration: '', session_activities: '', activitiesAndDuration: '',
    note_sections: { activities_and_duration: '' },
  });
  assert.strictEqual(activitiesOf(note), ACTIVITIES_NARRATIVE);
});

// ── G. Two real note shapes that produced "" ─────────────────────────────────
// De-identified, but the structure — heading punctuation, the "* " required
// marker, the run-on flat text — is verbatim from the stored rows.
test('G1. Real shape: eid 985486 (flat, "First Hour:" / "Second Hour:")', () => {
  const flat = 'Persons Present: Peer and client Location of the Meeting: 1 Example St, Monroe NY 10950 '
    + 'Focus of the meeting: * Helping the client notice a strong reaction earlier than before. '
    + 'What activities took place, and for how long? First Hour: The client described situations where he '
    + 'noticed a strong reaction starting and caught it earlier than before. Second Hour: We focused on what '
    + 'those higher-pressure moments have in common and rehearsed one response. '
    + "Peer Support Interventions: * Active Listening Patient's Response/Content: * He engaged throughout. "
    + 'Plan: * Continue noticing early signs. Diagnosis F90.2 - Attention-deficit hyperactivity disorder';
  const secs = splitSections(flat);
  assert.ok(secs.activities.startsWith('First Hour:'), 'activities was: ' + JSON.stringify(secs.activities));
  assert.ok(secs.activities.includes('Second Hour:'), 'activities lost the second hour');
  assert.strictEqual(secs.focus, 'Helping the client notice a strong reaction earlier than before.');
  assert.ok(!/What activities took place/.test(secs.focus), 'focus must not swallow the activities heading');
});

test('G2. Real shape: eid 985968 (flat, "The first 15 minutes...")', () => {
  const flat = 'Focus of the meeting: * The PSS met with the client and his parent for a session focused on '
    + 'strengthening consistent routines. What activities took place, and for how long? The first 15 minutes '
    + 'were spent checking in regarding progress since the previous session. The next 30 minutes focused on '
    + 'rehearsing one routine together. Peer Support Interventions: * Goal Setting '
    + "Patient's Response/Content: * The parent reported the routine felt manageable. Plan: * Continue the routine.";
  const secs = splitSections(flat);
  assert.ok(secs.activities.startsWith('The first 15 minutes'), 'activities was: ' + JSON.stringify(secs.activities));
  assert.ok(secs.activities.includes('The next 30 minutes'), 'activities lost the second block');
  assert.ok(!/What activities took place/.test(secs.focus), 'focus must not swallow the activities heading');
});

// ── The swallow regression, stated directly ──────────────────────────────────
test('H. Focus ends at the activities heading and does not absorb it', () => {
  for (const pair of [['structured', REAL_SHAPE], ['flat', REAL_SHAPE_FLAT]]) {
    const secs = splitSections(pair[1]);
    assert.strictEqual(secs.focus, 'Building confidence using coping skills before anxiety becomes overwhelming.',
      'focus wrong in ' + pair[0] + ': ' + JSON.stringify(secs.focus));
    assert.ok(!secs.focus.includes('Minutes'), 'focus swallowed activities in ' + pair[0]);
  }
});

test('I. Structured and flat agree on all five sections for the real shape', () => {
  const A = splitSections(REAL_SHAPE), B = splitSections(REAL_SHAPE_FLAT);
  for (const k of Object.keys(A)) {
    assert.ok(A[k], k + ' is empty in structured');
    assert.strictEqual(A[k], B[k], k + ' differs between structured and flat');
  }
});

test('J. The "?" terminator is scoped — narrative questions are not headings', () => {
  // If "?" were accepted for every label, this would split a Plan section out of
  // ordinary prose.
  const text = 'Focus of the meeting: He asked what was the plan? and then answered his own question. '
    + 'What activities took place, and for how long? We talked it through for 30 minutes. '
    + 'Peer Support Interventions: Active Listening';
  const secs = splitSections(text);
  assert.ok(secs.focus.includes('what was the plan?'), 'a narrative question must stay inside its section');
  assert.strictEqual(secs.plan, '', 'a narrative "plan?" must not become the Plan section');
  assert.strictEqual(secs.activities, 'We talked it through for 30 minutes.');
});

// ── Repeated heading ("Plan: *" then "Plan:" then the content) ───────────────
test('K. A repeated label does not collapse its section to empty', () => {
  const structured = [
    'Focus of the meeting: *',
    'Focus of the meeting:',
    'Helping him remember to use the strategy in the moment.',
    'What activities took place, and for how long?',
    'We rehearsed the strategy for 40 minutes.',
    "Patient's Response/Content: *",
    'He followed through.',
    'Plan: *',
    'Plan:',
    'He will practise keeping his original answer.',
  ].join('\n');
  const secs = splitSections(structured);
  assert.strictEqual(secs.focus, 'Helping him remember to use the strategy in the moment.');
  assert.strictEqual(secs.plan, 'He will practise keeping his original answer.');
  assert.strictEqual(secs.activities, 'We rehearsed the strategy for 40 minutes.');
});

// ── The guard itself ─────────────────────────────────────────────────────────
test('L. assertSectionsDerived throws on a blank-but-present section under test', () => {
  assert.strictEqual(process.env.NODE_ENV, 'test', 'run this suite with NODE_ENV=test');
  assert.throws(
    () => assertSectionsDerived({ eid: 'X' }, REAL_SHAPE,
      { focus: 'x', activities: '', interventions: 'x', response: 'x', plan: 'x' }),
    /activities .* is empty, but the note continues/s,
    'the guard must refuse to let an empty activities field through');
});

test('M. assertSectionsDerived stays quiet for a genuinely absent section', () => {
  // No Plan heading at all — "Plan / Visit Codes" and "Treatment Plan" contain
  // the word but are not the narrative Plan section.
  const text = 'Focus of the meeting: Building routine and reviewing the week together carefully. '
    + 'What activities took place, and for how long? We reviewed the schedule for 45 minutes together. '
    + 'Diagnosis F41.1 - Generalized anxiety disorder Plan / Visit Codes Visit Codes: H0038 - Peer Support - 15 min '
    + 'Treatment Plan Problem: Anxiety (Last Review Date: 01/01/2026)';
  assert.doesNotThrow(() => buildReviewPayload({ eid: 'Y', fullNoteText: text }));
});

// ── The payload is what the model receives ───────────────────────────────────
test('N. The full payload sent to the model has every section populated', () => {
  const payload = buildReviewPayload(noteWith({ structuredText: REAL_SHAPE }));
  const s = payload.note_sections;
  assert.strictEqual(s.activities_and_duration, ACTIVITIES_NARRATIVE);
  assert.strictEqual(s.focus, 'Building confidence using coping skills before anxiety becomes overwhelming.');
  assert.strictEqual(s.peer_interventions, 'Active Listening, Goal Setting');
  assert.strictEqual(s.patient_response, 'The client engaged well and asked to repeat the grounding exercise.');
  assert.strictEqual(s.plan, 'Continue practising the grounding exercise daily.');
  for (const k of Object.keys(s)) assert.ok(s[k], 'payload field ' + k + ' is empty');
  // This is the JSON.stringify(payload) that becomes the user message.
  assert.ok(JSON.stringify(payload).includes('60 Minutes'), 'the serialised payload lost part of the narrative');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

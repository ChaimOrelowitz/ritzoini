// Verification harness for PS CO-SIGN REVIEW V2 (plan Step 18, sections D-F, H-J).
// Makes REAL Claude calls — deliberately a small, fixed number, printed at the end.
// Every call goes through engine.aiReview, which is the only place the engine's
// aiCallCount increments, so the totals below are exact.
require('dotenv').config();
const supabase = require('../db/supabase');
const { InsyncCoSignEngine, OFFSITE_RATIONALE_FROM } = require('../utils/peerSupervisorEngine');
const { judgeNote } = require('../utils/psIngest');

const line = t => console.log(`\n=== ${t} ===`);
const show = (label, r) => {
  const o = r?.offsite_review || {};
  console.log(`  ${label}`);
  console.log(`    decision=${r?.decision}  confidence=${r?.confidence}`);
  console.log(`    offsite: applicable=${o.applicable} type=${o.service_type} status=${o.status} rationale=${o.rationale_status}`);
  console.log(`    narrative=${r?.narrative_goal_alignment?.status}  dx=${r?.diagnosis_problem_alignment?.status}`);
  console.log(`    intervention=${r?.intervention_response_review?.intervention_status}  response=${r?.intervention_response_review?.response_status}`);
  console.log(`    issues=${(r?.issues || []).length}  summary=${(r?.review_summary || '').slice(0, 140)}`);
  if (r?.usage) console.log(`    tokens: in=${r.usage.input_tokens} out=${r.usage.output_tokens} cache_write=${r.usage.cache_creation_input_tokens} cache_read=${r.usage.cache_read_input_tokens}`);
  if (r?.error) console.log(`    ERROR: ${r.error}`);
};

// Swap a note's visit date (both display and ISO paths) without touching text.
function withDate(note, mmddyyyy) {
  return { ...note, visitDate: mmddyyyy, visitDatetime: `${mmddyyyy} 10:00 AM` };
}
// Rewrite one narrative section in the full note text.
function withSection(note, heading, replacement) {
  const re = new RegExp(`(${heading}\\s*[:?\\-]\\s*)([\\s\\S]*?)(?=(Focus of the meeting|What activities took place|Peer Support Interventions|Patient's Response/Content|Plan\\s*:|Diagnosis|Treatment Plan))`, 'i');
  return { ...note, fullNoteText: note.fullNoteText.replace(re, `$1${replacement} `) };
}

(async () => {
  const engine = new InsyncCoSignEngine({ anthropicKey: process.env.ANTHROPIC_API_KEY });
  console.log(`System prompt: ${engine.systemPrompt().length} chars (static, cached)`);
  console.log(`Off-site rule effective from: ${OFFSITE_RATIONALE_FROM}`);

  const { data } = await supabase.from('ps_notes')
    .select('eid, mrn, patient_name, visit_date, note_data')
    .order('visit_date', { ascending: false }).limit(200);
  const rows = (data || []).filter(r => r.note_data?.fullNoteText);

  // An off-site, in-person note to use as the realistic base.
  const baseRow = rows.find(r => /outside the clinic/i.test(r.note_data.encounterType || ''));
  const base = { ...baseRow.note_data, eid: baseRow.eid, mrn: baseRow.mrn };
  console.log(`Base note eid=${base.eid} date=${base.visitDate} type="${(base.encounterType || '').slice(0, 70)}"`);

  // ── D. Date cutoff ─────────────────────────────────────────────────────────
  line('D. DATE CUTOFF');
  const pre  = await engine.aiReview(withDate(base, '07/27/2026'));
  show('off-site note dated 07/27/2026 (day before the rule)', pre);
  console.log(`    EXPECT applicable=false / NOT_APPLICABLE -> ${pre?.offsite_review?.applicable === false || pre?.offsite_review?.status === 'NOT_APPLICABLE' ? 'PASS' : 'CHECK'}`);

  const post = await engine.aiReview(withDate(base, '07/28/2026'));
  show('same note dated 07/28/2026 (rule in force)', post);
  console.log(`    EXPECT applicable=true, service_type=OFFSITE -> ${post?.offsite_review?.applicable === true && post?.offsite_review?.service_type === 'OFFSITE' ? 'PASS' : 'CHECK'}`);

  // Telehealth narrative but billed as off-site.
  const teleNarrative = withSection(
    withDate(base, '07/28/2026'),
    'Focus of the meeting',
    'The peer contacted the client by telephone for this session. No in-person contact occurred; the entire session was conducted over the phone while the client remained at home.');
  const tele = await engine.aiReview(teleNarrative);
  show('billed off-site, narrative describes a phone call', tele);
  console.log(`    EXPECT DO_NOT_BILL or SUPERVISOR_REVIEW -> ${['DO_NOT_BILL', 'SUPERVISOR_REVIEW'].includes(tele?.decision) ? 'PASS' : 'CHECK'}`);

  // A properly coded telehealth note.
  const teleRow = rows.find(r => /telehealth/i.test(r.note_data.encounterType || ''));
  if (teleRow) {
    const t = await engine.aiReview(withDate({ ...teleRow.note_data, eid: teleRow.eid, mrn: teleRow.mrn }, '07/28/2026'));
    show('properly coded telehealth note dated 07/28/2026', t);
    console.log(`    EXPECT off-site NOT_APPLICABLE -> ${t?.offsite_review?.status === 'NOT_APPLICABLE' ? 'PASS' : 'CHECK'}`);
  }

  // ── E. Unsupported diagnostic language ─────────────────────────────────────
  line('E. DIAGNOSIS / PROBLEM ALIGNMENT');
  const adhd = withSection(withDate(base, '07/28/2026'), 'Focus of the meeting',
    "Today's meeting focused on working on the client's ADHD, which is the primary condition driving his difficulties.");
  const adhdR = await engine.aiReview(adhd);
  show('peer writes "the client\'s ADHD" (check against the note\'s documented dx)', adhdR);
  console.log(`    EXPECT REOPEN_TO_PEER when ADHD is not a documented dx -> ${adhdR?.decision === 'REOPEN_TO_PEER' ? 'PASS' : 'CHECK — confirm the base note\'s diagnoses'}`);

  // ── F. Vague intervention ──────────────────────────────────────────────────
  line('F. INTERVENTION / RESPONSE');
  const vague = withSection(
    withSection(withDate(base, '07/28/2026'), 'Peer Support Interventions', 'Provided support.'),
    "Patient's Response/Content", 'Client was receptive.');
  const vagueR = await engine.aiReview(vague);
  show('intervention = "Provided support.", response = "Client was receptive."', vagueR);
  console.log(`    EXPECT REOPEN_TO_PEER + intervention NEEDS_REVISION -> ${vagueR?.decision === 'REOPEN_TO_PEER' && vagueR?.intervention_response_review?.intervention_status === 'NEEDS_REVISION' ? 'PASS' : 'CHECK'}`);

  // ── H. Fingerprint reuse (no AI calls) ─────────────────────────────────────
  line('H. FINGERPRINT REUSE (expects ZERO new AI calls)');
  const before = engine.aiCallCount;
  const fpA = engine.fingerprintFor(base);
  const fpSame = engine.fingerprintFor({ ...base });
  const fpVolatile = engine.fingerprintFor({ ...base, ingestedAt: new Date().toISOString(), judged_at: Date.now() });
  const fpChanged = engine.fingerprintFor(withSection(base, 'Peer Support Interventions', 'Something materially different happened.'));
  console.log(`  identical note      -> ${fpA === fpSame ? 'PASS (same fingerprint)' : 'FAIL'}`);
  console.log(`  volatile fields only-> ${fpA === fpVolatile ? 'PASS (same fingerprint)' : 'FAIL'}`);
  console.log(`  narrative changed   -> ${fpA !== fpChanged ? 'PASS (new fingerprint)' : 'FAIL'}`);

  const fakeCorpus = [];
  const priorReview = { fingerprint: fpA, decision: 'PASS', review_summary: 'stored', offsite_review: {} };
  const reuse = await judgeNote(engine, base, fakeCorpus, { priorReview });
  console.log(`  judgeNote with a matching stored review -> aiCalled=${reuse.aiCalled} reused=${!!reuse.flags.review?.reused} ${reuse.aiCalled === false ? 'PASS' : 'FAIL'}`);
  const changedNote = withSection(base, 'Peer Support Interventions', 'Something materially different happened this session.');
  const fresh = await judgeNote(engine, changedNote, fakeCorpus, { priorReview });
  console.log(`  judgeNote after a content change        -> aiCalled=${fresh.aiCalled} ${fresh.aiCalled === true ? 'PASS' : 'FAIL'}`);
  console.log(`  AI calls added by the reuse test: ${engine.aiCallCount - before} (1 expected — the changed note only)`);

  // ── I / J. Caching + call count ────────────────────────────────────────────
  line('I / J. CACHE + CALL COUNT');
  console.log(`  Total AI calls this run: ${engine.aiCallCount}`);
  console.log('  Cache read tokens are printed per call above; calls 2+ should be non-zero.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

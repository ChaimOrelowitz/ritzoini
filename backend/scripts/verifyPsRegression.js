// Regression suite for the PS Co-Sign Review V2 corrections (tests 7-17).
// Real Claude calls, one per scenario. Every scenario asserts what the corrected
// prompts must and must NOT flag.
require('dotenv').config();
const supabase = require('../db/supabase');
const { InsyncCoSignEngine } = require('../utils/peerSupervisorEngine');

const ok = (cond, label) => console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);

function summarise(r) {
  const o = r?.offsite_review || {};
  return {
    decision: r?.decision,
    dx: r?.diagnosis_problem_alignment?.status,
    narrative: r?.narrative_goal_alignment?.status,
    intervention: r?.intervention_response_review?.intervention_status,
    response: r?.intervention_response_review?.response_status,
    offsiteStatus: o.status, offsiteApplicable: o.applicable, rationale: o.rationale_status,
    issues: (r?.issues || []).length,
    msg: (r?.reopen_message_to_peer || '').slice(0, 220),
  };
}
const show = s => {
  console.log(`    decision=${s.decision} dx=${s.dx} narrative=${s.narrative} intervention=${s.intervention} response=${s.response}`);
  console.log(`    offsite: applicable=${s.offsiteApplicable} status=${s.offsiteStatus} rationale=${s.rationale} issues=${s.issues}`);
  if (s.msg) console.log(`    reopen: ${s.msg}`);
};

// True when the reopen message / issues talk about anything other than off-site.
function mentionsNonOffsite(r) {
  const sources = (r.issues || []).map(i => `${i.source || ''}`.toUpperCase());
  return sources.some(x => x && x !== 'OFFSITE');
}

const load = async (eid) => {
  const { data } = await supabase.from('ps_notes')
    .select('eid, mrn, patient_name, visit_date, note_data').eq('eid', eid).limit(1).maybeSingle();
  return data ? { ...data.note_data, eid: data.eid, mrn: data.mrn } : null;
};

// Replace one narrative section in the raw note text.
function withSection(note, heading, replacement) {
  const re = new RegExp(`(${heading}\\s*[:?\\-]\\s*)([\\s\\S]*?)(?=(Focus of the meeting|What activities took place|Peer Support Interventions|Patient's Response/Content|Plan\\s*:|Diagnosis|Treatment Plan))`, 'i');
  return { ...note, fullNoteText: note.fullNoteText.replace(re, `$1${replacement} `) };
}
const withDate = (note, d) => ({ ...note, visitDate: d, visitDatetime: `${d} 10:00 AM` });

(async () => {
  const engine = new InsyncCoSignEngine({ anthropicKey: process.env.ANTHROPIC_API_KEY });
  console.log(`System prompt: ${engine.systemPrompt().length} chars\n`);

  // ── 15. Nathan Mayer 07/30/2026 ────────────────────────────────────────────
  console.log('=== 15. NATHAN MAYER 07/30/2026 (expect REOPEN_TO_PEER, off-site rationale only) ===');
  const nathan = await load('994172');
  const rN = await engine.aiReview(nathan);
  const sN = summarise(rN); show(sN);
  ok(sN.decision === 'REOPEN_TO_PEER', 'decision is REOPEN_TO_PEER');
  ok(sN.dx !== 'UNSUPPORTED_DIAGNOSTIC_LANGUAGE', 'no unsupported diagnostic language');
  ok(sN.decision !== 'SUPERVISOR_REVIEW', 'not escalated to SUPERVISOR_REVIEW');
  ok(['ALIGNED', 'PLAUSIBLY_RELATED'].includes(sN.dx), `dx alignment acceptable (${sN.dx})`);
  ok(!mentionsNonOffsite(rN), 'the only issue raised is off-site');

  // ── 16. Mayer Weinstock 07/31/2026 ─────────────────────────────────────────
  console.log('\n=== 16. MAYER WEINSTOCK 07/31/2026 (expect REOPEN_TO_PEER, off-site rationale only) ===');
  const weinstock = await load('994901');
  const rW = await engine.aiReview(weinstock);
  const sW = summarise(rW); show(sW);
  ok(sW.decision === 'REOPEN_TO_PEER', 'decision is REOPEN_TO_PEER');
  ok(sW.intervention === 'SUFFICIENT', 'intervention SUFFICIENT');
  ok(!/progress statement|progress note|separate progress/i.test(rW.reopen_message_to_peer || ''), 'no missing-progress-statement demand');
  ok(sW.rationale === 'MISSING' || sW.rationale === 'PRESENT_TOO_GENERAL', 'off-site rationale is the gap');
  ok(!mentionsNonOffsite(rW), 'the only issue raised is off-site');

  // ── 17. Zalman Silber 07/08/2026 ───────────────────────────────────────────
  console.log('\n=== 17. ZALMAN SILBER 07/08/2026 (expect PASS — pre-cutoff) ===');
  const zalman = await load('979864');
  const rZ = await engine.aiReview(zalman);
  const sZ = summarise(rZ); show(sZ);
  ok(sZ.decision === 'PASS', 'decision is PASS');
  ok(sZ.intervention === 'SUFFICIENT', 'intervention SUFFICIENT (labels + surrounding narrative)');
  ok(sZ.offsiteApplicable === false || sZ.offsiteStatus === 'NOT_APPLICABLE', 'off-site rule not applied before the cutoff');

  // ── 7 / 8. Functional language vs an explicit diagnosis claim ──────────────
  console.log('\n=== 7. FUNCTIONAL FOCUS LANGUAGE WITH GAD (expect no unsupported-dx flag) ===');
  const functional = withSection(withDate(nathan, '07/20/2026'), 'Focus of the meeting',
    'The client had difficulty maintaining focus and became distracted during longer tasks. The session focused on task completion and planning; the peer helped the client break tasks into smaller steps and the client used reminders to remain attentive.');
  const rF = await engine.aiReview(functional);
  const sF = summarise(rF); show(sF);
  ok(sF.dx !== 'UNSUPPORTED_DIAGNOSTIC_LANGUAGE', 'functional focus language is NOT unsupported diagnostic language');

  console.log('\n=== 8. EXPLICIT "the client\'s ADHD" (expect unsupported-dx flag) ===');
  const explicitDx = withSection(withDate(nathan, '07/20/2026'), 'Focus of the meeting',
    "The client has ADHD. The client's ADHD caused the distraction, and due to his ADHD the client could not complete the task. We worked on treating his ADHD.");
  const rE = await engine.aiReview(explicitDx);
  const sE = summarise(rE); show(sE);
  ok(sE.dx === 'UNSUPPORTED_DIAGNOSTIC_LANGUAGE', 'explicit undocumented diagnosis IS flagged');

  // ── 9. Treatment-plan heading alone ────────────────────────────────────────
  console.log('\n=== 9. TP HEADING "ADHD" ALONE (expect no SUPERVISOR_REVIEW) ===');
  const tpHeading = { ...withDate(nathan, '07/20/2026') };
  tpHeading.treatmentPlan = 'Problem: Attention Deficit/Hyperactivity (mental health disorder - adult) (Last Review Date: 06/24/2026, Next Review Date: 08/23/2026) '
    + 'Long Term Goal(s) 1: Client will improve attention, organization, and task completion in daily responsibilities. '
    + 'Short Term Goal(s) 1: Client will review real-life challenges related to focus and follow-through with the Peer Support Specialist. '
    + 'Intervention(s) 1: Peer Support';
  tpHeading.diagnosis = 'F41.1 - Generalized anxiety disorder';
  const rT = await engine.aiReview(tpHeading);
  const sT = summarise(rT); show(sT);
  ok(sT.decision !== 'SUPERVISOR_REVIEW', 'a functional TP heading alone does not escalate');
  ok(sT.dx !== 'TREATMENT_PLAN_MISMATCH', 'no TREATMENT_PLAN_MISMATCH from the heading wording');

  // ── 10 / 11 / 12. Intervention read across the note; progress; null field ───
  console.log('\n=== 10-12. WHOLE-NOTE INTERVENTION + PROGRESS (expect SUFFICIENT, no progress demand) ===');
  const labelsOnly = withSection(withDate(zalman, '07/08/2026'), 'Peer Support Interventions',
    'Active Listening, Strengths-Based Approach, Coping Skills.');
  const rI = await engine.aiReview(labelsOnly);
  const sI = summarise(rI); show(sI);
  ok(sI.intervention === 'SUFFICIENT', 'bare labels + descriptive activities = SUFFICIENT');
  ok(!/progress statement/i.test(rI.reopen_message_to_peer || ''), 'progress_statement: null raises no issue');

  // ── 13 / 14. Setting-dependent activity vs an explicit rationale ────────────
  console.log('\n=== 13. USEFUL GARDEN ACTIVITY, NO EXPLICIT REASON (expect rationale still MISSING) ===');
  const garden = withSection(withDate(nathan, '07/30/2026'), 'Focus of the meeting',
    'The session took place in the community garden. Working outdoors in the garden was a great fit for this activity and the natural environment worked well for the client.');
  const rG = await engine.aiReview(garden);
  const sG = summarise(rG); show(sG);
  ok(['MISSING', 'PRESENT_TOO_GENERAL', 'UNSUPPORTED'].includes(sG.rationale), 'a setting-suited activity is NOT an off-site rationale');

  console.log('\n=== 14. EXPLICIT INDIVIDUALISED REASON (expect rationale accepted) ===');
  const explicit = withSection(withDate(nathan, '07/30/2026'), 'Focus of the meeting',
    'Because the client\'s severe anxiety symptoms have prevented him from entering the clinic building for the past three weeks — he has left two scheduled clinic appointments before check-in — meeting at his home was necessary to deliver the planned coping-skills practice, which could not be provided at the clinic while he is unable to attend. The session addressed task planning and follow-through.');
  const rX = await engine.aiReview(explicit);
  const sX = summarise(rX); show(sX);
  ok(sX.rationale === 'PRESENT_SUFFICIENT', 'an explicit individualised reason IS accepted');

  console.log(`\n=== AI CALL COUNT ===\n  Total AI calls: ${engine.aiCallCount} (one per scenario; duplicate detection contributed 0)`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

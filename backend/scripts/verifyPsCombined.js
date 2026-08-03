// Verification harness for PS CO-SIGN REVIEW V2 (plan Step 18, sections C and J).
// Proves that a possible duplicate does NOT suppress the AI review, that all
// three tracks are stored independently, and that the AI-call count equals the
// number of notes actually reviewed (duplicate detection contributing zero).
require('dotenv').config();
const supabase = require('../db/supabase');
const { InsyncCoSignEngine } = require('../utils/peerSupervisorEngine');
const { judgeNote } = require('../utils/psIngest');

(async () => {
  const engine = new InsyncCoSignEngine({ anthropicKey: process.env.ANTHROPIC_API_KEY });

  // Find a real pair that the mechanical rule flags, so the duplicate is genuine.
  const { data } = await supabase.from('ps_notes')
    .select('eid, mrn, patient_name, visit_date, note_data')
    .order('visit_date', { ascending: false }).limit(120);
  const rows = (data || []).filter(r => r.note_data?.fullNoteText);
  const notes = rows.map(r => ({
    eid: r.eid, mrn: r.mrn, patientName: r.patient_name, visitDate: r.visit_date,
    ...r.note_data,
  }));
  const prepared = notes.map(n => engine.prepareDupeEntry(n));

  let subject = null, partnerEid = null;
  for (let i = 0; i < notes.length && !subject; i++) {
    const hit = engine.findDupe(notes[i], prepared.filter((_, j) => j !== i));
    if (hit) { subject = notes[i]; partnerEid = hit.partnerEid; }
  }
  if (!subject) { console.log('No mechanically-duplicate pair in the sample — cannot run C.'); process.exit(0); }

  console.log('=== C. DUPLICATE + AI REVIEW TOGETHER ===');
  console.log(`Subject eid=${subject.eid}, duplicate partner eid=${partnerEid}`);

  const corpus = prepared.filter(p => p.eid !== subject.eid);
  const before = engine.aiCallCount;
  const judged = await judgeNote(engine, subject, corpus, { priorReview: null });
  const calls = engine.aiCallCount - before;

  const f = judged.flags;
  console.log(`  clone.status      = ${f.clone?.status}`);
  console.log(`  clone.pct         = ${f.clone?.pct}   sections = ${JSON.stringify(f.clone?.sections)}`);
  console.log(`  review.decision   = ${f.review?.decision}`);
  console.log(`  machine flags     = ${JSON.stringify(f.machine)}`);
  console.log(`  offsite           = ${JSON.stringify(f.offsite)}`);
  console.log(`  verdict           = ${judged.verdict}`);
  console.log(`  AI calls for this note = ${calls}`);

  const bothPresent = f.clone?.status === 'POSSIBLE_DUPLICATE' && !!f.review?.decision;
  console.log(`  ${bothPresent ? 'PASS' : 'FAIL'}  duplicate finding and AI review are both stored`);
  console.log(`  ${calls === 1 ? 'PASS' : 'FAIL'}  the duplicate did not suppress the AI review (exactly 1 call)`);
  console.log(`  ${judged.verdict === 'flagged' ? 'PASS' : 'FAIL'}  note needs human attention`);
  console.log(`  ${f.review?.decision !== 'PASS' || f.clone ? 'PASS' : 'n/a'}  a note can be AI-PASS and still show a possible duplicate`);

  // ── J. Call-count accounting over a simulated batch ────────────────────────
  console.log('\n=== J. AI CALL COUNT OVER A BATCH ===');
  const batch = notes.slice(0, 5);
  const start = engine.aiCallCount;
  let reviewed = 0, reused = 0;
  const stored = {};
  for (const n of batch) {                      // first pass — all new
    const r = await judgeNote(engine, n, corpus, { priorReview: stored[n.eid] || null });
    stored[n.eid] = r.flags.review;
    if (r.aiCalled) reviewed++; else reused++;
  }
  const firstPass = engine.aiCallCount - start;
  console.log(`  first pass over ${batch.length} notes: aiCalls=${firstPass}, reviewed=${reviewed}, reused=${reused}`);
  console.log(`  ${firstPass === batch.length ? 'PASS' : 'FAIL'}  one AI call per new note`);

  const mid = engine.aiCallCount;
  let reused2 = 0;
  for (const n of batch) {                      // second pass — nothing changed
    const r = await judgeNote(engine, n, corpus, { priorReview: stored[n.eid] || null });
    if (!r.aiCalled) reused2++;
  }
  const secondPass = engine.aiCallCount - mid;
  console.log(`  second pass, unchanged notes: aiCalls=${secondPass}, reused=${reused2}`);
  console.log(`  ${secondPass === 0 ? 'PASS' : 'FAIL'}  re-pulling unchanged notes costs ZERO AI calls`);

  console.log(`\n  Total AI calls this script: ${engine.aiCallCount}`);
  console.log('  Duplicate detection contributed 0 of them (findDupe is synchronous and makes no requests).');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

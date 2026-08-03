// Verification harness for PS CO-SIGN REVIEW V2 (plan Step 18, sections A and B).
// Read-only: pulls stored ps_notes and exercises the MECHANICAL paths only.
// Any network call from the duplicate path would be a bug — this script asserts
// the engine's AI counter stays at zero throughout.
require('dotenv').config();
const supabase = require('../db/supabase');
const {
  InsyncCoSignEngine, splitSections, prepareSections, compareSections, dupeVerdict,
} = require('../utils/peerSupervisorEngine');

const SECTION_KEYS = ['focus', 'activities', 'interventions', 'response', 'plan'];

(async () => {
  const { data, error } = await supabase.from('ps_notes')
    .select('id, eid, mrn, patient_name, visit_date, status, ai_flags, note_data');
  if (error) throw new Error(error.message);
  const rows = (data || []).filter(r => r.note_data?.fullNoteText);
  console.log(`Loaded ${rows.length} stored notes with text.\n`);

  // ── A. Section extraction ──────────────────────────────────────────────────
  console.log('=== A. SECTION EXTRACTION ===');
  let allFive = 0;
  const misses = [];
  for (const r of rows) {
    const t = r.note_data.fullNoteText;
    const secs = splitSections(t);
    const empty = SECTION_KEYS.filter(k => !secs[k]);
    if (!empty.length) allFive++;
    else misses.push({ eid: r.eid, empty, present: SECTION_KEYS.filter(k => secs[k]) });
    // Guard against the "whole note became one section" failure mode.
    if (secs.focus && secs.focus.length > t.length * 0.9)
      misses.push({ eid: r.eid, empty: ['<focus swallowed the whole note>'], present: [] });
  }
  const pct = (allFive / rows.length) * 100;
  console.log(`All five sections non-empty: ${allFive}/${rows.length} (${pct.toFixed(1)}%) — ${pct >= 95 ? 'PASS' : 'FAIL'} (threshold 95%)`);
  for (const m of misses.slice(0, 20))
    console.log(`  MISS eid=${m.eid} empty=[${m.empty.join(',')}] present=[${m.present.join(',')}]`);
  if (misses.length > 20) console.log(`  ...and ${misses.length - 20} more`);

  const lens = {};
  for (const k of SECTION_KEYS) {
    const v = rows.map(r => (splitSections(r.note_data.fullNoteText)[k] || '').length).sort((a, b) => a - b);
    lens[k] = { min: v[0], median: v[Math.floor(v.length / 2)], max: v[v.length - 1] };
  }
  console.log('Section length min/median/max:', JSON.stringify(lens));

  // ── B. Mechanical duplicate awareness ──────────────────────────────────────
  console.log('\n=== B. MECHANICAL DUPLICATE AWARENESS ===');
  const engine = new InsyncCoSignEngine({});   // no anthropicKey: any AI call would throw
  const pending = rows.filter(r => r.status === 'pending');
  console.log(`Pending pool: ${pending.length} notes`);

  const notes = pending.map(r => ({
    eid: r.eid, mrn: r.mrn, patientName: r.patient_name,
    visitDate: r.visit_date, fullNoteText: r.note_data.fullNoteText,
  }));
  const t0 = Date.now();
  const prepared = notes.map(n => engine.prepareDupeEntry(n));
  const found = [];
  for (let i = 0; i < notes.length; i++) {
    const hit = engine.findDupe(notes[i], prepared.filter((_, j) => j !== i));
    if (hit) found.push({ note: notes[i], hit });
  }
  const ms = Date.now() - t0;
  console.log(`findDupe over the whole pool: ${ms} ms, AI calls made: ${engine.aiCallCount} — ${engine.aiCallCount === 0 ? 'PASS (zero AI)' : 'FAIL'}`);
  console.log(`Flagged ${found.length} of ${notes.length} pending notes.`);
  for (const f of found.slice(0, 25))
    console.log(`  ${f.note.eid} -> ${f.hit.partnerEid}  ${f.hit.pct}%  [${f.hit.sections.map(s => `${s.label} ${s.pct}%`).join(', ')}]`);
  if (found.length > 25) console.log(`  ...and ${found.length - 25} more`);

  // Prior AI-judged duplicates still surfaced?
  const priorPairs = rows.filter(r => r.ai_flags?.clone?.partnerEid);
  console.log(`\nNotes carrying a PRIOR (AI-era) duplicate flag: ${priorPairs.length}`);
  let stillFound = 0;
  for (const p of priorPairs) {
    const me = rows.find(r => r.eid === p.eid);
    const partner = rows.find(r => r.eid === p.ai_flags.clone.partnerEid);
    if (!me || !partner) continue;
    const a = prepareSections(me.note_data.fullNoteText, me.patient_name);
    const b = prepareSections(partner.note_data.fullNoteText, partner.patient_name);
    const v = dupeVerdict(compareSections(a, b));
    const sects = compareSections(a, b).map(h => `${h.label} ${h.pct}%`).join(', ') || 'none >= 80%';
    console.log(`  ${p.eid} vs ${p.ai_flags.clone.partnerEid}: ${v ? 'STILL FLAGGED' : 'not flagged'} (${sects})`);
    if (v) stillFound++;
  }
  if (priorPairs.length) console.log(`  ${stillFound}/${priorPairs.length} prior pairs still surfaced mechanically.`);

  // ── Threshold rule unit checks ─────────────────────────────────────────────
  console.log('\n=== B2. THRESHOLD RULE UNIT CHECKS ===');
  const mk = hits => hits.map(h => ({ ...h, ratio: h.pct / 100 }));
  const cases = [
    ['(3) Focus at 90% -> possible duplicate',
      mk([{ label: 'Focus of the meeting', substantive: true, pct: 90 }]), true],
    ['one substantive section at 85% -> no flag',
      mk([{ label: 'Focus of the meeting', substantive: true, pct: 85 }]), false],
    ['(4) two compared sections at 80% -> possible duplicate',
      mk([{ label: 'Focus of the meeting', substantive: true, pct: 82 },
          { label: 'Plan', substantive: false, pct: 80 }]), true],
    ['(5) Plan alone at 99% -> no flag',
      mk([{ label: 'Plan', substantive: false, pct: 99 }]), false],
    ['no sections -> no flag', [], false],
  ];
  let ok = 0;
  for (const [name, hits, expect] of cases) {
    const got = !!dupeVerdict(hits);
    console.log(`  ${got === expect ? 'PASS' : 'FAIL'}  ${name}`);
    if (got === expect) ok++;
  }
  console.log(`  ${ok}/${cases.length} rule checks passed`);

  // ── Short-section skip ─────────────────────────────────────────────────────
  const shortNote = 'Focus of the meeting: short. Peer Support Interventions: also short. Plan: tiny.';
  const p = prepareSections(shortNote, '');
  console.log(`\n=== B3. SHORT-SECTION SKIP ===\n  sections kept from a <120-char note: ${Object.keys(p).length} — ${Object.keys(p).length === 0 ? 'PASS' : 'FAIL'}`);

  // ── B4. Interventions are excluded from duplicate comparison ───────────────
  console.log('\n=== B4. PEER SUPPORT INTERVENTIONS EXCLUDED (tests 1 and 2) ===');
  const filler = w => (w + ' ').repeat(40);
  const mkNote = (focus, activities, interventions, response, plan) =>
    `Focus of the meeting: ${focus} What activities took place, and for how long? ${activities}`
    + ` Peer Support Interventions: ${interventions} Patient's Response/Content: ${response}`
    + ` Plan: ${plan} Diagnosis F41.1 - Generalized anxiety disorder`;

  // Identical interventions, everything else completely different.
  const sameIntervention = filler('active listening validation coping skills strengths based approach');
  const noteX = mkNote(filler('alpha'), filler('bravo'), sameIntervention, filler('charlie'), filler('delta'));
  const noteY = mkNote(filler('epsilon'), filler('foxtrot'), sameIntervention, filler('golf'), filler('hotel'));
  const px = prepareSections(noteX, ''), py = prepareSections(noteY, '');
  const hitsXY = compareSections(px, py);
  const hasIntervention = hitsXY.some(h => /Intervention/i.test(h.label));
  console.log(`  prepared section keys: [${Object.keys(px).join(', ')}]`);
  console.log(`  ${!('interventions' in px) ? 'PASS' : 'FAIL'}  (1) interventions never prepared for comparison`);
  console.log(`  ${!hasIntervention ? 'PASS' : 'FAIL'}  (1) interventions absent from matched sections`);
  console.log(`  ${!dupeVerdict(hitsXY) ? 'PASS' : 'FAIL'}  (2) a 100% intervention match alone creates no duplicate flag`);

  // Same pair, but now Focus also matches -> must flag, and the reported
  // percentage must come from Focus, not from the identical interventions.
  const noteZ = mkNote(filler('alpha'), filler('india'), sameIntervention, filler('juliet'), filler('kilo'));
  const hitsXZ = compareSections(px, prepareSections(noteZ, ''));
  const vXZ = dupeVerdict(hitsXZ);
  console.log(`  ${vXZ ? 'PASS' : 'FAIL'}  identical Focus still flags (trigger: ${vXZ?.trigger.label} ${vXZ?.trigger.pct}%)`);
  console.log(`  ${vXZ && !vXZ.hits.some(h => /Intervention/i.test(h.label)) ? 'PASS' : 'FAIL'}  interventions do not affect the reported percentage`);

  console.log(`\nFinal engine AI call count: ${engine.aiCallCount} (must be 0)`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

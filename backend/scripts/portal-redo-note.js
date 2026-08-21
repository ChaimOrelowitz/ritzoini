#!/usr/bin/env node
//
// Reset one already-written note so it can be sent again.
//
//   node scripts/portal-redo-note.js <insync_encounter_id> [--apply]
//
// Use after DELETING that encounter in InSync. It clears the dedupe ledger entry
// and puts every staged copy of the note back to needs_attention, so a
// re-resolve can mark it Ready again.
//
// Dry by default: prints what it would touch and changes nothing.

require('dotenv').config();
const supabase = require('../db/supabase');

const fmt = m => {
  const h = Math.floor(m / 60), mi = m % 60, ap = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mi).padStart(2, '0')} ${ap}`;
};

async function main() {
  const encId = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!encId) { console.error('Usage: node scripts/portal-redo-note.js <encounter_id> [--apply]'); process.exit(1); }

  const { data: led } = await supabase.from('portal_processed_notes')
    .select('*').eq('insync_encounter_id', encId).maybeSingle();
  if (!led) { console.error(`No processed note recorded for encounter ${encId}`); process.exit(1); }

  const { data: staged } = await supabase.from('portal_staged_notes')
    .select('id, run_id, status, note, resolution').eq('portal_note_uuid', led.portal_note_uuid);

  const n = staged.find(x => x.resolution?.patient_id)?.note || staged[0].note;
  console.log(`\nencounter ${encId} — ${led.client_name}, ${led.session_date}`);
  console.log(`  appointment kept   : VisitID ${led.insync_visit_id}`);
  console.log(`  session per portal : ${fmt(n.sessionStartMinutes)} - ${fmt(n.sessionStartMinutes + n.durationMinutes)}` +
              `  (${n.durationMinutes} min = ${n.durationMinutes / 15} units)`);
  console.log(`  staged copies      : ${staged.length} (${staged.map(x => x.status).join(', ')})`);

  if (!apply) { console.log('\nDry run. Re-run with --apply once the encounter is deleted in InSync.'); return; }

  const { error: delErr } = await supabase.from('portal_processed_notes')
    .delete().eq('portal_note_uuid', led.portal_note_uuid);
  if (delErr) throw new Error(delErr.message);

  // Back to needs_attention rather than straight to ready: readiness is
  // resolveRun's call, and it re-checks the peer, client and type first.
  const { error: upErr } = await supabase.from('portal_staged_notes')
    .update({ status: 'needs_attention', updated_at: new Date().toISOString() })
    .eq('portal_note_uuid', led.portal_note_uuid);
  if (upErr) throw new Error(upErr.message);

  console.log('\nLedger entry removed and staged copies reset. Re-resolve, then run that row.');
}

main().catch(e => { console.error(e.message); process.exit(1); });

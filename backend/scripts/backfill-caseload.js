// One-time seed of Chaim Orelowitz's caseload entry dates.
//
// Airtable has no history of the Peers.Supervisor link changing, so these 26
// dates came from the supervisor directly and cannot be re-derived from any
// system. Record IDs are pinned rather than resolved by name: two peers here
// share surnames (Einhorn, Steinmetz, Wagschal) and several share first names,
// so a name match could silently attach a stint to the wrong person's payroll.
//
//   node scripts/backfill-caseload.js            # dry run
//   node scripts/backfill-caseload.js --commit   # write

require('dotenv').config();
const supabase = require('../db/supabase');
const { fetchCaseloadPeerIds, fetchPeers } = require('../utils/airtable');

const SUPERVISOR = process.env.AIRTABLE_SUPERVISOR_RECORD_ID;

const ENTRIES = [
  ['recv1VJlsmGb47Wd4', 'Halpert, Avrum',       '2026-06-15'],
  ['recgBKUP9krCtYXtd', 'Steinmetz, Elimelech', '2026-06-17'],
  ['recW7tCVmoi3RBJIK', 'Cohen, Yaakov',        '2026-06-18'],
  ['recbovQ4I03RXc8ER', 'Feldman, Jacob',       '2026-06-18'],
  ['recwLr3v6dTcxxsMy', 'Goldman, Avigdor',     '2026-06-18'],
  ['recsVW2gBq1AXIuwL', 'Hofman, Yosef',        '2026-06-18'],
  ['recFGaZmcuxOqfJYm', 'Morgenstern, Amrom',   '2026-06-18'],
  ['reckiZ5HL9wdPGxbg', 'Schneebalg, Usher',    '2026-06-18'],
  ['recDikr9qSPLOVCQP', 'Shtesl, Martin',       '2026-06-18'],
  ['recr0dE86ODLUhGHk', 'Spitzer, Mendy',       '2026-06-18'],
  ['recJrBaNC6xNsBEHV', 'Twersky, Shlome',      '2026-06-18'],
  ['rechlLl7VT02sKYHZ', 'Weiss, Joseph',        '2026-06-18'],
  ['recxlEFVDXTef1ZXF', 'Glatzer, Chaim',       '2026-06-29'],
  ['reclPYIGEflN1efYB', 'Lefkowitz, Israel',    '2026-07-03'],
  ['recrNkx0Y3Hue1PpX', 'Fishman, Yitzchok',    '2026-07-06'],
  ['rectK2m69mcjnILE3', 'Einhorn, Aron',        '2026-07-08'],
  ['recLfKK6RbuZsKESO', 'Brandwein, Moshe',     '2026-07-09'],
  ['recDMguQ3r6AUhi4L', 'Einhorn, Aryeh',       '2026-07-09'],
  ['recoC5vN9pzFOx1IG', 'Geller, Chaim',        '2026-07-09'],
  ['recJcafPClnf9q4XB', 'Laufer, Shmiel',       '2026-07-09'],
  ['recyL07WPrGEyMKI4', 'Paneth, Chaim',        '2026-07-09'],
  ['rec2va3QVALsKC0jB', 'Schonfeld, Aharon',    '2026-07-09'],
  ['recNg6LKHoCgfS1G3', 'Schwartz, Chaim B',    '2026-07-09'],
  ['recQQQbXj8T3i84zK', 'Sofer, Efraim',        '2026-07-09'],
  ['reccGuYJm40uarsyk', 'Wachsman, Yisroel',    '2026-07-09'],
  ['recl07Vbk2vydXicy', 'Wagschal, Chaskal',    '2026-07-09'],
];

async function main() {
  const commit = process.argv.includes('--commit');

  if (!SUPERVISOR) throw new Error('AIRTABLE_SUPERVISOR_RECORD_ID is not set');

  const { peerIds, supervisorName } = await fetchCaseloadPeerIds(SUPERVISOR);
  const live = await fetchPeers(peerIds);
  const liveById = new Map(live.map(p => [p.airtable_id, p]));

  console.log(`Supervisor : ${supervisorName}`);
  console.log(`Airtable   : ${live.length} peers on caseload`);
  console.log(`Backfill   : ${ENTRIES.length} entries\n`);

  // Every pinned ID must still be on the caseload, and every peer on the
  // caseload must be accounted for. Either mismatch means the list drifted
  // since it was written and the dates can no longer be trusted wholesale.
  const pinned  = new Set(ENTRIES.map(([id]) => id));
  const unknown = ENTRIES.filter(([id]) => !liveById.has(id));
  const missing = live.filter(p => !pinned.has(p.airtable_id));

  if (unknown.length) {
    console.log('Pinned but NOT on the live caseload:');
    unknown.forEach(([id, name]) => console.log(`  ${id}  ${name}`));
  }
  if (missing.length) {
    console.log('On the live caseload but NOT in the backfill list:');
    missing.forEach(p => console.log(`  ${p.airtable_id}  ${p.peer_name}`));
  }
  if (unknown.length || missing.length) {
    console.log('\nAborting: caseload and backfill list disagree. Reconcile first.');
    process.exit(1);
  }

  // Names are checked for drift but the pinned ID always wins.
  ENTRIES.forEach(([id, name]) => {
    const actual = (liveById.get(id).peer_name || '').trim();
    if (actual !== name) console.log(`  note: ${id} listed as "${name}", Airtable says "${actual}"`);
  });

  const { data: existing, error: ee } = await supabase
    .from('ps_caseload_periods')
    .select('peer_airtable_id')
    .eq('supervisor_airtable_id', SUPERVISOR);
  if (ee) throw new Error(`Reading existing periods: ${ee.message}`);

  const already = new Set((existing || []).map(r => r.peer_airtable_id));
  const toWrite = ENTRIES.filter(([id]) => !already.has(id));

  if (already.size) console.log(`\n${already.size} peer(s) already have periods; skipping those.`);

  console.log(`\n${toWrite.length} period(s) to write:`);
  toWrite.forEach(([id, name, date]) => console.log(`  ${date}  ${name.padEnd(22)} ${id}`));

  if (!toWrite.length) return console.log('\nNothing to do.');

  if (!commit) return console.log('\nDry run. Re-run with --commit to write.');

  const { error } = await supabase.from('ps_caseload_periods').insert(
    toWrite.map(([id, name, date]) => ({
      peer_airtable_id:       id,
      peer_name:              liveById.get(id).peer_name,
      supervisor_airtable_id: SUPERVISOR,
      entered_on:             date,
      source:                 'backfill',
      note:                   'Seeded from supervisor-provided entry dates',
    }))
  );
  if (error) throw new Error(`Inserting periods: ${error.message}`);

  console.log(`\nWrote ${toWrite.length} period(s).`);
}

main().catch(err => { console.error(`\n${err.message}`); process.exit(1); });

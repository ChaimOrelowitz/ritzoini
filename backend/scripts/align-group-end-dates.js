/**
 * CLI wrapper around utils/groupAlignment.js — the same pass the "Sync Zoho
 * Groups" button and the zoho-sync-groups cron run, callable by hand.
 *
 *   node scripts/align-group-end-dates.js            # dry run
 *   node scripts/align-group-end-dates.js --apply    # write
 */
require('dotenv').config();
const { alignGroupEndDates } = require('../utils/groupAlignment');

async function main() {
  const apply = process.argv.includes('--apply');
  const r = await alignGroupEndDates({ apply });

  console.log(apply ? '=== APPLIED ===' : '=== DRY RUN (no writes) ===');
  for (const e of r.extended) {
    console.log(`\n${e.group}  [group is ${e.group_status}]`);
    console.log(`  end_date       ${e.old_end} → ${e.new_end}${e.new_end !== e.zoho_end ? `  (Zoho's raw ${e.zoho_end}, 1d tz skew corrected)` : ''}`);
    console.log(`  total_sessions ${e.old_total} → ${e.new_total}`);
    console.log(`  + ${e.added.length} session${e.added.length === 1 ? '' : 's'}: ` +
      e.added.map(a => `${a.date}${a.status === 'cancelled' ? ' (cancelled)' : ''}`).join(', '));
  }
  console.log(`\n${r.extended.length} groups extended, ${r.sessionsAdded} sessions created ` +
    `(${r.cancelledAdded} cancelled on arrival, ${r.sessionsAdded - r.cancelledAdded} live).`);

  if (r.needsReview.length) {
    console.log('\n--- left alone ---');
    for (const n of r.needsReview) console.log(`  ${n.group}: ${n.reason}`);
  }
  if (r.errors.length) {
    console.log('\n--- errors ---');
    for (const e of r.errors) console.log(`  ${e.group}: ${e.error}`);
  }
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });

// The full "sync Zoho groups" sequence, in one place. The admin button
// (/api/config/zoho-sync-groups), the external-scheduler endpoint
// (/api/cron/zoho-sync-groups) and the hourly in-process timer all run this.
//
// Order matters:
//   1. pull Zoho groups into the cache + link Ritzoini groups by name
//   2. auto-create Ritzoini groups for new Zoho groups (utils/zohoAutoGroups)
//   3. reflect Zoho cancellations onto sessions — after step 2, so a group
//      created this run gets its cancelled dates straight away
//   4. extend groups Zoho says run longer than Ritzoini has sessions for
// Steps 2–4 are best-effort: a failure is reported, the rest still runs.

const { syncZohoGroups } = require('./zohoCrm');
const { autoCreateZohoGroups, autoCreateEnabled } = require('./zohoAutoGroups');
const { alignGroupEndDates } = require('./groupAlignment');

const HOUR = 60 * 60 * 1000;
let running = false;

async function runZohoGroupSync() {
  // Required late: routes/sessions pulls in the whole sessions router.
  const { reflectZohoCancellations } = require('../routes/sessions');
  const result = await syncZohoGroups();

  if (autoCreateEnabled()) {
    try { result.autoCreate = await autoCreateZohoGroups({ apply: true }); }
    catch (e) { console.error('[zoho] auto-create failed:', e.message); result.autoCreate = { error: e.message }; }
  }
  try { result.cancellations = await reflectZohoCancellations(); }
  catch (e) { console.error('[zoho] reflect-cancellations failed:', e.message); result.cancellations = { error: e.message }; }
  try { result.alignment = await alignGroupEndDates({ apply: true }); }
  catch (e) { console.error('[zoho] end-date alignment failed:', e.message); result.alignment = { error: e.message }; }
  return result;
}

async function scheduledRun() {
  if (running) return;                      // a slow run must not stack up
  running = true;
  try {
    const r = await runZohoGroupSync();
    console.log(`[zoho hourly] fetched ${r.fetched}, linked ${r.aligned}, auto-created ${r.autoCreate?.created?.length || 0}`);
  } catch (e) {
    console.error('[zoho hourly] sync failed:', e.message);
  } finally {
    running = false;
  }
}

// Hourly, inside the web service — same pattern as utils/crmKeepAlive.js.
// ZOHO_SYNC_HOURLY=off disables it (e.g. locally). The timer doesn't run while
// the service is asleep; /api/cron/zoho-sync-groups remains for an external
// scheduler if that ever matters.
function startZohoGroupSchedule() {
  if (String(process.env.ZOHO_SYNC_HOURLY || '').toLowerCase() === 'off') return;
  setInterval(scheduledRun, HOUR).unref();
  console.log('[zoho hourly] group sync scheduled every 60 min');
}

module.exports = { runZohoGroupSync, startZohoGroupSchedule };

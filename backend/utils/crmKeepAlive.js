// Keeps Ritzoini's CRM session usable, and pulls the CRM queue on a timer.
//
// The CRM logs a session out when it goes idle, which is why a session sent in
// the morning was dead by the afternoon. Its own web page avoids that by POSTing
// /api/auth/session/touch while you have a tab open; this does the same from the
// server, so the session the Chrome extension sent keeps working and nobody has
// to log in again.
//
// Runs inside the web service — no external scheduler needed. Two timers:
//   • touch  — every CRM_TOUCH_MINUTES (default 10): keeps the session alive.
//   • pull   — every CRM_PULL_MINUTES  (default 60): the same ingest the "Pull
//              CRM notes" button runs.
// Set CRM_AUTO=off to disable both. POST /api/ps/cosign/crm-cron stays available
// for an external scheduler (useful if the service sleeps, since timers don't
// run while it's asleep).

const { CrmPortalClient } = require('./crmPortal');

const MIN = 60 * 1000;
let started = false;
let pullRunning = false;

async function touchOnce() {
  const r = await new CrmPortalClient().touch();
  // Only worth a log line when something is wrong — this runs every few minutes.
  if (!r.ok && r.message !== 'no CRM session stored') console.warn(`[CRM keepalive] ${r.message}`);
  return r;
}

async function pullOnce() {
  if (pullRunning) return;                 // a slow pull must not stack up
  pullRunning = true;
  try {
    // Required late: this module is loaded at boot, and the ingest pulls in the
    // engine, Supabase and the Anthropic client.
    const { ingestCrmQueue } = require('./psIngest');
    const { buildPsEngine } = require('./psEngine');
    const stats = await ingestCrmQueue(await buildPsEngine(), new CrmPortalClient());
    console.log(`[CRM auto-pull] ${stats.new} new, ${stats.revised} revised, ${stats.skipped} already had, ${stats.closed || 0} closed`);
  } catch (err) {
    console.warn(`[CRM auto-pull] ${err.message}`);
  } finally {
    pullRunning = false;
  }
}

function startCrmKeepAlive() {
  if (started || String(process.env.CRM_AUTO || '').toLowerCase() === 'off') return;
  started = true;
  const touchMins = Math.max(2, Number(process.env.CRM_TOUCH_MINUTES) || 10);
  const pullMins  = Math.max(5, Number(process.env.CRM_PULL_MINUTES)  || 60);

  setInterval(touchOnce, touchMins * MIN).unref();
  setInterval(pullOnce,  pullMins  * MIN).unref();
  // First touch soon after boot: the service may have been asleep or restarted.
  setTimeout(touchOnce, MIN).unref();
  console.log(`[CRM keepalive] touching every ${touchMins} min, pulling every ${pullMins} min`);
}

module.exports = { startCrmKeepAlive, touchOnce, pullOnce };

// Daily caseload poll.
//
// Compares the supervisor's live Airtable caseload against the OPEN rows in
// ps_caseload_periods -- those open rows are the "previous list", so no
// separate snapshot table is needed. New peer => open a stint. Vanished peer
// => close the stint with today's date. A returning peer opens a fresh row;
// closed stints are never reopened, so payroll keeps every distinct spell.

const supabase = require('../db/supabase');
const { fetchCaseloadPeerIds, fetchPeers } = require('./airtable');

// The org runs on Eastern time; a UTC date would roll over mid-evening and
// stamp entry/exit a day early.
function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function syncCaseload({ supervisorId, dryRun = false, allowEmpty = false } = {}) {
  const sup = supervisorId || process.env.AIRTABLE_SUPERVISOR_RECORD_ID;
  if (!sup) throw new Error('No supervisor record id configured');

  const today = todayET();

  const { peerIds, supervisorName } = await fetchCaseloadPeerIds(sup);

  // An empty caseload is indistinguishable from a bad filter, a revoked token
  // scope, or a renamed/cleared link field -- and acting on it would stamp an
  // exit date on every peer at once and corrupt payroll. Refuse unless the
  // caller explicitly says the caseload really did go to zero.
  if (peerIds.length === 0 && !allowEmpty) {
    throw new Error(
      'Airtable returned an empty caseload; refusing to close every open period. ' +
      'Re-run with allowEmpty if the caseload is genuinely empty.'
    );
  }

  const live     = peerIds.length ? await fetchPeers(peerIds) : [];
  const liveById = new Map(live.map(p => [p.airtable_id, p]));

  const { data: open, error: oe } = await supabase
    .from('ps_caseload_periods')
    .select('id, peer_airtable_id, peer_name, entered_on')
    .eq('supervisor_airtable_id', sup)
    .is('left_on', null);
  if (oe) throw new Error(`Reading open periods: ${oe.message}`);

  const openByPeer = new Map((open || []).map(p => [p.peer_airtable_id, p]));

  const entered  = live.filter(p => !openByPeer.has(p.airtable_id));
  const departed = (open || []).filter(p => !liveById.has(p.peer_airtable_id));

  const result = {
    supervisor: supervisorName,
    date:       today,
    peers_seen: live.length,
    entered:    entered.map(p => ({ id: p.airtable_id, name: p.peer_name })),
    departed:   departed.map(p => ({ id: p.peer_airtable_id, name: p.peer_name, since: p.entered_on })),
    dryRun,
  };

  if (dryRun) return result;

  if (departed.length) {
    const { error } = await supabase
      .from('ps_caseload_periods')
      .update({ left_on: today, updated_at: new Date().toISOString() })
      .in('id', departed.map(p => p.id));
    if (error) throw new Error(`Closing periods: ${error.message}`);
  }

  if (entered.length) {
    const { error } = await supabase.from('ps_caseload_periods').insert(
      entered.map(p => ({
        peer_airtable_id:       p.airtable_id,
        peer_name:              p.peer_name,
        supervisor_airtable_id: sup,
        entered_on:             today,
        source:                 'sync',
      }))
    );
    if (error) throw new Error(`Opening periods: ${error.message}`);
  }

  if (live.length) {
    const { error } = await supabase.from('ps_peers').upsert(
      live.map(p => ({
        ...p,
        supervisor_airtable_id: sup,
        last_seen_at:           new Date().toISOString(),
        updated_at:             new Date().toISOString(),
      })),
      { onConflict: 'airtable_id' }
    );
    if (error) throw new Error(`Upserting peers: ${error.message}`);
  }

  await supabase.from('ps_sync_runs').insert({
    supervisor_airtable_id: sup,
    peers_seen:             live.length,
    entered:                entered.length,
    departed:               departed.length,
    ok:                     true,
    detail:                 { entered: result.entered, departed: result.departed },
  });

  return result;
}

async function logFailure(supervisorId, err) {
  await supabase.from('ps_sync_runs').insert({
    supervisor_airtable_id: supervisorId || process.env.AIRTABLE_SUPERVISOR_RECORD_ID,
    ok:    false,
    error: err.message,
  });
}

module.exports = { syncCaseload, logFailure, todayET };

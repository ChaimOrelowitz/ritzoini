/**
 * Align Ritzoini group end dates + session counts with Zoho (the source of truth).
 *
 * Scope: EXTEND ONLY. A group is touched only when Zoho says it runs longer than
 * the platform has sessions for — the "stopped too early" case. Groups that
 * already have sessions at or beyond Zoho's end date are reported for review and
 * left alone: shortening would retire sessions that were actually held.
 *
 * Zoho's How_many_Sessions counts every weekly slot including cancelled ones, so
 * the target series is <platform start_date> + 7d × (n − 1). Deriving the end date
 * that way (rather than copying Zoho's End_Date_and_Time verbatim) also corrects
 * the one-day timezone skew Zoho's datetime fields carry on some groups.
 *
 * Sessions are counted, not date-matched: a session moved off the weekly cadence
 * is still that week's session, and must not be duplicated.
 *
 * New sessions land on Zoho-cancelled dates as `cancelled` (the shape
 * reflectZohoCancellations would produce), otherwise as `scheduled`.
 *
 * Runs after reflectZohoCancellations in the sync sequence — cancellations never
 * change the session count, so the two passes don't interfere.
 */
const supabase = require('../db/supabase');

const D = d => (d ? String(d).slice(0, 10) : null);

const addDays = (d, n) => {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

const addMinutesToTime = (timeStr, mins) => {
  if (!timeStr) return null;
  const [h, m] = timeStr.slice(0, 5).split(':').map(Number);
  const total = h * 60 + m + parseInt(mins || 0, 10);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * @param {object}  opts
 * @param {boolean} opts.apply  false (default) computes the plan without writing.
 * @returns {Promise<{extended: Array, sessionsAdded: number, cancelledAdded: number,
 *                    needsReview: Array<{group: string, reason: string}>, errors: Array}>}
 */
async function alignGroupEndDates({ apply = false } = {}) {
  const { data: groups, error: gErr } = await supabase
    .from('groups')
    .select('id, group_name, name, status, start_date, end_date, total_sessions, default_duration, start_time, session_time, ecw_time, ecw_end_time, zoho_session_id')
    .not('zoho_session_id', 'is', null);
  if (gErr) throw gErr;

  const { data: zgroups, error: zErr } = await supabase
    .from('zoho_groups').select('id, session_name, end_date, how_many_sessions, cancelled_dates');
  if (zErr) throw zErr;
  const zById = Object.fromEntries(zgroups.map(z => [z.id, z]));

  const extended = [], needsReview = [], errors = [];
  let sessionsAdded = 0, cancelledAdded = 0;

  for (const g of groups) {
    const label = g.group_name || g.name;
    const z = zById[g.zoho_session_id];
    if (!z?.end_date || !z.how_many_sessions) { needsReview.push({ group: label, reason: 'no Zoho end date / session count' }); continue; }

    const { data: sess, error: sErr } = await supabase
      .from('sessions')
      .select('id, session_number, session_date, scheduled_date, status')
      .eq('group_id', g.id).order('session_number');
    if (sErr) { errors.push({ group: label, error: sErr.message }); continue; }
    if (!sess.length) { needsReview.push({ group: label, reason: 'no sessions on the platform' }); continue; }

    const target = z.how_many_sessions;
    const missing = target - sess.length;
    if (missing <= 0) {
      if (sess.length > target)
        needsReview.push({ group: label, reason: `has ${sess.length} sessions, Zoho says ${target} — longer than Zoho, left alone` });
      continue;
    }

    const last = sess[sess.length - 1];
    const lastDate = D(last.session_date || last.scheduled_date);
    if (!lastDate) { needsReview.push({ group: label, reason: 'last session has no date' }); continue; }

    const newEnd = addDays(g.start_date, (target - 1) * 7);
    // Safety: the derived end must line up with Zoho's own end date (±1d tz skew).
    const skew = Math.round((Date.parse(newEnd) - Date.parse(z.end_date)) / 86400000);
    if (Math.abs(skew) > 1) { needsReview.push({ group: label, reason: `derived end ${newEnd} is ${skew}d off Zoho's ${z.end_date}` }); continue; }

    const cancelledDates = new Set((z.cancelled_dates || []).map(D));
    const dur = parseInt(g.default_duration, 10) || 45;
    const sTime = (g.start_time || g.session_time || '09:00').slice(0, 5);
    const eTime = addMinutesToTime(sTime, dur);
    const ecwTime = (g.ecw_time || sTime).slice(0, 5);
    const ecwEnd = g.ecw_end_time ? g.ecw_end_time.slice(0, 5) : addMinutesToTime(ecwTime, dur);

    const rows = [];
    for (let i = 1; i <= missing; i++) {
      const date = addDays(lastDate, 7 * i);
      const isCancelled = cancelledDates.has(date);
      rows.push({
        group_id: g.id,
        session_number: (last.session_number || sess.length) + i,
        session_date: date, scheduled_date: date,
        start_time: sTime, scheduled_time: sTime, end_time: eTime,
        ecw_time: ecwTime, ecw_end_time: ecwEnd,
        duration: dur,
        session_day_of_week: new Date(date + 'T00:00:00Z').getUTCDay(),
        status: isCancelled ? 'cancelled' : 'scheduled',
        status_manual_override: isCancelled,
        soap_note: null, notes: null,
      });
    }
    if (D(rows[rows.length - 1].session_date) !== newEnd) {
      needsReview.push({ group: label, reason: `series ends ${D(rows[rows.length - 1].session_date)} but end date derives to ${newEnd} — off-cadence` });
      continue;
    }

    const cancelled = rows.filter(r => r.status === 'cancelled').length;

    if (apply) {
      const { error: insErr } = await supabase.from('sessions').insert(rows);
      if (insErr) { errors.push({ group: label, error: `session insert failed — ${insErr.message}` }); continue; }
      const { error: updErr } = await supabase.from('groups')
        .update({ end_date: newEnd, total_sessions: target }).eq('id', g.id);
      if (updErr) { errors.push({ group: label, error: `group update failed — ${updErr.message}` }); continue; }
    }

    sessionsAdded += rows.length;
    cancelledAdded += cancelled;
    extended.push({
      group: label, group_id: g.id, group_status: g.status,
      old_end: g.end_date, new_end: newEnd, zoho_end: z.end_date,
      old_total: g.total_sessions, new_total: target,
      added: rows.map(r => ({ date: r.session_date, status: r.status })),
    });
  }

  return { applied: apply, extended, sessionsAdded, cancelledAdded, needsReview, errors };
}

module.exports = { alignGroupEndDates };

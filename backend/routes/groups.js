const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function deriveDayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function computeEndDate(startDate, dowInt, numSessions) {
  if (!startDate || !numSessions) return null;
  const [y, m, d] = startDate.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const daysAhead = (dowInt - start.getDay() + 7) % 7;
  const first = new Date(start);
  first.setDate(first.getDate() + daysAhead);
  const last = new Date(first);
  last.setDate(last.getDate() + (parseInt(numSessions) - 1) * 7);
  return last.toISOString().split('T')[0];
}

function computeNumSessions(startDate, endDate, dowInt) {
  if (!startDate || !endDate) return null;
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const startMs = Date.UTC(sy, sm - 1, sd);
  const endMs   = Date.UTC(ey, em - 1, ed);
  const startDow = new Date(startMs).getUTCDay();
  const daysAhead = (dowInt - startDow + 7) % 7;
  const firstMs = startMs + daysAhead * 24 * 60 * 60 * 1000;
  if (firstMs > endMs) return 0;
  return Math.floor((endMs - firstMs) / (7 * 24 * 60 * 60 * 1000)) + 1;
}

function addMinutesToTime(timeStr, mins) {
  if (!timeStr) return null;
  const [h, m] = timeStr.slice(0,5).split(':').map(Number);
  const total = h * 60 + m + parseInt(mins || 0);
  return `${String(Math.floor(total / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
}

function computeEcwEnd(ecwTime, duration) {
  if (!ecwTime || !duration) return null;
  return addMinutesToTime(ecwTime, duration);
}

// Apply updated times to all future sessions (those whose ECW end hasn't passed yet)
async function applyTimeToFutureSessions(groupId, newStartTime, newEcwTime, newDuration) {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  // Get all scheduled sessions
  const { data: sessions } = await supabase
    .from('sessions')
    .select('id, session_date, scheduled_date, ecw_time, ecw_end_time, duration')
    .eq('group_id', groupId)
    .in('status', ['scheduled', 'group_ended'])
    .order('session_date', { ascending: true });

  if (!sessions?.length) return 0;

  const dur    = parseInt(newDuration) || 45;
  const eTime  = addMinutesToTime(newStartTime, dur);
  const ecwEnd = computeEcwEnd(newEcwTime, dur);

  // A session is "in the future" if its ECW end hasn't passed
  const futureSessions = sessions.filter(s => {
    const dateStr = s.session_date || s.scheduled_date;
    if (!dateStr) return true; // no date = future by default

    // Use the session's current ecw_end_time or compute it
    const sessEcwEnd = s.ecw_end_time || computeEcwEnd(s.ecw_time, s.duration);
    if (!sessEcwEnd) return dateStr >= todayStr;

    const [h, m] = sessEcwEnd.slice(0,5).split(':').map(Number);
    const endDT = new Date(dateStr + 'T00:00:00');
    endDT.setHours(h, m, 0, 0);
    return now <= endDT; // hasn't ended yet
  });

  if (!futureSessions.length) return 0;

  await supabase.from('sessions')
    .update({
      start_time:     newStartTime.slice(0,5),
      scheduled_time: newStartTime.slice(0,5),
      end_time:       eTime,
      ecw_time:       newEcwTime.slice(0,5),
      ecw_end_time:   ecwEnd,
      duration:       dur,
    })
    .in('id', futureSessions.map(s => s.id));

  return futureSessions.length;
}

// Reschedule all scheduled sessions when the group start date changes
async function applyDatesToScheduledSessions(groupId, newStartDate, newDayOfWeekInt) {
  const { data: sessions } = await supabase
    .from('sessions')
    .select('id, session_number')
    .eq('group_id', groupId)
    .eq('status', 'scheduled')
    .order('session_number', { ascending: true });

  if (!sessions?.length) return 0;

  const [sy, sm, sd] = newStartDate.split('-').map(Number);
  const baseMs = Date.UTC(sy, sm - 1, sd);

  for (const s of sessions) {
    const newDate = new Date(baseMs + (s.session_number - 1) * 7 * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0];
    await supabase.from('sessions')
      .update({ session_date: newDate, scheduled_date: newDate, session_day_of_week: newDayOfWeekInt })
      .eq('id', s.id);
  }

  return sessions.length;
}

// Mark sessions beyond newCount as group_ended
async function truncateExcessSessions(groupId, newCount) {
  const { data: excess } = await supabase
    .from('sessions')
    .select('id')
    .eq('group_id', groupId)
    .eq('status', 'scheduled')
    .gt('session_number', newCount);

  if (excess?.length) {
    await supabase.from('sessions')
      .update({ status: 'group_ended', status_manual_override: true })
      .in('id', excess.map(s => s.id));
  }
}

const GROUP_LIST_SELECT = `
  id, internal_name, group_name, name, description, supervisor_id, instructor_id, status, archived,
  start_date, end_date, day_of_week_int, day_of_week,
  start_time, session_time, end_time, ecw_time, ecw_end_time,
  total_sessions, default_duration, created_at, ai_notes,
  supervisor:profiles!supervisor_id(id, first_name, last_name, email),
  instructor:instructors!instructor_id(id, first_name, last_name, phone),
  sessions(id, status, locked)
`;

const GROUP_DETAIL_SELECT = `
  id, internal_name, group_name, name, description, supervisor_id, instructor_id, status, archived,
  start_date, end_date, day_of_week_int, day_of_week,
  start_time, session_time, end_time, ecw_time, ecw_end_time,
  total_sessions, default_duration, created_at, ai_notes,
  supervisor:profiles!supervisor_id(id, first_name, last_name, email),
  instructor:instructors!instructor_id(id, first_name, last_name, phone)
`;

router.get('/', requireAuth, async (req, res) => {
  try {
    const showArchived = req.query.archived === 'true';
    let query = supabase
      .from('groups').select(GROUP_LIST_SELECT)
      .eq('archived', showArchived)
      .order('day_of_week_int', { ascending: true })
      .order('ecw_time', { ascending: true });
    if (req.user.role === 'supervisor') query = query.eq('supervisor_id', req.user.id);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('groups').select(GROUP_DETAIL_SELECT).eq('id', req.params.id).single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Group not found' });
    if (req.user.role === 'supervisor' && data.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { internal_name, group_name, description, instructor_id,
            start_date, end_date, start_time, ecw_time, total_sessions, default_duration,
            skip_dates } = req.body;
    // Supervisors can only create groups for themselves
    const supervisor_id = req.user.role === 'admin'
      ? (req.body.supervisor_id || null)
      : req.user.id;

    if (!internal_name) return res.status(400).json({ error: 'internal_name is required' });
    if (!start_date)    return res.status(400).json({ error: 'start_date is required' });
    if (!start_time)    return res.status(400).json({ error: 'start_time is required' });

    const dowInt   = deriveDayOfWeek(start_date);
    const duration = parseInt(default_duration) || 45;
    const sTime    = start_time.slice(0,5);
    const end_time = addMinutesToTime(sTime, duration);
    const effEcw   = ecw_time ? ecw_time.slice(0,5) : sTime;
    const ecwEnd   = computeEcwEnd(effEcw, duration);

    let resolvedSessions = total_sessions ? parseInt(total_sessions) : null;
    let resolvedEndDate  = end_date || null;
    if (resolvedEndDate && !resolvedSessions)
      resolvedSessions = computeNumSessions(start_date, resolvedEndDate, dowInt);
    else if (resolvedSessions && !resolvedEndDate)
      resolvedEndDate = computeEndDate(start_date, dowInt, resolvedSessions);

    const { data: group, error } = await supabase.from('groups').insert({
      internal_name,
      group_name:      group_name || internal_name,
      name:            group_name || internal_name,
      description:     description || null,
      supervisor_id:   supervisor_id || null,
      instructor_id:   instructor_id || null,
      start_date,
      end_date:        resolvedEndDate,
      day_of_week_int: dowInt,
      day_of_week:     DAY_NAMES[dowInt],
      start_time:      sTime,
      session_time:    sTime,
      end_time,
      ecw_time:        effEcw,
      ecw_end_time:    ecwEnd,
      total_sessions:  resolvedSessions,
      default_duration: duration,
      created_by:      req.user.id,
    }).select().single();

    if (error) throw error;
    if (resolvedSessions) {
      await supabase.rpc('generate_sessions_for_group', { p_group_id: group.id });

      if (skip_dates?.length) {
        const { data: allSessions } = await supabase
          .from('sessions').select('id, session_date, scheduled_date').eq('group_id', group.id);
        const skipSet = new Set(skip_dates);
        console.log('[skip_dates] requested:', skip_dates);
        console.log('[skip_dates] sessions sample:', (allSessions || []).slice(0, 3).map(s => ({ id: s.id, session_date: s.session_date, scheduled_date: s.scheduled_date })));
        const toSkip = (allSessions || []).filter(s => {
          const d1 = (s.session_date || '').slice(0, 10);
          const d2 = (s.scheduled_date || '').slice(0, 10);
          return skipSet.has(d1) || skipSet.has(d2);
        }).map(s => s.id);
        console.log('[skip_dates] toSkip ids:', toSkip);
        if (toSkip.length) {
          const { error: skipErr } = await supabase.from('sessions')
            .update({ status: 'skipped', status_manual_override: true })
            .in('id', toSkip);
          console.log('[skip_dates] update error:', skipErr);
        }
      }
    }
    res.status(201).json(group);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('groups')
      .select('supervisor_id, start_date, day_of_week_int, default_duration, total_sessions, start_time, session_time, ecw_time, ecw_end_time')
      .eq('id', req.params.id).single();

    if (fetchErr || !existing) return res.status(404).json({ error: 'Group not found' });
    if (req.user.role === 'supervisor' && existing.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const adminOnly = ['internal_name', 'supervisor_id', 'instructor_id'];
    const supervisorAllowed = ['group_name','description','start_date','end_date',
                               'start_time','ecw_time','total_sessions','default_duration','status','ai_notes'];
    const allowed = req.user.role === 'admin' ? [...adminOnly, ...supervisorAllowed] : supervisorAllowed;
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));

    const effStartDate = updates.start_date || existing.start_date;
    const effDow       = updates.start_date ? deriveDayOfWeek(updates.start_date) : existing.day_of_week_int;
    const effDuration  = parseInt(updates.default_duration || existing.default_duration) || 45;
    const effStartTime = (updates.start_time || existing.start_time || existing.session_time || '09:00').slice(0,5);
    const effEcwTime   = (updates.ecw_time || existing.ecw_time || effStartTime).slice(0,5);

    if (updates.start_date) {
      updates.day_of_week_int = effDow;
      updates.day_of_week     = DAY_NAMES[effDow];
    }
    if (updates.total_sessions && !updates.end_date)
      updates.end_date = computeEndDate(effStartDate, effDow, parseInt(updates.total_sessions));
    else if (updates.end_date && !updates.total_sessions)
      updates.total_sessions = computeNumSessions(effStartDate, updates.end_date, effDow);

    // Recompute times
    if (updates.start_time || updates.default_duration) {
      updates.end_time     = addMinutesToTime(effStartTime, effDuration);
      updates.session_time = effStartTime;
    }
    if (updates.ecw_time || updates.default_duration) {
      updates.ecw_end_time = computeEcwEnd(effEcwTime, effDuration);
    }
    if (updates.start_time && !updates.ecw_time) {
      updates.ecw_time     = effStartTime;
      updates.ecw_end_time = computeEcwEnd(effStartTime, effDuration);
    }
    if (updates.group_name) updates.name = updates.group_name;

    const { data, error } = await supabase
      .from('groups').update(updates).eq('id', req.params.id)
      .select(GROUP_DETAIL_SELECT).single();
    if (error) throw error;

       // If session count changed, adjust sessions
    const newTotal = parseInt(updates.total_sessions || existing.total_sessions);
    const oldTotal = parseInt(existing.total_sessions);

    if (newTotal && oldTotal) {
      if (newTotal < oldTotal) {
        // Fewer sessions: mark sessions beyond newTotal as group_ended
        await truncateExcessSessions(req.params.id, newTotal);
      } else if (newTotal > oldTotal) {
        // More sessions: generate missing future sessions
        await supabase.rpc('generate_sessions_for_group', { p_group_id: req.params.id });
      }
    }

    // If time/ecw/duration changed, update future sessions
    const timeChanged = updates.start_time || updates.ecw_time || updates.default_duration;
    if (timeChanged) {
      const affected = await applyTimeToFutureSessions(
        req.params.id, effStartTime, effEcwTime, effDuration
      );
      console.log(`[groups patch] updated ${affected} future sessions with new time`);
    }

    // If start date changed, reschedule all scheduled sessions
    if (updates.start_date) {
      const affected = await applyDatesToScheduledSessions(req.params.id, effStartDate, effDow);
      console.log(`[groups patch] rescheduled ${affected} sessions to new start date`);
    }

    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// End group
router.post('/:id/end', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    await supabase.from('sessions')
      .update({ status: 'group_ended', status_manual_override: true })
      .eq('group_id', req.params.id).eq('status', 'scheduled');
    const { data, error } = await supabase.from('groups')
      .update({ status: 'completed' }).eq('id', req.params.id)
      .select(GROUP_DETAIL_SELECT).single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Un-end group
router.post('/:id/unend', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    await supabase.from('sessions')
      .update({ status: 'scheduled', status_manual_override: false })
      .eq('group_id', req.params.id).eq('status', 'group_ended');
    const { data, error } = await supabase.from('groups')
      .update({ status: 'active' }).eq('id', req.params.id)
      .select(GROUP_DETAIL_SELECT).single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/archive', requireAuth, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('groups').select('supervisor_id').eq('id', req.params.id).single();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (req.user.role === 'supervisor' && existing.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });
    const { data, error } = await supabase.from('groups')
      .update({ archived: true, archived_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/unarchive', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('groups')
      .update({ archived: false, archived_at: null })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

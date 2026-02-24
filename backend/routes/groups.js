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
  const start = new Date(sy, sm - 1, sd);
  const end   = new Date(ey, em - 1, ed);
  const daysAhead = (dowInt - start.getDay() + 7) % 7;
  const first = new Date(start);
  first.setDate(first.getDate() + daysAhead);
  if (first > end) return 0;
  return Math.floor((end - first) / (7 * 24 * 60 * 60 * 1000)) + 1;
}

function addMinutesToTime(timeStr, mins) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + parseInt(mins);
  return `${String(Math.floor(total / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
}

const GROUP_LIST_SELECT = `
  id, internal_name, group_name, name, description, supervisor_id, instructor_id, status, archived,
  start_date, end_date, day_of_week_int, day_of_week,
  start_time, session_time, end_time, ecw_time,
  total_sessions, default_duration, created_at,
  supervisor:profiles!supervisor_id(id, first_name, last_name, email),
  instructor:instructors!instructor_id(id, first_name, last_name, phone),
  sessions(id, status)
`;

const GROUP_DETAIL_SELECT = `
  id, internal_name, group_name, name, description, supervisor_id, instructor_id, status, archived,
  start_date, end_date, day_of_week_int, day_of_week,
  start_time, session_time, end_time, ecw_time,
  total_sessions, default_duration, created_at,
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
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can create groups' });
    const { internal_name, group_name, description, supervisor_id, instructor_id,
            start_date, end_date, start_time, ecw_time, total_sessions, default_duration } = req.body;

    if (!internal_name) return res.status(400).json({ error: 'internal_name is required' });
    if (!start_date)    return res.status(400).json({ error: 'start_date is required' });
    if (!start_time)    return res.status(400).json({ error: 'start_time is required' });

    const dowInt   = deriveDayOfWeek(start_date);
    const duration = parseInt(default_duration) || 45;
    const end_time = addMinutesToTime(start_time, duration);

    let resolvedSessions = total_sessions ? parseInt(total_sessions) : null;
    let resolvedEndDate  = end_date || null;
    if (resolvedEndDate && !resolvedSessions) {
      resolvedSessions = computeNumSessions(start_date, resolvedEndDate, dowInt);
    } else if (resolvedSessions && !resolvedEndDate) {
      resolvedEndDate = computeEndDate(start_date, dowInt, resolvedSessions);
    }

    const { data: group, error } = await supabase.from('groups').insert({
      internal_name,
      group_name: group_name || internal_name,
      name: group_name || internal_name,
      description: description || null,
      supervisor_id: supervisor_id || null,
      instructor_id: instructor_id || null,
      start_date, end_date: resolvedEndDate,
      day_of_week_int: dowInt, day_of_week: DAY_NAMES[dowInt],
      start_time, session_time: start_time, end_time,
      ecw_time: ecw_time || start_time,
      total_sessions: resolvedSessions,
      default_duration: duration,
      created_by: req.user.id,
    }).select().single();

    if (error) throw error;
    if (resolvedSessions) {
      await supabase.rpc('generate_sessions_for_group', { p_group_id: group.id });
    }
    res.status(201).json(group);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('groups')
      .select('supervisor_id, start_date, day_of_week_int, default_duration, total_sessions, start_time, session_time')
      .eq('id', req.params.id).single();

    if (fetchErr || !existing) return res.status(404).json({ error: 'Group not found' });
    if (req.user.role === 'supervisor' && existing.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const adminOnly = ['internal_name', 'supervisor_id', 'instructor_id'];
    const supervisorAllowed = ['group_name','description','start_date','end_date','start_time',
                               'ecw_time','total_sessions','default_duration','status'];
    const allowed = req.user.role === 'admin' ? [...adminOnly, ...supervisorAllowed] : supervisorAllowed;
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));

    const effStartDate = updates.start_date || existing.start_date;
    const effDow       = updates.start_date ? deriveDayOfWeek(updates.start_date) : existing.day_of_week_int;
    const effDuration  = parseInt(updates.default_duration || existing.default_duration) || 45;
    const effStartTime = updates.start_time || existing.start_time || existing.session_time;

    if (updates.start_date) {
      updates.day_of_week_int = effDow;
      updates.day_of_week = DAY_NAMES[effDow];
    }
    if (updates.total_sessions && !updates.end_date)
      updates.end_date = computeEndDate(effStartDate, effDow, parseInt(updates.total_sessions));
    else if (updates.end_date && !updates.total_sessions)
      updates.total_sessions = computeNumSessions(effStartDate, updates.end_date, effDow);

    if (updates.start_time || updates.default_duration)
      updates.end_time = addMinutesToTime(effStartTime, effDuration);
    if (updates.start_time && !updates.ecw_time) updates.ecw_time = updates.start_time;
    if (updates.group_name) updates.name = updates.group_name;
    if (updates.start_time) updates.session_time = updates.start_time;

    const { data, error } = await supabase
      .from('groups').update(updates).eq('id', req.params.id)
      .select(GROUP_DETAIL_SELECT).single();
    if (error) throw error;

    if (updates.total_sessions || updates.start_date || updates.end_date)
      await supabase.rpc('generate_sessions_for_group', { p_group_id: req.params.id });

    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// End group → remaining scheduled → group_ended
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

// Un-end group → revert group_ended sessions → scheduled, group → active
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

const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function deriveDayOfWeek(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day).getDay();
}

const GROUP_LIST_SELECT = `
  id, internal_name, group_name, name, supervisor_id, status, archived,
  start_date, day_of_week_int, day_of_week, start_time, session_time, end_time, ecw_time,
  total_sessions, created_at,
  supervisor:profiles!supervisor_id(id, first_name, last_name, email),
  sessions(id, status)
`;

const GROUP_DETAIL_SELECT = `
  id, internal_name, group_name, name, supervisor_id, status, archived,
  start_date, day_of_week_int, day_of_week, start_time, session_time, end_time, ecw_time,
  total_sessions, created_at,
  supervisor:profiles!supervisor_id(id, first_name, last_name, email)
`;

// GET /api/groups
router.get('/', requireAuth, async (req, res) => {
  try {
    const showArchived = req.query.archived === 'true';
    let query = supabase
      .from('groups')
      .select(GROUP_LIST_SELECT)
      .eq('archived', showArchived)
      .order('day_of_week_int', { ascending: true })
      .order('ecw_time', { ascending: true });

    if (req.user.role === 'supervisor') {
      query = query.eq('supervisor_id', req.user.id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/groups/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('groups')
      .select(GROUP_DETAIL_SELECT)
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Group not found' });

    if (req.user.role === 'supervisor' && data.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/groups
router.post('/', requireAuth, async (req, res) => {
  try {
    const { internal_name, group_name, supervisor_id, start_date, start_time, end_time, ecw_time, total_sessions } = req.body;

    if (!internal_name) return res.status(400).json({ error: 'internal_name is required' });
    if (!group_name)    return res.status(400).json({ error: 'group_name is required' });
    if (!start_date)    return res.status(400).json({ error: 'start_date is required' });
    if (!start_time)    return res.status(400).json({ error: 'start_time is required' });
    if (!end_time)      return res.status(400).json({ error: 'end_time is required' });

    const effectiveSupervisorId = req.user.role === 'supervisor' ? req.user.id : (supervisor_id || null);
    const day_of_week_int = deriveDayOfWeek(start_date);

    const { data: group, error } = await supabase
      .from('groups')
      .insert({
        internal_name, group_name, name: group_name,
        supervisor_id: effectiveSupervisorId,
        start_date, day_of_week_int,
        day_of_week: DAY_NAMES[day_of_week_int],
        start_time, session_time: start_time,
        end_time,
        ecw_time: ecw_time || start_time,
        total_sessions: parseInt(total_sessions) || 8,
        created_by: req.user.id,
      })
      .select().single();

    if (error) throw error;
    await supabase.rpc('generate_sessions_for_group', { p_group_id: group.id });
    res.status(201).json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/groups/:id
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('groups').select('supervisor_id').eq('id', req.params.id).single();

    if (fetchErr || !existing) return res.status(404).json({ error: 'Group not found' });
    if (req.user.role === 'supervisor' && existing.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const allowed = ['internal_name','group_name','supervisor_id','start_date','start_time','end_time','ecw_time','total_sessions','status'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));

    if (req.user.role === 'supervisor') delete updates.supervisor_id;
    if (updates.start_date) {
      updates.day_of_week_int = deriveDayOfWeek(updates.start_date);
      updates.day_of_week = DAY_NAMES[updates.day_of_week_int];
    }
    if (updates.start_time && !updates.ecw_time) updates.ecw_time = updates.start_time;
    if (updates.group_name) updates.name = updates.group_name;
    if (updates.start_time) updates.session_time = updates.start_time;

    const { data, error } = await supabase
      .from('groups').update(updates).eq('id', req.params.id).select(GROUP_DETAIL_SELECT).single();

    if (error) throw error;
    if (updates.total_sessions || updates.start_date) {
      await supabase.rpc('generate_sessions_for_group', { p_group_id: req.params.id });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/groups/:id/archive
router.post('/:id/archive', requireAuth, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('groups').select('supervisor_id').eq('id', req.params.id).single();
    if (!existing) return res.status(404).json({ error: 'Group not found' });
    if (req.user.role === 'supervisor' && existing.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { data, error } = await supabase
      .from('groups').update({ archived: true, archived_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/groups/:id/unarchive
router.post('/:id/unarchive', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('groups').update({ archived: false, archived_at: null })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

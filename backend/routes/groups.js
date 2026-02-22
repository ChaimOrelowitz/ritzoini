const express = require('express');
const router = require('express').Router();
const supabase = require('../db/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /api/groups
router.get('/', requireAuth, async (req, res) => {
  try {
    let query = supabase
      .from('groups')
      .select(`*, supervisor:profiles!supervisor_id(id, first_name, last_name, email), sessions(id, status)`)
      .order('created_at', { ascending: false });

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
      .select(`*, supervisor:profiles!supervisor_id(id, first_name, last_name, email), sessions(*)`)
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    if (req.user.role === 'supervisor' && data.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/groups — admin only
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, supervisor_id, total_sessions, start_date, day_of_week, session_time } = req.body;

    const { data: group, error } = await supabase
      .from('groups')
      .insert({ name, supervisor_id, total_sessions, start_date, day_of_week, session_time, created_by: req.user.id })
      .select()
      .single();

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
    const { data: existing } = await supabase.from('groups').select('supervisor_id').eq('id', req.params.id).single();

    if (req.user.role === 'supervisor' && existing.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const allowed = ['name', 'supervisor_id', 'total_sessions', 'start_date', 'day_of_week', 'session_time', 'status'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));

    const { data, error } = await supabase
      .from('groups')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    if (req.body.total_sessions) {
      await supabase.rpc('generate_sessions_for_group', { p_group_id: req.params.id });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/groups/:id — admin only
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('groups').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

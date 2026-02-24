const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');

// GET /api/instructors — all authenticated users
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('instructors')
      .select('*')
      .order('last_name');
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/instructors — admin only
router.post('/', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { first_name, last_name, phone } = req.body;
    if (!first_name) return res.status(400).json({ error: 'first_name is required' });
    if (!last_name)  return res.status(400).json({ error: 'last_name is required' });

    const { data, error } = await supabase
      .from('instructors')
      .insert({ first_name, last_name, phone: phone || null })
      .select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/instructors/:id — admin only
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { first_name, last_name, phone } = req.body;
    const { data, error } = await supabase
      .from('instructors')
      .update({ first_name, last_name, phone })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/instructors/:id — admin only
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { error } = await supabase.from('instructors').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

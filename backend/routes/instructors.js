const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');

function resolveNames(first_name, last_name, phone) {
  const digits = (phone || '').replace(/\D/g, '');
  const last4  = digits.slice(-4) || '????';
  return {
    first_name: (first_name || '').trim() || 'Instructor',
    last_name:  (last_name  || '').trim() || last4,
  };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('instructors').select('*').order('last_name');
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
    const { first_name, last_name, phone } = req.body;
    const digits = (phone || '').replace(/\D/g, '');
    if (digits.length < 4) return res.status(400).json({ error: 'Phone number is required' });

    const names = resolveNames(first_name, last_name, digits);
    const { data, error } = await supabase
      .from('instructors').insert({ ...names, phone: digits }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
    const { data: existing } = await supabase
      .from('instructors').select('*').eq('id', req.params.id).single();
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const { first_name, last_name, phone } = req.body;
    const digits = phone !== undefined ? (phone).replace(/\D/g, '') : existing.phone;
    const names  = resolveNames(
      first_name !== undefined ? first_name : existing.first_name,
      last_name  !== undefined ? last_name  : existing.last_name,
      digits
    );

    const { data, error } = await supabase
      .from('instructors').update({ ...names, phone: digits })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { error } = await supabase.from('instructors').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

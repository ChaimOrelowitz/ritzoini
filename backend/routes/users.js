const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, email, phone, role, created_at')
      .order('last_name');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/invite', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { first_name, last_name, email, phone, role } = req.body;
    if (!email)      return res.status(400).json({ error: 'Email is required' });
    if (!first_name) return res.status(400).json({ error: 'First name is required' });
    if (!last_name)  return res.status(400).json({ error: 'Last name is required' });

    const assignedRole = role === 'admin' ? 'admin' : 'supervisor';
    const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
      data: { first_name, last_name, phone: phone || '', role: assignedRole },
    });
    if (error) throw error;
    res.json({ success: true, message: `Invitation sent to ${email}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('profiles').select('email').eq('id', req.params.id).single();
    if (!profile) return res.status(404).json({ error: 'User not found' });

    const { error } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email: profile.email,
    });
    if (error) throw error;
    res.json({ success: true, message: `Password reset email sent to ${profile.email}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const allowed = ['first_name', 'last_name', 'phone', 'role'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

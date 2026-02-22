const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sendSessionNotesEmail } = require('../services/email');

// GET /api/sessions?group_id=xxx
router.get('/', requireAuth, async (req, res) => {
  try {
    let query = supabase
      .from('sessions')
      .select(`*, group:groups(id, name, supervisor_id)`)
      .order('session_number', { ascending: true });

    if (req.query.group_id) {
      query = query.eq('group_id', req.query.group_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Supervisors filtered to their groups
    const filtered = req.user.role === 'admin'
      ? data
      : data.filter(s => s.group?.supervisor_id === req.user.id);

    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/sessions/:id — update session date/time or status
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select('*, group:groups(supervisor_id, name)')
      .eq('id', req.params.id)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const allowed = ['scheduled_date', 'scheduled_time', 'status', 'notes'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));

    const { data, error } = await supabase
      .from('sessions')
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

// POST /api/sessions/:id/submit-notes — supervisor submits notes → email sent → ready to lock
router.post('/:id/submit-notes', requireAuth, async (req, res) => {
  try {
    const { notes } = req.body;
    if (!notes?.trim()) return res.status(400).json({ error: 'Notes are required' });

    const { data: session } = await supabase
      .from('sessions')
      .select('*, group:groups(name, supervisor_id)')
      .eq('id', req.params.id)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (session.locked_at) return res.status(400).json({ error: 'Session is already locked' });

    // Send (simulated) email
    await sendSessionNotesEmail({
      sessionNumber: session.session_number,
      groupName: session.group.name,
      supervisorName: req.user.name,
      notes,
      sessionDate: session.scheduled_date,
    });

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('sessions')
      .update({
        notes,
        status: 'completed',
        email_sent_at: now,
        ready_to_lock_at: now,
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ ...data, emailSimulated: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/:id/lock — admin or supervisor locks session
router.post('/:id/lock', requireAuth, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select('*, group:groups(supervisor_id)')
      .eq('id', req.params.id)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.ready_to_lock_at) return res.status(400).json({ error: 'Session is not ready to be locked' });
    if (session.locked_at) return res.status(400).json({ error: 'Session is already locked' });

    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data, error } = await supabase
      .from('sessions')
      .update({ locked_at: new Date().toISOString(), locked_by: req.user.id })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/:id/cancel
router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select('*, group:groups(supervisor_id)')
      .eq('id', req.params.id)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.locked_at) return res.status(400).json({ error: 'Cannot cancel a locked session' });

    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data, error } = await supabase
      .from('sessions')
      .update({ status: 'cancelled' })
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

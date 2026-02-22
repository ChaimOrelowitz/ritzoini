const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');

// ─── Auto-complete stale sessions (Option A: run on fetch) ────
async function autoCompleteSessions(groupId) {
  const now = new Date();

  // Fetch scheduled sessions not manually overridden
  const { data: staleSessions } = await supabase
    .from('sessions')
    .select('id, session_date, end_time')
    .eq('group_id', groupId)
    .eq('status', 'scheduled')
    .eq('status_manual_override', false);

  if (!staleSessions?.length) return;

  const toComplete = staleSessions.filter(s => {
    if (!s.session_date || !s.end_time) return false;
    const [h, m] = s.end_time.split(':').map(Number);
    const endDateTime = new Date(s.session_date + 'T00:00:00');
    endDateTime.setHours(h, m, 0, 0);
    return now > endDateTime;
  });

  if (!toComplete.length) return;

  await supabase
    .from('sessions')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .in('id', toComplete.map(s => s.id));
}

// ─── GET /api/sessions?group_id=xxx ───────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { group_id } = req.query;
    if (!group_id) return res.status(400).json({ error: 'group_id is required' });

    // Check access
    const { data: group } = await supabase
      .from('groups')
      .select('supervisor_id')
      .eq('id', group_id)
      .single();

    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (req.user.role === 'supervisor' && group.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Auto-complete stale sessions before returning
    await autoCompleteSessions(group_id);

    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('group_id', group_id)
      .order('session_number', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/sessions/:id ───────────────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select('*, group:groups(supervisor_id)')
      .eq('id', req.params.id)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const allowed = [
      'soap_note', 'status', 'status_manual_override',
      'email_sent', 'ready_to_lock', 'locked',
      'session_date', 'start_time', 'end_time', 'ecw_time',
    ];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    // If status is being manually set, flag it
    if (updates.status !== undefined && updates.status_manual_override === undefined) {
      updates.status_manual_override = true;
    }

    // If locked is being set to true, record who/when
    if (updates.locked === true && !session.locked) {
      updates.locked_at  = new Date().toISOString();
      updates.locked_by  = req.user.id;
    }
    if (updates.locked === false) {
      updates.locked_at = null;
      updates.locked_by = null;
    }

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

// ─── POST /api/sessions/:id/cancel ────────────────────────────
router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select('*, group:groups(supervisor_id)')
      .eq('id', req.params.id)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data, error } = await supabase
      .from('sessions')
      .update({ status: 'cancelled', status_manual_override: true })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sessions/:id/return-to-auto ────────────────────
router.post('/:id/return-to-auto', requireAuth, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select('*, group:groups(supervisor_id)')
      .eq('id', req.params.id)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Re-evaluate status based on current time
    let newStatus = 'scheduled';
    if (session.session_date && session.end_time) {
      const [h, m] = session.end_time.split(':').map(Number);
      const endDT = new Date(session.session_date + 'T00:00:00');
      endDT.setHours(h, m, 0, 0);
      if (new Date() > endDT) newStatus = 'completed';
    }

    const { data, error } = await supabase
      .from('sessions')
      .update({ status: newStatus, status_manual_override: false })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sessions/:id/submit-notes (legacy compat) ──────
router.post('/:id/submit-notes', requireAuth, async (req, res) => {
  try {
    const { notes, soap_note } = req.body;
    const note = soap_note || notes;
    if (!note?.trim()) return res.status(400).json({ error: 'Note is required' });

    const { data: session } = await supabase
      .from('sessions')
      .select('*, group:groups(name, group_name, supervisor_id)')
      .eq('id', req.params.id)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Simulate email
    console.log(`📧 EMAIL SIMULATED: Session #${session.session_number} notes for ${session.group.group_name || session.group.name}`);

    const { data, error } = await supabase
      .from('sessions')
      .update({
        soap_note: note,
        notes: note,
        status: 'completed',
        status_manual_override: true,
        email_sent: true,
        ready_to_lock: true,
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

// ─── POST /api/sessions/:id/lock (legacy compat) ──────────────
router.post('/:id/lock', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .update({
        locked: true,
        locked_at: new Date().toISOString(),
        locked_by: req.user.id,
      })
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

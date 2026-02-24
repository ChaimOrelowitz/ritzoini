const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');

function addMinutesToTime(timeStr, mins) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + parseInt(mins);
  return `${String(Math.floor(total / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
}

async function autoCompleteSessions(groupId) {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const { data } = await supabase
    .from('sessions')
    .select('id, session_date, scheduled_date, start_time, scheduled_time, duration')
    .eq('group_id', groupId)
    .eq('status', 'scheduled')
    .eq('status_manual_override', false);

  if (!data?.length) return;
  const toComplete = data.filter(s => {
    const dateStr = s.session_date || s.scheduled_date;
    const timeStr = s.start_time   || s.scheduled_time;
    if (!dateStr || !timeStr) return false;
    const dur = s.duration || 45;
    const [h, m] = timeStr.split(':').map(Number);
    const endDT = new Date(dateStr + 'T00:00:00');
    endDT.setHours(h, m + dur, 0, 0);
    return fiveMinAgo > endDT;
  });
  if (toComplete.length)
    await supabase.from('sessions').update({ status: 'completed' }).in('id', toComplete.map(s => s.id));
}

// GET /api/sessions?group_id=xxx
router.get('/', requireAuth, async (req, res) => {
  try {
    const { group_id } = req.query;
    if (!group_id) return res.status(400).json({ error: 'group_id is required' });
    const { data: group } = await supabase.from('groups').select('supervisor_id').eq('id', group_id).single();
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (req.user.role === 'supervisor' && group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    await autoCompleteSessions(group_id);

    const { data, error } = await supabase
      .from('sessions').select('*').eq('group_id', group_id)
      .order('session_number', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/sessions/:id
// NOTE: group_ended status CAN be manually changed via status dropdown — just set status_manual_override=true
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions').select('*, group:groups(supervisor_id, default_duration)')
      .eq('id', req.params.id).single();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const allowed = [
      'soap_note', 'status', 'status_manual_override',
      'email_sent', 'ready_to_lock', 'locked',
      'session_date', 'start_time', 'ecw_time', 'duration',
    ];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));

    // Any manual status change (including out of group_ended) → flag override
    if (updates.status !== undefined && updates.status_manual_override === undefined)
      updates.status_manual_override = true;

    const effStartTime = updates.start_time || session.start_time || session.scheduled_time;
    const effDuration  = parseInt(updates.duration || session.duration || session.group.default_duration || 45);
    if (updates.start_time || updates.duration)
      updates.end_time = addMinutesToTime(effStartTime, effDuration);

    if (updates.session_date) {
      const [y, m, d] = updates.session_date.split('-').map(Number);
      updates.session_day_of_week = new Date(y, m - 1, d).getDay();
      updates.scheduled_date = updates.session_date;
    }
    if (updates.locked === true  && !session.locked) { updates.locked_at = new Date().toISOString(); updates.locked_by = req.user.id; }
    if (updates.locked === false) { updates.locked_at = null; updates.locked_by = null; }

    const { data, error } = await supabase
      .from('sessions').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/sessions/:id/cancel
// Cancels session and appends a replacement at end
router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select('*, group:groups(supervisor_id, start_time, session_time, ecw_time, default_duration)')
      .eq('id', req.params.id).single();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    await supabase.from('sessions')
      .update({ status: 'cancelled', status_manual_override: true })
      .eq('id', req.params.id);

    // Find last session to compute next date
    const { data: lastSession } = await supabase
      .from('sessions')
      .select('id, session_date, scheduled_date, session_number')
      .eq('group_id', session.group_id)
      .order('session_number', { ascending: false })
      .limit(1).single();

    let newSessionId = null;
    if (lastSession) {
      const lastDate = lastSession.session_date || lastSession.scheduled_date;
      const [y, m, d] = lastDate.split('-').map(Number);
      const next = new Date(y, m - 1, d);
      next.setDate(next.getDate() + 7);
      const nextDateStr = next.toISOString().split('T')[0];

      const g = session.group;
      const sTime = g.start_time || g.session_time || '09:00';
      const dur   = g.default_duration || 45;
      const eTime = addMinutesToTime(sTime, dur);
      const newNum = lastSession.session_number + 1;

      const { data: newSess } = await supabase.from('sessions').insert({
        group_id: session.group_id, session_number: newNum,
        session_date: nextDateStr, scheduled_date: nextDateStr,
        start_time: sTime, scheduled_time: sTime, end_time: eTime,
        ecw_time: g.ecw_time || sTime, duration: dur,
        session_day_of_week: new Date(next).getDay(),
        status: 'scheduled', status_manual_override: false,
        // Track which session this replaces
        replaced_session_id: req.params.id,
      }).select().single();

      newSessionId = newSess?.id;

      await supabase.from('groups').update({ total_sessions: newNum }).eq('id', session.group_id);
    }

    res.json({ success: true, new_session_id: newSessionId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/sessions/:id/uncancel
// Restores a cancelled session:
// 1. Finds the replacement session (the one added at the end when this was cancelled)
// 2. If the replacement is still unused (scheduled, no soap_note), removes it
// 3. Restores this session to scheduled
router.post('/:id/uncancel', requireAuth, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions').select('*, group:groups(supervisor_id, total_sessions)')
      .eq('id', req.params.id).single();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'cancelled') return res.status(400).json({ error: 'Session is not cancelled' });
    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    // Try to find the replacement: either tracked by replaced_session_id, or last session in group
    let replacementId = null;

    // First: look for a session that explicitly replaced this one
    const { data: tracked } = await supabase
      .from('sessions')
      .select('id, session_number, status, soap_note, notes')
      .eq('group_id', session.group_id)
      .eq('replaced_session_id', req.params.id)
      .single();

    if (tracked) {
      replacementId = tracked.id;
    } else {
      // Fallback: last session in group that's still scheduled and empty
      const { data: last } = await supabase
        .from('sessions')
        .select('id, session_number, status, soap_note, notes')
        .eq('group_id', session.group_id)
        .order('session_number', { ascending: false })
        .limit(1).single();

      if (last && last.id !== req.params.id && last.status === 'scheduled' && !last.soap_note && !last.notes) {
        replacementId = last.id;
      }
    }

    if (replacementId) {
      const { data: rep } = await supabase.from('sessions').select('session_number, soap_note, notes, status').eq('id', replacementId).single();
      // Only remove if it's still unused
      if (!rep.soap_note && !rep.notes && rep.status === 'scheduled') {
        await supabase.from('sessions').delete().eq('id', replacementId);
        await supabase.from('groups')
          .update({ total_sessions: rep.session_number - 1 })
          .eq('id', session.group_id);
      }
    }

    // Restore the original session
    const { data, error } = await supabase
      .from('sessions')
      .update({ status: 'scheduled', status_manual_override: false })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/sessions/:id/return-to-auto
router.post('/:id/return-to-auto', requireAuth, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions').select('*, group:groups(supervisor_id)').eq('id', req.params.id).single();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const dateStr = session.session_date || session.scheduled_date;
    const timeStr = session.start_time   || session.scheduled_time;
    let newStatus = 'scheduled';
    if (dateStr && timeStr) {
      const dur = session.duration || 45;
      const [h, m] = timeStr.split(':').map(Number);
      const endDT = new Date(dateStr + 'T00:00:00');
      endDT.setHours(h, m + dur, 0, 0);
      if (new Date(Date.now() - 5 * 60 * 1000) > endDT) newStatus = 'completed';
    }

    const { data, error } = await supabase
      .from('sessions').update({ status: newStatus, status_manual_override: false })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/sessions/bulk-notes/:groupId
router.post('/bulk-notes/:groupId', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { notes_text } = req.body;
    if (!notes_text?.trim()) return res.status(400).json({ error: 'notes_text is required' });

    const { data: group } = await supabase.from('groups').select('supervisor_id').eq('id', groupId).single();
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (req.user.role === 'supervisor' && group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const chunks = notes_text.split(/\n?---\n?/).map(c => c.trim()).filter(Boolean);
    const { data: sessions } = await supabase
      .from('sessions').select('id, session_number, status')
      .eq('group_id', groupId).neq('status', 'cancelled')
      .order('session_number', { ascending: true });

    if (!sessions?.length) return res.status(400).json({ error: 'No sessions found' });
    const count = Math.min(chunks.length, sessions.length);
    await Promise.all(Array.from({ length: count }, (_, i) =>
      supabase.from('sessions').update({ soap_note: chunks[i], notes: chunks[i] }).eq('id', sessions[i].id)
    ));
    res.json({ success: true, updated: count, total_chunks: chunks.length, total_sessions: sessions.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Legacy
router.post('/:id/submit-notes', requireAuth, async (req, res) => {
  try {
    const { notes, soap_note } = req.body;
    const note = soap_note || notes;
    if (!note?.trim()) return res.status(400).json({ error: 'Note is required' });
    const { data, error } = await supabase.from('sessions')
      .update({ soap_note: note, notes: note, status: 'completed', status_manual_override: true, email_sent: true, ready_to_lock: true })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/lock', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('sessions')
      .update({ locked: true, locked_at: new Date().toISOString(), locked_by: req.user.id })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');

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

// Auto-complete sessions whose ECW end time has passed (5 min buffer)
// Uses ecw_end_time (not start_time) as the trigger
async function autoCompleteSessions(groupId) {
  const now = new Date();

  const { data } = await supabase
    .from('sessions')
    .select('id, session_date, scheduled_date, ecw_time, ecw_end_time, duration')
    .eq('group_id', groupId)
    .eq('status', 'scheduled')
    .eq('status_manual_override', false);

  if (!data?.length) return;

  const toComplete = data.filter(s => {
    const dateStr  = s.session_date || s.scheduled_date;
    // Use ecw_end_time if available, otherwise compute from ecw_time + duration
    const ecwEnd   = s.ecw_end_time || computeEcwEnd(s.ecw_time, s.duration);
    if (!dateStr || !ecwEnd) return false;

    const [h, m] = ecwEnd.slice(0,5).split(':').map(Number);
    const endDT = new Date(dateStr + 'T00:00:00');
    endDT.setHours(h, m, 0, 0);
    // 5 minutes after ECW end
    return now > new Date(endDT.getTime() + 5 * 60 * 1000);
  });

  if (!toComplete.length) return;

  await supabase.from('sessions')
    .update({ status: 'completed' })
    .in('id', toComplete.map(s => s.id));

  // After completing, check if group should auto-complete
  await checkGroupAutoComplete(groupId);
}

// If ALL sessions in group are locked → set group status = completed
async function checkGroupAutoComplete(groupId) {
  const { data: sessions } = await supabase
    .from('sessions')
    .select('id, status, locked')
    .eq('group_id', groupId);

  if (!sessions?.length) return;

  // Only count non-cancelled, non-group_ended sessions
  const active = sessions.filter(s => s.status !== 'cancelled' && s.status !== 'group_ended');
  if (!active.length) return;

  const allLocked = active.every(s => s.locked === true);
  if (!allLocked) return;

  // Check none are still scheduled or completed-but-not-locked
  const allDone = active.every(s => s.locked === true);
  if (allDone) {
    await supabase.from('groups')
      .update({ status: 'completed' })
      .eq('id', groupId)
      .neq('status', 'completed'); // don't double-update
  }
}

// GET /api/sessions?group_id=xxx
router.get('/', requireAuth, async (req, res) => {
  try {
    const { group_id } = req.query;
    if (!group_id) return res.status(400).json({ error: 'group_id is required' });

    const { data: group } = await supabase
      .from('groups').select('supervisor_id').eq('id', group_id).single();
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
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select('*, group:groups(supervisor_id, default_duration, ecw_time)')
      .eq('id', req.params.id).single();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const allowed = [
      'soap_note', 'status', 'status_manual_override',
      'email_sent', 'ready_to_lock', 'locked',
      'session_date', 'start_time', 'ecw_time', 'ecw_end_time', 'duration',
    ];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    if (updates.status !== undefined && updates.status_manual_override === undefined)
      updates.status_manual_override = true;

    const effDuration = parseInt(updates.duration || session.duration || session.group.default_duration || 45);

    // Recompute end_time from start_time
    const effStartTime = updates.start_time || session.start_time || session.scheduled_time;
    if (updates.start_time || updates.duration)
      updates.end_time = addMinutesToTime(effStartTime, effDuration);

    // Recompute ecw_end_time from ecw_time
    const effEcwTime = updates.ecw_time || session.ecw_time || session.group.ecw_time;
    if (updates.ecw_time || updates.duration)
      updates.ecw_end_time = computeEcwEnd(effEcwTime, effDuration);

    if (updates.session_date) {
      const [y, m, d] = updates.session_date.split('-').map(Number);
      updates.session_day_of_week = new Date(y, m - 1, d).getDay();
      updates.scheduled_date = updates.session_date;
    }

    if (updates.locked === true  && !session.locked) {
      updates.locked_at  = new Date().toISOString();
      updates.locked_by  = req.user.id;
    }
    if (updates.locked === false) {
      updates.locked_at = null;
      updates.locked_by = null;
    }

    const { data, error } = await supabase
      .from('sessions').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;

    // If just locked, check if group should auto-complete
    if (updates.locked === true) {
      await checkGroupAutoComplete(session.group_id);
    }

    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/sessions/:id/cancel
router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { data: session, error: loadErr } = await supabase
      .from('sessions')
      .select('id, group_id, status, session_number, group:groups(id, supervisor_id, start_time, session_time, ecw_time, ecw_end_time, default_duration)')
      .eq('id', req.params.id).single();

    if (loadErr || !session) return res.status(404).json({ error: 'Session not found' });
    if (session.status === 'cancelled') return res.status(400).json({ error: 'Already cancelled' });
    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const g = session.group;
    const sTime   = (g.start_time || g.session_time || '09:00').slice(0, 5);
    const dur     = parseInt(g.default_duration) || 45;
    const eTime   = addMinutesToTime(sTime, dur);
    const ecwTime = (g.ecw_time || sTime).slice(0, 5);
    const ecwEnd  = g.ecw_end_time || computeEcwEnd(ecwTime, dur);

    const { data: allSessions, error: allErr } = await supabase
      .from('sessions')
      .select('id, session_number, session_date, scheduled_date')
      .eq('group_id', session.group_id)
      .order('session_number', { ascending: false });
    if (allErr) throw allErr;

    const lastSess    = allSessions[0];
    const lastDateStr = lastSess.session_date || lastSess.scheduled_date;
    if (!lastDateStr) throw new Error('Last session has no date');

    const [y, m, d] = lastDateStr.split('-').map(Number);
    const nextDate  = new Date(y, m - 1, d);
    nextDate.setDate(nextDate.getDate() + 7);
    const nextDateStr = nextDate.toISOString().split('T')[0];
    const newNum      = lastSess.session_number + 1;

    const { data: newSess, error: insertErr } = await supabase
      .from('sessions')
      .insert({
        group_id: session.group_id, session_number: newNum,
        session_date: nextDateStr, scheduled_date: nextDateStr,
        start_time: sTime, scheduled_time: sTime, end_time: eTime,
        ecw_time: ecwTime, ecw_end_time: ecwEnd,
        duration: dur, session_day_of_week: nextDate.getDay(),
        status: 'scheduled', status_manual_override: false,
      })
      .select().single();
    if (insertErr) throw new Error(`Could not create replacement: ${insertErr.message}`);

    // Cancel original + store replacement ref
    await supabase.from('sessions')
      .update({ status: 'cancelled', status_manual_override: true, replacement_session_id: newSess.id })
      .eq('id', req.params.id);

    await supabase.from('groups')
      .update({ total_sessions: newNum })
      .eq('id', session.group_id);

    res.json({ success: true, new_session: newSess });
  } catch (err) {
    console.error('[cancel]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/:id/uncancel
router.post('/:id/uncancel', requireAuth, async (req, res) => {
  try {
    const { data: session, error: loadErr } = await supabase
      .from('sessions')
      .select('id, group_id, status, session_number, replacement_session_id, group:groups(supervisor_id)')
      .eq('id', req.params.id).single();

    if (loadErr || !session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'cancelled') return res.status(400).json({ error: 'Not cancelled' });
    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    let replacementId = null, replacementNum = null;

    if (session.replacement_session_id) {
      const { data: rep } = await supabase
        .from('sessions').select('id, session_number, status, soap_note, notes')
        .eq('id', session.replacement_session_id).single();
      if (rep && rep.status === 'scheduled' && !rep.soap_note && !rep.notes) {
        replacementId = rep.id; replacementNum = rep.session_number;
      }
    }

    if (!replacementId) {
      const { data: last } = await supabase
        .from('sessions').select('id, session_number, status, soap_note, notes')
        .eq('group_id', session.group_id)
        .order('session_number', { ascending: false }).limit(1).single();
      if (last && last.id !== session.id && last.session_number > session.session_number
        && last.status === 'scheduled' && !last.soap_note && !last.notes) {
        replacementId = last.id; replacementNum = last.session_number;
      }
    }

    if (replacementId) {
      await supabase.from('sessions').delete().eq('id', replacementId);
      await supabase.from('groups')
        .update({ total_sessions: replacementNum - 1 })
        .eq('id', session.group_id);
    }

    const { data, error } = await supabase
      .from('sessions')
      .update({ status: 'scheduled', status_manual_override: false, replacement_session_id: null })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('[uncancel]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/:id/return-to-auto
router.post('/:id/return-to-auto', requireAuth, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions').select('*, group:groups(supervisor_id)')
      .eq('id', req.params.id).single();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const dateStr  = session.session_date || session.scheduled_date;
    const ecwEnd   = session.ecw_end_time || computeEcwEnd(session.ecw_time, session.duration);
    let newStatus  = 'scheduled';
    if (dateStr && ecwEnd) {
      const [h, m] = ecwEnd.slice(0,5).split(':').map(Number);
      const endDT  = new Date(dateStr + 'T00:00:00');
      endDT.setHours(h, m, 0, 0);
      if (new Date() > new Date(endDT.getTime() + 5 * 60 * 1000)) newStatus = 'completed';
    }

    const { data, error } = await supabase
      .from('sessions')
      .update({ status: newStatus, status_manual_override: false })
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

    const { data: group } = await supabase
      .from('groups').select('supervisor_id').eq('id', groupId).single();
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
      supabase.from('sessions')
        .update({ soap_note: chunks[i], notes: chunks[i] })
        .eq('id', sessions[i].id)
    ));
    res.json({ success: true, updated: count, total_chunks: chunks.length, total_sessions: sessions.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    const { data: session } = await supabase.from('sessions').select('group_id').eq('id', req.params.id).single();
    const { data, error } = await supabase.from('sessions')
      .update({ locked: true, locked_at: new Date().toISOString(), locked_by: req.user.id })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    if (session?.group_id) await checkGroupAutoComplete(session.group_id);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

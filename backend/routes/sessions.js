const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');

function addMinutesToTime(timeStr, mins) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + parseInt(mins || 0);
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
    await supabase.from('sessions').update({ status: 'completed' })
      .in('id', toComplete.map(s => s.id));
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
      .select('*, group:groups(supervisor_id, default_duration)')
      .eq('id', req.params.id).single();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const allowed = [
      'soap_note', 'status', 'status_manual_override',
      'email_sent', 'ready_to_lock', 'locked',
      'session_date', 'start_time', 'ecw_time', 'duration',
    ];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

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
// ALWAYS creates a replacement session at the end.
// Stores the replacement's ID on the cancelled session for reliable uncancel.
router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    // ── 1. Load session + group ────────────────────────────────
    const { data: session, error: loadErr } = await supabase
      .from('sessions')
      .select('id, group_id, status, session_number, group:groups(id, supervisor_id, start_time, session_time, ecw_time, default_duration)')
      .eq('id', req.params.id)
      .single();

    if (loadErr || !session) return res.status(404).json({ error: 'Session not found' });
    if (session.status === 'cancelled') return res.status(400).json({ error: 'Session is already cancelled' });
    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const g = session.group;
    const sTime = ((g.start_time || g.session_time || '09:00')).slice(0, 5);
    const dur   = parseInt(g.default_duration) || 45;
    const eTime = addMinutesToTime(sTime, dur);
    const ecwTime = ((g.ecw_time || g.start_time || g.session_time || '09:00')).slice(0, 5);

    // ── 2. Find current last session to compute next date ─────
    const { data: allSessions, error: allErr } = await supabase
      .from('sessions')
      .select('id, session_number, session_date, scheduled_date')
      .eq('group_id', session.group_id)
      .order('session_number', { ascending: false });

    if (allErr) throw allErr;
    if (!allSessions?.length) throw new Error('No sessions found in group');

    const lastSess = allSessions[0];
    const lastDateStr = lastSess.session_date || lastSess.scheduled_date;
    if (!lastDateStr) throw new Error('Last session has no date');

    const [y, m, d] = lastDateStr.split('-').map(Number);
    const nextDate = new Date(y, m - 1, d);
    nextDate.setDate(nextDate.getDate() + 7);
    const nextDateStr = nextDate.toISOString().split('T')[0];
    const nextDow     = nextDate.getDay();
    const newNum      = lastSess.session_number + 1;

    // ── 3. Insert replacement session ─────────────────────────
    // Build the insert object without replaced_session_id first,
    // then try to add it (in case the column doesn't exist yet).
    const insertPayload = {
      group_id:            session.group_id,
      session_number:      newNum,
      session_date:        nextDateStr,
      scheduled_date:      nextDateStr,
      start_time:          sTime,
      scheduled_time:      sTime,
      end_time:            eTime,
      ecw_time:            ecwTime,
      duration:            dur,
      session_day_of_week: nextDow,
      status:              'scheduled',
      status_manual_override: false,
    };

    const { data: newSess, error: insertErr } = await supabase
      .from('sessions')
      .insert(insertPayload)
      .select()
      .single();

    if (insertErr) {
      console.error('[cancel] insert replacement error:', JSON.stringify(insertErr));
      throw new Error(`Could not create replacement session: ${insertErr.message}`);
    }

    // ── 4. Cancel the original + store replacement ref ────────
    const cancelUpdate = { status: 'cancelled', status_manual_override: true };
    // Try to store the replacement ID for reliable uncancel
    // (column may not exist if migration-uncancel.sql wasn't run)
    try {
      await supabase.from('sessions')
        .update({ ...cancelUpdate, replacement_session_id: newSess.id })
        .eq('id', req.params.id);
    } catch {
      // Column might not exist — just cancel without the link
      await supabase.from('sessions')
        .update(cancelUpdate)
        .eq('id', req.params.id);
    }

    // ── 5. Update group total_sessions ────────────────────────
    const { error: groupErr } = await supabase.from('groups')
      .update({ total_sessions: newNum })
      .eq('id', session.group_id);
    if (groupErr) console.warn('[cancel] group update error:', groupErr.message);

    res.json({ success: true, new_session: newSess });
  } catch (err) {
    console.error('[cancel] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/:id/uncancel
// Restores a cancelled session.
// Removes the replacement ONLY if it's still unused (scheduled, no soap note).
router.post('/:id/uncancel', requireAuth, async (req, res) => {
  try {
    // ── 1. Load session ───────────────────────────────────────
    const { data: session, error: loadErr } = await supabase
      .from('sessions')
      .select('id, group_id, status, session_number, replacement_session_id, group:groups(supervisor_id)')
      .eq('id', req.params.id)
      .single();

    if (loadErr || !session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'cancelled') return res.status(400).json({ error: 'Session is not cancelled' });
    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    // ── 2. Find the replacement to remove ─────────────────────
    let replacementId  = null;
    let replacementNum = null;

    // Option A: use the stored link (most reliable)
    if (session.replacement_session_id) {
      const { data: rep } = await supabase
        .from('sessions')
        .select('id, session_number, status, soap_note, notes')
        .eq('id', session.replacement_session_id)
        .single();

      if (rep && rep.status === 'scheduled' && !rep.soap_note && !rep.notes) {
        replacementId  = rep.id;
        replacementNum = rep.session_number;
      }
    }

    // Option B: fall back to last session if it's unused and came after this one
    if (!replacementId) {
      const { data: last } = await supabase
        .from('sessions')
        .select('id, session_number, status, soap_note, notes')
        .eq('group_id', session.group_id)
        .order('session_number', { ascending: false })
        .limit(1)
        .single();

      if (
        last &&
        last.id !== session.id &&
        last.session_number > session.session_number &&
        last.status === 'scheduled' &&
        !last.soap_note &&
        !last.notes
      ) {
        replacementId  = last.id;
        replacementNum = last.session_number;
      }
    }

    // ── 3. Remove replacement + update total_sessions ─────────
    if (replacementId) {
      const { error: delErr } = await supabase
        .from('sessions').delete().eq('id', replacementId);
      if (delErr) console.warn('[uncancel] delete replacement error:', delErr.message);

      await supabase.from('groups')
        .update({ total_sessions: replacementNum - 1 })
        .eq('id', session.group_id);
    }

    // ── 4. Restore original session ───────────────────────────
    const { data, error } = await supabase
      .from('sessions')
      .update({ status: 'scheduled', status_manual_override: false, replacement_session_id: null })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('[uncancel] error:', err.message);
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
    const { data, error } = await supabase.from('sessions')
      .update({ locked: true, locked_at: new Date().toISOString(), locked_by: req.user.id })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

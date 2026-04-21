const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');
const { sendSoapNoteEmail } = require('../utils/mailer');
const { generateSessionNote } = require('../utils/noteGenerator');

function addMinutesToTime(timeStr, mins) {
  if (!timeStr) return null;
  const [h, m] = timeStr.slice(0, 5).split(':').map(Number);
  const total = h * 60 + m + parseInt(mins || 0, 10);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function computeEcwEnd(ecwTime, duration) {
  if (!ecwTime || !duration) return null;
  return addMinutesToTime(ecwTime, duration);
}

// Helper: normalize note source (you have both soap_note and legacy notes)
function getNote(s) {
  return (s.soap_note ?? s.notes ?? null);
}

// Auto-complete sessions whose ECW end time has passed (5 min buffer)
async function autoCompleteSessions(groupId) {
  const now = new Date();

  const { data: group } = await supabase
    .from('groups')
    .select('id, ai_notes, description, total_sessions, status')
    .eq('id', groupId)
    .single();

  if (!group || group.status !== 'active') return;

  const { data } = await supabase
    .from('sessions')
    .select('id, session_number, session_date, scheduled_date, ecw_time, ecw_end_time, duration, soap_note, notes')
    .eq('group_id', groupId)
    .eq('status', 'scheduled')
    .eq('status_manual_override', false);

  if (!data?.length) return;

  const toComplete = data.filter(s => {
    const dateStr = s.session_date || s.scheduled_date;
    const ecwEnd = s.ecw_end_time || computeEcwEnd(s.ecw_time, s.duration);
    if (!dateStr || !ecwEnd) return false;
    const [h, m] = ecwEnd.slice(0, 5).split(':').map(Number);
    const endDT = new Date(dateStr + 'T00:00:00');
    endDT.setHours(h, m, 0, 0);
    return now > new Date(endDT.getTime() + 5 * 60 * 1000);
  });

  if (!toComplete.length) return;

  await supabase.from('sessions')
    .update({ status: 'completed' })
    .in('id', toComplete.map(s => s.id));

  for (const s of toComplete) {
    let shouldEmail = false;

    if (group?.ai_notes) {
      const existingNote = s.soap_note || s.notes;
      if (existingNote?.trim()) {
        // Note already exists (e.g. shifted from a cancelled session) — just email it
        shouldEmail = true;
      } else {
        // Generate a new note
        try {
          const { data: prevSessions } = await supabase
            .from('sessions')
            .select('session_number, soap_note, notes')
            .eq('group_id', groupId)
            .lt('session_number', s.session_number)
            .not('status', 'in', '("cancelled","group_ended")')
            .order('session_number', { ascending: true });

          const previousNotes = (prevSessions || [])
            .map(p => p.soap_note || p.notes)
            .filter(Boolean);

          const note = await generateSessionNote(
            group.description || '',
            s.session_number,
            group.total_sessions || 0,
            previousNotes
          );

          await supabase.from('sessions')
            .update({ soap_note: note, notes: note })
            .eq('id', s.id);

          shouldEmail = true;
        } catch (err) {
          console.error(`[noteGenerator] Failed to generate note for session ${s.id}:`, err.message);
        }
      }
    } else {
      // Manual mode: only email if a note already exists
      const currentNote = s.soap_note || s.notes;
      shouldEmail = !!currentNote?.trim();
    }

    if (shouldEmail) await sendSoapNoteEmail(s.id);
  }

  await checkGroupAutoComplete(groupId);
}

// If ALL sessions in group are locked OR all are completed → set group status = completed
async function checkGroupAutoComplete(groupId) {
  const { data: sessions } = await supabase
    .from('sessions')
    .select('id, status, locked')
    .eq('group_id', groupId);

  if (!sessions?.length) return;

  const active = sessions.filter(s => s.status !== 'cancelled' && s.status !== 'group_ended' && s.status !== 'skipped');
  if (!active.length) return;

  const allLocked = active.every(s => s.locked === true);
  const allCompleted = active.every(s => s.status === 'completed');
  if (!allLocked && !allCompleted) return;

  await supabase.from('groups')
    .update({ status: 'completed' })
    .eq('id', groupId)
    .neq('status', 'completed');
}

// GET /api/sessions/calendar — all sessions across all groups, with group info
router.get('/calendar', requireAuth, async (req, res) => {
  try {
    const { supervisor_id, include_archived } = req.query;

    let query = supabase
      .from('sessions')
      .select(`
        id, group_id, session_number, session_date, scheduled_date,
        start_time, scheduled_time, ecw_time, ecw_end_time, duration, status,
        groups!inner (
          id, internal_name, group_name, supervisor_id, archived,
          supervisor:supervisor_id ( id, first_name, last_name )
        )
      `)
      .not('status', 'in', '("cancelled","group_ended","skipped")')
      .order('session_date', { ascending: true });

    if (include_archived !== 'true') {
      query = query.eq('groups.archived', false);
    }

    query = query.eq('groups.status', 'active');

    if (req.user.role === 'supervisor') {
      query = query.eq('groups.supervisor_id', req.user.id);
    } else if (supervisor_id) {
      query = query.eq('groups.supervisor_id', supervisor_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/sessions/all — sessions dashboard across all groups
router.get('/all', requireAuth, async (req, res) => {
  try {
    const { supervisor_id } = req.query;

    let query = supabase
      .from('sessions')
      .select(`
        id, group_id, session_number, session_date, scheduled_date,
        start_time, scheduled_time, ecw_time, status, email_sent, ready_to_lock, locked,
        group:groups!inner(id, internal_name, group_name, supervisor_id)
      `)
      .not('status', 'in', '("cancelled","group_ended","skipped")')
      .not('groups.status', 'eq', 'archived')
      .order('session_date', { ascending: true });

    if (req.user.role === 'supervisor') {
      query = query.eq('groups.supervisor_id', req.user.id);
    } else if (supervisor_id) {
      query = query.eq('groups.supervisor_id', supervisor_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
      'soap_note', 'notes', 'status', 'status_manual_override',
      'email_sent', 'ready_to_lock', 'locked',
      'session_date', 'start_time', 'ecw_time', 'ecw_end_time', 'duration',
    ];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    if (updates.status !== undefined && updates.status_manual_override === undefined)
      updates.status_manual_override = true;

    // If date/time changed on a completed session, revert to scheduled only if the new time is in the future
    if ((updates.session_date || updates.start_time) && updates.status === undefined && session.status === 'completed') {
      const effectiveDate = updates.session_date || session.session_date || session.scheduled_date;
      const effectiveTime = updates.start_time || session.start_time || session.scheduled_time;
      if (effectiveDate && effectiveTime) {
        const [h, m] = effectiveTime.slice(0, 5).split(':').map(Number);
        const sessionDT = new Date(effectiveDate + 'T00:00:00');
        sessionDT.setHours(h, m, 0, 0);
        if (sessionDT > new Date()) {
          updates.status = 'scheduled';
          updates.status_manual_override = false;
        }
      }
    }

    const effDuration = parseInt(updates.duration || session.duration || session.group.default_duration || 45, 10);

    const effStartTime = updates.start_time || session.start_time || session.scheduled_time;
    if (updates.start_time || updates.duration)
      updates.end_time = addMinutesToTime(effStartTime, effDuration);

    const effEcwTime = updates.ecw_time || session.ecw_time || session.group.ecw_time;
    if (updates.ecw_time || updates.duration)
      updates.ecw_end_time = computeEcwEnd(effEcwTime, effDuration);

    if (updates.session_date) {
      const [y, m, d] = updates.session_date.split('-').map(Number);
      updates.session_day_of_week = new Date(y, m - 1, d).getDay();
      updates.scheduled_date = updates.session_date;
    }

    if (updates.locked === true && !session.locked) {
      updates.locked_at = new Date().toISOString();
      updates.locked_by = req.user.id;
    }
    if (updates.locked === false) {
      updates.locked_at = null;
      updates.locked_by = null;
    }

    const { data, error } = await supabase
      .from('sessions').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;

    if (updates.status === 'completed' && session.status !== 'completed') {
      const { data: group } = await supabase
        .from('groups')
        .select('ai_notes, description, total_sessions')
        .eq('id', session.group_id)
        .single();

      if (group?.ai_notes) {
        try {
          const { data: prevSessions } = await supabase
            .from('sessions')
            .select('session_number, soap_note, notes')
            .eq('group_id', session.group_id)
            .lt('session_number', session.session_number)
            .not('status', 'in', '("cancelled","group_ended")')
            .order('session_number', { ascending: true });

          const previousNotes = (prevSessions || [])
            .map(p => p.soap_note || p.notes)
            .filter(Boolean);

          const note = await generateSessionNote(
            group.description || '',
            session.session_number,
            group.total_sessions || 0,
            previousNotes
          );

          await supabase.from('sessions')
            .update({ soap_note: note, notes: note })
            .eq('id', req.params.id);
        } catch (err) {
          console.error(`[noteGenerator] Failed for session ${req.params.id}:`, err.message);
        }
      }

      const freshNote = updates.soap_note || session.soap_note || session.notes;
      if (group?.ai_notes || freshNote?.trim()) {
        await sendSoapNoteEmail(req.params.id);
      }
    }

    if (updates.locked === true || updates.status === 'completed') {
      await checkGroupAutoComplete(session.group_id);
    }

    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/sessions/:id/cancel
 * Behavior:
 * - Creates a new session at the end (next week from last session)
 * - Shifts notes forward "down the chain"
 * - LOCKED sessions (locked on ECW) are treated as barriers:
 *   - do not move notes into locked sessions
 *   - do not move notes out of locked sessions
 *   - do not clear notes on locked sessions
 */
/**
 * POST /api/sessions/:id/cancel
 * Behavior:
 * - Creates a new session at the end (next week from last session)
 * - Shifts notes forward "down the chain"
 *   so the cancelled session’s SOAP note moves to the next session, etc.
 * - LOCKED sessions are treated as barriers:
 *   - do not move notes into locked sessions
 *   - do not move notes out of locked sessions
 */
router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { data: session, error: loadErr } = await supabase
      .from('sessions')
      .select(
        'id, group_id, status, session_number, ' +
        'group:groups(id, supervisor_id, start_time, session_time, ecw_time, ecw_end_time, default_duration)'
      )
      .eq('id', req.params.id)
      .single();

    if (loadErr || !session) return res.status(404).json({ error: 'Session not found' });
    if (session.status === 'cancelled') return res.status(400).json({ error: 'Already cancelled' });
    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const g = session.group;

    const sTime = (g.start_time || g.session_time || '09:00').slice(0, 5);
    const dur = parseInt(g.default_duration, 10) || 45;
    const eTime = addMinutesToTime(sTime, dur);
    const ecwTime = (g.ecw_time || sTime).slice(0, 5);
    const ecwEnd = g.ecw_end_time || computeEcwEnd(ecwTime, dur);

    // Fetch all sessions ascending, including notes and locked status
    const { data: allSessions, error: allErr } = await supabase
      .from('sessions')
      .select('id, session_number, session_date, scheduled_date, soap_note, notes, locked, status')
      .eq('group_id', session.group_id)
      .order('session_number', { ascending: true });

    if (allErr) throw allErr;
    if (!allSessions?.length) throw new Error('No sessions found for group');

    // Compute where the new replacement session will go
    const lastSess = allSessions[allSessions.length - 1];
    const lastDateStr = lastSess.session_date || lastSess.scheduled_date;
    if (!lastDateStr) throw new Error('Last session has no date');

    const [y, m, d] = lastDateStr.split('-').map(Number);
    const nextDate = new Date(y, m - 1, d);
    nextDate.setDate(nextDate.getDate() + 7);
    const nextDateStr = nextDate.toISOString().split('T')[0];
    const newNum = (lastSess.session_number || 0) + 1;

    // Create new blank session at the end
    const { data: newSess, error: insertErr } = await supabase
      .from('sessions')
      .insert({
        group_id: session.group_id,
        session_number: newNum,

        session_date: nextDateStr,
        scheduled_date: nextDateStr,

        start_time: sTime,
        scheduled_time: sTime,
        end_time: eTime,

        ecw_time: ecwTime,
        ecw_end_time: ecwEnd,

        duration: dur,
        session_day_of_week: nextDate.getDay(),

        status: 'scheduled',
        status_manual_override: false,

        soap_note: null,
        notes: null,
      })
      .select()
      .single();
    if (insertErr) throw new Error(`Could not create replacement: ${insertErr.message}`);

    // ── SHIFT NOTES FORWARD ───────────────────────────────────
    // Build the chain of sessions affected by this cancel:
    //  - start at the cancelled session’s number
    //  - include sessions after it that are NOT already cancelled/group_ended
    //  - append the new replacement session at the end
    const chainBase = allSessions
      .filter(s =>
        s.session_number >= session.session_number &&
        s.status !== 'cancelled' &&
        s.status !== 'group_ended'
      )
      .sort((a, b) => a.session_number - b.session_number);

    const chain = [...chainBase, newSess];

    // Safety: make sure the cancelled session is part of the chain
    const hasCancelledInChain = chain.some(s => s.id === session.id);
    if (!hasCancelledInChain) {
      console.warn('[cancel] Cancelled session not found in shift chain, skipping note shift');
    } else {
      // Work backwards: move note from chain[i] -> chain[i+1] if BOTH are unlocked
      for (let i = chain.length - 2; i >= 0; i--) {
        const from = chain[i];
        const to = chain[i + 1];

        // barrier-safe: never move into/out of locked
        if (from.locked || to.locked) continue;

        const note = getNote(from);
        if (!note || !String(note).trim()) continue;

        // Write note onto the "next" session
        const { error: upToErr } = await supabase
          .from('sessions')
          .update({ soap_note: note, notes: note })
          .eq('id', to.id);
        if (upToErr) throw upToErr;

        // Clear note from the "from" session
        const { error: clearFromErr } = await supabase
          .from('sessions')
          .update({ soap_note: null, notes: null })
          .eq('id', from.id);
        if (clearFromErr) throw clearFromErr;
      }
    }

    // Cancel original + store replacement ref
    const { error: cancelErr } = await supabase
      .from('sessions')
      .update({
        status: 'cancelled',
        status_manual_override: true,
        replacement_session_id: newSess.id,
      })
      .eq('id', req.params.id);
    if (cancelErr) throw cancelErr;

    // Keep total_sessions in groups aligned
    await supabase
      .from('groups')
      .update({ total_sessions: newNum })
      .eq('id', session.group_id);

    res.json({ success: true, new_session: newSess });
  } catch (err) {
    console.error('[cancel]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sessions/:id/uncancel
 * Behavior:
 * - Intended as "oops undo" for cancelling the wrong session
 * - Shifts notes BACKWARD from replacement chain
 * - LOCKED sessions (locked on ECW) are barriers:
 *   - do not move notes into locked sessions
 *   - do not move notes out of locked sessions
 *   - do not clear notes on locked sessions
 * - Deletes replacement session ONLY if safe (unlocked and empty after shifting)
 */
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

    // Fetch all sessions ascending so we can shift notes back
    const { data: allSessions, error: allErr } = await supabase
      .from('sessions')
      .select('id, session_number, status, soap_note, notes, locked')
      .eq('group_id', session.group_id)
      .order('session_number', { ascending: true });

    if (allErr) throw allErr;
    if (!allSessions?.length) throw new Error('No sessions found for group');

    let replacementId = null;
    let replacementNum = null;

    // First try the stored replacement reference
    if (session.replacement_session_id) {
      const rep = allSessions.find(s => s.id === session.replacement_session_id);
      if (rep && rep.status === 'scheduled') {
        replacementId = rep.id;
        replacementNum = rep.session_number;
      }
    }

    // Fall back: last scheduled session after the cancelled one
    if (!replacementId) {
      const last = allSessions[allSessions.length - 1];
      if (
        last &&
        last.id !== session.id &&
        last.session_number > session.session_number &&
        last.status === 'scheduled'
      ) {
        replacementId = last.id;
        replacementNum = last.session_number;
      }
    }

    // If we can't find a replacement, still uncancel the session itself
    if (!replacementId) {
      const { data, error } = await supabase
        .from('sessions')
        .update({ status: 'scheduled', status_manual_override: false, replacement_session_id: null })
        .eq('id', req.params.id).select().single();
      if (error) throw error;
      return res.json(data);
    }

    const cancelledIdx = allSessions.findIndex(s => s.id === session.id);
    const replacementIdx = allSessions.findIndex(s => s.id === replacementId);
    if (cancelledIdx === -1 || replacementIdx === -1 || replacementIdx <= cancelledIdx) {
      throw new Error('Invalid replacement chain');
    }

    // Sessions between the cancelled one (exclusive) and the replacement (inclusive)
    const chain = allSessions.slice(cancelledIdx + 1, replacementIdx + 1);

    // Shift notes BACKWARDS barrier-safe:
    // move note from chain[i+1] -> chain[i] only if BOTH are unlocked
    for (let i = 0; i < chain.length - 1; i++) {
      const to = chain[i];
      const from = chain[i + 1];

      if (to.locked || from.locked) continue;

      const note = getNote(from);

      const { error: upToErr } = await supabase
        .from('sessions')
        .update({ soap_note: note, notes: note })
        .eq('id', to.id);
      if (upToErr) throw upToErr;

      const { error: clearFromErr } = await supabase
        .from('sessions')
        .update({ soap_note: null, notes: null })
        .eq('id', from.id);
      if (clearFromErr) throw clearFromErr;
    }

    // Delete the replacement session ONLY if it's safe (unlocked and empty)
    const { data: repNow, error: repErr } = await supabase
      .from('sessions')
      .select('id, locked, soap_note, notes')
      .eq('id', replacementId)
      .single();
    if (repErr) throw repErr;

    const repNoteNow = repNow ? (repNow.soap_note ?? repNow.notes ?? null) : null;

    // Restore the cancelled session first (clears replacement_session_id ref before we delete it)
    const { data, error } = await supabase
      .from('sessions')
      .update({ status: 'scheduled', status_manual_override: false, replacement_session_id: null })
      .eq('id', req.params.id).select().single();
    if (error) throw error;

    if (repNow && !repNow.locked && !repNoteNow) {
      const { error: delErr } = await supabase.from('sessions').delete().eq('id', replacementId);
      if (delErr) throw delErr;

      await supabase.from('groups')
        .update({ total_sessions: (replacementNum || 1) - 1 })
        .eq('id', session.group_id);
    }

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

    const dateStr = session.session_date || session.scheduled_date;
    const ecwEnd = session.ecw_end_time || computeEcwEnd(session.ecw_time, session.duration);
    let newStatus = 'scheduled';
    if (dateStr && ecwEnd) {
      const [h, m] = ecwEnd.slice(0, 5).split(':').map(Number);
      const endDT = new Date(dateStr + 'T00:00:00');
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
    const { notes_text, start_from } = req.body;
    if (!notes_text?.trim()) return res.status(400).json({ error: 'notes_text is required' });

    const { data: group } = await supabase
      .from('groups').select('supervisor_id').eq('id', groupId).single();
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (req.user.role === 'supervisor' && group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const chunks = notes_text.split(/\n?---\n?/).map(c => c.trim()).filter(Boolean);
    let query = supabase
      .from('sessions').select('id, session_number, status')
      .eq('group_id', groupId).neq('status', 'cancelled')
      .order('session_number', { ascending: true });

    if (start_from && parseInt(start_from) > 1) {
      query = query.gte('session_number', parseInt(start_from));
    }

    const { data: sessions } = await query;
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

// GET /api/sessions/compile-notes/:groupId
router.get('/compile-notes/:groupId', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { data: group } = await supabase
      .from('groups').select('supervisor_id').eq('id', groupId).single();
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (req.user.role === 'supervisor' && group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const { data: sessions } = await supabase
      .from('sessions').select('session_number, soap_note, notes, status')
      .eq('group_id', groupId).neq('status', 'cancelled')
      .order('session_number', { ascending: true });

    const compiled = (sessions || [])
      .filter(s => s.soap_note || s.notes)
      .map(s => `Week ${s.session_number}:\n${s.soap_note || s.notes}`)
      .join('\n\n---\n\n');

    res.json({ compiled });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/sessions/:id/generate-note
router.post('/:id/generate-note', requireAuth, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select('*, group:groups(supervisor_id, description, total_sessions, ai_notes)')
      .eq('id', req.params.id).single();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const { data: prevSessions } = await supabase
      .from('sessions')
      .select('session_number, soap_note, notes')
      .eq('group_id', session.group_id)
      .lt('session_number', session.session_number)
      .not('status', 'in', '("cancelled","group_ended")')
      .order('session_number', { ascending: true });

    const previousNotes = (prevSessions || []).map(p => p.soap_note || p.notes).filter(Boolean);

    const note = await generateSessionNote(
      session.group.description || '',
      session.session_number,
      session.group.total_sessions || 0,
      previousNotes
    );

    const { data, error } = await supabase
      .from('sessions').update({ soap_note: note, notes: note }).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/sessions/:id/send-email
router.post('/:id/send-email', requireAuth, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions').select('*, group:groups(supervisor_id)').eq('id', req.params.id).single();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });
    const note = session.soap_note || session.notes;
    if (!note?.trim()) return res.status(400).json({ error: 'No note to send' });
    await sendSoapNoteEmail(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/submit-notes', requireAuth, async (req, res) => {
  try {
    const { notes, soap_note } = req.body;
    const note = soap_note || notes;
    if (!note?.trim()) return res.status(400).json({ error: 'Note is required' });

    const { data, error } = await supabase.from('sessions')
      .update({
        soap_note: note,
        notes: note,
        status: 'completed',
        status_manual_override: true,
        ready_to_lock: true
      })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    await sendSoapNoteEmail(req.params.id);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/restore-skip', requireAuth, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions').select('*, group:groups(supervisor_id)').eq('id', req.params.id).single();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role === 'supervisor' && session.group.supervisor_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });
    const { data, error } = await supabase.from('sessions')
      .update({ status: 'scheduled', status_manual_override: false })
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
module.exports.autoCompleteSessions = autoCompleteSessions;

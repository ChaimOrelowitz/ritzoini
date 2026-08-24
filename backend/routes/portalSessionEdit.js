const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');

function requirePortal(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.portal_only !== true) {
    return res.status(403).json({ error: 'Portal POC access required' });
  }
  next();
}

const guard = [requireAuth, requirePortal];

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function clockFromMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ap}`;
}

// Intercept only session-field edits. Every other PATCH continues to the
// existing Portal POC router unchanged.
router.patch('/runs/:runId/notes/:noteId', ...guard, async (req, res, next) => {
  const editsSession = req.body?.session_date !== undefined
    || req.body?.session_start_minutes !== undefined
    || req.body?.duration_minutes !== undefined;
  if (!editsSession) return next();

  try {
    const { data: row, error: rowErr } = await supabase.from('portal_staged_notes')
      .select('*')
      .eq('id', req.params.noteId)
      .eq('run_id', req.params.runId)
      .maybeSingle();
    if (rowErr) throw rowErr;
    if (!row) return res.status(404).json({ error: 'Staged note not found' });
    if (row.status === 'done') {
      return res.status(409).json({ error: 'This note has already been written to InSync' });
    }
    if (row.status === 'duplicate') {
      return res.status(409).json({ error: 'This note is already marked as being in InSync' });
    }

    const note = { ...(row.note || {}) };
    const resolution = { ...(row.resolution || {}) };

    if (req.body.session_date !== undefined) {
      const date = String(req.body.session_date || '').trim();
      if (!validIsoDate(date)) {
        return res.status(400).json({ error: 'Session date must be a valid YYYY-MM-DD date' });
      }
      note.sessionDate = date;
    }

    if (req.body.session_start_minutes !== undefined) {
      const minutes = Number(req.body.session_start_minutes);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1439) {
        return res.status(400).json({ error: 'Session start time is invalid' });
      }
      note.sessionStartMinutes = minutes;
      note.sessionStartClock = clockFromMinutes(minutes);
    }

    if (req.body.duration_minutes !== undefined) {
      const duration = Number(req.body.duration_minutes);
      if (!Number.isInteger(duration) || duration <= 0 || duration > 1440) {
        return res.status(400).json({ error: 'Duration must be a positive whole number of minutes' });
      }
      note.durationMinutes = duration;
      resolution.duration = duration;
    }

    // A calendar hold describes the old date/time slot. Once Bella changes the
    // timing, the next dry/live run must check the new slot instead.
    const oldHold = resolution.calendar_hold;
    delete resolution.calendar_hold;

    const flags = (row.flags || []).filter(f => f.field !== 'encounter');
    const blocking = flags.filter(f => f.blocking !== false);
    const ready = !!(resolution.provider_id && resolution.patient_id && resolution.visit_type_id
      && Number(note.durationMinutes) > 0 && blocking.length === 0);

    resolution.duration = Number(note.durationMinutes) || resolution.duration || 0;
    if (ready) resolution.needs = [];
    else if (oldHold && Array.isArray(resolution.needs)) {
      resolution.needs = resolution.needs.filter(n => n !== oldHold);
    }

    const status = ready ? 'ready' : (row.status === 'skipped' ? 'skipped' : 'needs_attention');
    const { error: updateErr } = await supabase.from('portal_staged_notes').update({
      note,
      resolution,
      flags,
      status,
      updated_at: new Date().toISOString(),
    }).eq('id', row.id);
    if (updateErr) throw updateErr;

    res.json({ ok: true, status, note, resolution, flags });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { generateSessionNote } = require('../utils/noteGenerator');
const { sendSoapNoteEmail, getEmailEnabled } = require('../utils/mailer');

// Simple token auth — no user session needed
function requireCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers['x-cron-secret'] || req.query.secret;
  if (!secret || provided !== secret) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// POST /api/cron/process-sessions
router.post('/process-sessions', requireCronSecret, async (req, res) => {
  const log = [];
  let processed = 0, skipped = 0, failed = 0;

  try {
    // Find completed sessions with no note and email not yet sent, for ai_notes groups
    const { data: sessions, error } = await supabase
      .from('sessions')
      .select(`
        id, session_number, group_id, soap_note, notes, email_sent,
        group:groups!group_id(
          id, description, total_sessions, ai_notes,
          supervisor:profiles!supervisor_id(email, email_enabled)
        )
      `)
      .eq('status', 'completed')
      .eq('email_sent', false)
      .or('soap_note.is.null,soap_note.eq.')
      .limit(50); // cap per run to avoid timeouts

    if (error) throw error;

    for (const session of (sessions || [])) {
      const group = session.group;

      // Only process ai_notes groups
      if (!group?.ai_notes) { skipped++; continue; }

      // Respect per-user email setting
      if (group.supervisor?.email_enabled === false) { skipped++; continue; }

      try {
        // Generate note
        const { data: prevSessions } = await supabase
          .from('sessions')
          .select('session_number, soap_note, notes')
          .eq('group_id', session.group_id)
          .lt('session_number', session.session_number)
          .not('status', 'in', '("cancelled","group_ended","skipped")')
          .order('session_number', { ascending: true });

        const previousNotes = (prevSessions || []).map(p => p.soap_note || p.notes).filter(Boolean);

        const note = await generateSessionNote(
          group.description || '',
          session.session_number,
          group.total_sessions || 0,
          previousNotes
        );

        await supabase.from('sessions')
          .update({ soap_note: note, notes: note })
          .eq('id', session.id);

        // Send email (mailer checks global kill switch internally)
        await sendSoapNoteEmail(session.id);

        processed++;
        log.push({ id: session.id, status: 'ok' });
      } catch (err) {
        failed++;
        log.push({ id: session.id, status: 'error', error: err.message });
        console.error(`[cron] Failed session ${session.id}:`, err.message);
      }
    }

    console.log(`[cron] process-sessions: processed=${processed} skipped=${skipped} failed=${failed}`);
    res.json({ processed, skipped, failed, log });
  } catch (err) {
    console.error('[cron] Fatal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

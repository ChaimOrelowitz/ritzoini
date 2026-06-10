const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { autoCompleteSessions } = require('./sessions');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

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
    const { data: groups, error } = await supabase
      .from('groups')
      .select('id')
      .eq('status', 'active');

    if (error) throw error;

    for (const group of (groups || [])) {
      try {
        await autoCompleteSessions(group.id);
        processed++;
        log.push({ id: group.id, status: 'ok' });
      } catch (err) {
        failed++;
        log.push({ id: group.id, status: 'error', error: err.message });
        console.error(`[cron] Failed group ${group.id}:`, err.message);
      }
    }

    console.log(`[cron] process-sessions: groups=${groups?.length || 0} processed=${processed} failed=${failed}`);
    res.json({ processed, skipped, failed, log });
  } catch (err) {
    console.error('[cron] Fatal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cron/send-oo-notes
router.post('/send-oo-notes', requireCronSecret, async (req, res) => {
  const now = new Date();
  const log = [];

  // Find all scheduled appointments where send time has passed and note not yet sent
  const { data: appts, error } = await supabase
    .from('oo_appointments')
    .select('*, oo_clients(id, first_name, last_name, mrn, oo_referral_sources(name, notes_email))')
    .eq('status', 'scheduled')
    .is('note_sent_at', null);

  if (error) return res.status(500).json({ error: error.message });

  let sent = 0, alerted = 0, skipped = 0;

  for (const appt of (appts || [])) {
    // Calculate send time = date + time + duration + 5 min
    const [h, m] = appt.time.split(':').map(Number);
    const sendTime = new Date(`${appt.date}T00:00:00Z`);
    sendTime.setUTCHours(h, m + appt.duration + 5, 0, 0);

    if (now < sendTime) { skipped++; continue; }

    const client = appt.oo_clients;
    const notesEmail = client?.oo_referral_sources?.notes_email;
    const clientName = `${client?.first_name} ${client?.last_name}`;
    const apptLabel  = `${appt.date} at ${appt.time}`;

    if (!appt.raw_notes || !appt.raw_notes.trim()) {
      // BLANK — alert supervisor
      try {
        const alertEmail = process.env.SUPERVISOR_EMAIL || process.env.FROM_EMAIL;
        if (alertEmail) {
          await resend.emails.send({
            from: process.env.FROM_EMAIL || 'noreply@ritzoini.com',
            to: alertEmail,
            subject: `⚠️ Missing notes — ${clientName} (${apptLabel})`,
            html: `<p>Notes were not entered for <strong>${clientName}</strong> (MRN: ${client?.mrn || '—'}) scheduled on <strong>${apptLabel}</strong>.</p><p>Please enter notes and send manually.</p>`,
          });
        }
        await supabase.from('oo_appointments').update({ status: 'notes_missing', updated_at: now.toISOString() }).eq('id', appt.id);
        alerted++;
        log.push({ id: appt.id, client: clientName, action: 'alerted_blank' });
      } catch (err) {
        log.push({ id: appt.id, client: clientName, action: 'alert_failed', error: err.message });
      }
      continue;
    }

    if (!notesEmail) {
      skipped++;
      log.push({ id: appt.id, client: clientName, action: 'skipped_no_email' });
      continue;
    }

    // Send notes to secretary
    try {
      const result = await resend.emails.send({
        from: process.env.FROM_EMAIL || 'noreply@ritzoini.com',
        to: notesEmail,
        subject: `Session note — ${clientName} | MRN: ${client?.mrn || '—'} | ${apptLabel}`,
        html: `<p><strong>Client:</strong> ${clientName}<br><strong>MRN:</strong> ${client?.mrn || '—'}<br><strong>Appointment:</strong> ${apptLabel}</p><hr><p>${appt.raw_notes.replace(/\n/g, '<br>')}</p>`,
      });
      const emailId = result?.data?.id || result?.id || null;
      await supabase.from('oo_appointments').update({
        note_sent_at: now.toISOString(),
        note_sent_email_id: emailId,
        status: 'completed',
        updated_at: now.toISOString(),
      }).eq('id', appt.id);
      sent++;
      log.push({ id: appt.id, client: clientName, action: 'sent' });
    } catch (err) {
      log.push({ id: appt.id, client: clientName, action: 'send_failed', error: err.message });
    }
  }

  console.log(`[cron] send-oo-notes: sent=${sent} alerted=${alerted} skipped=${skipped}`);
  res.json({ sent, alerted, skipped, log });
});

module.exports = router;

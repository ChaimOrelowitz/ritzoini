const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { autoCompleteSessions } = require('./sessions');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const { generateOrRefreshDigest } = require('../utils/peerDigestGenerator');

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

// POST /api/cron/generate-peer-digests
// Runs once per day. Finds OO appointments scheduled for tomorrow,
// generates or refreshes a Weekly Peer Digest for each client.
router.post('/generate-peer-digests', requireCronSecret, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrowDate = new Date(Date.now() + 86400000);
  const tomorrow = tomorrowDate.toISOString().slice(0, 10);
  const windowStart = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);

  const log = [];
  let appointments_checked = 0, digests_generated = 0, digests_refreshed = 0,
      no_peer_notes = 0, errors = 0;

  try {
    const { data: appts, error: apptErr } = await supabase
      .from('oo_appointments')
      .select('id, client_id, date, oo_clients(first_name, last_name)')
      .eq('date', tomorrow)
      .eq('status', 'scheduled');
    if (apptErr) throw apptErr;

    for (const appt of (appts || [])) {
      appointments_checked++;
      const c = appt.oo_clients;
      const clientName = c ? `${c.first_name || ''} ${c.last_name || ''}`.trim() : '';
      try {
        const { summary } = await generateOrRefreshDigest({
          clientId:          appt.client_id,
          clientName,
          generationMode:    'AppointmentTriggered',
          ooAppointmentId:   appt.id,
          digestWindowStart: windowStart,
          digestWindowEnd:   today,
        });
        if (summary.digestStatus === 'No Peer Notes Found') {
          no_peer_notes++;
        } else if (summary.wasRefreshed) {
          digests_refreshed++;
        } else {
          digests_generated++;
        }
        log.push({ appt_id: appt.id, client: clientName, status: summary.digestStatus,
          notes_included: summary.notesIncluded });
      } catch (err) {
        errors++;
        log.push({ appt_id: appt.id, client: clientName, status: 'error', error: err.message });
        console.error(`[cron/generate-peer-digests] appt ${appt.id}:`, err.message);
      }
    }

    console.log(`[cron] generate-peer-digests: checked=${appointments_checked} generated=${digests_generated} refreshed=${digests_refreshed} no_notes=${no_peer_notes} errors=${errors}`);
    res.json({ appointments_checked, digests_generated, digests_refreshed, no_peer_notes, errors, log });
  } catch (err) {
    console.error('[cron/generate-peer-digests] fatal:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

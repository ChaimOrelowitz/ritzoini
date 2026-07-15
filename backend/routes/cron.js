const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { autoCompleteSessions } = require('./sessions');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const { generateOrRefreshDigest } = require('../utils/peerDigestGenerator');
const { postSoapNoteToZoho, syncZohoGroups } = require('../utils/zohoCrm');
const { getDeliveryMode } = require('../utils/soapNoteDelivery');

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

// POST /api/cron/zoho-sync-groups — daily pull of Zoho groups + auto-align.
router.post('/zoho-sync-groups', requireCronSecret, async (req, res) => {
  try {
    res.json(await syncZohoGroups());
  } catch (err) {
    console.error('[cron] zoho-sync-groups error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cron/zoho-sync
// Reposts any done-session SOAP note that isn't in Zoho yet. Handles Zoho's
// delay in making an occurrence available ("ready for notes") — a note that
// couldn't match a Zoho record when the session finished lands on a later run
// once the occurrence exists. Idempotent: already-posted sessions are skipped.
router.post('/zoho-sync', requireCronSecret, async (req, res) => {
  const mode = getDeliveryMode();
  if (mode !== 'zoho' && mode !== 'both') {
    return res.json({ skipped: true, reason: `delivery mode is '${mode}'` });
  }

  // Only recent notes: a note usually posts on completion or within a run or
  // two; anything older that still hasn't matched won't (dead group / no Zoho
  // occurrence) and shouldn't slow every run. Manual "Send Note" covers old ones.
  const WINDOW_DAYS = 14;
  const BATCH = 30;      // cap work per run so we stay well under the HTTP timeout
  const CONCURRENCY = 5; // run Zoho calls a few at a time
  const sinceDate = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  let checked = 0, posted = 0, pending = 0, failed = 0;
  const log = [];

  try {
    const { data: sessions, error } = await supabase
      .from('sessions')
      .select('id, soap_note, notes, session_date')
      .eq('status', 'completed')
      .gte('session_date', sinceDate)
      .or('zoho_posted.is.null,zoho_posted.eq.false')
      .order('session_date', { ascending: false }) // newest first
      .limit(BATCH);
    if (error) throw error;

    const todo = (sessions || []).filter(s => (s.soap_note || s.notes || '').trim());

    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      await Promise.all(todo.slice(i, i + CONCURRENCY).map(async (s) => {
        checked++;
        try {
          await postSoapNoteToZoho(s.id);
          posted++;
        } catch (err) {
          // "No ... record found" = Zoho not ready yet → retry next run.
          if (/No .* record found/i.test(err.message)) pending++;
          else { failed++; log.push({ id: s.id, error: err.message }); }
        }
      }));
    }

    console.log(`[cron] zoho-sync: checked=${checked} posted=${posted} pending=${pending} failed=${failed}`);
    res.json({ checked, posted, pending, failed, windowDays: WINDOW_DAYS, log });
  } catch (err) {
    console.error('[cron] zoho-sync fatal:', err.message);
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

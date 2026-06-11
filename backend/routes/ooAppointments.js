const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');
const { Resend } = require('resend');

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const resend    = process.env.RESEND_API_KEY    ? new Resend(process.env.RESEND_API_KEY) : null;

const MODALITIES = ['CBT','EMDR','Sand Tray','Solution Focused','Client Centered','DBT','Art Therapy','Strength Based','Family Systems','Trauma Focused','Play Therapy','Mindfulness','Behavioral Role Play','Guided Imagery','Motivational Interviewing'];

// GET all appointments (with client info)
router.get('/', requireAuth, async (req, res) => {
  const { client_id, week_start, week_end } = req.query;
  let query = supabase
    .from('oo_appointments')
    .select('*, oo_clients(id, first_name, last_name, mrn, phone, mobile, status, referral_source_id, oo_referral_sources(id, name, notes_email))')
    .order('date').order('time');

  if (client_id)  query = query.eq('client_id', client_id);
  if (week_start) query = query.gte('date', week_start);
  if (week_end)   query = query.lte('date', week_end);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET calls page data — all active clients with appointment in rolling 7-day window
router.get('/calls', requireAuth, async (req, res) => {
  const now = new Date();
  const windowEnd = new Date(now);
  windowEnd.setDate(now.getDate() + 6);
  const ws = now.toISOString().split('T')[0];
  const we = windowEnd.toISOString().split('T')[0];

  const [{ data: clients }, { data: appts }] = await Promise.all([
    supabase.from('oo_clients').select('id, first_name, last_name, mrn, referral_source_id, insync_data, oo_referral_sources(name)').eq('status', 'active').order('last_name'),
    supabase.from('oo_appointments').select('*').gte('date', ws).lte('date', we).eq('status', 'scheduled'),
  ]);

  const apptByClient = {};
  for (const a of (appts || [])) {
    if (!apptByClient[a.client_id]) apptByClient[a.client_id] = [];
    apptByClient[a.client_id].push(a);
  }

  const result = (clients || []).map(c => {
    const clientAppts = (apptByClient[c.id] || []).sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.time.localeCompare(b.time);
    });
    const nextAppt = clientAppts[0] || null;
    const called = nextAppt && nextAppt.raw_notes && nextAppt.raw_notes.trim().length > 0;
    return { ...c, next_appointment: nextAppt, called: !!called };
  });

  res.json({ clients: result, week_start: ws, week_end: we });
});

// POST create appointments (with repeat)
router.post('/', requireAuth, async (req, res) => {
  const { client_id, date, time, duration, repeat_weeks } = req.body;
  if (!client_id || !date || !time) return res.status(400).json({ error: 'client_id, date, time required' });

  const weeks = Math.max(1, parseInt(repeat_weeks) || 1);
  const dur   = parseInt(duration) || 45;
  const rows  = [];

  for (let i = 0; i < weeks; i++) {
    const d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + i * 7);
    rows.push({
      client_id,
      date: d.toISOString().split('T')[0],
      time,
      duration: dur,
      status: 'scheduled',
    });
  }

  // Check for time conflicts: same time slot, any client (including this one)
  const dates = rows.map(r => r.date);
  const { data: existing } = await supabase
    .from('oo_appointments')
    .select('date, time, client_id, oo_clients(first_name, last_name)')
    .in('date', dates)
    .eq('time', time)
    .eq('status', 'scheduled');

  const conflicts = (existing || []).map(a => {
    const who = a.client_id === client_id
      ? 'same client already booked'
      : `${a.oo_clients?.first_name} ${a.oo_clients?.last_name}`;
    return `${a.date} ${time} — ${who}`;
  });

  const { data, error } = await supabase.from('oo_appointments').insert(rows).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ appointments: data, conflicts });
});

// POST bulk schedule — assign multiple clients to days of the week, auto-assign times back-to-back
router.post('/bulk-schedule', requireAuth, async (req, res) => {
  const { assignments, weeks, start_date, start_time } = req.body;
  if (!assignments?.length || !weeks || !start_date || !start_time) {
    return res.status(400).json({ error: 'assignments, weeks, start_date, start_time required' });
  }

  // Find the Sunday of the week containing start_date
  const anchor = new Date(start_date + 'T12:00:00Z');
  const weekSunday = new Date(anchor);
  weekSunday.setUTCDate(anchor.getUTCDate() - anchor.getUTCDay());

  // Build date -> [{client_id, duration}] map
  const dateMap = {};
  for (const a of assignments) {
    for (const day of a.days) { // 0=Sun … 5=Fri
      for (let w = 0; w < weeks; w++) {
        const d = new Date(weekSunday);
        d.setUTCDate(weekSunday.getUTCDate() + w * 7 + day);
        const dateStr = d.toISOString().split('T')[0];
        if (dateStr < start_date) continue;
        if (!dateMap[dateStr]) dateMap[dateStr] = [];
        dateMap[dateStr].push({ client_id: a.client_id, duration: parseInt(a.duration) || 45 });
      }
    }
  }

  const allDates = Object.keys(dateMap);
  if (!allDates.length) return res.json({ created: 0, conflicts: [] });

  // Fetch existing scheduled appointments on these dates
  const { data: existing } = await supabase
    .from('oo_appointments')
    .select('date, time, duration, client_id')
    .in('date', allDates)
    .eq('status', 'scheduled');

  const existingByDate = {};
  for (const a of (existing || [])) {
    if (!existingByDate[a.date]) existingByDate[a.date] = [];
    existingByDate[a.date].push(a);
  }

  function timeToMins(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
  function minsToTime(m) { return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:00`; }

  const startMins = timeToMins(start_time);
  const rows = [];

  for (const date of allDates.sort()) {
    // Build sorted list of occupied intervals for this date
    const occupied = (existingByDate[date] || []).map(a => ({
      start: timeToMins(a.time),
      end:   timeToMins(a.time) + (a.duration || 45),
    })).sort((a, b) => a.start - b.start);

    let cursor = startMins;

    for (const { client_id, duration } of dateMap[date]) {
      let slotStart = cursor;
      // Push past any overlapping existing interval
      let moved = true;
      while (moved) {
        moved = false;
        for (const iv of occupied) {
          if (slotStart < iv.end && slotStart + duration > iv.start) {
            slotStart = iv.end;
            moved = true;
            break;
          }
        }
      }
      const slotEnd = slotStart + duration;
      rows.push({ client_id, date, time: minsToTime(slotStart), duration, status: 'scheduled' });
      // Reserve this slot so the next client on the same day starts after it
      occupied.push({ start: slotStart, end: slotEnd });
      occupied.sort((a, b) => a.start - b.start);
      cursor = slotEnd;
    }
  }

  const { data: inserted, error } = await supabase.from('oo_appointments').insert(rows).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ created: inserted.length, total_dates: allDates.length });
});

// POST /:id/process-note — run raw_notes through Claude, return structured fields
router.post('/:id/process-note', requireAuth, async (req, res) => {
  try {
    if (!anthropic) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
    const { raw_notes, treatment_plan } = req.body;
    if (!raw_notes?.trim()) return res.status(400).json({ error: 'raw_notes required' });

    const prompt = `You are a licensed clinical social worker's documentation assistant. The clinician has given you raw session notes and their client's treatment plan. Expand the raw notes into a complete clinical session note with the following 10 fields. Return ONLY valid JSON — no markdown, no explanation.

Raw notes:
${raw_notes}

Treatment plan (for context only, do not include in output):
${treatment_plan || '(none provided)'}

Fields to populate:
1. additional_persons_present — string, who else was on the call if anyone (leave empty string if none)
2. location_of_meeting — always exactly: "Telehealth - Video"
3. audio_only_reason — string, reason if audio-only (usually leave empty)
4. content_discussed — paragraph, what was discussed in the session
5. interventions_used — paragraph, what therapeutic interventions were used
6. modalities — array of strings, choose ONLY from: ${MODALITIES.map(m => `"${m}"`).join(', ')}
7. patient_response — paragraph, how the patient responded to the interventions
8. progress_toward_goals — paragraph, progress made toward treatment goals
9. treatment_plan_changes — string, any changes needed to the treatment plan (or "No changes at this time")
10. additional_comments — string, any other relevant clinical observations

Return exactly this JSON structure:
{
  "additional_persons_present": "",
  "location_of_meeting": "Telehealth - Video",
  "audio_only_reason": "",
  "content_discussed": "",
  "interventions_used": "",
  "modalities": [],
  "patient_response": "",
  "progress_toward_goals": "",
  "treatment_plan_changes": "",
  "additional_comments": ""
}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    const jsonStart = text.indexOf('{');
    const jsonEnd   = text.lastIndexOf('}');
    if (jsonStart === -1) return res.status(500).json({ error: 'AI returned no JSON', raw: text });
    const fields = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    await supabase.from('oo_appointments')
      .update({ ai_fields: fields, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    res.json({ fields });
  } catch (err) {
    console.error('[process-note]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/send-note — build email from processed fields, send to secretary
router.post('/:id/send-note', requireAuth, async (req, res) => {
  try {
    if (!resend) return res.status(500).json({ error: 'RESEND_API_KEY not configured on server' });
    const { fields, treatment_plan } = req.body;
    if (!fields) return res.status(400).json({ error: 'fields required' });

    // Fetch appointment + client + referral source
    const { data: appt, error: ae } = await supabase
      .from('oo_appointments')
      .select('*, oo_clients(id, first_name, last_name, mrn, referral_source_id, oo_referral_sources(name, notes_email))')
      .eq('id', req.params.id)
      .single();
    if (ae || !appt) return res.status(404).json({ error: 'Appointment not found' });

    const client = appt.oo_clients;
    const ref    = client?.oo_referral_sources;
    const toEmail = ref?.notes_email;
    if (!toEmail) return res.status(400).json({ error: 'No notes_email for this referral source' });

    const initials = client ? `${client.first_name[0]}${client.last_name[0]}`.toUpperCase() : '??';
    const mrn      = client?.mrn || appt.client_id;
    const dateStr  = appt.date || 'unknown date';

    const modStr   = (fields.modalities || []).join(', ') || '—';
    const emailHtml = `
<p><strong>Client:</strong> ${initials} (MRN: ${mrn})</p>
<p><strong>Date:</strong> ${dateStr}</p>
<hr>
<p><strong>Location of Meeting:</strong> ${fields.location_of_meeting || 'Telehealth - Video'}</p>
${fields.additional_persons_present ? `<p><strong>Additional Person(s) Present:</strong> ${fields.additional_persons_present}</p>` : ''}
${fields.audio_only_reason ? `<p><strong>Audio Only Reason:</strong> ${fields.audio_only_reason}</p>` : ''}
<p><strong>Content Discussed:</strong><br>${(fields.content_discussed || '').replace(/\n/g, '<br>')}</p>
<p><strong>Interventions Used:</strong><br>${(fields.interventions_used || '').replace(/\n/g, '<br>')}</p>
<p><strong>Modality:</strong> ${modStr}</p>
<p><strong>Patient Response:</strong><br>${(fields.patient_response || '').replace(/\n/g, '<br>')}</p>
<p><strong>Progress Toward Goals:</strong><br>${(fields.progress_toward_goals || '').replace(/\n/g, '<br>')}</p>
<p><strong>Changes to Treatment Plan:</strong><br>${(fields.treatment_plan_changes || '—').replace(/\n/g, '<br>')}</p>
${fields.additional_comments ? `<p><strong>Additional Comments:</strong><br>${fields.additional_comments.replace(/\n/g, '<br>')}</p>` : ''}
<hr>
<p><strong>── Treatment Plan ──</strong></p>
<pre style="font-family:inherit;white-space:pre-wrap">${treatment_plan || '(not provided)'}</pre>
`.trim();

    const subject = `Session Note — ${initials} (${mrn}) — ${dateStr}`;

    const { data: emailData, error: emailErr } = await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to:   toEmail,
      subject,
      html: emailHtml,
    });
    if (emailErr) return res.status(500).json({ error: emailErr.message || JSON.stringify(emailErr) });

    // Mark note sent
    const now = new Date().toISOString();
    await supabase.from('oo_appointments').update({ note_sent_at: now, updated_at: now }).eq('id', req.params.id);

    res.json({ ok: true, email_id: emailData?.id, sent_to: toEmail });
  } catch (err) {
    console.error('[send-note]', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH update appointment (notes, status)
router.patch('/:id', requireAuth, async (req, res) => {
  const allowed = ['raw_notes', 'status', 'duration', 'date', 'time', 'note_sent_at', 'note_sent_email_id', 'note_done_at', 'called_at', 'ai_fields'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('oo_appointments')
    .update(updates)
    .eq('id', req.params.id)
    .select('*, oo_clients(id, first_name, last_name, mrn)')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE
router.delete('/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('oo_appointments').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;

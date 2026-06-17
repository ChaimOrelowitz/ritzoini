const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');
const { Resend } = require('resend');
const insync = require('../utils/insync');
const { attachPendingTranscriptsForClients } = require('../utils/zoomTranscripts');

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const resend    = process.env.RESEND_API_KEY    ? new Resend(process.env.RESEND_API_KEY) : null;

const MODALITIES = ['CBT','EMDR','Sand Tray','Solution Focused','Client Centered','DBT','Art Therapy','Strength Based','Family Systems','Trauma Focused','Play Therapy','Mindfulness','Behavioral Role Play','Guided Imagery','Motivational Interviewing'];

// duration (min) → InSync VisitTypeID for Telehealth Individual Therapy
const VISIT_TYPE = { 30: 1169, 45: 1170, 60: 1171 };

// Provider/facility constants for Chaim Orelowitz @ The Derech Shalom Center
const INSYNC_PROVIDER = {
  ScheduleSetupID: '1329',
  ScheduleID:      '1399',
  ResourceId:      '2317',
  Provider:        'Orelowitz, Chaim (P)',
  FacilityId:      '199',
};

// ─── InSync note-push helpers ─────────────────────────────────────────────────
const MODALITY_VALUE_MAP = {
  'CBT': '1', 'EMDR': '3', 'Sand Tray': '5', 'Solution Focused': '6',
  'Client Centered': '7', 'DBT': '8', 'Art Therapy': '9',
  'Strength Based': '10', 'Family Systems': '11', 'Trauma Focused': '12',
  'Play Therapy': '13',
};

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Extract just the divdynamiccharting_101 form div from the full page HTML that
// PreviewConfigTemplateById returns. The full response includes outer page chrome
// (modals, credit-card dialogs, scripts, CSS) that must not appear in DynamicHTML.
function extractFormHtml(pageHtml) {
  const marker = 'id="divdynamiccharting_101"';
  const markerIdx = pageHtml.indexOf(marker);
  if (markerIdx === -1) return pageHtml;
  const start = pageHtml.lastIndexOf('<div', markerIdx);
  let depth = 0, i = start;
  while (i < pageHtml.length) {
    if (pageHtml.slice(i, i + 4) === '<div') { depth++; i += 4; }
    else if (pageHtml.slice(i, i + 6) === '</div') {
      depth--;
      if (depth === 0) return pageHtml.slice(start, i + 6);
      i += 6;
    } else i++;
  }
  return pageHtml.slice(start);
}

function fillNoteTemplate(html, encounterId, fields, providerName, patientName, locationValue, locationLabel) {
  // data-EncId uses mixed case in the blank template — replace case-insensitively
  html = html.replace(/data-[Ee]nc[Ii]d="[^"]*"/g, `data-encid="${encounterId}"`);

  // Strip dvElementsRow_1 — it's the practice logo header row (data-Type=21).
  // The browser excludes this row from DynamicHTML when saving; keeping it produces
  // a broken image container in the PDF.
  html = html.replace(/<div[^>]*id="dvElementsRow_1"[^>]*>[\s\S]*?(?=<div[^>]*id="dvElementsRow_\d)/, '');

  // Fill db-value divs for provider/patient — use \s before id= so we don't accidentally
  // match the outer wrapper div whose data-currentcontrolid attribute contains "id=ControlId_96"
  // as a substring, which would inject the name as stray text and produce a duplicate in the PDF.
  html = html.replace(
    /(<div[^>]*\sid="ControlId_96"[^>]*>)[^<]*/,
    `$1${escapeHtml(providerName || '')}`
  );
  html = html.replace(
    /(<div[^>]*\sid="ControlId_108"[^>]*>)[^<]*/,
    `$1${escapeHtml(patientName || '')}`
  );

  const textFields = [
    ['ControlId_101', fields.content_discussed      || ''],
    ['ControlId_102', fields.interventions_used     || ''],
    ['ControlId_63',  fields.patient_response       || ''],
    ['ControlId_60',  fields.progress_toward_goals  || ''],
    ['ControlId_107', fields.treatment_plan_changes || ''],
    ['ControlId_37',  fields.additional_comments    || ''],
  ];
  for (const [cid, text] of textFields) {
    html = html.replace(
      new RegExp(`<textarea[^>]*id="${cid}"[^>]*>[\\s\\S]*?<\\/textarea>`),
      `<label class="border-0 textAlign-left" id="${cid}">${escapeHtml(text)}</label>`
    );
  }

  // Remove the fixed-height style from textarea wrapper divs. The blank template wraps
  // each textarea in <div style="height:84px"> but the browser strips this when saving,
  // leaving just <div>. Without removing it the rendered PDF has a large blank space
  // above each text field.
  html = html.replace(/ style="height:\d+px"/g, '');

  // ControlId_99 and ControlId_109 are single-line text inputs (not textareas).
  // Replace them with read-only labels matching the format InSync uses in its saved HTML.
  html = html.replace(
    /<input[^>]*id="ControlId_99"[^>]*>/,
    `<label class="border-0 textAlign-left" id="ControlId_99">${escapeHtml(fields.additional_persons_present || '')}</label>`
  );
  html = html.replace(
    /<input[^>]*id="ControlId_109"[^>]*>/,
    `<label class="border-0 textAlign-left" id="ControlId_109">${escapeHtml(fields.audio_only_reason || 'patient does not have internet access')}</label>`
  );

  // ControlId_112 — blank template has raw <select>, not a SumoSelect wrapper.
  // Replace the hidden inputs + select with the selected-value format InSync expects.
  // Must include hdnFieldVal_112 (numeric value) in addition to hdnFieldText_112 (display text).
  const _locLabel = locationLabel || 'Audio only Telehealth';
  const _locValue = locationValue  || '3';
  html = html.replace(
    /<input[^>]*id="hdnFieldText_112"[^>]*>[\s\S]*?<\/select>/,
    `<input type="hidden" id="hdnFieldText_112" class="SumoSelectedText" value="${escapeHtml(_locLabel)}" name="NaN"><label class="full-width has-no-control textAlign-left">${escapeHtml(_locLabel)}</label><input type="hidden" id="hdnFieldVal_112" class="SumoSelectedVal" value="${_locValue}" name="NaN">`
  );

  // ControlId_104 — first modality has no prefix; subsequent ones get ", " inside their label
  const modalities = (fields.modalities || []).filter(m => MODALITY_VALUE_MAP[m]);
  const modalityDisplay = modalities
    .map((m, i) => i === 0
      ? `<label class=""><span class=" ">${escapeHtml(m)}</span></label>`
      : `<label class="">, <span class=" ">${escapeHtml(m)}</span></label>`)
    .join('');
  html = html.replace(
    /<div[^>]*id="divchkDynamicId_104"[^>]*>[\s\S]*?<\/div>/,
    `<div id="divchkDynamicId_104" class="elem-control has-no-label textAlign-left">${modalityDisplay}</div>`
  );

  return html;
}
// ──────────────────────────────────────────────────────────────────────────────

// GET all appointments (with client info)
router.get('/', requireAuth, async (req, res) => {
  const { client_id, week_start, week_end } = req.query;
  let query = supabase
    .from('oo_appointments')
    .select('*, oo_clients(id, first_name, last_name, mrn, phone, mobile, status, referral_source_id, insync_patient_id, insync_data, referral:oo_referral_sources!referral_source_id(id, name, notes_email))')
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
    supabase.from('oo_clients').select('id, first_name, last_name, mrn, referral_source_id, insync_data, referral:oo_referral_sources!referral_source_id(name)').eq('status', 'active').order('last_name'),
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

  const byClient = {};
  for (const r of data) (byClient[r.client_id] ||= []).push(r);
  await attachPendingTranscriptsForClients([client_id], byClient);

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

  const byClient = {};
  for (const r of inserted) (byClient[r.client_id] ||= []).push(r);
  await attachPendingTranscriptsForClients(Object.keys(byClient), byClient);

  res.json({ created: inserted.length, total_dates: allDates.length });
});

// POST /:id/process-note — run raw_notes through Claude, return structured fields
router.post('/:id/process-note', requireAuth, async (req, res) => {
  try {
    if (!anthropic) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
    const { raw_notes, treatment_plan } = req.body;
    if (!raw_notes?.trim()) return res.status(400).json({ error: 'raw_notes required' });

    const prompt = `You are a licensed clinical social worker's documentation assistant. The input below is a raw call transcript or session notes from an individual therapy session. Your job is to extract the clinically relevant content and write a concise, professional session note.

Raw notes / transcript:
${raw_notes}

Treatment plan (for context only, do not include in output):
${treatment_plan || '(none provided)'}

Return ONLY valid JSON — no markdown, no explanation, no code fences.

Instructions:
- Focus only on clinically meaningful content: what the client presented with, what was addressed, how the client responded, and what progress was observed.
- Ignore greetings, scheduling talk, logistics, and small talk entirely. Do not document phrases like "we spoke yesterday to arrange today's meeting" or any mention of how the session was set up.
- Be concise. Each paragraph field should be 2–4 sentences. Do not pad with filler.
- Do not state or imply that services took place in a school setting unless the notes explicitly and clearly support that.
- Do not mention audits, billing concerns, compliance requirements, agency rules, documentation standards, or any internal administrative pressure. These have no place in a clinical note.
- Do not include information that is not supported by the notes provided.
- Use neutral, professional clinical language appropriate for a licensed clinician's documentation.

Fields to populate:
1. additional_persons_present — string, who else was on the call if anyone (leave empty string if none)
2. content_discussed — paragraph, the clinically relevant topics and issues addressed in the session
3. interventions_used — paragraph, what therapeutic interventions and techniques were used
4. modalities — array of strings, choose ONLY from: ${MODALITIES.map(m => `"${m}"`).join(', ')}
5. patient_response — paragraph, how the client responded to interventions and engaged in the session
6. progress_toward_goals — paragraph, progress made toward treatment plan goals based on this session
7. treatment_plan_changes — string, any changes needed to the treatment plan (or "No changes at this time")
8. additional_comments — string, any other clinically relevant observations not captured above (leave empty string if none)

Return exactly this JSON structure:
{
  "additional_persons_present": "",
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
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    if (response.stop_reason === 'max_tokens')
      return res.status(500).json({ error: 'AI response was cut off (raw notes too long for one pass) — try trimming the notes and re-processing' });

    const text = response.content[0].text.trim();
    const jsonStart = text.indexOf('{');
    const jsonEnd   = text.lastIndexOf('}');
    if (jsonStart === -1) return res.status(500).json({ error: 'AI returned no JSON', raw: text });
    let fields;
    try {
      fields = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    } catch (parseErr) {
      return res.status(500).json({ error: `AI response was not valid JSON: ${parseErr.message}` });
    }
    await supabase.from('oo_appointments')
      .update({ ai_fields: fields, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    res.json({ fields });
  } catch (err) {
    console.error('[process-note]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/magic-note — generate draft ai_fields from last 7 days of peer notes + client summary
router.post('/:id/magic-note', requireAuth, async (req, res) => {
  try {
    if (!anthropic) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const { data: appt, error: ae } = await supabase
      .from('oo_appointments')
      .select('*, oo_clients(id, first_name, last_name, client_summary, insync_data)')
      .eq('id', req.params.id)
      .single();
    if (ae || !appt) return res.status(404).json({ error: 'Appointment not found' });

    const client = appt.oo_clients;
    const tp = buildTpText(client.insync_data?.treatment_plan);

    const windowEnd = new Date().toISOString().slice(0, 10);
    const d = new Date(); d.setDate(d.getDate() - 6);
    const windowStart = d.toISOString().slice(0, 10);

    const { data: peerNotes } = await supabase
      .from('insync_raw_notes')
      .select('service_date, raw_note_text, encounter_type')
      .eq('oo_client_id', client.id)
      .gte('service_date', windowStart)
      .lte('service_date', windowEnd)
      .not('raw_note_text', 'is', null)
      .neq('raw_note_text', '')
      .order('service_date', { ascending: false })
      .limit(15);

    const noteBlocks = (peerNotes || []).map((n, i) =>
      `--- Note ${i + 1} (${n.service_date || 'unknown date'}, ${n.encounter_type || 'Peer Support'}) ---\n${n.raw_note_text.trim()}`
    ).join('\n\n');

    const clientSummary = client.client_summary || null;

    if (!noteBlocks && !clientSummary) {
      return res.status(400).json({ error: 'No peer notes found in the last 7 days and no client summary on file.' });
    }

    const prompt = `You are a licensed clinical social worker's documentation assistant. Based on the context below, write a realistic individual therapy session note — as if the session has already occurred.

${clientSummary ? `CLIENT SUMMARY (background context about this client):\n${clientSummary}\n\n` : ''}${noteBlocks ? `PEER SUPPORT NOTES (last 7 days — for context only):\n${noteBlocks}\n\n` : ''}Treatment plan (for context only, do not include in output):
${tp || '(none provided)'}

Based on this context, generate what a realistic therapy session note would look like. Write as if the session took place — describe what the client likely presented with, what was addressed, how the client responded. Base this on the patterns and themes visible in the peer notes and client history.

Rules:
- Write in past tense as a completed session
- Do NOT quote directly from the peer notes — translate patterns and themes into clean clinical observations
- Base the note on what is realistic given the context — do not invent dramatic new content
- Use neutral, professional clinical language. Concise 2–4 sentences per field.
- Do not mention peer support workers, peer groups, or peer services
- Do not imply a school setting unless the notes explicitly state it
- Do not mention audits, billing, compliance, or administrative language
- Do not include scheduling or logistical details
- Ignore greetings, scheduling talk, logistics, and small talk from the peer notes entirely

Return ONLY valid JSON — no markdown, no explanation, no code fences.

Fields to populate:
1. additional_persons_present — string, who else was on the call if anyone (empty string if none)
2. content_discussed — paragraph, what was addressed in the therapy session
3. interventions_used — paragraph, what therapeutic interventions were used
4. modalities — array of strings, choose ONLY from: ${MODALITIES.map(m => `"${m}"`).join(', ')}
5. patient_response — paragraph, how the client responded to the therapist
6. progress_toward_goals — paragraph, progress toward treatment goals
7. treatment_plan_changes — string, any treatment plan changes (or "No changes at this time")
8. additional_comments — string, any other observations (empty string if none)

Return exactly this JSON structure:
{
  "additional_persons_present": "",
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
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    if (response.stop_reason === 'max_tokens')
      return res.status(500).json({ error: 'AI response was cut off' });

    const text = response.content[0].text.trim();
    const jsonStart = text.indexOf('{');
    const jsonEnd   = text.lastIndexOf('}');
    if (jsonStart === -1) return res.status(500).json({ error: 'AI returned no JSON', raw: text });
    let fields;
    try {
      fields = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    } catch (parseErr) {
      return res.status(500).json({ error: `AI response was not valid JSON: ${parseErr.message}` });
    }

    await supabase.from('oo_appointments')
      .update({ ai_fields: fields, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);

    res.json({ fields });
  } catch (err) {
    console.error('[magic-note]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/summarize-session — AI summary of raw notes for therapist feel (not a clinical note)
router.post('/:id/summarize-session', requireAuth, async (req, res) => {
  try {
    if (!anthropic) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const { data: appt, error: ae } = await supabase
      .from('oo_appointments')
      .select('id, raw_notes')
      .eq('id', req.params.id)
      .single();
    if (ae || !appt) return res.status(404).json({ error: 'Appointment not found' });

    const notes = (req.body.raw_notes || appt.raw_notes || '').trim();
    if (!notes) return res.status(400).json({ error: 'No notes to summarize.' });

    const prompt = `You are helping a therapist build an accurate feel for their client. Below are raw notes or a call transcript from a session. Write a brief, plain-language summary (3–5 sentences) that captures how the client showed up.

Raw notes / transcript:
${notes}

Focus on:
- The client's emotional state and energy in this session
- What they were preoccupied with or kept coming back to
- How they engaged — open or guarded, scattered or focused, heavy or light
- Any notable shifts, moments, or things that stood out
- The overall vibe and feel of who this person is right now

Rules:
- Write in plain, direct language — NOT clinical documentation language
- No "client presented with", no diagnostic framing, no billing language
- This is for the therapist's internal feel for the client — not a formal record
- Ignore greetings, scheduling, and logistics entirely
- 3–5 sentences maximum
- Return only the summary — no headers, no labels`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const summaryText = response.content[0].text.trim();

    await supabase.from('oo_appointments')
      .update({ session_summary: summaryText, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);

    res.json({ session_summary: summaryText });
  } catch (err) {
    console.error('[summarize-session]', err);
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
      .select('*, oo_clients(id, first_name, last_name, mrn, referral_source_id, referral:oo_referral_sources!referral_source_id(name, notes_email))')
      .eq('id', req.params.id)
      .single();
    if (ae || !appt) return res.status(404).json({ error: 'Appointment not found' });

    const client = appt.oo_clients;
    const ref    = client?.referral;
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
  const allowed = ['raw_notes', 'status', 'duration', 'date', 'time', 'note_sent_at', 'note_sent_email_id', 'note_done_at', 'called_at', 'ai_fields', 'session_summary', 'topics_for_upcoming'];
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

const CPT_BY_DURATION = { 30: '90832', 45: '90834', 60: '90837' };
const CPT_DESC        = { 30: 'PSYCHOTHERAPY W/PATIENT 30 MINUTES', 45: 'PSYCHOTHERAPY W/PATIENT 45 MINUTES', 60: 'PSYCHOTHERAPY W/PATIENT 60 MINUTES' };
const CPT_MAP_ID      = { 30: '321', 45: '322', 60: '323' };
const VISIT_TYPE_DESC = { 30: 'Telehealth Individual Therapy - 30m-- [30  mins] ', 45: 'Telehealth Individual Therapy - 45m-- [45  mins] ', 60: 'Telehealth Individual Therapy - 60m-- [60  mins] ' };

// POST /:id/push-to-insync — create appointment in InSync Scheduler
router.post('/:id/push-to-insync', requireAuth, async (req, res) => {
  try {
    // Load appointment + client (including insync_data for stored payer IDs)
    const { data: appt, error: ae } = await supabase
      .from('oo_appointments')
      .select('*, oo_clients(id, first_name, last_name, dob, insync_patient_id, insync_data)')
      .eq('id', req.params.id)
      .single();
    if (ae || !appt) return res.status(404).json({ error: 'Appointment not found' });

    const client = appt.oo_clients;
    if (!client?.insync_patient_id)
      return res.status(400).json({ error: 'Client has no InSync patient ID — sync from InSync first' });

    const duration    = appt.duration || 45;
    const visitTypeId = String(VISIT_TYPE[duration] || VISIT_TYPE[45]);
    const cptCode     = CPT_BY_DURATION[duration] || CPT_BY_DURATION[45];
    const cptDesc     = CPT_DESC[duration]        || CPT_DESC[45];
    const cptMapId    = CPT_MAP_ID[duration]      || CPT_MAP_ID[45];
    const vtDesc      = VISIT_TYPE_DESC[duration] || VISIT_TYPE_DESC[45];

    // Format date MM/DD/YYYY
    const [y, m, d] = appt.date.split('-');
    const visitDate = `${m}/${d}/${y}`;

    // Format time HH:MM AM/PM with leading zero (InSync requires it)
    const [hh, mm] = appt.time.slice(0, 5).split(':').map(Number);
    const ampm     = hh >= 12 ? 'PM' : 'AM';
    const h12      = String(hh % 12 || 12).padStart(2, '0');
    const visitTime = `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;

    // Patient display name for InSync (Last, First - DOB)
    const dobStr = client.dob ? ` - ${client.dob}` : '';
    const patientFullName = `${client.last_name}, ${client.first_name}${dobStr}`;

    // Load InSync credentials
    const [{ data: uSetting }, { data: pSetting }] = await Promise.all([
      supabase.from('app_settings').select('value').eq('key', 'insync_username').maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'insync_password').maybeSingle(),
    ]);
    const username = uSetting?.value || process.env.INSYNC_USERNAME;
    const password = pSetting?.value || process.env.INSYNC_PASSWORD;
    if (!username || !password)
      return res.status(400).json({ error: 'InSync credentials not configured — click ⚙ in Clients page' });

    const cookie = await insync.login(username, password);

    // Fetch patient program from InSync
    const progRes  = await insync.post('/ProgramManagement/ProgramManagementSearch', {
      ProgramManagementDetailID: '0',
      ProgramDisplayId:          '1',
      PatientId:                 String(client.insync_patient_id),
      ProgramDate:               visitDate,
      FacilityID:                INSYNC_PROVIDER.FacilityId,
      ProviderID:                INSYNC_PROVIDER.ResourceId,
    }, cookie);
    const progJson = await progRes.json();
    const prog = Array.isArray(progJson) ? progJson[0] : null;
    const programDetailId    = prog?.ProgramManagementDetailID ? String(prog.ProgramManagementDetailID) : '0';
    const programName        = prog?.ProgramName || '';
    const consumedVisitOrUnit = prog?.VisitCount  ? String(prog.VisitCount) : '0';

    // Fetch payer IDs from InSync — CaseProgramDetails returns the patient's active payers
    let primaryPayerID = '', secondaryPayerID = '';
    if (programDetailId !== '0') {
      const caseRes  = await insync.post('/ProgramManagement/CaseProgramDetails', {
        CaseManagementID:          '0',
        ProgramManagementDetailID: programDetailId,
      }, cookie);
      const caseJson = await caseRes.json();
      primaryPayerID   = caseJson?.PrimaryPayerID   ? String(caseJson.PrimaryPayerID)   : '';
      secondaryPayerID = caseJson?.SecondaryPayerID ? String(caseJson.SecondaryPayerID) : '';
    }
    const primaryPayerName   = client.insync_data?.primaryPayerName   || '';
    const secondaryPayerName = client.insync_data?.secondaryPayerName || '';
    console.log(`[push-to-insync] Payers: primary=${primaryPayerID} secondary=${secondaryPayerID}`);

    // Book the appointment — params mirror the working HAR request exactly
    const params = {
      WithStartEncounter: '0',
      OnFlyGroupName:     '',
      BookAndStartEncounter: 'false',
      PageViewNo:         '1',
      'objBookAppointmentss[ScheduleSetupID]':    INSYNC_PROVIDER.ScheduleSetupID,
      'objBookAppointmentss[ScheduleID]':         INSYNC_PROVIDER.ScheduleID,
      'objBookAppointmentss[ScheduleTypeID]':     '0',
      'objBookAppointmentss[ResourceId]':         INSYNC_PROVIDER.ResourceId,
      'objBookAppointmentss[ResourceTypeId]':     '0',
      'objBookAppointmentss[Provider]':           INSYNC_PROVIDER.Provider,
      'objBookAppointmentss[IsGroupTherapyHeaderRow]': 'False',
      'objBookAppointmentss[VisitDate]':          visitDate,
      'objBookAppointmentss[VisitTime]':          visitTime,
      'objBookAppointmentss[bookVisitdate]':      visitDate,
      'objBookAppointmentss[AppointmentTime]':    visitTime,
      'objBookAppointmentss[AppointmentFacility]': ' The Derech Shalom Center ',
      'objBookAppointmentss[ProfileName]':        'Scheduler',
      'objBookAppointmentss[POSCode]':            '10',
      'objBookAppointmentss[POSCodeDescription]': "10 - Telehealth Provided in Patient's Home",
      'objBookAppointmentss[PatientId]':          String(client.insync_patient_id),
      'objBookAppointmentss[PatientFullName]':    patientFullName,
      'objBookAppointmentss[VisitID]':            '0',
      'objBookAppointmentss[VisitIDList]':        '',
      'objBookAppointmentss[VisitTypeID]':        visitTypeId,
      'objBookAppointmentss[VisitTypeDescription]': vtDesc,
      'objBookAppointmentss[RefPhysicianID]':     '0',
      'objBookAppointmentss[VisitStatusId]':      '10',
      'objBookAppointmentss[VisitStatusDescription]': 'Pre Check In',
      'objBookAppointmentss[mappedvisitstatusid]': '10',
      'objBookAppointmentss[SelfPay]':            'false',
      'objBookAppointmentss[SelfPayStr]':         'No',
      'objBookAppointmentss[PrimaryPatientPayerID]':    primaryPayerID,
      'objBookAppointmentss[PrimaryIsActivePayer]':     primaryPayerID ? 'true' : '',
      'objBookAppointmentss[SchedulerPrimaryPayerName]': primaryPayerName,
      'objBookAppointmentss[PrimaryInsurance]':         primaryPayerName,
      'objBookAppointmentss[SecondaryPatientPayerID]':  secondaryPayerID,
      'objBookAppointmentss[SecondaryInsurance]':       secondaryPayerName,
      'objBookAppointmentss[TertiaryPatientPayerID]':   '',
      'objBookAppointmentss[TertiaryInsurance]':        'Select',
      'objBookAppointmentss[ExpectedCopay]':      '0.00',
      'objBookAppointmentss[OldExpectedCopay]':   '0',
      'objBookAppointmentss[EncTypeExpectedCopay]': '0.00',
      'objBookAppointmentss[ExpectedCopayDetail]': '0.00',
      'objBookAppointmentss[ExpectedAllowable]':  '0.00',
      'objBookAppointmentss[ExpAllowableDetails]': '0.00',
      'objBookAppointmentss[AuthNoText]':         '',
      'objBookAppointmentss[AuthNumberID]':       '0',
      'objBookAppointmentss[IsPrimaryAutoAttachAuthorization]': 'false',
      'objBookAppointmentss[SecAuthNoText]':      '',
      'objBookAppointmentss[SecAuthNumberID]':    '0',
      'objBookAppointmentss[IsSecondaryAutoAttachAuthorization]': 'false',
      'objBookAppointmentss[TerAuthNoText]':      '',
      'objBookAppointmentss[TerAuthNumberID]':    '0',
      'objBookAppointmentss[IsTertiaryAutoAttachAuthorization]': 'false',
      'objBookAppointmentss[PriAuthorization]':   '',
      'objBookAppointmentss[SecAuthorization]':   '',
      'objBookAppointmentss[TerAuthorization]':   '',
      'objBookAppointmentss[BookComment]':        '',
      'objBookAppointmentss[Duration]':           String(duration),
      'objBookAppointmentss[TotalUnits]':         '1',
      'objBookAppointmentss[FacilityId]':         INSYNC_PROVIDER.FacilityId,
      'objBookAppointmentss[IsBillable]':         'true',
      'objBookAppointmentss[IsTelemedicineVisit]': 'true',
      'objBookAppointmentss[ReSchedule]':         '0',
      'objBookAppointmentss[ResByPractice]':      '0',
      'objBookAppointmentss[ResByPatient]':       '1',
      'objBookAppointmentss[hdnIsOverride]':      '0',
      'objBookAppointmentss[hdnRefPhyUpdateId]':  '0',
      'objBookAppointmentss[hdnPDRefPhyID]':      '0',
      'objBookAppointmentss[ReferringProvide]':   '',
      'objBookAppointmentss[ReferringProviderDescription]': '',
      'objBookAppointmentss[OldResResourceid]':   '0',
      'objBookAppointmentss[ComfirmMsg]':         'false',
      'objBookAppointmentss[AdditionalResourceID]': '0',
      'objBookAppointmentss[AdditionalResTypeID]':  '',
      'objBookAppointmentss[AdditionalParticipant]': '',
      'objBookAppointmentss[AppointRecurren]':    'false',
      'objBookAppointmentss[RecurrenceType]':     'Daily | Every: Day(s)',
      'objBookAppointmentss[RecurrenceStartDate]': visitDate,
      'objBookAppointmentss[RecurrenceEndAfter]': '',
      'objBookAppointmentss[RecurrenceEndBy]':    '',
      'objBookAppointmentss[RescheduleByText]':   'Patient',
      'objBookAppointmentss[RescheduleReason]':   '',
      'objBookAppointmentss[WithStartEncounterstatus]': '0',
      'objBookAppointmentss[WithStartEncounterSeesion]': 'false',
      'objBookAppointmentss[GroupTherapyEncounter]': 'false',
      'objBookAppointmentss[oldVisitTypeDuration]': '',
      'objBookAppointmentss[IsCptChange]':        '0',
      'objBookAppointmentss[BillingProviderId]':  '0',
      'objBookAppointmentss[BillingProviderDescription]': '',
      'objBookAppointmentss[BillingProviderCredentialDescription]': 'Select',
      'objBookAppointmentss[BillingProviderCredentialConfigID]': '0',
      'objBookAppointmentss[VisitCountId]':       '',
      'objBookAppointmentss[IsExcludeVisitCount]': 'false',
      'objBookAppointmentss[SecVisitCountId]':    '',
      'objBookAppointmentss[IsExcludeSecVisitCount]': 'false',
      'objBookAppointmentss[TerVisitCountId]':    '',
      'objBookAppointmentss[IsExcludeTerVisitCount]': 'false',
      'objBookAppointmentss[VisitCountDetails]':  '',
      'objBookAppointmentss[IsFamily]':           'false',
      'objBookAppointmentss[NoOfParticipants]':   '0',
      'objBookAppointmentss[ReEvalConfigId]':     '',
      'objBookAppointmentss[ReEvaluationId]':     '',
      'objBookAppointmentss[initReEvalId]':       '0',
      'objBookAppointmentss[ReEvalConfigDetailId]': '',
      'objBookAppointmentss[CaseManagementID]':   '0',
      'objBookAppointmentss[ProgramManagementDetailID]': programDetailId,
      'objBookAppointmentss[ProgramDescription]':        programName,
      'objBookAppointmentss[PatientGroupId]':     '0',
      'objBookAppointmentss[TelemedicineDefaultsMasterId]': '0',
      'objBookAppointmentss[TeleDefaultsCPTAction]':        '0',
      'objBookAppointmentss[TelemedicineSendMail]': '1,2,3',
      'objBookAppointmentss[IsAntenatalVisit]':   'NaN',
      'objBookAppointmentss[IsFromDashboard]':    'false',
      'objBookAppointmentss[IsFromOfflineSync]':  'false',
      'objBookAppointmentss[IsEditAppointment]':  'false',
      'objBookAppointmentss[IsSameAppointmentBookedDiffFacility]': 'False',
      'objBookAppointmentss[hdnAllowBookingInSameSlot]': '1',
      'objBookAppointmentss[PatientLocationId]':  '',
      'objBookAppointmentss[PatientLocationName]': 'Select',
      'objBookAppointmentss[CredentialConfigID]': '0',
      'objBookAppointmentss[CredentialDescription]': '',
      'objBookAppointmentss[LevelID]':            '0',
      'objBookAppointmentss[LevelofCareStartDate]': '',
      'objBookAppointmentss[LevelofCareEndDate]': '',
      'objBookAppointmentss[AllowToCheckInAndStartEncVisitIds]': '',
      'objBookAppointmentss[SchedulerPatientSing]': '',
      'objBookAppointmentss[ProcedureCodeDescription]': `${cptCode} - ${cptDesc} (Units: 1.00) |`,
      'objBookAppointmentss[InitialVisitDescription]': 'Select',
      'objBookAppointmentss[PageTitle]':          '',
      'objBookAppointmentss[ShowPrimaryProviderAlert]': '0',
      'objBookAppointmentss[IsUpdatePrimaryProvider]': 'false',
      'objBookAppointmentss[IsUpdateMasterLevelOfCare]': '0',
      'objBookAppointmentss[IsAllowToAddPatientToCensusFromScheduler]': '',
      'objBookAppointmentss[IsCaptureCensusStatusInAllRecVisits]': '',
      'objBookAppointmentss[AppointmentDataID]':  '0',
      'objBookAppointmentss[DailyCensusText]':    '',
      'objBookAppointmentss[CensusStatusText]':   '',
      'objBookAppointmentss[PMAlertData][ShowAlert]':             'false',
      'objBookAppointmentss[PMAlertData][RestrictionType]':       '0',
      'objBookAppointmentss[PMAlertData][AlertAllowedFlag]':      '0',
      'objBookAppointmentss[PMAlertData][AllowedUnitOrVisit]':    '0',
      'objBookAppointmentss[PMAlertData][ConsumedUnitOrVisit]':   consumedVisitOrUnit,
      'objBookAppointmentss[PMAlertData][RemainingUnitOrVisit]':  '0',
      'objBookAppointmentss[PMAlertData][CurrentVisitOrUnit]':    consumedVisitOrUnit,
      'objBookAppointmentss[PMAlertData][ActualCurrentUnitOrVisit]': '1',
      'objBookAppointmentss[PMAlertData][AllowSaveFlag]':         '0',
      'objBookAppointmentss[PMAlertData][PatientID]':             '',
      'objBookAppointmentss[PMAlertData][PatientName]':           '',
      'objBookAppointmentss[PMAlertData][VisitID]':               '',
      'objBookAppointmentss[PMAlertData][ProgramName]':           '',
      'objBookAppointmentss[PMAlertData][PracticeId]':            '0',
      'objBookAppointmentss[PMAlertData][AlertEndEncounterFlag]': '0',
      'objBookAppointmentss[PMAlertData][ActualAllowedUnitOrVisit]': '0',
      'objBookAppointmentss[PMAlertData][ProgramToDoAlertIDs]':   '',
      'objBookAppointmentss[PMAlertData][ProgramManagementDetailID]': programDetailId,
      'objBookAppointmentss[VisitHistory][VisitStatus]':          'Pending',
      'objBookAppointmentss[VisitHistory][VisitType]':            'Select',
      'objBookAppointmentss[VisitHistory][Credential]':           '',
      'objBookAppointmentss[VisitHistory][PatientLocation]':      'Select',
      'objBookAppointmentss[VisitHistory][POSCode]':              '11 - Office',
      'objBookAppointmentss[VisitHistory][ReferringProvider]':    '',
      'objBookAppointmentss[VisitHistory][InitialVisit]':         '',
      'objBookAppointmentss[VisitHistory][ProcedureCode]':        '',
      'objBookAppointmentss[VisitHistory][Comment]':              '',
      'objBookAppointmentss[VisitHistory][BillingProvider]':      '',
      'objBookAppointmentss[VisitHistory][PrimaryInsurance]':     primaryPayerName,
      'objBookAppointmentss[VisitHistory][SecondaryInsurance]':   secondaryPayerName,
      'objBookAppointmentss[VisitHistory][TertiaryInsurance]':    '',
      'objBookAppointmentss[VisitHistory][PriAuthorization]':     '',
      'objBookAppointmentss[VisitHistory][SecAuthorization]':     '',
      'objBookAppointmentss[VisitHistory][TerAuthorization]':     '',
      'objBookAppointmentss[VisitHistory][ExpAllowable]':         '0.00',
      'objBookAppointmentss[VisitHistory][VisitCount]':           '',
      'objBookAppointmentss[VisitHistory][Billable]':             'No',
      'objBookAppointmentss[VisitHistory][Program]':              '',
      'objBookAppointmentss[VisitHistory][ProgramManagementDetailID]': '0',
      'objBookAppointmentss[VisitHistory][LevelID]':              '0',
      'objBookAppointmentss[VisitHistory][LevelofCareStartDateString]': '',
      'objBookAppointmentss[VisitHistory][LevelofCareEndDateString]':   '',
      'objBookAppointmentss[VisitHistory][Duration]':             '',
      'objBookAppointmentss[VisitHistory][RescheduleReason]':     '',
      'objBookAppointmentss[VisitHistory][AppointmentTime]':      '',
      'objBookAppointmentss[VisitHistory][AppointmentFacility]':  ' The Derech Shalom Center ',
      'objBookAppointmentss[VisitHistory][RecurrenceType]':       'Daily | Every: Day(s)',
      'objBookAppointmentss[VisitHistory][RecurrenceStartDate]':  visitDate,
      'objBookAppointmentss[VisitHistory][RecurrenceEndAfter]':   '',
      'objBookAppointmentss[VisitHistory][RecurrenceEndBy]':      '',
      'objBookAppointmentss[VisitHistory][RescheduleByText]':     'Patient',
      'objBookAppointmentss[VisitHistory][bookVisitdate]':        '',
      'objBookAppointmentss[VisitHistory][DailyCensusText]':      '',
      'objBookAppointmentss[VisitHistory][CensusStatusText]':     '',
      'objBookAppointmentss[VisitHistory][IsGrant]':              'No',
      'objBookAppointmentss[VisitHistory][SelfPayStr]':           'No',
      'objCpt[0][CPT_Code]':           cptCode,
      'objCpt[0][CPT_Description]':    cptDesc,
      'objCpt[0][IsSelected]':         'true',
      'objCpt[0][M1]':                 'null',
      'objCpt[0][M2]':                 'null',
      'objCpt[0][M3]':                 'null',
      'objCpt[0][M4]':                 'null',
      'objCpt[0][Units]':              '1',
      'objCpt[0][EncounterTypeCPTMapID]': cptMapId,
      'objCpt[0][CPTMapTypeID]':       '1',
      'objCpt[0][ChargeCodeId]':       '0',
      'objCpt[0][RevenueCode]':        '',
      'objTeleUpdateVisit[IsRescheduleAppForTelemedicine]': 'false',
      'objTeleUpdateVisit[TelemedicineEmailReceipts]':      '',
      'objTeleUpdateVisit[SendEMailTo]':                    '1,2,3',
    };

    const saveRes  = await insync.post('/Scheduler/SaveBookAppointment', params, cookie);
    const saveJson = await saveRes.json();

    if (!saveJson?.DataSave)
      return res.status(400).json({ error: saveJson?.MessageDispaly?.ErrorMessage || 'InSync did not confirm save', raw: saveJson });

    const inSyncVisitId = saveJson?.BookAppoint?.VisitID || null;

    // Mark appointment as pushed
    await supabase.from('oo_appointments')
      .update({ insync_visit_id: inSyncVisitId, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);

    res.json({ ok: true, insync_visit_id: inSyncVisitId, date: visitDate, time: visitTime });
  } catch (err) {
    console.error('[push-to-insync]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST push session note to InSync encounter
router.post('/:id/push-note-to-insync', requireAuth, async (req, res) => {
  try {
    const { data: appt, error: ae } = await supabase
      .from('oo_appointments')
      .select('*, oo_clients(id, first_name, last_name, dob, insync_patient_id, insync_data)')
      .eq('id', req.params.id)
      .single();
    if (ae || !appt) return res.status(404).json({ error: 'Appointment not found' });

    const client = appt.oo_clients;
    if (!client?.insync_patient_id)
      return res.status(400).json({ error: 'Client has no InSync patient ID — sync from InSync first' });
    if (!appt.insync_visit_id)
      return res.status(400).json({ error: 'Appointment not in InSync — push appointment first' });
    if (!appt.ai_fields?.content_discussed)
      return res.status(400).json({ error: 'No processed note — write and process notes first' });

    const locationValue   = req.body.location_value  || '3';
    const locationLabel   = req.body.location_label  || 'Audio only Telehealth';
    const audioOnlyReason = req.body.audio_only_reason
      || appt.ai_fields.audio_only_reason
      || 'patient does not have internet access';

    const duration    = appt.duration || 45;
    const [yr, mo, dy] = appt.date.split('-');
    const visitDate   = `${mo}/${dy}/${yr}`;
    const [hh, mm]    = appt.time.slice(0, 5).split(':').map(Number);
    const visitTime   = `${String(hh % 12 || 12).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`;
    const cptCode     = CPT_BY_DURATION[duration] || CPT_BY_DURATION[45];
    const cptMapId    = CPT_MAP_ID[duration]      || CPT_MAP_ID[45];
    const visitTypeId = String(VISIT_TYPE[duration] || VISIT_TYPE[45]);
    const cptFull     = `${cptCode}#*#&*&${cptMapId}`;
    const patientName = `${client.last_name}, ${client.first_name}${client.dob ? ` - ${client.dob}` : ''}`;
    const providerDisplayName = INSYNC_PROVIDER.Provider.replace(' (P)', '').split(', ').reverse().join(' '); // "Orelowitz, Chaim" → "Chaim Orelowitz"
    const patientDisplayName  = `${client.first_name} ${client.last_name}`;

    const [{ data: uRow }, { data: pRow }] = await Promise.all([
      supabase.from('app_settings').select('value').eq('key', 'insync_username').maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'insync_password').maybeSingle(),
    ]);
    const username = uRow?.value || process.env.INSYNC_USERNAME;
    const password = pRow?.value || process.env.INSYNC_PASSWORD;
    if (!username || !password)
      return res.status(400).json({ error: 'InSync credentials not configured' });

    const cookie = await insync.login(username, password);
    const stdHeaders = {
      'Cookie': cookie, 'User-Agent': insync.UA,
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': insync.BASE, 'Referer': `${insync.BASE}/Scheduler/Index`,
      'Accept': 'text/html,*/*',
    };

    // Live payer IDs
    const progRes  = await insync.post('/ProgramManagement/ProgramManagementSearch', {
      ProgramManagementDetailID: '0', ProgramDisplayId: '1',
      PatientId: String(client.insync_patient_id), ProgramDate: visitDate,
      FacilityID: INSYNC_PROVIDER.FacilityId, ProviderID: INSYNC_PROVIDER.ResourceId,
    }, cookie);
    const progJson = await progRes.json();
    const prog     = Array.isArray(progJson) ? progJson[0] : null;
    const programDetailId = prog?.ProgramManagementDetailID ? String(prog.ProgramManagementDetailID) : '0';
    const programId       = prog?.ProgramManagementID       ? String(prog.ProgramManagementID)       : '18';
    const programName     = prog?.ProgramName || 'OH';

    let primaryPayerID = '', secondaryPayerID = '';
    if (programDetailId !== '0') {
      const caseRes  = await insync.post('/ProgramManagement/CaseProgramDetails',
        { CaseManagementID: '0', ProgramManagementDetailID: programDetailId }, cookie);
      const caseJson = await caseRes.json();
      primaryPayerID   = caseJson?.PrimaryPayerID   ? String(caseJson.PrimaryPayerID)   : '';
      secondaryPayerID = caseJson?.SecondaryPayerID ? String(caseJson.SecondaryPayerID) : '';
    }

    // 1. Start encounter
    await insync.post('/Scheduler/StartEncounter', {
      sPatientID:              String(client.insync_patient_id),
      sVisitID:                String(appt.insync_visit_id),
      sVisitStatusDescription: 'Pre Check In',
      IsCheckinAndStartEnc:    '0',
      ResourceId:              INSYNC_PROVIDER.ResourceId,
    }, cookie);

    // 2. Fetch blank note template
    const tplRes = await insync.post('/ConfigurePracticeTemplate/PreviewConfigTemplateById', {
      tempId: '101', isPrev: 'false', sectionConfigId: '0', templateDetailsId: '7',
      FormTableName: 'tbldf200_101_200',
      InsertColumn: 'ControlId_100,ControlId_101,ControlId_102,ControlId_103,ControlId_104,ControlId_105,ControlId_106,ControlId_107,ControlId_108,ControlId_109,ControlId_110,ControlId_111,ControlId_112,ControlId_14,ControlId_20,ControlId_26,ControlId_36,ControlId_37,ControlId_60,ControlId_63,ControlId_67,ControlId_90,ControlId_93,ControlId_96,ControlId_99',
      isDisabled: 'false', providerId: '0',
    }, cookie);
    const blankHtml = extractFormHtml(await tplRes.text());

    // 3. Save encounter metadata — EncounterId=0 lets InSync create/assign it; response contains the ID
    const aeRes  = await insync.post('/EncounterDetail/AddEditStartEncounter', {
      'SEEncounterDetails.IsPrimaryAutoAttachAuthorization':    'False',
      'SEEncounterDetails.IsSecondaryyAutoAttachAuthorization': 'False',
      'SEEncounterDetails.IstertiaryAutoAttachAuthorization':   'False',
      'SEEncounterDetails.EncounterDurationAlertConfigID':      '0',
      'SEEncounterDetails.UpdatePayerFromProgram':              '0',
      'IsCheckInStartEncounter':                                '0',
      'SEEncounterDetails.IsRequiredToUpdateBedBoardPayers':    'False',
      'hdnAlertTypeForProviderOverlappingEncounter':            '0',
      'hdnAlertOverlappingAppointmentEncounter':                '1',
      'hdnchkSEIsAccident':                                     'false',
      'SEEncounterDetails.TelemedicineSendMail':                '1,2,3',
      'SEEncounterDetails.IsAntenatalVisit':                    '0',
      'SEEncounterDetails.SEEncounterTypeID':                   visitTypeId,
      'SEEncounterDetails.SEProviderID':                        INSYNC_PROVIDER.ResourceId,
      'SEEncounterDetails.SEReferringProviderId':               '0',
      'SEEncounterDetails.IsUpdateRefPhyPD':                    '0',
      'SEEncounterDetails.SEOldReferringProviderId':            '0',
      'SEEncounterDetails.SEPrimaryFacilityID':                 INSYNC_PROVIDER.FacilityId,
      'SEEncounterDetails.SEPOSCode':                           '10',
      'SEEncounterDetails.SEVisitStartDate':                    visitDate,
      'SEEncounterDetails.SEVisitStartTime':                    visitTime,
      'SEEncounterDetails.SEEncounterStartDate':                visitDate,
      'SEEncounterDetails.SEEncounterStartTime':                visitTime,
      'SEEncounterDetails.SEEncounterStartDateTime':            visitDate,
      'SEEncounterDetails.SEVisitStartDateTime':                `${visitDate} ${visitTime}`,
      'SEEncounterDetails.IsTelemedicine':                      'true',
      'SEEncounterDetails.TeleDefaultsCPTAction':               '0',
      'SEEncounterDetails.TeleDefaultsMasterID':                '0',
      'SEEncounterDetails.TeleDefaultsPOSAction':               '0',
      'SEEncounterDetails.InitialReEvalID':                     '0',
      'SEEncounterDetails.SEPatientPayerId':                    primaryPayerID,
      'SEEncounterDetails.SEPatientPayerId1':                   secondaryPayerID,
      'oldSEPatientPayerId':                                    primaryPayerID,
      'oldSEPatientPayerId1':                                   secondaryPayerID,
      'oldSEPatientPayerId2':                                   '0',
      'SEClinicalSummary_EncounterTypeIDs':                     '0',
      'SEEncounterDetails.SECPTModifiers':                      `${cptFull},,,,,1.00,&*%^1,&*%^1`,
      'SEEncounterDetails.SECPTDescription':                    `${cptFull} -  ${CPT_DESC[duration] || CPT_DESC[45]}(Units: 1.00) `,
      'SEEncounterDetails.SECPTCode':                           cptFull,
      'SEEncounterDetails_SECPTCode':                           cptFull,
      'SEEncounterDetails.ChargeCodeId':                        '0',
      'SEEncounterDetails.SERevenueCode':                       'NULL',
      'SEEncounterDetails.SEBillable':                          'true',
      'SEEncounterDetails.SEIsAccident':                        'false',
      'SEEncounterDetails.IsSelfPay':                           'false',
      'SEEncounterDetails.SEAuthorizationId':                   '0',
      'SEEncounterDetails.SEAuthorizationId1':                  '0',
      'SEEncounterDetails.CaseManagementID':                    '0',
      'SEEncounterDetails.CaseEncounterConfirm':                '0',
      'SEEncounterDetails.ProgramManagementID':                 programId,
      'SEEncounterDetails.ProgramManagementDetailID':           programDetailId,
      'SEEncounterDetails.ProgramName':                         programName,
      'SEEncounterDetails.IsUpdateMasterLevelOfCare':           '0',
      'SEEncounterDetails.SEEncounterCategoryId':               '0',
      'SEEncounterDetails.ProgramEncounterConfirm':             '2',
      'SEEncounterDetails.SEChargeID':                          '0',
      'SEEncounterDetails.IsChargeGeneratedFlage':              'False',
      'SEEncounterDetails.SEDuration':                          String(duration),
      'SEEncounterDetails.EncounterId':                         '0',
      'SEEncounterDetails.SEVisitID':                           String(appt.insync_visit_id),
      'SEEncounterDetails.SEVisitTypeID':                       '0',
      'SEEncounterDetails.ScheduleID':                          INSYNC_PROVIDER.ScheduleID,
      'SEEncounterDetails.VisitDuration':                       String(duration),
      'SEEncounterDetails.SEPatientId':                         String(client.insync_patient_id),
      'SEEncounterDetails.SEPatientName':                       patientName,
      'SEEncounterDetails.IsClosedEncounter':                   '1',
      'SEEncounterDetails.hdnEncounterTimeLog':                 '1',
      'SEEncounterDetails.IsFetchEncounterTypeWithMapping':     'True',
      'SEEncounterDetails.PrimaryInsurance':                    client.insync_data?.primaryPayerName || '',
      'SEEncounterDetails.SecondaryInsurance':                  client.insync_data?.secondaryPayerName || '',
      'SEEncounterDetails.SEProviderName':                      INSYNC_PROVIDER.Provider,
      'SEEncounterDetails.SEEncounterType':                     (VISIT_TYPE_DESC[duration] || VISIT_TYPE_DESC[45]).trim(),
      'SEEncounterDetails.SEPOSDescription':                    "Telehealth Provided in Patient's Home",
      'ChartWOScheduler':                                       '0',
      'WEResourceId':                                           INSYNC_PROVIDER.ResourceId,
      'ResourceTypeId':                                         '0',
      'SEEncounterDetails.OldSEEncounterTypeID':                visitTypeId,
      'SEEncounterDetails.BedBookDetailID':                     '0',
      'SEEncounterDetails.hdnAllowToUpdateAntenatalVisitFlag':  '3',
      'ISCurrentDate':                                          visitDate,
      'EncounterDataID':                                        '0',
      'X-Requested-With':                                       'XMLHttpRequest',
    }, cookie);
    const aeText = await aeRes.text();
    console.log('[push-note] AddEditStartEncounter status:', aeRes.status, 'body:', aeText.slice(0, 1000));

    // Parse EncounterID from AddEditStartEncounter response — it's in result.Item2[0].EncounterID
    let aeJson = null;
    try { aeJson = JSON.parse(aeText); } catch { /* non-JSON response */ }
    const encounterId = String(
      aeJson?.result?.Item2?.[0]?.EncounterID ||
      aeJson?.result?.Item2?.[0]?.EncounterId ||
      aeJson?.EncounterId || aeJson?.EncounterID ||
      (aeText.match(/"EncounterID"\s*:\s*"?(\d+)"?/)?.[1]) ||
      ''
    );
    if (!encounterId || encounterId === '0')
      throw new Error(`Could not get EncounterID from AddEditStartEncounter. Response: ${aeText.slice(0, 300)}`);

    // 4. Fill template with note content
    const filledHtml = fillNoteTemplate(blankHtml, encounterId, appt.ai_fields, providerDisplayName, patientDisplayName, locationValue, locationLabel);

    // DynamicHTML must be HTML-encoded (InSync stores and renders it that way)
    const htmlEncodeForDynamic = s => s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // 5. Save filled note HTML — send only the params the browser sends (matched to Save Note HAR).
    // Text fields (101, 102, 63, 60) are already embedded in DynamicHTML; sending them again
    // as separate params causes InSync to render content twice in the PDF.
    const modalityValues = (appt.ai_fields.modalities || [])
      .map(m => MODALITY_VALUE_MAP[m]).filter(Boolean).join(',');
    const saveRes  = await insync.post('/ConfigurePracticeTemplate/SaveDynamicTemplateDetails', {
      'data[FormTemplateDetailId]':        '7',
      'data[SectionConfigurationId]':      '0',
      'data[DynamicHTML]':                 htmlEncodeForDynamic(filledHtml),
      'data[ControlId_99]':                appt.ai_fields.additional_persons_present || '',
      'data[ControlId_109]':               audioOnlyReason,
      'data[ControlId_105]':               '',
      'data[ControlId_107]':               appt.ai_fields.treatment_plan_changes     || '',
      'data[ControlId_104]':               modalityValues,
      'data[ControlId_112]':               locationValue,
      'data[ControlId_96]':                providerDisplayName,
      'data[ControlId_108]':               patientDisplayName,
      'data[DataBaseValueCollection]':     `<ControlId_96>${INSYNC_PROVIDER.ResourceId}</ControlId_96>`,
      'data[IsClearData]':                 '0',
      'data[ProviderId]':                  '0',
      'data[MatrixIds]':                   '',
      'data[IsSubmitted]':                 'false',
      'data[SubPatientFormID]':            '0',
      'data[PatientId]':                   String(client.insync_patient_id),
      'data[IsCallFromPortal]':            '0',
      'data[TemplateId]':                  '101',
      'data[FunctionId]':                  '10070',
      'data[SignRefusalReason]':           '',
      'data[IsResent]':                    'false',
      'data[IsOverrideForm]':              'false',
      'data[IsCallFromRegistration]':      'false',
      'data[IsSendFormToPatient]':         'false',
      'data[ControlXML]':                  '',
      'data[SaveMode]':                    '1',
      'data[SaveAsToDM]':                  'false',
      'data[PatientDelegateId]':           '0',
    }, cookie);
    const saveText = await saveRes.text();
    console.log('[push-note] SaveDynamicTemplateDetails status:', saveRes.status, 'body:', saveText.slice(0, 300));
    let saveJson = null;
    try { saveJson = JSON.parse(saveText); } catch { /* non-JSON */ }
    if (saveJson?.Status !== 1)
      return res.status(400).json({ error: 'InSync did not confirm note save', raw: saveJson });

    // 6. Persist encounter ID in OO
    await supabase.from('oo_appointments')
      .update({ insync_encounter_id: encounterId, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);

    res.json({ ok: true, insync_encounter_id: encounterId });
  } catch (err) {
    console.error('[push-note-to-insync]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST end InSync encounter (SaveEndEncounter with PIN 1111)
router.post('/:id/end-insync-encounter', requireAuth, async (req, res) => {
  try {
    const { data: appt, error: ae } = await supabase
      .from('oo_appointments')
      .select('*, oo_clients(insync_patient_id)')
      .eq('id', req.params.id).single();
    if (ae || !appt) return res.status(404).json({ error: 'Appointment not found' });
    if (!appt.insync_encounter_id)
      return res.status(400).json({ error: 'No encounter ID — push note first' });

    const [{ data: uRow }, { data: pRow }] = await Promise.all([
      supabase.from('app_settings').select('value').eq('key', 'insync_username').maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'insync_password').maybeSingle(),
    ]);
    const username = uRow?.value || process.env.INSYNC_USERNAME;
    const password = pRow?.value || process.env.INSYNC_PASSWORD;
    if (!username || !password)
      return res.status(400).json({ error: 'InSync credentials not configured' });

    const cookie = await insync.login(username, password);

    const dur     = appt.duration || 45;
    const [yr, mo, dy] = appt.date.split('-');
    const visitDate  = `${mo}/${dy}/${yr}`;         // MM/DD/YYYY
    const visitDateM = `${Number(mo)}/${Number(dy)}/${yr}`; // M/D/YYYY (no leading zeros)

    const [hh, mm] = appt.time.slice(0, 5).split(':').map(Number);
    const startAmpm  = hh >= 12 ? 'PM' : 'AM';
    const startH12   = hh % 12 || 12;
    const startTime  = `${String(startH12).padStart(2,'0')}:${String(mm).padStart(2,'0')} ${startAmpm}`;
    const startTimePadded = startTime; // same format

    const endMinutes = hh * 60 + mm + dur;
    const endHH  = Math.floor(endMinutes / 60) % 24;
    const endMM  = endMinutes % 60;
    const endAmpm = endHH >= 12 ? 'PM' : 'AM';
    const endH12  = endHH % 12 || 12;
    const endTime = `${String(endH12).padStart(2,'0')}:${String(endMM).padStart(2,'0')} ${endAmpm}`;

    const visitTypeId   = String(VISIT_TYPE[dur] || VISIT_TYPE[45]);
    const encounterType = (VISIT_TYPE_DESC[dur] || VISIT_TYPE_DESC[45]).split('--')[0].trim();
    const patientId     = String(appt.oo_clients?.insync_patient_id || '');

    // Get ProgramManagementDetailID
    const progRes  = await insync.post('/ProgramManagement/ProgramManagementSearch', {
      ProgramManagementDetailID: '0', ProgramDisplayId: '1',
      PatientId: patientId, ProgramDate: visitDate,
      FacilityID: INSYNC_PROVIDER.FacilityId, ProviderID: INSYNC_PROVIDER.ResourceId,
    }, cookie);
    const progJson = await progRes.json();
    const prog     = Array.isArray(progJson) ? progJson[0] : null;
    const programDetailId = prog?.ProgramManagementDetailID ? String(prog.ProgramManagementDetailID) : '0';

    // Load the ENDEncounter page first — InSync requires this to establish server-side session state
    await fetch(`${insync.BASE}/ENDEncounter/ENDEncounter?eid=${appt.insync_encounter_id}&pid=${patientId}`, {
      headers: {
        'User-Agent': insync.UA,
        'Accept': 'text/html,*/*',
        'Cookie': cookie,
      },
      redirect: 'follow',
    });

    // SaveEndEncounter — the actual close with PIN
    const endRes  = await insync.post('/ENDEncounter/SaveEndEncounter', {
      'SaveEndEncounter[PatientId]':             patientId,
      'SaveEndEncounter[EncounterId]':           appt.insync_encounter_id,
      'SaveEndEncounter[VisitDateTime]':         `${visitDateM} ${startH12}:${String(mm).padStart(2,'0')}:00 ${startAmpm}`,
      'SaveEndEncounter[EncounterCategoryID]':   '0',
      'SaveEndEncounter[NoteId]':                '234',
      'SaveEndEncounter[EncounterType]':         encounterType,
      'SaveEndEncounter[AdditionalEncNotes][0][NoteId]':   '234',
      'SaveEndEncounter[AdditionalEncNotes][0][NoteName]': 'Therapy',
      'SaveEndEncounter[EPIN]':                  '1111',
      'SaveEndEncounter[EncounterStartDate]':    `${visitDate} ${startTimePadded}`,
      'SaveEndEncounter[EncounterEndDate]':      `${visitDate} ${endTime}`,
      'SaveEndEncounter[IsOntheFlyCosignRequest]': 'true',
      'SaveEndEncounter[Note]':                  '',
      'SaveEndEncounter[IsReferralTrackingEnable]': 'true',
      'SaveEndEncounter[IsSubmitEncounterNote]': 'false',
      'SaveEndEncounter[IsPatientDischarge]':    'false',
      'SaveEndEncounter[ReferringTrackingID]':   '',
      'SaveEndEncounter[IsReferralfromTP]':      'false',
      'SaveEndEncounter[SendToDoTemplateID]':    '',
      'SaveEndEncounter[IsSpecificEncounterToDo]': 'false',
      'SaveEndEncounter[IsSendToCDR]':           'false',
      'SaveEndEncounter[IsSendToWCIS]':          'false',
      'SaveEndEncounter[IsSendToFASAMS]':        'false',
      'SaveEndEncounter[IsShowSendToFASAMS]':    'false',
      'SaveEndEncounter[IsSendToCSI]':           'false',
      'SaveEndEncounter[IsShowSendToCSI]':       'false',
      'SaveEndEncounter[IsSendToCALOMS]':        'false',
      'SaveEndEncounter[IsShowSendToCALOMS]':    'false',
      'SaveEndEncounter[IsSendToIMCANS]':        'false',
      'SaveEndEncounter[IsShowSendToIMCANS]':    'false',
      'SaveEndEncounter[IsSendToPCP]':           'false',
      'SaveEndEncounter[IsShowSendToPCP]':       'false',
      'SaveEndEncounter[IsSendToPPS]':           'false',
      'SaveEndEncounter[IsShowSendToPPS]':       'false',
      'SaveEndEncounter[IsSendToCLTS]':          'false',
      'SaveEndEncounter[IsSendToBHDS]':          'false',
      'SaveEndEncounter[IsShowSendToBHDS]':      'false',
      'SaveEndEncounter[IsShowSendToCLTS]':      'false',
      'SaveEndEncounter[IsSendToFSP]':           'false',
      'SaveEndEncounter[IsShowSendToFSP]':       'false',
      'SaveEndEncounter[EncounterDurationAlertConfigID]': '',
      'SaveEndEncounter[IsSendToWAMS]':          'false',
      'SaveEndEncounter[IsSendToCCS]':           'false',
      'SaveEndEncounter[SelectedReEvalStatus]':  '',
      'SaveEndEncounter[SelectedProgramStatus]': '4',
      'SaveEndEncounter[IsSendToOBHIS]':         'false',
      'SaveEndEncounter[IsShowSendToOBHIS]':     'false',
      'SaveEndEncounter[IsSendToIBHRS]':         'false',
      'SaveEndEncounter[IsShowSendToIBHRS]':     'false',
      'SaveEndEncounter[IsSendToMEDCO]':         'false',
      'SaveEndEncounter[IsShowSendToMEDCO]':     'false',
      'SaveEndEncounter[IsSendToOSHPD]':         'false',
      'SaveEndEncounter[IsShowSendToOSHPD]':     'false',
      'SaveEndEncounter[IsSendToOBH]':           'false',
      'SaveEndEncounter[IsShowSendToOBH]':       'false',
      'SaveEndEncounter[IsSendToNOMS]':          'false',
      'SaveEndEncounter[IsShowSendToNOMS]':      'false',
      'SaveEndEncounter[IsSendToCSS]':           'false',
      'SaveEndEncounter[IsShowSendToCSS]':       'false',
      'SaveEndEncounter[IsSendToGPRA]':          'false',
      'SaveEndEncounter[IsShowSendToGPRA]':      'false',
      'SaveEndEncounter[IsSendToDAANES]':        'false',
      'SaveEndEncounter[IsShowSendToDAANES]':    'false',
      'SaveEndEncounter[IsSendToCDS]':           'false',
      'SaveEndEncounter[IsShowSendToCDS]':       'false',
      'SaveEndEncounter[IsSendToBHSD]':          'false',
      'SaveEndEncounter[IsShowSendToBHSD]':      'false',
      'SaveEndEncounter[IsSendToKSTEDS]':        'false',
      'SaveEndEncounter[IsShowSendToKSTEDS]':    'false',
      'SaveEndEncounter[IsSendToMMCR]':          'false',
      'SaveEndEncounter[IsShowSendToMMCR]':      'false',
      'SaveEndEncounter[ProgramDischargeUpdateType]': '',
      'SaveEndEncounter[IsConfirmUpdate]':       '1',
      'SaveEndEncounter[WithinDay]':             '0',
      'SaveEndEncounter[VisitID]':               String(appt.insync_visit_id || '0'),
      'SaveEndEncounter[ProviderID]':            INSYNC_PROVIDER.ResourceId,
      'SaveEndEncounter[VisitStatusID]':         '1',
      'SaveEndEncounter[MappedVisitStatusID]':   '1',
      'SaveEndEncounter[IsAutoCheckOutAppointmentwhileEndingEncounter]': 'false',
      'SaveEndEncounter[CheckOutVisitStatuswhileEndingEncounter]':       '',
      'SaveEndEncounter[CheckOutVisitStatusEncounterTypeIDs]':           '',
      'SaveEndEncounter[EncounterTypeID]':       visitTypeId,
      'SaveEndEncounter[ScheduleID]':            INSYNC_PROVIDER.ScheduleID,
      'SaveEndEncounter[VisitDate]':             `${visitDateM} 12:00:00 AM`,
      'SaveEndEncounter[StartTime]':             startTimePadded,
      'SaveEndEncounter[IsSynchronizeEncountertypeWithVisitandViceVersa]': '1',
      'SaveEndEncounter[GroupTherapyMainEncounterTypeID]': '0',
      'SaveEndEncounter[IsAnyAntenatalVisitOpen]': 'false',
      'SaveEndEncounter[IsAntenatalIconDisplay]':  'false',
      'SaveEndEncounter[Duration]':              String(dur),
      'SaveEndEncounter[IsAntenatalVisit]':      '3',
      'SaveEndEncounter[CurrentVisitTypeId]':    '0',
      'SaveEndEncounter[CurrentVisitType]':      '0',
      'SaveEndEncounter[ChargeStatus]':          '1',
      'SaveEndEncounter[EncounterStatus]':       '1',
      'SaveEndEncounter[PatientLocation]':       '',
      'SaveEndEncounter[Vdate]':                 visitDate,
      'SaveEndEncounter[IsEnableInformationBlocking]': '',
      'SaveEndEncounter[ProgramManagementDetailID]': programDetailId,
      'SaveEndEncounter[POCNotesId]':            '0',
      'SaveEndEncounter[IsSavePOCDocument]':     'false',
      'SaveEndEncounter[VisitTypeID]':           '0',
      'SaveEndEncounter[IsCptChange]':           '0',
      'SaveEndEncounter[IsoverWirteVisit]':      '0',
      'SaveEndEncounter[IsOverWriteEncounterType]': '0',
      'SaveEndEncounter[InitialReEvaluationId]': '0',
      'SaveEndEncounter[ReEvalConfigId]':        '0',
      'SaveEndEncounter[IsVisitTypeChange]':     'false',
      'SaveEndEncounter[IsUpdateForCofacilitator]': '0',
      'SaveEndEncounter[OldVisitType]':          '',
      'SaveEndEncounter[EncounterCategoryName]': '',
    }, cookie);
    const endText = await endRes.text();
    console.log('[end-encounter] SaveEndEncounter status:', endRes.status, 'body:', endText.slice(0, 400));

    // Mark closed in scheduler (EncounterID=0 = use active session encounter)
    await fetch(`${insync.BASE}/Scheduler/setEncounterClosedByName`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': insync.UA,
        'Origin': insync.BASE,
        'Referer': `${insync.BASE}/CustomForm/CustomForm?IsZoomTelemedicineVisitType=true`,
        'Cookie': cookie,
      },
      body: JSON.stringify({ EncounterID: '0' }),
    });

    const doneAt = appt.note_done_at || new Date().toISOString();
    await supabase.from('oo_appointments')
      .update({ note_done_at: doneAt, status: 'completed' })
      .eq('id', appt.id);

    res.json({ ok: true, endTime, note_done_at: doneAt, status: 'completed' });
  } catch (err) {
    console.error('[end-insync-encounter]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

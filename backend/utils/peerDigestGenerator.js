const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../db/supabase');

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

function isoToday() { return new Date().toISOString().slice(0, 10); }

function isoMinus6() {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return d.toISOString().slice(0, 10);
}

const MAX_NOTES = 15;

// Generate or refresh a PeerWeeklyDigest for a client.
// Upserts on (client_id, generation_mode, digest_window_start, digest_window_end).
async function generateOrRefreshDigest({
  clientId,
  clientName,
  generationMode,          // 'ManualClientTriggered' | 'AppointmentTriggered'
  ooAppointmentId = null,
  digestWindowStart,
  digestWindowEnd,
}) {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY not configured');

  const windowStart = digestWindowStart || isoMinus6();
  const windowEnd   = digestWindowEnd   || isoToday();
  const now = new Date().toISOString();

  const summary = {
    clientId,
    ooAppointmentId,
    generationMode,
    digestWindowStart: windowStart,
    digestWindowEnd:   windowEnd,
    notesFound:    0,
    notesIncluded: 0,
    digestStatus:  null,
    wasRefreshed:  false,
    errors:        [],
  };

  // Detect existing record to distinguish Generated vs Refreshed
  const { data: existing } = await supabase
    .from('peer_weekly_digests')
    .select('id')
    .eq('client_id', clientId)
    .eq('generation_mode', generationMode)
    .eq('digest_window_start', windowStart)
    .eq('digest_window_end', windowEnd)
    .maybeSingle();
  summary.wasRefreshed = !!existing;

  // Fetch attributed peer notes in the window
  const { data: notes, error: notesErr } = await supabase
    .from('insync_raw_notes')
    .select('id, service_date, raw_note_text, encounter_type, provider_name')
    .eq('oo_client_id', clientId)
    .gte('service_date', windowStart)
    .lte('service_date', windowEnd)
    .not('raw_note_text', 'is', null)
    .neq('raw_note_text', '')
    .order('service_date', { ascending: false });

  if (notesErr) throw notesErr;

  summary.notesFound = notes?.length || 0;
  const capped = (notes || []).slice(0, MAX_NOTES);
  summary.notesIncluded = capped.length;
  const wasCapped = summary.notesFound > MAX_NOTES;

  const basePayload = {
    client_id:           clientId,
    oo_appointment_id:   ooAppointmentId,
    generation_mode:     generationMode,
    digest_window_start: windowStart,
    digest_window_end:   windowEnd,
    generated_at:        now,
    updated_at:          now,
  };

  // No notes in window → store No Peer Notes Found and return
  if (summary.notesIncluded === 0) {
    summary.digestStatus = 'No Peer Notes Found';
    const { data: upserted, error: uErr } = await supabase
      .from('peer_weekly_digests')
      .upsert({
        ...basePayload,
        peer_note_ids_included: [],
        notes_included_count:   0,
        digest_status:          'No Peer Notes Found',
        summary:                null,
        error_message:          null,
      }, { onConflict: 'client_id,generation_mode,digest_window_start,digest_window_end' })
      .select()
      .single();
    if (uErr) summary.errors.push(uErr.message);
    return { digest: upserted, summary };
  }

  // Build prompt text from peer notes
  const capLine = wasCapped
    ? `\n\n(Note: ${summary.notesFound} peer notes exist for this window. Showing the ${MAX_NOTES} most recent.)`
    : '';

  const noteBlocks = capped.map((n, i) => {
    const date = n.service_date || 'unknown date';
    const type = n.encounter_type || 'Peer Support';
    return `--- Note ${i + 1} (${date}, ${type}) ---\n${n.raw_note_text.trim()}`;
  }).join('\n\n');

  const prompt = `You are a documentation assistant helping a licensed clinical social worker prepare for an individual therapy (OO) session. The following are peer support notes for a client named ${clientName || 'this client'} from ${windowStart} through ${windowEnd}.${capLine}

${noteBlocks}

Based ONLY on these peer support notes, write a brief therapist-facing weekly digest. The therapist will read this at a glance before their OO session.

Format exactly as follows — no headings, no extra sections:

[2–3 sentence paragraph summarizing what the client dealt with this week across peer work]

• Problem/theme: [key problems or themes from the week]
• Intervention/support: [peer interventions or support approaches used]
• Progress/response: [how the client responded or what progress was noted]
• OO focus: [one suggested OO focus area — include only if clearly supported by the notes]

Rules:
- Maximum 3–4 bullets total. Omit "OO focus" if the notes do not clearly support a suggestion.
- Do not use headings or section labels beyond the bullet labels above.
- Do not list every session date, activity, or intervention name.
- Do not mention locations or provider names unless clinically important.
- Do not include "no safety concerns" unless safety was actually a relevant issue.
- Total output: roughly 175 words maximum.
- Summarize ONLY what is in the notes. Do not invent or infer beyond what is written.
- Use neutral, therapist-facing clinical language.
- Do NOT write as if the OO therapist provided the peer service.
- Do NOT add diagnosis language, medical necessity language, or compliance concerns.
- Do NOT mention audits, billing, documentation, or administrative details.
- Do NOT say peer services happened in school unless the notes explicitly state it.
- Return only the digest text. No JSON, no markdown, no code fences, no explanation.`;

  let digestText = null;
  try {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    });
    digestText = response.content[0].text.trim();
    if (!digestText) throw new Error('Empty response from AI');
  } catch (aiErr) {
    summary.errors.push(`AI error: ${aiErr.message}`);
    summary.digestStatus = 'Error';
    const { data: upserted } = await supabase
      .from('peer_weekly_digests')
      .upsert({
        ...basePayload,
        peer_note_ids_included: capped.map(n => n.id),
        notes_included_count:   capped.length,
        digest_status:          'Error',
        error_message:          aiErr.message,
        summary:                null,
      }, { onConflict: 'client_id,generation_mode,digest_window_start,digest_window_end' })
      .select().single();
    return { digest: upserted, summary };
  }

  const digestStatus = summary.wasRefreshed ? 'Refreshed' : 'Generated';
  summary.digestStatus = digestStatus;

  const { data: upserted, error: upsertErr } = await supabase
    .from('peer_weekly_digests')
    .upsert({
      ...basePayload,
      peer_note_ids_included: capped.map(n => n.id),
      notes_included_count:   capped.length,
      summary:                digestText,
      digest_status:          digestStatus,
      error_message:          null,
    }, { onConflict: 'client_id,generation_mode,digest_window_start,digest_window_end' })
    .select()
    .single();

  if (upsertErr) summary.errors.push(upsertErr.message);

  console.log(`[peer-digest] ${generationMode} client=${clientId} status=${digestStatus} notes=${summary.notesIncluded}/${summary.notesFound}`);
  return { digest: upserted, summary };
}

module.exports = { generateOrRefreshDigest };

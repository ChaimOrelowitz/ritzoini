const crypto = require('crypto');
const supabase = require('../db/supabase');

let cachedToken = null;
let cachedExpiryMs = 0;

// Zoom Phone recording transcripts require a real OAuth bearer token (the
// webhook's download_token only applies to meeting recordings, not phone
// calls) — fetched via Server-to-Server OAuth client-credentials grant and
// cached until shortly before it expires.
async function getZoomAccessToken() {
  if (cachedToken && Date.now() < cachedExpiryMs) return cachedToken;

  const accountId = process.env.ZOOM_S2S_ACCOUNT_ID;
  const clientId = process.env.ZOOM_S2S_CLIENT_ID;
  const clientSecret = process.env.ZOOM_S2S_CLIENT_SECRET;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const resp = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
    { method: 'POST', headers: { Authorization: `Basic ${basic}` } }
  );
  if (!resp.ok) throw new Error(`Zoom OAuth token request failed: HTTP ${resp.status}`);
  const json = await resp.json();

  cachedToken = json.access_token;
  cachedExpiryMs = Date.now() + (json.expires_in - 60) * 1000;
  return cachedToken;
}

function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  return digits;
}

async function findMatchingClients(normalizedNumber) {
  if (!normalizedNumber) return [];
  const { data: clients, error } = await supabase
    .from('oo_clients')
    .select('id, first_name, last_name, phone, mobile, mother_phone, father_phone')
    .eq('status', 'active');
  if (error) throw error;

  return (clients || []).filter(c =>
    [c.phone, c.mobile, c.mother_phone, c.father_phone].some(
      n => normalizePhone(n) === normalizedNumber
    )
  );
}

// Writes both sides of an attach: the appointment's note + the transcript's match record.
async function attachTranscriptToAppointment(transcriptId, appointmentId) {
  const now = new Date().toISOString();

  const { data: transcript } = await supabase
    .from('zoom_call_transcripts')
    .select('transcript_text')
    .eq('id', transcriptId)
    .single();

  await supabase.from('oo_appointments').update({
    raw_notes: transcript?.transcript_text || '',
    transcript_attached_at: now,
    updated_at: now,
  }).eq('id', appointmentId);

  await supabase.from('zoom_call_transcripts').update({
    matched_appointment_id: appointmentId,
    status: 'attached',
    attached_at: now,
  }).eq('id', transcriptId);
}

function dateDiffDays(dateStr, isoDateTime) {
  const a = new Date(dateStr + 'T00:00:00Z').getTime();
  const b = new Date(isoDateTime);
  const bDateOnly = new Date(`${b.toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  return Math.abs(a - bDateOnly);
}

// Finds the nearest-by-date blank appointment for a client and attaches the transcript.
// Returns true if attached, false if no blank appointment was available.
async function attachToNearestBlankAppointment(transcriptId, clientId, callDateTime) {
  const { data: candidates, error } = await supabase
    .from('oo_appointments')
    .select('id, date, raw_notes')
    .eq('client_id', clientId)
    .or('raw_notes.is.null,raw_notes.eq.')
    .order('date');
  if (error) throw error;
  if (!candidates?.length) return false;

  const nearest = candidates.reduce((best, c) => {
    const diff = dateDiffDays(c.date, callDateTime);
    return (!best || diff < best.diff) ? { id: c.id, diff } : best;
  }, null);

  await attachTranscriptToAppointment(transcriptId, nearest.id);
  return true;
}

// Clears a transcript's existing attachment (if any) before re-matching, so
// reassigning to a different client doesn't leave that transcript's text
// sitting in the wrong client's appointment note.
async function detachFromAppointment(transcriptId) {
  const { data: row } = await supabase
    .from('zoom_call_transcripts')
    .select('matched_appointment_id')
    .eq('id', transcriptId)
    .single();
  if (!row?.matched_appointment_id) return;

  await supabase.from('oo_appointments').update({
    raw_notes: null,
    transcript_attached_at: null,
  }).eq('id', row.matched_appointment_id);
}

// Single place that resolves "client X is the match for this transcript" —
// used by the webhook's auto-match step and by the manual retry/assign
// actions, so attached vs pending_appointment is decided consistently.
async function matchClientToTranscript(transcriptId, clientId, callDateTime) {
  await detachFromAppointment(transcriptId);
  const attached = await attachToNearestBlankAppointment(transcriptId, clientId, callDateTime);
  if (attached) {
    await supabase.from('zoom_call_transcripts')
      .update({ matched_client_id: clientId, candidate_client_ids: null })
      .eq('id', transcriptId);
  } else {
    await supabase.from('zoom_call_transcripts')
      .update({ status: 'pending_appointment', matched_client_id: clientId, candidate_client_ids: null })
      .eq('id', transcriptId);
  }
  return attached;
}

// Called after new appointments are created — checks for transcripts already
// waiting on this client and attaches the oldest one to the nearest new row.
async function attachPendingTranscriptsForClients(clientIds, newAppointmentsByClient) {
  const ids = [...new Set(clientIds)];
  if (!ids.length) return;

  const { data: pending, error } = await supabase
    .from('zoom_call_transcripts')
    .select('id, matched_client_id, call_date_time')
    .in('matched_client_id', ids)
    .eq('status', 'pending_appointment')
    .order('call_date_time');
  if (error) throw error;
  if (!pending?.length) return;

  const claimed = new Set();
  for (const t of pending) {
    const rows = (newAppointmentsByClient[t.matched_client_id] || [])
      .filter(r => !claimed.has(r.id));
    if (!rows.length) continue;

    const nearest = rows.reduce((best, r) => {
      const diff = dateDiffDays(r.date, t.call_date_time);
      return (!best || diff < best.diff) ? { id: r.id, diff } : best;
    }, null);

    claimed.add(nearest.id);
    await attachTranscriptToAppointment(t.id, nearest.id);
  }
}

function verifyZoomSignature(req, secretToken) {
  const signature = req.headers['x-zm-signature'];
  const timestamp = req.headers['x-zm-request-timestamp'];
  if (!signature || !timestamp || !req.rawBody) return false;

  const ageMs = Date.now() - Number(timestamp) * 1000;
  if (!Number.isFinite(ageMs) || Math.abs(ageMs) > 5 * 60 * 1000) return false;

  const message = `v0:${timestamp}:${req.rawBody.toString('utf8')}`;
  const hash = crypto.createHmac('sha256', secretToken).update(message).digest('hex');
  const expected = `v0=${hash}`;

  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

module.exports = {
  getZoomAccessToken,
  normalizePhone,
  findMatchingClients,
  attachTranscriptToAppointment,
  attachToNearestBlankAppointment,
  matchClientToTranscript,
  attachPendingTranscriptsForClients,
  verifyZoomSignature,
};

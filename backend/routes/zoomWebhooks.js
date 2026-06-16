const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');
const crypto = require('crypto');
const {
  getZoomAccessToken,
  normalizePhone,
  findMatchingClients,
  attachToNearestBlankAppointment,
  verifyZoomSignature,
} = require('../utils/zoomTranscripts');

// POST /api/zoom/webhook — Zoom Phone event notifications. No requireAuth: Zoom
// can't send our Supabase JWT, so this is secured by Zoom's own HMAC signature instead.
router.post('/webhook', async (req, res) => {
  const body = req.body || {};

  // One-time CRC handshake Zoom sends when the endpoint URL is first saved.
  if (body.event === 'endpoint.url_validation') {
    const plainToken = body.payload?.plainToken;
    const secretToken = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
    if (!plainToken || !secretToken) return res.status(400).json({ error: 'Missing plainToken or secret' });
    const encryptedToken = crypto.createHmac('sha256', secretToken).update(plainToken).digest('hex');
    return res.json({ plainToken, encryptedToken });
  }

  const secretToken = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
  if (!secretToken || !verifyZoomSignature(req, secretToken)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (body.event !== 'phone.recording_transcript_completed') {
    return res.json({ ok: true, ignored: body.event });
  }

  const recordings = body.payload?.object?.recordings;
  if (!Array.isArray(recordings) || !recordings.length) {
    return res.json({ ok: true, ignored: 'no recordings in payload' });
  }

  for (const recording of recordings) {
    try {
      await processRecording(recording, body.payload);
    } catch (err) {
      console.error('[zoom-webhook] Failed to process recording:', recording?.call_id, err.message);
    }
  }

  res.json({ ok: true, processed: recordings.length });
});

async function processRecording(recording, payload) {
  const zoomCallId = recording.call_id || recording.id;

  const { data: insertedRows, error: insertError } = await supabase
    .from('zoom_call_transcripts')
    .upsert({
      zoom_call_id: zoomCallId,
      call_date_time: recording.date_time || null,
      duration_seconds: recording.duration || null,
      direction: recording.direction || null,
      other_party_number: recording.direction === 'outbound' ? recording.callee_number : recording.caller_number,
      raw_payload: payload,
      status: 'pending_match',
    }, { onConflict: 'zoom_call_id', ignoreDuplicates: true })
    .select();

  if (insertError) throw insertError;
  if (!insertedRows?.length) return; // duplicate webhook retry — already logged on first delivery
  const inserted = insertedRows[0];

  const otherNumber = inserted.other_party_number;
  const normalized = normalizePhone(otherNumber);

  await supabase.from('zoom_call_transcripts')
    .update({ other_party_number_normalized: normalized })
    .eq('id', inserted.id);

  let transcriptText = null;
  try {
    transcriptText = await downloadTranscript(recording.transcript_download_url);
  } catch (err) {
    await supabase.from('zoom_call_transcripts')
      .update({ status: 'download_failed', error_detail: err.message })
      .eq('id', inserted.id);
    return;
  }

  await supabase.from('zoom_call_transcripts')
    .update({ transcript_text: transcriptText })
    .eq('id', inserted.id);

  const clients = await findMatchingClients(normalized);

  if (clients.length === 0) {
    await supabase.from('zoom_call_transcripts').update({ status: 'unmatched' }).eq('id', inserted.id);
    return;
  }

  if (clients.length > 1) {
    await supabase.from('zoom_call_transcripts')
      .update({ status: 'unmatched', candidate_client_ids: clients.map(c => c.id) })
      .eq('id', inserted.id);
    return;
  }

  const client = clients[0];
  const attached = await attachToNearestBlankAppointment(inserted.id, client.id, recording.date_time);
  if (!attached) {
    await supabase.from('zoom_call_transcripts')
      .update({ status: 'pending_appointment', matched_client_id: client.id })
      .eq('id', inserted.id);
  } else {
    await supabase.from('zoom_call_transcripts')
      .update({ matched_client_id: client.id })
      .eq('id', inserted.id);
  }
}

async function downloadTranscript(url) {
  if (!url) throw new Error('No transcript_download_url in payload');
  const token = await getZoomAccessToken();
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);
  const raw = await resp.text();
  return toPlainTranscript(raw);
}

// Zoom Phone returns the transcript as a JSON document with a speaker-tagged
// timeline, not plain text — convert it to readable "Speaker: line" text so
// raw_notes holds an actual conversation, not a JSON blob, for AI processing.
function toPlainTranscript(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!Array.isArray(json?.timeline)) return raw;

  return json.timeline
    .map(entry => {
      const speaker = entry.users?.[0]?.username || entry.username || 'Unknown';
      const text = entry.text || entry.raw_text || '';
      return `${speaker}: ${text}`;
    })
    .join('\n');
}

// GET /api/zoom/transcripts — for the frontend visibility page.
router.get('/transcripts', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const { data, error } = await supabase
    .from('zoom_call_transcripts')
    .select(`
      id, zoom_call_id, call_date_time, duration_seconds, direction,
      other_party_number, transcript_text, status, error_detail,
      candidate_client_ids, created_at, attached_at,
      matched_client:oo_clients!matched_client_id(id, first_name, last_name),
      matched_appointment:oo_appointments!matched_appointment_id(id, date, time)
    `)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });

  // Resolve candidate client names for ambiguous matches
  const candidateIds = [...new Set((data || []).flatMap(t => t.candidate_client_ids || []))];
  let candidateMap = {};
  if (candidateIds.length) {
    const { data: candidates } = await supabase
      .from('oo_clients').select('id, first_name, last_name').in('id', candidateIds);
    candidateMap = Object.fromEntries((candidates || []).map(c => [c.id, c]));
  }

  const transcripts = (data || []).map(t => ({
    ...t,
    candidate_clients: (t.candidate_client_ids || []).map(id => candidateMap[id]).filter(Boolean),
  }));

  res.json({ transcripts });
});

module.exports = router;

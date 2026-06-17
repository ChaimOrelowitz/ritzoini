const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { BASE, UA, login } = require('../utils/insync');

const HEADERS = (cookie, referer) => ({
  'User-Agent': UA,
  'Cookie': cookie,
  'Content-Type': 'application/x-www-form-urlencoded',
  'X-Requested-With': 'XMLHttpRequest',
  'Origin': BASE,
  'Referer': referer || `${BASE}/facesheet`,
});

// Parse FSEncounterReload HTML → [{ encId, dateIso, type, provider }]
function parseEncounterList(html) {
  const rows = html.split(/(?=<tr class="trfslist)/i);
  const results = [];
  for (const row of rows) {
    if (!row.includes('trfslist')) continue;

    // Encounter ID from any encounterid attribute or onclick
    const encIdMatch = row.match(/encounterid[="'\s:]+(\d{5,})/i);
    if (!encIdMatch) continue;
    const encId = encIdMatch[1];

    // Date from first td title: "MM/DD/YYYY ..."
    const dateMatch = row.match(/title="(\d{2})\/(\d{2})\/(\d{4})/);
    const dateIso = dateMatch ? `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}` : null;

    // All simple tds where title equals text content
    const simpleTds = [...row.matchAll(/<td[^>]+title="([^"]{2,80})">\s*\1\s*<\/td>/g)]
      .map(m => m[1].trim());
    // simpleTds[0] = date string, [1] = type, [2] = provider, [3] = location
    const type = simpleTds[1] || null;
    const provider = simpleTds[2] || null;

    results.push({ encId, dateIso, type, provider });
  }
  return results;
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// GET /api/oo/insync-notes?days=N (optional filter)
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    let q = supabase
      .from('insync_raw_notes')
      .select('id, insync_source_id, insync_patient_id, oo_client_id, client_name, service_date, encounter_type, provider_name, raw_note_text, import_batch, imported_at')
      .order('service_date', { ascending: false })
      .order('imported_at', { ascending: false })
      .limit(500);

    if (req.query.days) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - parseInt(req.query.days, 10));
      q = q.gte('service_date', cutoff.toISOString().slice(0, 10));
    }

    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/oo/insync-notes/import?days=7
// Pulls peer support encounter notes from InSync for all OO clients in the date window.
// Upserts into insync_raw_notes by insync_source_id — safe to run repeatedly.
router.post('/import', requireAuth, requireAdmin, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || req.body?.days || '7', 10), 90);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffIso = cutoff.toISOString().slice(0, 10);

    // Credentials from app_settings → env fallback
    const { data: settings } = await supabase
      .from('app_settings')
      .select('key,value')
      .in('key', ['insync_username', 'insync_password']);
    const username = settings?.find(r => r.key === 'insync_username')?.value || process.env.INSYNC_USERNAME;
    const password = settings?.find(r => r.key === 'insync_password')?.value || process.env.INSYNC_PASSWORD;
    if (!username || !password) return res.status(400).json({ error: 'InSync credentials not configured' });

    console.log('[insync-notes] logging in to InSync');
    const cookie = await login(username, password);

    const { data: clients, error: clientsErr } = await supabase
      .from('oo_clients')
      .select('id, first_name, last_name, insync_patient_id')
      .not('insync_patient_id', 'is', null)
      .neq('status', 'archived');
    if (clientsErr) throw clientsErr;

    const batchId = new Date().toISOString().slice(0, 10);
    const summary = { clients_checked: 0, peer_notes_found: 0, upserted: 0, errors: [] };

    for (const client of clients || []) {
      summary.clients_checked++;
      const pid = client.insync_patient_id;
      const clientName = `${client.first_name || ''} ${client.last_name || ''}`.trim();

      try {
        const encListRes = await fetch(`${BASE}/Facesheet/FSEncounterReload`, {
          method: 'POST',
          headers: HEADERS(cookie),
          body: `PatientID=${pid}&PageSize=50&SortBy=VisitDateNTime+DESC`,
        });
        if (!encListRes.ok) continue;
        const encHtml = await encListRes.text();

        const encounters = parseEncounterList(encHtml);
        const peerEncs = encounters.filter(e =>
          e.dateIso && e.dateIso >= cutoffIso &&
          e.type && e.type.toLowerCase().includes('peer')
        );

        console.log(`[insync-notes] ${clientName}: ${encounters.length} encounters, ${peerEncs.length} peer in window`);

        for (const enc of peerEncs) {
          summary.peer_notes_found++;
          const noteRef = `${BASE}/EncounterNote/EncounterNote?pid=${pid}&eid=${enc.encId}`;

          // GetDefaultNote → notesId
          const gdnBody = new URLSearchParams({
            'EncounterNoteBaseData[IsNeedToGeneretePDF]': 'true',
            'EncounterNoteBaseData[EncounterID]': enc.encId,
            'EncounterNoteBaseData[PatientID]': String(pid),
            'EncounterNoteBaseData[IsSignatureControlDisplay]': 'true',
            'EncounterNoteBaseData[PracticeId]': '200',
            'EncounterNoteBaseData[ConfigType]': '0',
            'EncounterNoteBaseData[TPChartingElementName]': '',
            'EncounterNoteBaseData[isFromCarePlan]': 'false',
          });

          let notesId = 0;
          try {
            const gdnRes = await fetch(`${BASE}/EncounterNote/GetDefaultNote`, {
              method: 'POST',
              headers: HEADERS(cookie, noteRef),
              body: gdnBody.toString(),
            });
            if (gdnRes.ok) {
              const gdnJson = await gdnRes.json();
              notesId = gdnJson.EncounterNoteStyle?.EncNotelist?.[0]?.NotesId || 0;
            }
          } catch (e) {
            summary.errors.push(`GetDefaultNote enc ${enc.encId}: ${e.message}`);
          }
          if (!notesId) continue;

          // GenerateEncounterNote → HTML note text
          const genBody = new URLSearchParams({
            'EncounterNoteBaseData[IsNeedToGeneretePDF]': 'true',
            'EncounterNoteBaseData[EncounterID]': enc.encId,
            'EncounterNoteBaseData[PatientID]': String(pid),
            'EncounterNoteBaseData[IsSignatureControlDisplay]': 'true',
            'EncounterNoteBaseData[PracticeId]': '200',
            'EncounterNoteBaseData[ConfigType]': '0',
            'EncounterNoteBaseData[TPChartingElementName]': '',
            'EncounterNoteBaseData[isFromCarePlan]': 'false',
            'EncounterNoteBaseData[FilePath]': '',
            'EncounterNoteBaseData[HTMLFontSize]': '11px',
            'EncounterNoteBaseData[HTMLFontName]': 'Arial',
            'EncounterNoteBaseData[ReferingPhyID]': '0',
            'EncounterNoteBaseData[IsEncounterClose]': 'false',
            'EncounterNoteBaseData[NotesID]': String(notesId),
          });

          let rawHtml = '';
          let rawText = '';
          try {
            const genRes = await fetch(`${BASE}/EncounterNote/GenerateEncounterNote`, {
              method: 'POST',
              headers: HEADERS(cookie, noteRef),
              body: genBody.toString(),
            });
            if (genRes.ok) {
              const genJson = await genRes.json();
              rawHtml = genJson.StrEncounterNote || '';
              rawText = stripHtml(rawHtml);
            }
          } catch (e) {
            summary.errors.push(`GenerateEncounterNote enc ${enc.encId}: ${e.message}`);
          }

          const { error: upsertErr } = await supabase
            .from('insync_raw_notes')
            .upsert({
              insync_source_id:  enc.encId,
              insync_patient_id: String(pid),
              oo_client_id:      client.id,
              client_name:       clientName,
              service_date:      enc.dateIso,
              encounter_type:    enc.type,
              provider_name:     enc.provider,
              raw_note_html:     rawHtml,
              raw_note_text:     rawText,
              import_batch:      batchId,
            }, { onConflict: 'insync_source_id' });

          if (upsertErr) {
            summary.errors.push(`Upsert enc ${enc.encId}: ${upsertErr.message}`);
          } else {
            summary.upserted++;
            console.log(`[insync-notes] upserted enc ${enc.encId} (${clientName}, ${enc.dateIso})`);
          }
        }
      } catch (e) {
        summary.errors.push(`Client ${clientName} (pid=${pid}): ${e.message}`);
      }
    }

    console.log('[insync-notes] import complete', summary);
    res.json({ success: true, batch: batchId, days, cutoff: cutoffIso, ...summary });
  } catch (err) {
    console.error('[insync-notes] import error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Portal POC — peer note transcription (portal.linksnetwork.com → InSync EHR).
//
// Mounted at /api/portal. Two phases, two different InSync logins:
//   Phase A (resolution) uses the ADMIN login and only READS — peer→provider id,
//     client→patient id, portal label→VisitTypeID, plus dedupe.
//   Phase B (execution) uses EACH PEER's own login, because only that session
//     sees the peer's calendar and only that session can sign as the peer.
//
// Between them sits the review screen: nothing is written to InSync until a
// human has looked at every staged row and pressed GO.

const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');
const { login } = require('../utils/insync');
const crypto = require('../utils/portalCrypto');
const IP = require('../utils/insyncPortal');
const M = require('../utils/portalMatch');
const X = require('../utils/portalExecute');

// Admins, plus accounts flagged portal_only. requireAuth already fences
// portal_only accounts out of the rest of the API; this keeps everyone else out
// of here.
function requirePortal(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.portal_only !== true) {
    return res.status(403).json({ error: 'Portal POC access required' });
  }
  next();
}

const guard = [requireAuth, requirePortal];
const ok = (res, p) => res.json(p);
const fail = (res, err, code = 500) => res.status(code).json({ error: err.message || String(err) });

// --- shared helpers --------------------------------------------------------

// The admin InSync session used for resolution only. Same credential source the
// OO section already uses, so there is one place to rotate it.
async function adminCookie() {
  const { data } = await supabase.from('app_settings').select('key,value')
    .in('key', ['insync_username', 'insync_password']);
  const username = data?.find(r => r.key === 'insync_username')?.value || process.env.INSYNC_USERNAME;
  const password = data?.find(r => r.key === 'insync_password')?.value || process.env.INSYNC_PASSWORD;
  if (!username || !password) throw new Error('Admin InSync credentials are not configured (app_settings.insync_username / insync_password)');
  return login(username, password);
}

async function captureTemplates() {
  const { data, error } = await supabase.from('portal_capture_templates').select('*');
  if (error) throw new Error(error.message);
  const out = {};
  for (const row of data || []) out[row.step] = { url: row.url, params: row.params };
  return out;
}

async function logEvent(runId, stagedNoteId, level, step, message, detail = null) {
  // Credentials must never reach this table. Callers pass step/message text they
  // built themselves; nothing here interpolates a password or a PIN.
  await supabase.from('portal_run_events').insert({
    run_id: runId, staged_note_id: stagedNoteId, level, step,
    message: String(message).slice(0, 2000), detail,
  });
}

// --- status ----------------------------------------------------------------

// What the page needs to tell the operator whether the system is even usable.
router.get('/status', ...guard, async (req, res) => {
  try {
    const [{ data: caps }, { data: verified }, { data: settings }] = await Promise.all([
      supabase.from('portal_capture_templates')
        .select('step, captured_from, captured_visit_type_id, field_count, updated_at').order('step'),
      supabase.from('portal_verified_types').select('*').order('insync_visit_type_id'),
      supabase.from('app_settings').select('key').in('key', ['insync_username', 'insync_password']),
    ]);
    const have = new Set((caps || []).map(c => c.step));
    ok(res, {
      credentials_configured: crypto.isConfigured(),
      admin_insync_configured: (settings || []).length === 2
        || !!(process.env.INSYNC_USERNAME && process.env.INSYNC_PASSWORD),
      captures: caps || [],
      missing_captures: X.REQUIRED_STEPS.filter(s => !have.has(s)),
      live_ready: X.REQUIRED_STEPS.every(s => have.has(s)),
      // The Offsite note form is optional — without it, Offsite encounter types
      // are blocked and base types are unaffected.
      offsite_form_available: have.has('note_offsite'),
      captured_visit_type_id: capturedType(caps),
      verified_types: verified || [],
      note_fields: X.NOTE_FIELDS,
      interventions: X.PEER_INTERVENTIONS.map(([code, label]) => ({ code, label })),
    });
  } catch (err) { fail(res, err); }
});

// Turn a row's flags into the short list of things somebody has to DO to make it
// runnable. The flags carry the diagnosis; this is the instruction. Computed
// here rather than in the page so the review screen and any future report agree.
function neededActions(resolution, flags, note) {
  const r = resolution || {};
  const has = field => (flags || []).some(f => f.field === field);
  const needs = [];

  if (!r.peer_id)            needs.push(`Add peer "${note?.peerName || '?'}"`);
  else if (!r.provider_id)   needs.push(`Set ${r.peer_name || 'peer'}'s InSync provider ID`);
  if (r.peer_id && (flags || []).some(f => f.field === 'peer' && /no stored InSync login/.test(f.message))) {
    needs.push(`Add ${r.peer_name || 'peer'}'s InSync login`);
  }
  if (r.peer_id && (flags || []).some(f => f.field === 'peer' && /inactive/.test(f.message))) {
    needs.push(`${r.peer_name || 'Peer'} is inactive`);
  }

  if (!r.patient_id) {
    const one = (r.client_candidates || []).find(c => c.dob_matches);
    needs.push(one
      ? `Bind patient — ${one.name}${one.mrn ? ` (MRN ${one.mrn})` : ''}`
      : (r.client_candidates || []).length
        ? `Pick the right patient (${r.client_candidates.length} candidates)`
        : `Find patient "${note?.clientName || '?'}" in InSync`);
  }

  if (!r.visit_type_id)      needs.push('Pick an encounter type');
  if (!r.duration)           needs.push('Portal note has no session duration');

  for (const f of flags || []) {
    if (f.field === 'note' && f.blocking) needs.push(f.message);
  }
  if (has('dedupe')) needs.push('Already processed — will be skipped');

  return needs;
}

// The encounter type the WRITE templates were captured against. Those payloads
// carry that type's CPT / modifier / POS / copay scaffolding, so any other type
// is replaying someone else's billing setup with the id swapped.
function capturedType(caps) {
  const appt = (caps || []).find(c => c.step === 'appointment');
  return appt?.captured_visit_type_id || null;
}

// Retained as audit history: rows recorded while live runs were gated on a
// human payload diff. Billing is now resolved per type from InSync, so nothing
// reads this to decide anything — it is kept because deleting a record of what
// somebody verified buys nothing.

router.get('/verified-types', ...guard, async (req, res) => {
  try {
    const { data, error } = await supabase.from('portal_verified_types').select('*').order('insync_visit_type_id');
    if (error) throw new Error(error.message);
    ok(res, data || []);
  } catch (err) { fail(res, err); }
});

// --- peers -----------------------------------------------------------------

// Credentials are WRITE-ONLY through this API: the response says whether a
// secret is on file, never what it is.
const peerView = p => ({
  id: p.id,
  portal_peer_name: p.portal_peer_name,
  insync_provider_id: p.insync_provider_id,
  insync_provider_name: p.insync_provider_name,
  insync_username: p.insync_username,
  has_password: !!p.insync_password_enc,
  has_pin: !!p.signing_pin_enc,
  is_active: p.is_active,
  notes: p.notes,
  created_at: p.created_at,
  updated_at: p.updated_at,
});

router.get('/peers', ...guard, async (req, res) => {
  try {
    const { data, error } = await supabase.from('portal_peers').select('*').order('portal_peer_name');
    if (error) throw new Error(error.message);
    ok(res, (data || []).map(peerView));
  } catch (err) { fail(res, err); }
});

function peerWrite(body) {
  const row = {};
  for (const k of ['portal_peer_name', 'insync_provider_id', 'insync_provider_name', 'insync_username', 'notes']) {
    if (body[k] !== undefined) row[k] = body[k] === '' ? null : body[k];
  }
  if (body.is_active !== undefined) row.is_active = body.is_active === true;
  // Empty string means "leave it alone"; null means "clear it".
  if (body.insync_password !== undefined) {
    row.insync_password_enc = body.insync_password ? crypto.encrypt(body.insync_password) : null;
  }
  if (body.signing_pin !== undefined) {
    row.signing_pin_enc = body.signing_pin ? crypto.encrypt(body.signing_pin) : null;
  }
  row.updated_at = new Date().toISOString();
  return row;
}

router.post('/peers', ...guard, async (req, res) => {
  try {
    if (!req.body.portal_peer_name) return res.status(400).json({ error: 'portal_peer_name is required' });
    const { data, error } = await supabase.from('portal_peers').insert(peerWrite(req.body)).select().single();
    if (error) throw new Error(error.message);
    ok(res, peerView(data));
  } catch (err) { fail(res, err); }
});

router.patch('/peers/:id', ...guard, async (req, res) => {
  try {
    const { data, error } = await supabase.from('portal_peers')
      .update(peerWrite(req.body)).eq('id', req.params.id).select().single();
    if (error) throw new Error(error.message);
    ok(res, peerView(data));
  } catch (err) { fail(res, err); }
});

router.delete('/peers/:id', ...guard, async (req, res) => {
  try {
    const { error } = await supabase.from('portal_peers').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    ok(res, { ok: true });
  } catch (err) { fail(res, err); }
});

// Live provider directory, optionally scored against a name. Suggestions only —
// binding a peer to a provider id is always an explicit human save.
router.get('/providers', ...guard, async (req, res) => {
  try {
    const providers = await IP.getProviderDirectory(await adminCookie());
    const q = String(req.query.q || '').trim();
    if (!q) return ok(res, { providers, exact: [], near: [] });
    const { exact, near } = M.matchName(q, providers);
    ok(res, { providers, exact, near });
  } catch (err) { fail(res, err); }
});

router.get('/visit-types', ...guard, async (req, res) => {
  try {
    const templates = await captureTemplates();
    const all = await IP.getVisitTypes(await adminCookie(), { template: templates.visittypes?.params });
    ok(res, all.filter(t => M.isPeerIndividualType(t.VisitType))
      .map(t => ({ ...t, offsite: M.parseInsyncTypeName(t.VisitType).offsite }))
      .sort((a, b) => a.VisitType.localeCompare(b.VisitType)));
  } catch (err) { fail(res, err); }
});

// --- client map ------------------------------------------------------------

router.get('/clients', ...guard, async (req, res) => {
  try {
    const { data, error } = await supabase.from('portal_client_map').select('*').order('portal_client_name');
    if (error) throw new Error(error.message);
    ok(res, data || []);
  } catch (err) { fail(res, err); }
});

// Free-text patient search for the confirm-a-client dialog.
router.get('/patients', ...guard, async (req, res) => {
  try {
    const text = String(req.query.q || '').trim();
    if (text.length < 2) return res.status(400).json({ error: 'Search text is too short' });
    const cookie = await adminCookie();
    let rows = await IP.searchPatients(cookie, { text });
    if (!rows.length) rows = await IP.searchPatients(cookie, { text, includeInactive: true });
    ok(res, rows);
  } catch (err) { fail(res, err); }
});

// Bind a portal client to an InSync patient. This is the one-time human
// confirmation the whole client-matching guardrail rests on.
router.post('/clients', ...guard, async (req, res) => {
  try {
    const { portal_client_name, portal_client_dob, insync_patient_id, insync_patient_name, insync_mrn } = req.body;
    if (!portal_client_name || !portal_client_dob || !insync_patient_id) {
      return res.status(400).json({ error: 'portal_client_name, portal_client_dob and insync_patient_id are required' });
    }
    const row = {
      portal_client_name, portal_client_dob,
      insync_patient_id: String(insync_patient_id),
      insync_patient_name: insync_patient_name || null,
      insync_mrn: insync_mrn || null,
      confirmed_by: req.user.id,
      confirmed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // The uniqueness rule is a FUNCTIONAL index -- lower(portal_client_name)
    // plus dob -- which ON CONFLICT cannot target by column name, so an upsert
    // here fails with "no unique or exclusion constraint matching". Match the
    // index's own semantics instead: find case-insensitively, then update or
    // insert.
    const { data: existing, error: findErr } = await supabase.from('portal_client_map')
      .select('id').ilike('portal_client_name', portal_client_name)
      .eq('portal_client_dob', portal_client_dob).maybeSingle();
    if (findErr) throw new Error(findErr.message);

    const q = existing
      ? supabase.from('portal_client_map').update(row).eq('id', existing.id)
      : supabase.from('portal_client_map').insert(row);
    const { data, error } = await q.select().single();
    if (error) throw new Error(error.message);
    ok(res, data);
  } catch (err) { fail(res, err); }
});

router.delete('/clients/:id', ...guard, async (req, res) => {
  try {
    const { error } = await supabase.from('portal_client_map').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    ok(res, { ok: true });
  } catch (err) { fail(res, err); }
});

// --- Phase A: upload, dedupe, resolve --------------------------------------

const REQUIRED_NOTE_KEYS = ['portalNoteId', 'peerName', 'clientName', 'clientDateOfBirth', 'sessionDate', 'sessionStartMinutes'];

// Resolve every staged row in a run against InSync. Idempotent — re-runnable
// after the operator fixes a peer binding or confirms a client.
async function resolveRun(runId) {
  const cookie = await adminCookie();
  const packForTypes = await captureTemplates();
  const [visitTypes, providers, peers, clientMap] = await Promise.all([
    IP.getVisitTypes(cookie, { template: packForTypes.visittypes?.params }),
    IP.getProviderDirectory(cookie),
    supabase.from('portal_peers').select('*').then(r => r.data || []),
    supabase.from('portal_client_map').select('*').then(r => r.data || []),
  ]);

  const peerByName = new Map(peers.map(p => [M.normalizeName(p.portal_peer_name), p]));
  const clientByKey = new Map(clientMap.map(c => [`${M.normalizeName(c.portal_client_name)}|${c.portal_client_dob}`, c]));

  const { data: staged } = await supabase.from('portal_staged_notes')
    .select('*').eq('run_id', runId).neq('status', 'done');

  const updates = [];
  for (const row of staged || []) {
    const note = row.note;
    const prev = row.resolution || {};
    const flags = [];
    const resolution = { ...prev };

    // -- peer → provider id
    const peer = peerByName.get(M.normalizeName(note.peerName));
    if (!peer) {
      flags.push({ field: 'peer', message: `"${note.peerName}" is not in the peer list — add them on the Peers tab` });
      resolution.peer_id = null; resolution.provider_id = null;
    } else if (!peer.is_active) {
      flags.push({ field: 'peer', message: `${peer.portal_peer_name} is marked inactive` });
      resolution.peer_id = peer.id;
    } else {
      resolution.peer_id = peer.id;
      resolution.peer_name = peer.portal_peer_name;
      resolution.provider_id = peer.insync_provider_id || null;
      resolution.provider_name = peer.insync_provider_name || null;
      if (!peer.insync_provider_id) {
        const { exact, near } = M.matchName(note.peerName, providers);
        resolution.provider_suggestions = [...exact, ...near].slice(0, 5);
        flags.push({ field: 'peer', message: `${peer.portal_peer_name} has no InSync provider ID yet` });
      }
      if (!peer.insync_username || !peer.insync_password_enc) {
        flags.push({ field: 'peer', message: `${peer.portal_peer_name} has no stored InSync login — execution runs as the peer` });
      }
    }

    // -- client → patient id. Confirmed bindings only; a fresh search NEVER
    //    auto-binds, because a note in the wrong chart is real harm.
    const key = `${M.normalizeName(note.clientName)}|${note.clientDateOfBirth}`;
    const mapped = clientByKey.get(key);
    if (mapped) {
      resolution.patient_id = mapped.insync_patient_id;
      resolution.patient_name = mapped.insync_patient_name || note.clientName;
      resolution.client_map_id = mapped.id;
      resolution.client_candidates = null;
    } else {
      resolution.patient_id = null;
      resolution.client_map_id = null;
      let candidates = [];
      try {
        // InSync matches on "Last, First" and returns NOTHING for the portal's
        // "First Last" — searching the portal string verbatim found zero
        // patients for every client tested. Fall back to the bare surname for
        // first-name drift ("Chana Englard" is "Chana Rochel" in her own notes).
        let rows = [];
        for (const q of M.patientQueries(note.clientName)) {
          rows = await IP.searchPatients(cookie, { text: q });
          if (rows.some(r => r.dob === note.clientDateOfBirth)) break;
        }
        const byDob = rows.filter(r => r.dob === note.clientDateOfBirth);
        candidates = (byDob.length ? byDob : rows).slice(0, 10)
          .map(r => ({ ...r, dob_matches: r.dob === note.clientDateOfBirth }));
      } catch (e) {
        flags.push({ field: 'client', message: `Patient search failed: ${e.message}` });
      }
      resolution.client_candidates = candidates;
      flags.push({
        field: 'client',
        message: candidates.length === 1 && candidates[0].dob_matches
          ? `One likely InSync patient (${candidates[0].name}, MRN ${candidates[0].mrn || '—'}) — confirm it to bind this client`
          : candidates.length
            ? `${candidates.length} possible InSync patients — pick the right one`
            : 'No InSync patient matched this name; search manually',
      });
    }

    // -- encounter type. An operator override always wins over the auto-match.
    const match = M.matchEncounterType(note, visitTypes);
    // Offsite types are switched off by policy — the portal has no field for the
    // justification their template requires, so they are not offerable at all.
    // Filtering here (rather than only guarding execution) keeps the dropdown
    // honest about what can actually be run.
    resolution.type_candidates = match.candidates
      .filter(t => !M.parseInsyncTypeName(t.VisitType).offsite)
      .map(t => ({
        VisitTypeID: t.VisitTypeID, VisitType: t.VisitType, Duration: t.Duration,
        offsite: false,
      }));
    resolution.dimensions = match.dimensions;

    const overrideId = prev.visit_type_override || null;
    const chosen = overrideId
      ? match.candidates.find(t => t.VisitTypeID === String(overrideId))
      : match.matched;

    if (chosen) {
      resolution.visit_type_id = chosen.VisitTypeID;
      resolution.visit_type_name = chosen.VisitType;
      resolution.visit_type_offsite = M.parseInsyncTypeName(chosen.VisitType).offsite;
      resolution.visit_type_auto = !overrideId;
    } else {
      resolution.visit_type_id = null;
      resolution.visit_type_name = null;
      resolution.visit_type_offsite = false;
      flags.push({ field: 'encounter_type', message: match.reason || 'No encounter type selected' });
    }

    // -- note fields. The template shape is driven by the SELECTED type, so an
    //    offsite override immediately makes the justification field required.
    const { fields, warnings } = X.buildNoteFields(note, {
      manual: prev.manual || {},
      offsite: !!resolution.visit_type_offsite,
    });
    resolution.note_fields = fields;
    for (const w of warnings) {
      flags.push({ field: 'note', message: w, blocking: /required by the Offsite template|InSync requires at least one/.test(w) });
    }

    resolution.duration = Number(note.durationMinutes) || 0;
    if (!resolution.duration) flags.push({ field: 'note', message: 'Portal note has no session duration' });

    // A flag blocks unless it explicitly says otherwise — "Intervention Details
    // is empty" is a warning worth showing, not a reason to hold the row.
    const blocking = flags.filter(f => f.blocking !== false);
    const ready = !!(resolution.provider_id && resolution.patient_id && resolution.visit_type_id
                     && resolution.duration && blocking.length === 0);
    resolution.needs = ready ? [] : neededActions(resolution, flags, note);

    updates.push({
      id: row.id, resolution, flags,
      status: row.status === 'duplicate' ? 'duplicate' : (ready ? 'ready' : 'needs_attention'),
      updated_at: new Date().toISOString(),
    });
  }

  for (const u of updates) {
    const { id, ...rest } = u;
    await supabase.from('portal_staged_notes').update(rest).eq('id', id);
  }
  return updates.length;
}

// Upload a portal export. The whole file is staged verbatim; nothing is
// rewritten, and nothing reaches InSync yet.
router.post('/runs', ...guard, async (req, res) => {
  try {
    const payload = req.body?.payload;
    const notes = payload?.notes;
    if (!Array.isArray(notes) || !notes.length) {
      return res.status(400).json({ error: 'Upload does not look like a portal export — no notes array' });
    }
    const bad = notes.findIndex(n => REQUIRED_NOTE_KEYS.some(k => n[k] === undefined || n[k] === null));
    if (bad !== -1) {
      return res.status(400).json({ error: `Note ${bad + 1} is missing one of: ${REQUIRED_NOTE_KEYS.join(', ')}` });
    }

    const uuids = notes.map(n => String(n.portalNoteId));
    const { data: already } = await supabase.from('portal_processed_notes')
      .select('portal_note_uuid, status').in('portal_note_uuid', uuids);
    const done = new Set((already || []).filter(r => r.status === 'done').map(r => r.portal_note_uuid));

    const { data: run, error: runErr } = await supabase.from('portal_job_runs').insert({
      uploaded_by: req.user.id,
      source_filename: req.body.filename || null,
      exported_at: payload.exportedAt || null,
      note_count: notes.length,
      duplicate_count: 0,
      status: 'staged',
    }).select().single();
    if (runErr) throw new Error(runErr.message);

    // Dedupe on the portal's own UUID, and honour the portal's own
    // "already entered" marker — either one means hands off.
    const seen = new Set();
    const rows = [];
    let duplicates = 0;
    for (const n of notes) {
      const uuid = String(n.portalNoteId);
      if (seen.has(uuid)) { duplicates++; continue; }
      seen.add(uuid);
      const dupe = done.has(uuid) || !!n.enteredInInsyncAt;
      if (dupe) duplicates++;
      rows.push({
        run_id: run.id, portal_note_uuid: uuid, note: n,
        resolution: {}, flags: dupe
          ? [{ field: 'dedupe', message: n.enteredInInsyncAt ? 'The portal already marks this note as entered in InSync' : 'This note was already processed by a previous run' }]
          : [],
        status: dupe ? 'duplicate' : 'needs_attention',
      });
    }

    const { error: stErr } = await supabase.from('portal_staged_notes').insert(rows);
    if (stErr) throw new Error(stErr.message);
    await supabase.from('portal_job_runs').update({ duplicate_count: duplicates }).eq('id', run.id);
    await logEvent(run.id, null, 'info', 'upload',
      `Staged ${rows.length} note(s) from ${req.body.filename || 'upload'}; ${duplicates} skipped as already done`);

    let resolveError = null;
    try { await resolveRun(run.id); }
    catch (e) { resolveError = e.message; await logEvent(run.id, null, 'error', 'resolve', `Resolution failed: ${e.message}`); }

    ok(res, { run_id: run.id, staged: rows.length, duplicates, resolve_error: resolveError });
  } catch (err) { fail(res, err); }
});

router.get('/runs', ...guard, async (req, res) => {
  try {
    const { data, error } = await supabase.from('portal_job_runs')
      .select('*').order('uploaded_at', { ascending: false }).limit(50);
    if (error) throw new Error(error.message);
    ok(res, data || []);
  } catch (err) { fail(res, err); }
});

router.get('/runs/:id', ...guard, async (req, res) => {
  try {
    const [{ data: run }, { data: notes }] = await Promise.all([
      supabase.from('portal_job_runs').select('*').eq('id', req.params.id).maybeSingle(),
      supabase.from('portal_staged_notes').select('*').eq('run_id', req.params.id).order('created_at'),
    ]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    ok(res, { run, notes: notes || [] });
  } catch (err) { fail(res, err); }
});

router.delete('/runs/:id', ...guard, async (req, res) => {
  try {
    const { error } = await supabase.from('portal_job_runs').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    ok(res, { ok: true });
  } catch (err) { fail(res, err); }
});

router.post('/runs/:id/resolve', ...guard, async (req, res) => {
  try {
    const n = await resolveRun(req.params.id);
    await logEvent(req.params.id, null, 'info', 'resolve', `Re-resolved ${n} staged note(s)`);
    ok(res, { resolved: n });
  } catch (err) { fail(res, err); }
});

// Operator overrides from the review screen: encounter type, the manual note
// fields, or skipping a row. Everything else about a note is immutable.
router.patch('/runs/:runId/notes/:noteId', ...guard, async (req, res) => {
  try {
    const { data: row } = await supabase.from('portal_staged_notes')
      .select('*').eq('id', req.params.noteId).eq('run_id', req.params.runId).maybeSingle();
    if (!row) return res.status(404).json({ error: 'Staged note not found' });
    if (row.status === 'done') return res.status(409).json({ error: 'This note has already been written to InSync' });

    const resolution = { ...row.resolution };
    if (req.body.visit_type_override !== undefined) {
      resolution.visit_type_override = req.body.visit_type_override || null;
    }
    if (req.body.manual && typeof req.body.manual === 'object') {
      resolution.manual = { ...(resolution.manual || {}), ...req.body.manual };
    }
    // Recompute this one row in place, without a round trip to InSync: the
    // encounter type comes from the candidate list already resolved for it, and
    // the template shape follows from that choice. Peer and client bindings are
    // untouched here, so nothing needs re-looking-up.
    const candidates = resolution.type_candidates || [];
    const chosen = resolution.visit_type_override
      ? candidates.find(t => t.VisitTypeID === String(resolution.visit_type_override))
      : candidates.find(t => t.VisitTypeID === resolution.visit_type_id);
    if (chosen) {
      resolution.visit_type_id = chosen.VisitTypeID;
      resolution.visit_type_name = chosen.VisitType;
      resolution.visit_type_offsite = !!chosen.offsite;
      resolution.visit_type_auto = !resolution.visit_type_override;
    }

    const keep = (row.flags || []).filter(f => f.field !== 'note' && f.field !== 'encounter_type');
    const flags = [...keep];
    if (!resolution.visit_type_id) flags.push({ field: 'encounter_type', message: 'No encounter type selected' });

    const { fields, warnings } = X.buildNoteFields(row.note, {
      manual: resolution.manual || {}, offsite: !!resolution.visit_type_offsite,
    });
    resolution.note_fields = fields;
    for (const w of warnings) {
      flags.push({ field: 'note', message: w, blocking: /required by the Offsite template|InSync requires at least one/.test(w) });
    }

    const ready = !!(resolution.provider_id && resolution.patient_id && resolution.visit_type_id
                     && resolution.duration && flags.filter(f => f.blocking !== false).length === 0);
    resolution.needs = ready ? [] : neededActions(resolution, flags, row.note);

    const patch = { resolution, flags, updated_at: new Date().toISOString() };
    if (req.body.status === 'skipped') patch.status = 'skipped';
    else if (row.status !== 'duplicate') patch.status = ready ? 'ready' : 'needs_attention';

    await supabase.from('portal_staged_notes').update(patch).eq('id', row.id);
    ok(res, { ok: true, status: patch.status, flags, resolution });
  } catch (err) { fail(res, err); }
});

router.get('/runs/:id/events', ...guard, async (req, res) => {
  try {
    const after = Number(req.query.after || 0);
    const { data, error } = await supabase.from('portal_run_events')
      .select('*').eq('run_id', req.params.id).gt('id', after).order('id').limit(1000);
    if (error) throw new Error(error.message);
    ok(res, data || []);
  } catch (err) { fail(res, err); }
});

// The payload-diff gate: the exact bodies that WOULD be sent for one note, so a
// new encounter type can be compared against a real manual capture before any
// bulk live run on that type.
router.get('/runs/:runId/notes/:noteId/payloads', ...guard, async (req, res) => {
  try {
    const { data: row } = await supabase.from('portal_staged_notes')
      .select('*').eq('id', req.params.noteId).eq('run_id', req.params.runId).maybeSingle();
    if (!row) return res.status(404).json({ error: 'Staged note not found' });
    const templates = await captureTemplates();
    const r = row.resolution || {};
    if (!r.visit_type_id) return res.status(400).json({ error: 'This note has no encounter type selected yet' });

    // Resolve billing live so the preview shows the numbers that would really be
    // sent, not the captured type's.
    let billing = null;
    if (r.patient_id) {
      try {
        billing = await IP.resolveBilling(await adminCookie(), {
          template: templates.schedulercalendar?.params,
          patientId: r.patient_id, providerId: r.provider_id,
          dateIso: row.note.sessionDate, visitTypeId: r.visit_type_id,
        });
      } catch (e) {
        return res.status(400).json({ error: `Could not resolve billing for this type: ${e.message}` });
      }
    }
    const { data: caps } = await supabase.from('portal_capture_templates')
      .select('step, captured_visit_type_id');

    const prepared = X.preparePayloads({
      templates: X.templatesFor(templates, !!r.visit_type_offsite),
      capturedVisitTypeId: capturedType(caps),
      ctx: {
        billing,
        patientId: r.patient_id || '<patient>', patientName: r.patient_name || row.note.clientName,
        providerId: r.provider_id || '<provider>', providerName: r.provider_name || row.note.peerName,
        visitTypeId: r.visit_type_id, visitTypeName: r.visit_type_name,
        sessionDate: row.note.sessionDate, sessionStartMinutes: row.note.sessionStartMinutes,
        duration: r.duration, noteFields: r.note_fields || {},
      },
      visitId: '<visit>', encounterId: '<encounter>',
      // Never render a real PIN into a diff artifact.
      signingPin: '<peer PIN>',
    });
    ok(res, { visit_type: r.visit_type_name, billing, payloads: prepared });
  } catch (err) { fail(res, err); }
});

// --- Phase B: execution ----------------------------------------------------

// Peers are processed in batches — log in once as a peer, do all of their notes,
// move on. Serially, always: InSync keeps a current-patient in session state, so
// two concurrent requests on one login would misattribute a note.
async function executeRun(runId, { mode, sign, noteIds }) {
  const live = mode === 'live';
  const templates = await captureTemplates();
  const { data: caps } = await supabase.from('portal_capture_templates')
    .select('step, captured_visit_type_id');

  await supabase.from('portal_job_runs').update({
    status: 'executing', last_execution_mode: live ? 'live' : 'dry_run',
    last_executed_at: new Date().toISOString(),
  }).eq('id', runId);

  let q = supabase.from('portal_staged_notes').select('*').eq('run_id', runId).eq('status', 'ready');
  if (Array.isArray(noteIds) && noteIds.length) q = q.in('id', noteIds);
  const { data: rows } = await q;

  await logEvent(runId, null, 'info', 'start',
    `${live ? 'LIVE RUN' : 'DRY RUN'} starting for ${(rows || []).length} ready note(s)${live && sign ? ' (signing ON)' : live ? ' (signing OFF)' : ''}`);

  const byPeer = new Map();
  for (const r of rows || []) {
    const pid = r.resolution?.peer_id || 'unknown';
    if (!byPeer.has(pid)) byPeer.set(pid, []);
    byPeer.get(pid).push(r);
  }

  let done = 0, failed = 0;

  for (const [peerId, notes] of byPeer) {
    const { data: peer } = await supabase.from('portal_peers').select('*').eq('id', peerId).maybeSingle();
    if (!peer) {
      for (const n of notes) { failed++; await recordFailure(runId, n, 'peer', 'Peer record disappeared before execution', live); }
      continue;
    }

    let cookie = null;
    let pin = null;
    if (live) {
      try {
        const password = crypto.decrypt(peer.insync_password_enc);
        if (!peer.insync_username || !password) throw new Error('no stored InSync login');
        pin = sign ? crypto.decrypt(peer.signing_pin_enc) : null;
        if (sign && !pin) throw new Error('signing is on but no signing PIN is stored');
        await logEvent(runId, null, 'info', 'login', `Logging in to InSync as ${peer.portal_peer_name}`);
        cookie = await login(peer.insync_username, password);
        // The plaintext password is not held past this point.
      } catch (e) {
        // crypto.scrub is belt-and-braces: a decrypt/login error should never
        // carry a secret, but this guarantees it.
        const msg = crypto.scrub(e.message, peer.insync_username);
        for (const n of notes) { failed++; await recordFailure(runId, n, 'login', `Could not sign in as ${peer.portal_peer_name}: ${msg}`, true); }
        continue;
      }
    } else {
      await logEvent(runId, null, 'info', 'login',
        `Would log in to InSync as ${peer.portal_peer_name}${peer.insync_username ? '' : ' (NO stored username — live would fail here)'}`);
    }

    for (const row of notes) {
      const r = row.resolution || {};
      const note = row.note;
      const log = (level, step, message, detail) => logEvent(runId, row.id, level, step, message, detail);
      try {
        await log('info', 'note', `${note.clientName} — ${note.sessionDate} ${note.sessionStartClock || ''} — ${r.visit_type_name}`);

        // The appointment-exists check can only happen here, on the peer's own
        // session. Caseload is not a valid signal — clients change peers.
        let existing = null;
        if (live) {
          const appts = await IP.loadCalendarView(cookie, {
            dateIso: note.sessionDate, resourceId: r.provider_id,
            template: templates.calendar?.params,
          });
          existing = IP.findExistingAppointment(appts, {
            patientId: r.patient_id, startMinutes: note.sessionStartMinutes, clientName: note.clientName,
          });
          await log('info', 'calendar', existing
            ? `Found appointment VisitID ${existing.visitId} at minute ${existing.startMinutes} (status ${existing.statusId})`
            : `No matching appointment on ${note.sessionDate} at minute ${note.sessionStartMinutes} — one will be created`);
        }

        // Everything that follows from the chosen encounter type — CPT, modifier,
        // units, POS — plus this patient's program enrolment, asked of InSync
        // rather than replayed from the capture. Resolved per note because the
        // program is per patient and the CPT map is per type.
        const billing = await IP.resolveBilling(cookie || await adminCookie(), {
          template: templates.schedulercalendar?.params,
          patientId: r.patient_id,
          providerId: r.provider_id,
          dateIso: note.sessionDate,
          visitTypeId: r.visit_type_id,
        });
        if (!billing.programManagementDetailId) {
          throw new X.StepError('billing',
            billing.programCount > 1
              ? `${note.clientName} has ${billing.programCount} program enrolments in InSync ` +
                `(${billing.programNames.join(', ')}). Which one this encounter belongs to is a human ` +
                `decision — pick it in InSync, or run this note by hand.`
              : `InSync returned no program enrolment for ${note.clientName}. Refusing to book with ` +
                `another patient's program — check the client's program in InSync.`);
        }
        await log('info', 'billing',
          `Type ${r.visit_type_id}: CPT ${billing.cptCode} map ${billing.cptMapId}` +
          `${billing.m1 ? ` modifier ${billing.m1}` : ' no modifier'}` +
          `, ${billing.units} unit(s), POS ${billing.posCode}, program ${billing.programManagementDetailId}`);

        const result = await X.executeNote({
          templates,
          capturedVisitTypeId: capturedType(caps),
          ctx: {
            billing,
            patientId: r.patient_id, patientName: r.patient_name || note.clientName,
            providerId: r.provider_id, providerName: r.provider_name || note.peerName,
            visitTypeId: r.visit_type_id, visitTypeName: r.visit_type_name,
            sessionDate: note.sessionDate, sessionStartMinutes: note.sessionStartMinutes,
            duration: r.duration, noteFields: r.note_fields || {},
            // Drives which note FORM is replayed — base or Offsite.
            offsite: !!r.visit_type_offsite,
          },
          cookie, existing, signingPin: pin, allowSign: !!(live && sign),
          dryRun: !live, log,
        });

        if (live) {
          await supabase.from('portal_processed_notes').upsert({
            portal_note_uuid: row.portal_note_uuid, run_id: runId,
            peer_name: peer.portal_peer_name, client_name: note.clientName,
            session_date: note.sessionDate, insync_visit_type_id: r.visit_type_id,
            insync_visit_id: result.visitId, insync_encounter_id: result.encounterId,
            appointment_reused: result.appointmentReused, signed: result.signed,
            status: 'done', error_detail: null, processed_at: new Date().toISOString(),
          }, { onConflict: 'portal_note_uuid' });
          await supabase.from('portal_staged_notes').update({ status: 'done' }).eq('id', row.id);
        }
        done++;
        await log('info', 'note', live ? 'Note complete' : 'Dry run complete for this note');
      } catch (e) {
        failed++;
        await recordFailure(runId, row, e.step || 'note', crypto.scrub(e.message, peer.insync_username), live);
      }
    }
    cookie = null; pin = null;
  }

  await logEvent(runId, null, 'info', 'finish',
    `${live ? 'LIVE RUN' : 'DRY RUN'} finished — ${done} succeeded, ${failed} failed`);
  await supabase.from('portal_job_runs').update({ status: failed && !done ? 'failed' : 'done' }).eq('id', runId);
  return { done, failed };
}

async function recordFailure(runId, row, step, message, live = false) {
  await logEvent(runId, row.id, 'error', step, message);
  if (live) {
    await supabase.from('portal_processed_notes').upsert({
      portal_note_uuid: row.portal_note_uuid, run_id: runId,
      peer_name: row.resolution?.peer_name || row.note?.peerName,
      client_name: row.note?.clientName, session_date: row.note?.sessionDate,
      insync_visit_type_id: row.resolution?.visit_type_id || null,
      status: 'failed', error_detail: message, processed_at: new Date().toISOString(),
    }, { onConflict: 'portal_note_uuid' });
    await supabase.from('portal_staged_notes').update({ status: 'failed' }).eq('id', row.id);
  }
}

// Kick a run off in the background and return immediately — a live batch can
// take minutes, and the page follows along through /events.
router.post('/runs/:id/execute', ...guard, async (req, res) => {
  try {
    const mode = req.body?.mode === 'live' ? 'live' : 'dry_run';
    const sign = req.body?.sign === true;

    if (mode === 'live') {
      const templates = await captureTemplates();
      const missing = X.REQUIRED_STEPS.filter(s => !templates[s]);
      if (missing.length) {
        return res.status(400).json({
          error: `Live execution is blocked: no captured request template for ${missing.join(', ')}. ` +
                 `Run scripts/extract-insync-captures.js against a HAR that contains those calls.`,
        });
      }
      if (req.body?.confirm !== true) {
        return res.status(400).json({ error: 'A live run must be confirmed explicitly' });
      }

    }

    const { data: run } = await supabase.from('portal_job_runs').select('id, status').eq('id', req.params.id).maybeSingle();
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status === 'executing') return res.status(409).json({ error: 'This run is already executing' });

    res.json({ started: true, mode, sign });
    executeRun(req.params.id, { mode, sign, noteIds: req.body?.note_ids })
      .catch(async e => {
        await logEvent(req.params.id, null, 'error', 'run', `Run aborted: ${e.message}`);
        await supabase.from('portal_job_runs').update({ status: 'failed' }).eq('id', req.params.id);
      });
  } catch (err) { fail(res, err); }
});

router.get('/processed', ...guard, async (req, res) => {
  try {
    const { data, error } = await supabase.from('portal_processed_notes')
      .select('*').order('processed_at', { ascending: false }).limit(500);
    if (error) throw new Error(error.message);
    ok(res, data || []);
  } catch (err) { fail(res, err); }
});

module.exports = router;

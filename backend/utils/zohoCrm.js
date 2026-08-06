const supabase = require('../db/supabase');

// Zoho data-center domains. Defaults to the US (.com) DC; override via env for
// EU/IN/AU/etc. (e.g. https://accounts.zoho.eu / https://www.zohoapis.eu).
const ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com';
const API_DOMAIN      = process.env.ZOHO_API_DOMAIN      || 'https://www.zohoapis.com';

// The custom module + fields the "Therapist View" widget reads/writes. These
// defaults match the widget (utils reverse-engineered from "Iframe for zoho");
// override via env only if the org renamed the module/fields.
const OCC_MODULE   = process.env.ZOHO_OCC_MODULE   || 'Session_Occurrences';
const DATE_FIELD   = process.env.ZOHO_OCC_DATE_FIELD || 'Session_Date'; // matched to session_date
const NOTE_FIELD   = process.env.ZOHO_OCC_NOTE_FIELD || 'Clinical_Note';
const STATUS_FIELD = process.env.ZOHO_OCC_STATUS_FIELD || 'ECW';
const STATUS_VALUE = process.env.ZOHO_OCC_STATUS_VALUE || 'Notes Received';

// The parent group module ("Session"). Its Session_Name is the friendly group
// name; occurrences link to it via their `Session` lookup. Occurrences carry NO
// Session_Name of their own — matching goes through the parent id.
const PARENT_MODULE     = process.env.ZOHO_PARENT_MODULE || 'Session';
const PARENT_NAME_FIELD = process.env.ZOHO_PARENT_NAME_FIELD || 'Session_Name';

// Cached access token — Zoho access tokens live ~1h; refresh on demand.
let cachedToken = null;
let cachedTokenExpiry = 0; // epoch ms

// Refresh token can come from the DB (minted via the exchange helper, survives
// restarts) or fall back to the env var. DB wins so the "Get Refresh Token"
// button takes effect immediately with no redeploy.
let dbRefreshToken = null;

const clean = (v) => (v || '').trim().replace(/^["']|["']$/g, '');

function currentRefreshToken() {
  return dbRefreshToken || clean(process.env.ZOHO_REFRESH_TOKEN);
}

// Load a previously-exchanged refresh token from app_config on startup.
async function loadZohoRefreshToken() {
  try {
    const { data } = await supabase
      .from('app_config').select('value').eq('key', 'zoho_refresh_token').single();
    if (data?.value) dbRefreshToken = clean(data.value);
  } catch (err) {
    // Table row absent is fine — falls back to env.
  }
}

function zohoConfigured() {
  return !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && currentRefreshToken());
}

// Exchange the long-lived refresh token for a short-lived access token.
async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry - 60_000) return cachedToken;

  if (!zohoConfigured()) {
    throw new Error('Zoho not configured (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN)');
  }

  const params = new URLSearchParams({
    refresh_token: currentRefreshToken(),
    client_id:     clean(process.env.ZOHO_CLIENT_ID),
    client_secret: clean(process.env.ZOHO_CLIENT_SECRET),
    grant_type:    'refresh_token',
  });

  // Zoho wants the params as a form-encoded body (query-string also works, but
  // the body form is the documented one and avoids some general_error cases).
  const resp = await fetch(`${ACCOUNTS_DOMAIN}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const raw = await resp.text();
  let body = {};
  try { body = JSON.parse(raw); } catch { /* non-JSON */ }

  if (!resp.ok || !body.access_token) {
    console.error(`[zoho] token refresh raw response (${resp.status}) from ${ACCOUNTS_DOMAIN}:`, raw);
    const hint = body.error === 'general_error'
      ? ' — usually means client_id/secret and refresh_token are from different apps, or a different Zoho data center'
      : '';
    throw new Error(`Zoho token refresh failed: ${resp.status} ${body.error || raw.slice(0, 200)}${hint}`);
  }

  cachedToken = body.access_token;
  cachedTokenExpiry = Date.now() + (Number(body.expires_in) || 3600) * 1000;
  return cachedToken;
}

async function zohoFetch(path, options = {}) {
  const token = await getAccessToken();
  return fetch(`${API_DOMAIN}${path}`, {
    ...options,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

function normalizeName(v) {
  return (v || '').trim().toLowerCase();
}

// Find the Session_Occurrences record for a given group name + date.
// Fetch every Session_Occurrences record on a given date (Session_Date is a
// searchable YYYY-MM-DD field). Returns the array (each record carries its
// `Session` parent lookup and `Name`).
async function searchOccurrencesByDate(sessionDate) {
  if (!sessionDate) return [];
  const criteria = encodeURIComponent(`(${DATE_FIELD}:equals:${sessionDate})`);
  const resp = await zohoFetch(`/crm/v2/${OCC_MODULE}/search?criteria=${criteria}&per_page=200`);
  if (resp.status === 204) return []; // Zoho returns 204 for no matches
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Zoho search failed: ${resp.status} ${JSON.stringify(body)}`);
  return body.data || [];
}

// Pick the occurrence for a Ritzoini group out of a date's occurrences.
// Primary: the aligned parent id (group.zoho_session_id === occ.Session.id).
// Fallback (unaligned groups): the occurrence's Name embeds the group name,
// e.g. "Emotional Boundaries Skills Group - Session 7".
function matchOccurrence(occurrences, group) {
  const zohoId = group?.zoho_session_id;
  if (zohoId) {
    const byId = occurrences.find(o => o.Session && o.Session.id === zohoId);
    if (byId) return byId;
  }
  const gname = normalizeName(group?.group_name || group?.name);
  if (gname) {
    const byName = occurrences.find(o => normalizeName(o.Name).startsWith(gname));
    if (byName) return byName;
  }
  return null;
}

// Match a single group + date (used by the diagnostic).
async function findOccurrence(group, sessionDate) {
  return matchOccurrence(await searchOccurrencesByDate(sessionDate), group);
}

// Zoho preloads Clinical_Note with a header ("Group Name:" / "Group Activity:")
// that carries Zoho-only info (e.g. the activity/level). Preserve those leading
// header lines and put the Ritzoini note beneath them, rather than overwriting.
const HEADER_RE = /^\s*(Group Name|Group Activity)\s*:/i;
// Keep the "Group Name:" / "Group Activity:" header on the note. If the existing
// Zoho note already has one (a re-post/edit), preserve it; otherwise use the
// built `fallbackHeader` — Zoho only pre-fills that header client-side in the
// widget, so on a first post it isn't stored and must be supplied by us.
function mergeWithHeader(existing, note, fallbackHeader) {
  const header = [];
  for (const line of String(existing || '').split(/\r?\n/)) {
    if (HEADER_RE.test(line)) { header.push(line.replace(/\s+$/, '')); continue; }
    if (line.trim() === '') { if (header.length) break; else continue; }
    break; // first real content line ends the header region
  }
  const headerStr = header.length ? header.join('\n') : String(fallbackHeader || '').trim();
  const body = String(note || '');
  if (!headerStr) return body.trim();

  // Drop any duplicate header/blank lines already at the top of the note.
  const noteLines = body.split(/\r?\n/);
  let i = 0;
  while (i < noteLines.length && (HEADER_RE.test(noteLines[i]) || noteLines[i].trim() === '')) i++;
  return `${headerStr}\n\n${noteLines.slice(i).join('\n').trim()}`;
}

// Build the header Zoho would pre-fill: "Group Name: <group>\nGroup Activity: <activity>".
// Group name from the parent cache (or occ.Name minus the "- Session N" suffix);
// activity from the parent cache (occurrences don't carry it).
function buildOccHeader(occ, cacheRow, groupName) {
  const name = (cacheRow && cacheRow.session_name)
    || String(occ.Name || '').replace(/\s*-\s*Session\s*\d+\s*$/i, '').trim()
    || groupName || '';
  const activity = cacheRow && cacheRow.group_activity;
  const lines = [];
  if (name) lines.push(`Group Name: ${name}`);
  if (activity) lines.push(`Group Activity: ${activity}`);
  return lines.join('\n');
}

// Set an occurrence's lock (Ritzoini "Locked" click → Zoho Locked_Notes).
async function setOccurrenceLock(occId, locked) {
  const resp = await zohoFetch(`/crm/v2/${OCC_MODULE}/${occId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: [{ Locked_Notes: locked ? 'Yes' : 'No' }] }),
  });
  const body = await resp.json().catch(() => ({}));
  const rec = body.data?.[0];
  if (!resp.ok || rec?.code !== 'SUCCESS') {
    throw new Error(`Zoho lock update failed: ${resp.status} ${JSON.stringify(body)}`);
  }
  return true;
}

// Reverse sync: reflect Zoho lock state onto posted sessions.
//   Approved_notes = "Yes" (and not locked) → Ritzoini ready_to_lock
//   Locked_Notes   = "Yes"                  → Ritzoini locked
// Keyed by the stored occurrence id; stops polling a session once it's locked.
async function syncZohoLockStatus({ windowDays = 21, batch = 40, concurrency = 5 } = {}) {
  const since = new Date(Date.now() - windowDays * 864e5).toISOString().slice(0, 10);
  const { data: sessions, error } = await supabase
    .from('sessions')
    .select('id, zoho_note_id, ready_to_lock, locked')
    .not('zoho_note_id', 'is', null)
    .or('locked.is.null,locked.eq.false')
    .gte('session_date', since)
    .order('session_date', { ascending: false })
    .limit(batch);
  if (error) throw error;

  let checked = 0, readyToLock = 0, locked = 0, errors = 0;
  const todo = sessions || [];
  for (let i = 0; i < todo.length; i += concurrency) {
    await Promise.all(todo.slice(i, i + concurrency).map(async (s) => {
      checked++;
      try {
        const occ = await getOccurrenceRaw(s.zoho_note_id);
        if (!occ) return;
        const isLocked   = String(occ.Locked_Notes   || '').toLowerCase() === 'yes';
        const isApproved = String(occ.Approved_notes || '').toLowerCase() === 'yes';
        const upd = {};
        if (isLocked && !s.locked) { upd.locked = true; upd.locked_at = new Date().toISOString(); }
        if (!isLocked && isApproved && !s.ready_to_lock) { upd.ready_to_lock = true; upd.ready_to_lock_at = new Date().toISOString(); }
        if (Object.keys(upd).length) {
          await supabase.from('sessions').update(upd).eq('id', s.id);
          if (upd.locked) locked++;
          if (upd.ready_to_lock) readyToLock++;
        }
      } catch (e) { errors++; }
    }));
  }
  console.log(`[zoho] lock-status: checked=${checked} readyToLock=${readyToLock} locked=${locked} errors=${errors}`);
  return { checked, readyToLock, locked, errors };
}

// One-time full-history lock reconciliation for sessions that have a Zoho note
// (no 21-day window, unlike the cron). Reads Locked_Notes/Approved_notes off
// each occurrence and reflects it onto Ritzoini. dry run reports only.
// Ritzoini-writes only — never touches Zoho.
async function zohoLockBackfill({ apply = false } = {}) {
  const { data, error } = await supabase
    .from('sessions')
    .select('id, session_date, zoho_note_id, ready_to_lock, locked, group:groups(group_name)')
    .not('zoho_note_id', 'is', null);
  if (error) throw error;

  const todo = (data || []).filter(s => !s.locked); // already-locked need nothing
  const CONCURRENCY = 8;
  let checked = 0, wouldLock = 0, wouldReady = 0, errors = 0, applied = 0;
  const sample = [];

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    await Promise.all(todo.slice(i, i + CONCURRENCY).map(async (s) => {
      checked++;
      try {
        const occ = await getOccurrenceRaw(s.zoho_note_id);
        if (!occ) return;
        const isLocked   = String(occ.Locked_Notes   || '').toLowerCase() === 'yes';
        const isApproved = String(occ.Approved_notes || '').toLowerCase() === 'yes';
        const upd = {};
        if (isLocked) { upd.locked = true; upd.locked_at = new Date().toISOString(); wouldLock++; }
        else if (isApproved && !s.ready_to_lock) { upd.ready_to_lock = true; upd.ready_to_lock_at = new Date().toISOString(); wouldReady++; }
        if (Object.keys(upd).length) {
          if (sample.length < 25) sample.push({ date: s.session_date, group: s.group?.group_name, action: upd.locked ? 'lock' : 'ready-to-lock' });
          if (apply) { await supabase.from('sessions').update(upd).eq('id', s.id); applied++; }
        }
      } catch (e) { errors++; }
    }));
  }

  console.log(`[zoho] lock-backfill (${apply ? 'APPLY' : 'dry'}): checked=${checked} wouldLock=${wouldLock} wouldReady=${wouldReady} applied=${applied} errors=${errors}`);
  return { mode: apply ? 'applied' : 'dry-run', totalWithZohoNote: (data || []).length, unlockedInRitzoini: todo.length, checked, wouldLock, wouldReady, errors, applied, sample };
}

// Fetch an occurrence's full raw record (all fields) — for the inspector.
async function getOccurrenceRaw(occId) {
  if (!occId) throw new Error('occurrence id required');
  const resp = await zohoFetch(`/crm/v2/${OCC_MODULE}/${encodeURIComponent(occId)}`);
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Zoho get failed: ${resp.status} ${JSON.stringify(body)}`);
  return body.data?.[0] || null;
}

// Read an occurrence's current Clinical_Note (to preserve its header).
async function getOccurrenceNote(occId) {
  const resp = await zohoFetch(`/crm/v2/${OCC_MODULE}/${occId}?fields=${NOTE_FIELD}`);
  if (!resp.ok) return '';
  const body = await resp.json().catch(() => ({}));
  return body.data?.[0]?.[NOTE_FIELD] || '';
}

// Write the clinical note onto an occurrence and advance its status.
async function updateOccurrenceNote(occId, noteText) {
  const resp = await zohoFetch(`/crm/v2/${OCC_MODULE}/${occId}`, {
    method: 'PUT',
    body: JSON.stringify({
      data: [{ [NOTE_FIELD]: noteText, [STATUS_FIELD]: STATUS_VALUE }],
    }),
  });
  const body = await resp.json().catch(() => ({}));
  const record = body.data?.[0];
  if (!resp.ok || record?.code !== 'SUCCESS') {
    throw new Error(`Zoho occurrence update failed: ${resp.status} ${JSON.stringify(body)}`);
  }
  return record.details?.id || occId;
}

// Post a session's SOAP note to Zoho by updating the matching
// Session_Occurrences record's Clinical_Note (mirrors the widget's Save Note).
async function postSoapNoteToZoho(sessionId) {
  const { data: session, error: selErr } = await supabase
    .from('sessions')
    .select(`
      id, session_date, scheduled_date, soap_note, notes,
      group:groups!group_id(internal_name, group_name, name, zoho_session_id)
    `)
    .eq('id', sessionId)
    .single();

  // Surface a real DB error (e.g. missing zoho_session_id column) instead of
  // silently no-oping and reporting a false success.
  if (selErr) throw new Error(`Failed to load session ${sessionId} for Zoho post: ${selErr.message}`);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const group = session.group;
  const sessionDate = session.session_date || session.scheduled_date;
  const noteText = (session.soap_note || session.notes || '').trim();
  if (!noteText) {
    console.warn(`[zoho] Session ${sessionId} has no note; skipping Zoho post`);
    return;
  }

  const occ = matchOccurrence(await searchOccurrencesByDate(sessionDate), group);

  if (!occ) {
    throw new Error(
      `No ${OCC_MODULE} record found for ${DATE_FIELD}=${sessionDate} for group "${group?.group_name}" ` +
      `(${group?.zoho_session_id ? 'aligned id ' + group.zoho_session_id : 'not aligned — run Sync Zoho Groups'})`
    );
  }

  // Don't clobber a note that's already locked in Zoho.
  if (occ.Locked_Notes === 'Yes') {
    throw new Error(`Occurrence ${occ.id} ("${group?.group_name}" ${sessionDate}) is locked in Zoho; not overwriting`);
  }

  // Build the "Group Name:" / "Group Activity:" header. Zoho only pre-fills it
  // client-side in the widget (not stored until saved), and Group_Activity lives
  // on the parent (our zoho_groups cache) — so we supply it on a first post.
  const parentId = occ.Session && occ.Session.id;
  let cacheRow = null;
  if (parentId) {
    const { data } = await supabase.from('zoho_groups')
      .select('session_name, group_activity').eq('id', parentId).maybeSingle();
    cacheRow = data;
  }
  const existingNote = occ[NOTE_FIELD] != null ? occ[NOTE_FIELD] : await getOccurrenceNote(occ.id);
  const fallbackHeader = buildOccHeader(occ, cacheRow, group && group.group_name);
  const finalNote = mergeWithHeader(existingNote, noteText, fallbackHeader);

  const zohoId = await updateOccurrenceNote(occ.id, finalNote);

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase.from('sessions').update({
    zoho_posted: true,
    zoho_posted_at: now,
    zoho_note_id: zohoId,
    // Also tick the generic "note delivered" flag that drives the Note Sent box.
    email_sent: true,
    email_sent_at: now,
  }).eq('id', sessionId);
  if (updateErr) {
    // Note landed in Zoho; only local bookkeeping failed (e.g. columns missing).
    console.error(`[zoho] Posted note to ${zohoId} but failed to update session ${sessionId}:`, updateErr.message);
  }

  console.log(`[zoho] Posted SOAP note for session ${sessionId} → ${OCC_MODULE}/${zohoId} ("${group?.group_name}" ${sessionDate})`);
}

// Read-only health check: verifies creds → token → module read access, and
// (if a session is given) whether its matching occurrence can be found. Writes
// nothing. Used by the admin "Test Zoho" button.
async function zohoDiagnostic(sessionId) {
  const result = {
    configured: zohoConfigured(),
    tokenOk: false,
    moduleReadOk: false,
    module: OCC_MODULE,
    dataCenter: API_DOMAIN,
    match: null,
    errors: [],
  };

  if (!result.configured) {
    result.errors.push('Missing ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN');
    return result;
  }

  try {
    await getAccessToken();
    result.tokenOk = true;
  } catch (e) {
    result.errors.push(`Token refresh failed: ${e.message}`);
    return result;
  }

  // Probe module read — this is what proves the token's CRM scope is wide enough.
  try {
    const resp = await zohoFetch(`/crm/v2/${OCC_MODULE}?fields=Name,${DATE_FIELD}&per_page=1`);
    if (resp.status === 204) {
      result.moduleReadOk = true; // reachable, just empty
    } else {
      const body = await resp.json().catch(() => ({}));
      if (resp.ok) result.moduleReadOk = true;
      else result.errors.push(`Module read failed (${resp.status}): ${body.code || ''} ${body.message || JSON.stringify(body)}`);
    }
  } catch (e) {
    result.errors.push(`Module read error: ${e.message}`);
  }

  // Optional: does a specific session's occurrence resolve?
  if (sessionId && result.moduleReadOk) {
    try {
      const { data: session } = await supabase
        .from('sessions')
        .select('id, session_date, scheduled_date, group:groups!group_id(internal_name, group_name, name, zoho_session_id)')
        .eq('id', sessionId)
        .single();
      const g = session?.group;
      const date = session?.session_date || session?.scheduled_date;
      const occ = await findOccurrence(g, date);
      result.match = occ
        ? { found: true, occurrenceId: occ.id, occurrenceName: occ.Name, parentId: occ.Session?.id, date, ecw: occ.ECW, locked: occ.Locked_Notes === 'Yes' }
        : { found: false, date, group: g?.group_name, aligned: !!g?.zoho_session_id };
    } catch (e) {
      result.errors.push(`Session match error: ${e.message}`);
    }
  }

  return result;
}

// Safe write probe: rewrites one occurrence's Clinical_Note to its OWN current
// value (a no-op — no data change, ECW/status untouched) purely to prove the
// token's write scope works. Needs no Ritzoini session. Returns which record
// it exercised.
async function zohoWriteTest() {
  const result = { tokenOk: false, writeOk: false, occurrence: null, errors: [] };

  try { await getAccessToken(); result.tokenOk = true; }
  catch (e) { result.errors.push(`Token refresh failed: ${e.message}`); return result; }

  // Grab one occurrence to write back to.
  let occ;
  try {
    const resp = await zohoFetch(`/crm/v2/${OCC_MODULE}?fields=Name,${DATE_FIELD},${NOTE_FIELD}&per_page=1`);
    if (resp.status === 204) { result.errors.push(`No ${OCC_MODULE} records exist to test against`); return result; }
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) { result.errors.push(`Read failed (${resp.status}): ${body.code || ''} ${body.message || ''}`); return result; }
    occ = body.data?.[0];
    if (!occ) { result.errors.push(`No ${OCC_MODULE} records returned`); return result; }
  } catch (e) { result.errors.push(`Read error: ${e.message}`); return result; }

  result.occurrence = { id: occ.id, name: occ.Name, date: occ[DATE_FIELD] };

  // Write the same note value back — proves write scope without changing data.
  // Deliberately does NOT send the status field, so nothing is advanced.
  try {
    const resp = await zohoFetch(`/crm/v2/${OCC_MODULE}/${occ.id}`, {
      method: 'PUT',
      body: JSON.stringify({ data: [{ [NOTE_FIELD]: occ[NOTE_FIELD] ?? '' }] }),
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok && body.data?.[0]?.code === 'SUCCESS') result.writeOk = true;
    else result.errors.push(`Write failed (${resp.status}): ${body.data?.[0]?.code || body.code || ''} ${body.data?.[0]?.message || body.message || JSON.stringify(body)}`);
  } catch (e) { result.errors.push(`Write error: ${e.message}`); }

  return result;
}

// One-time exchange: turn a Self Client "grant token" (code) into a long-lived
// refresh token, using the client_id/secret already in env. The returned
// refresh_token is what belongs in ZOHO_REFRESH_TOKEN. A grant code can only be
// exchanged once and expires in minutes, so this must run promptly after
// generating the code in the Zoho API console.
async function exchangeGrantCode(code) {
  const clientId = clean(process.env.ZOHO_CLIENT_ID);
  const clientSecret = clean(process.env.ZOHO_CLIENT_SECRET);
  if (!clientId || !clientSecret) throw new Error('ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET not set in env');
  if (!code || !clean(code)) throw new Error('No grant code provided');

  const params = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     clientId,
    client_secret: clientSecret,
    code:          clean(code),
  });

  const resp = await fetch(`${ACCOUNTS_DOMAIN}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const raw = await resp.text();
  let body = {};
  try { body = JSON.parse(raw); } catch { /* non-JSON */ }

  if (!resp.ok || body.error || !body.refresh_token) {
    const hint = body.error === 'invalid_code'
      ? ' — the grant code is expired or already used; generate a fresh one and try again immediately'
      : (body.error === 'invalid_client'
        ? ' — client_id/secret in env do not match this Self Client'
        : '');
    throw new Error(`Grant exchange failed: ${resp.status} ${body.error || raw.slice(0, 200)}${hint}`);
  }

  // Persist immediately so it's live without a redeploy or manual env edit,
  // and drop any cached access token so the next call uses the new credential.
  dbRefreshToken = clean(body.refresh_token);
  cachedToken = null;
  cachedTokenExpiry = 0;
  let saved = false;
  try {
    await supabase.from('app_config').upsert({ key: 'zoho_refresh_token', value: dbRefreshToken });
    saved = true;
  } catch (err) {
    console.error('[zoho] Failed to persist refresh token to app_config:', err.message);
  }

  return {
    refresh_token: body.refresh_token,
    api_domain:    body.api_domain || API_DOMAIN,
    scope:         body.scope || null,
    saved,
  };
}

// Pull all parent Session (group) records from Zoho, paginated.
// Generic paginated fetch of a module's records with a fields list.
async function listAll(module, fields) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const resp = await zohoFetch(`/crm/v2/${module}?fields=${fields}&per_page=200&page=${page}`);
    if (resp.status === 204) break;
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`Zoho ${module} list failed: ${resp.status} ${JSON.stringify(body)}`);
    for (const r of (body.data || [])) out.push(r);
    if (!body.info || !body.info.more_records) break;
  }
  return out;
}

async function listZohoSessions() {
  return listAll(PARENT_MODULE,
    `${PARENT_NAME_FIELD},Session_Code,Group_Activity,Class_Day,Group_Type,Status,` +
    `Instructor,Therapist,Start_Date_and_Time,End_Date_and_Time,How_many_Sessions`);
}

// Cancelled occurrence dates, grouped by parent Session id — for the Roster.
async function listCancelledDatesByGroup() {
  const occ = await listAll(OCC_MODULE, `Session,${DATE_FIELD},Status,${STATUS_FIELD}`);
  const byGroup = {};
  for (const r of occ) {
    const cancelled = String(r.Status || '').toLowerCase() === 'cancelled'
                   || String(r[STATUS_FIELD] || '').toLowerCase() === 'cancelled';
    if (cancelled && r.Session?.id && r[DATE_FIELD]) {
      (byGroup[r.Session.id] ||= []).push(r[DATE_FIELD]);
    }
  }
  for (const k of Object.keys(byGroup)) byGroup[k] = [...new Set(byGroup[k])].sort();
  return byGroup;
}

// Sync Zoho groups into the zoho_groups cache and auto-align Ritzoini groups
// (groups.zoho_session_id) by matching group_name to the parent Session_Name.
async function syncZohoGroups() {
  const sessions = await listZohoSessions();
  const now = new Date().toISOString();

  // Instructors (name + phone) → cache, for the Roster.
  const instructors = await listAll('Instructors', 'Name,Phone');
  const instRows = instructors.map(i => ({ id: i.id, name: i.Name || null, phone: i.Phone || null, synced_at: now }));
  if (instRows.length) {
    const { error } = await supabase.from('zoho_instructors').upsert(instRows, { onConflict: 'id' });
    if (error) console.error('[zoho] zoho_instructors upsert failed:', error.message);
  }
  // Auto-link Zoho instructors to the fuller Ritzoini Instructors records.
  try { await autoLinkInstructors(); } catch (e) { console.error('[zoho] instructor auto-link failed:', e.message); }

  // Clients (Deals) → cache, roster-relevant fields ONLY (no PII/financial).
  try {
    const SESSION_KEYS = ['Session', ...Array.from({ length: 10 }, (_, i) => `Session${i + 2}`)];
    const clients = await listAll('Deals',
      `First_Name,Last_Name,Age,Grade,Gender,Stage,${SESSION_KEYS.join(',')}`);
    const cRows = clients.map(d => ({
      id:         d.id,
      first_name: d.First_Name || null,
      last_name:  d.Last_Name || null,
      age:        Number.isFinite(+d.Age) && d.Age !== '' && d.Age != null ? parseInt(d.Age, 10) : null,
      grade:      d.Grade || null,
      gender:     d.Gender || null,
      stage:      d.Stage || null,
      group_ids:  SESSION_KEYS.map(k => d[k]?.id).filter(Boolean),
      synced_at:  now,
    }));
    if (cRows.length) {
      const { error } = await supabase.from('zoho_clients').upsert(cRows, { onConflict: 'id' });
      if (error) console.error('[zoho] zoho_clients upsert failed:', error.message);
    }
    console.log(`[zoho] sync clients: ${cRows.length}`);
  } catch (e) { console.error('[zoho] client sync failed:', e.message); }

  // Cancelled occurrence dates per group.
  let cancelledByGroup = {};
  try { cancelledByGroup = await listCancelledDatesByGroup(); }
  catch (e) { console.error('[zoho] cancelled-dates fetch failed:', e.message); }

  // Zoho datetimes carry the local offset ("…T16:30:00-04:00"); the wall-clock
  // time IS the intended local time. Capture it as text before timestamptz
  // normalization loses it to UTC.
  const localParts = iso => { const m = /(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso || ''); return m ? { date: m[1], time: m[2] } : { date: null, time: null }; };
  const rows = sessions.map(s => {
    const sp = localParts(s.Start_Date_and_Time), ep = localParts(s.End_Date_and_Time);
    return {
    id:                s.id,
    start_date:        sp.date,
    start_time:        sp.time,
    end_date:          ep.date,
    session_name:      s[PARENT_NAME_FIELD] || null,
    session_code:      s.Session_Code || null,
    group_activity:    s.Group_Activity || null,
    class_day:         s.Class_Day || null,
    group_type:        s.Group_Type || null,
    status:            s.Status || null,
    instructor_id:     s.Instructor?.id || null,
    instructor_name:   s.Instructor?.name || null,
    therapist_id:      s.Therapist?.id || null,
    therapist_name:    s.Therapist?.name || null,
    start_at:          s.Start_Date_and_Time || null,
    end_at:            s.End_Date_and_Time || null,
    how_many_sessions: s.How_many_Sessions ?? null,
    cancelled_dates:   cancelledByGroup[s.id] || [],
    synced_at:         now,
    };
  });
  if (rows.length) {
    const { error } = await supabase.from('zoho_groups').upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(`zoho_groups upsert failed: ${error.message}`);
  }

  // name → parent id (first wins on duplicate names)
  const byName = new Map();
  for (const s of sessions) {
    const n = normalizeName(s[PARENT_NAME_FIELD]);
    if (n && !byName.has(n)) byName.set(n, s.id);
  }

  const { data: groups, error: gErr } = await supabase
    .from('groups').select('id, group_name, name, zoho_session_id');
  if (gErr) throw gErr;

  let aligned = 0, alreadyLinked = 0;
  const unmatched = [];
  for (const g of (groups || [])) {
    // Never overwrite an existing link — manual picks and prior links are sticky.
    if (g.zoho_session_id) { alreadyLinked++; continue; }
    const target = byName.get(normalizeName(g.group_name || g.name));
    if (!target) { unmatched.push(g.group_name || g.name); continue; }
    const { error } = await supabase.from('groups').update({ zoho_session_id: target }).eq('id', g.id);
    if (!error) aligned++;
  }

  console.log(`[zoho] sync-groups: fetched=${sessions.length} aligned=${aligned} already=${alreadyLinked} unmatched=${unmatched.length}`);
  return { fetched: sessions.length, aligned, alreadyLinked, unmatched };
}

// Strip titles / annotations from a messy Zoho instructor name for matching:
// "Mr Ch Neustadt - Paint Group" / "Leah Hoffman (Daniella Hassan)" → core name.
function cleanInstructorName(name) {
  return String(name || '')
    .replace(/\([^)]*\)/g, ' ')                          // (Daniella Hassan)
    .replace(/\s[-–].*$/, ' ')                            // - Paint Group
    .replace(/\b(mr|mrs|ms|dr|rabbi|reb)\.?\b/gi, ' ')    // titles
    .replace(/\s+/g, ' ').trim();
}

// Auto-link Zoho instructors → Ritzoini instructors by a CONFIDENT (unique)
// name match. Never overwrites an existing (manual or prior) link.
async function autoLinkInstructors() {
  const [{ data: zi }, { data: ri }] = await Promise.all([
    supabase.from('zoho_instructors').select('id, name, phone, ritzoini_instructor_id'),
    supabase.from('instructors').select('id, first_name, last_name'),
  ]);
  const byFull = {}, byFirst = {}, byLast = {};
  const add = (m, k, id) => { if (!k) return; (m[k] ||= new Set()).add(id); };
  const index = (r) => {
    const f = normalizeName(r.first_name), l = normalizeName(r.last_name);
    add(byFull, `${f} ${l}`.trim(), r.id); add(byFirst, f, r.id); add(byLast, l, r.id);
  };
  for (const r of (ri || [])) index(r);
  const uniq = (m, k) => { const s = m[k]; return s && s.size === 1 ? [...s][0] : null; };

  let linked = 0, created = 0;
  for (const z of (zi || [])) {
    if (z.ritzoini_instructor_id) continue;
    const cleaned = cleanInstructorName(z.name);
    const n = normalizeName(cleaned);
    if (!n || n === 'no instructor') continue;
    const toks = n.split(' ').filter(Boolean);

    // 1. Link to an existing Ritzoini instructor by a confident unique match.
    let target = uniq(byFull, n);
    if (!target) target = toks.length === 1
      ? (uniq(byFirst, toks[0]) || uniq(byLast, toks[0]))
      : uniq(byLast, toks[toks.length - 1]);

    // 2. Not in Ritzoini yet + has a name and a phone → create the instructor.
    if (!target) {
      const digits = String(z.phone || '').replace(/\D/g, '');
      const parts = cleaned.split(/\s+/).filter(Boolean);
      if (digits.length >= 4 && parts.length) {
        const first_name = parts.length > 1 ? parts[0] : '';
        const last_name  = parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
        const { data: ins, error } = await supabase.from('instructors')
          .insert({ first_name: first_name || null, last_name, phone: digits })
          .select('id, first_name, last_name').single();
        if (!error && ins) { target = ins.id; created++; index(ins); }
        else if (error) console.error('[zoho] instructor create failed for', z.name, error.message);
      }
    }

    if (target) {
      const { error } = await supabase.from('zoho_instructors').update({ ritzoini_instructor_id: target }).eq('id', z.id);
      if (!error) linked++;
    }
  }
  console.log(`[zoho] instructor auto-link: linked ${linked}, created ${created}`);
  return { linked, created };
}

// Assemble the Roster from the caches: the configured therapist's Zoho groups,
// each with instructor phone (Zoho → Ritzoini Instructors fallback → missing
// flag), cancelled dates, and whether it's linked to a Ritzoini group.
async function getRoster() {
  const { data: cfg } = await supabase.from('app_config').select('value').eq('key', 'zoho_roster_therapist').maybeSingle();
  const therapist = normalizeName(cfg?.value || 'Chaim Orelowitz');

  const [zg, zi, rg, ri, zc] = await Promise.all([
    supabase.from('zoho_groups').select('*'),
    supabase.from('zoho_instructors').select('id, name, phone, ritzoini_instructor_id'),
    supabase.from('groups').select('id, zoho_session_id').not('zoho_session_id', 'is', null),
    supabase.from('instructors').select('id, first_name, last_name, phone'),
    supabase.from('zoho_clients').select('age, stage, group_ids'),
  ]);

  // Per-group active-client counts + ages (for the Age range column).
  const agesByGroup = {}, countByGroup = {};
  for (const c of (zc.data || [])) {
    if (String(c.stage || '').toLowerCase() !== 'active') continue;
    for (const gid of (Array.isArray(c.group_ids) ? c.group_ids : [])) {
      countByGroup[gid] = (countByGroup[gid] || 0) + 1;
      if (Number.isFinite(c.age)) (agesByGroup[gid] ||= []).push(c.age);
    }
  }

  const zInstById = Object.fromEntries((zi.data || []).map(i => [i.id, i]));
  const rInstById = Object.fromEntries((ri.data || []).map(i => [i.id, i]));
  const ritzByZoho = {};
  (rg.data || []).forEach(g => { if (g.zoho_session_id) ritzByZoho[g.zoho_session_id] = g.id; });

  const mine = (zg.data || []).filter(g => therapist && normalizeName(g.therapist_name) === therapist);
  return mine.map(g => {
    const zinst = zInstById[g.instructor_id];
    // Linked Ritzoini instructor is authoritative for name + phone.
    const rinst = zinst?.ritzoini_instructor_id ? rInstById[zinst.ritzoini_instructor_id] : null;
    const displayName = rinst
      ? `${rinst.first_name || ''} ${rinst.last_name || ''}`.trim()
      : (g.instructor_name || zinst?.name || null);
    const phone = rinst?.phone || zinst?.phone || null;
    const isPlaceholder = normalizeName(displayName) === 'no instructor' || !displayName;
    const ages = agesByGroup[g.id] || [];
    const ageMin = ages.length ? Math.min(...ages) : null;
    const ageMax = ages.length ? Math.max(...ages) : null;
    return {
      id: g.id,
      age_min:             ageMin,
      age_max:             ageMax,
      age_range:           ages.length ? (ageMin === ageMax ? `${ageMin}` : `${ageMin}–${ageMax}`) : null,
      client_count:        countByGroup[g.id] || 0,
      group_name:          g.session_name,
      group_activity:      g.group_activity,
      class_day:           g.class_day,
      group_type:          g.group_type,
      session_code:        g.session_code,
      status:              g.status,
      start_date:          g.start_date,   // local wall-clock text (tz-safe)
      start_time:          g.start_time,
      end_date:            g.end_date,
      how_many_sessions:   g.how_many_sessions,
      instructor_name:       displayName,
      instructor_phone:      phone,
      zoho_instructor_id:    g.instructor_id || null,
      ritzoini_instructor_id: rinst?.id || null,
      instructor_linked:     !!rinst,
      // Flag a real instructor with no phone anywhere (prompts a manual link).
      phone_missing:       !phone && !isPlaceholder,
      cancelled_dates:     Array.isArray(g.cancelled_dates) ? g.cancelled_dates : [],
      ritzoini_group_id:   ritzByZoho[g.id] || null,
      on_ritzoini:         !!ritzByZoho[g.id],
    };
  });
}

module.exports = { postSoapNoteToZoho, zohoConfigured, findOccurrence, getAccessToken, zohoDiagnostic, zohoWriteTest, exchangeGrantCode, loadZohoRefreshToken, getOccurrenceRaw, syncZohoGroups, setOccurrenceLock, syncZohoLockStatus, zohoLockBackfill, getRoster };

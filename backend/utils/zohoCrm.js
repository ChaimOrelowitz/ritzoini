const supabase = require('../db/supabase');

// Zoho data-center domains. Defaults to the US (.com) DC; override via env for
// EU/IN/AU/etc. (e.g. https://accounts.zoho.eu / https://www.zohoapis.eu).
const ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com';
const API_DOMAIN      = process.env.ZOHO_API_DOMAIN      || 'https://www.zohoapis.com';

// The custom module + fields the "Therapist View" widget reads/writes. These
// defaults match the widget (utils reverse-engineered from "Iframe for zoho");
// override via env only if the org renamed the module/fields.
const OCC_MODULE   = process.env.ZOHO_OCC_MODULE   || 'Session_Occurrences';
const NAME_FIELD   = process.env.ZOHO_OCC_NAME_FIELD || 'Session_Name'; // matched to group name
const DATE_FIELD   = process.env.ZOHO_OCC_DATE_FIELD || 'Session_Date'; // matched to session_date
const NOTE_FIELD   = process.env.ZOHO_OCC_NOTE_FIELD || 'Clinical_Note';
const STATUS_FIELD = process.env.ZOHO_OCC_STATUS_FIELD || 'ECW';
const STATUS_VALUE = process.env.ZOHO_OCC_STATUS_VALUE || 'Notes Received';

// Cached access token — Zoho access tokens live ~1h; refresh on demand.
let cachedToken = null;
let cachedTokenExpiry = 0; // epoch ms

function zohoConfigured() {
  return !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN);
}

// Exchange the long-lived refresh token for a short-lived access token.
async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry - 60_000) return cachedToken;

  if (!zohoConfigured()) {
    throw new Error('Zoho not configured (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN)');
  }

  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type:    'refresh_token',
  });

  const resp = await fetch(`${ACCOUNTS_DOMAIN}/oauth/v2/token?${params.toString()}`, { method: 'POST' });
  const body = await resp.json().catch(() => ({}));

  if (!resp.ok || !body.access_token) {
    throw new Error(`Zoho token refresh failed: ${resp.status} ${body.error || JSON.stringify(body)}`);
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

// Escape Zoho search-criteria special chars in a value.
function escapeCriteria(v) {
  return String(v).replace(/([(),\\])/g, '\\$1');
}

// Find the Session_Occurrences record for a given group name + date.
// Returns the record object (with id, ECW, Locked_Notes) or null.
async function findOccurrence(sessionName, sessionDate) {
  if (!sessionName || !sessionDate) return null;
  const criteria = encodeURIComponent(
    `(${NAME_FIELD}:equals:${escapeCriteria(sessionName)})and(${DATE_FIELD}:equals:${sessionDate})`
  );
  const resp = await zohoFetch(`/crm/v2/${OCC_MODULE}/search?criteria=${criteria}`);

  if (resp.status === 204) return null; // Zoho returns 204 for no matches
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Zoho search failed: ${resp.status} ${JSON.stringify(body)}`);
  return body.data?.[0] || null;
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
  const { data: session } = await supabase
    .from('sessions')
    .select(`
      id, session_date, scheduled_date, soap_note, notes,
      group:groups!group_id(internal_name, group_name, name)
    `)
    .eq('id', sessionId)
    .single();

  if (!session) return;

  const group = session.group;
  const sessionDate = session.session_date || session.scheduled_date;
  const noteText = (session.soap_note || session.notes || '').trim();
  if (!noteText) {
    console.warn(`[zoho] Session ${sessionId} has no note; skipping Zoho post`);
    return;
  }

  // Zoho's Session_Name is the full group name; fall back to internal_name.
  const candidateNames = [group?.group_name, group?.name, group?.internal_name].filter(Boolean);

  let occ = null;
  let matchedName = null;
  for (const name of candidateNames) {
    occ = await findOccurrence(name, sessionDate);
    if (occ) { matchedName = name; break; }
  }

  if (!occ) {
    throw new Error(
      `No ${OCC_MODULE} record found for ${DATE_FIELD}=${sessionDate} matching ${NAME_FIELD} in [${candidateNames.join(', ')}]`
    );
  }

  // Don't clobber a note that's already locked in Zoho.
  if (occ.Locked_Notes === 'Yes') {
    throw new Error(`Occurrence ${occ.id} ("${matchedName}" ${sessionDate}) is locked in Zoho; not overwriting`);
  }

  const zohoId = await updateOccurrenceNote(occ.id, noteText);

  const { error: updateErr } = await supabase.from('sessions').update({
    zoho_posted: true,
    zoho_posted_at: new Date().toISOString(),
    zoho_note_id: zohoId,
  }).eq('id', sessionId);
  if (updateErr) {
    // Note landed in Zoho; only local bookkeeping failed (e.g. columns missing).
    console.error(`[zoho] Posted note to ${zohoId} but failed to update session ${sessionId}:`, updateErr.message);
  }

  console.log(`[zoho] Posted SOAP note for session ${sessionId} → ${OCC_MODULE}/${zohoId} ("${matchedName}" ${sessionDate})`);
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
    const resp = await zohoFetch(`/crm/v2/${OCC_MODULE}?fields=${NAME_FIELD},${DATE_FIELD}&per_page=1`);
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
        .select('id, session_date, scheduled_date, group:groups!group_id(internal_name, group_name, name)')
        .eq('id', sessionId)
        .single();
      const g = session?.group;
      const date = session?.session_date || session?.scheduled_date;
      const names = [g?.group_name, g?.name, g?.internal_name].filter(Boolean);
      let occ = null, matchedName = null;
      for (const n of names) {
        occ = await findOccurrence(n, date);
        if (occ) { matchedName = n; break; }
      }
      result.match = occ
        ? { found: true, occurrenceId: occ.id, matchedName, date, ecw: occ.ECW, locked: occ.Locked_Notes === 'Yes' }
        : { found: false, date, triedNames: names };
    } catch (e) {
      result.errors.push(`Session match error: ${e.message}`);
    }
  }

  return result;
}

module.exports = { postSoapNoteToZoho, zohoConfigured, findOccurrence, getAccessToken, zohoDiagnostic };

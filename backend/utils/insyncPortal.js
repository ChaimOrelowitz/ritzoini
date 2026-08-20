// Portal POC — the READ side of InSync (Phase A resolution + the Phase B
// appointment-exists check). Nothing here writes to a chart.
//
// Sessions come from utils/insync.js `login()`, which returns a cookie string.
// Two different logins flow through these helpers: the admin login for the
// directory/patient/visit-type lookups, and each peer's own login for the
// calendar check. The functions don't care which — the caller supplies the
// cookie, and that is what keeps the two phases honest about whose session
// they are using.

const { BASE, UA, post } = require('./insync');

function headers(cookie, referer) {
  return {
    'User-Agent': UA,
    'Cookie': cookie,
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': BASE,
    'Referer': referer || `${BASE}/Scheduler/Index`,
  };
}

async function json(res, what) {
  const text = await res.text();
  if (/Session Timeout/i.test(text.slice(0, 4000))) {
    throw new Error(`${what}: the InSync session expired`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what}: InSync returned a non-JSON response (${res.status})`);
  }
}

// --- encounter types -------------------------------------------------------

// Live GetVisitTypes. Called every run — the whole point is that a new encounter
// type appearing in InSync shows up here without a code change.
async function getVisitTypes(cookie) {
  const res = await post('/Scheduler/GetVisitTypes', {}, cookie);
  const body = await json(res, 'GetVisitTypes');

  // The list arrives as result.Item2 in the captures, but InSync has shipped
  // more than one envelope shape; walk for the array rather than trusting a path.
  let found = null;
  (function walk(v) {
    if (found) return;
    if (Array.isArray(v)) {
      if (v.length && v.some(x => x && typeof x === 'object' && 'VisitTypeID' in x)) { found = v; return; }
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  })(body);

  if (!found) throw new Error('GetVisitTypes returned no recognizable visit-type array');

  return found
    .filter(t => t && t.VisitTypeID && t.VisitType && t.IsActive !== false)
    .map(t => ({
      VisitTypeID: String(t.VisitTypeID),
      // The human name lives in VisitType, NOT Description — easy trap.
      VisitType: String(t.VisitType).trim(),
      Duration: Number(t.Duration) || 0,
      IsBillable: t.IsBillable !== false,
    }));
}

// --- provider directory ----------------------------------------------------

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

// The advanced-search fragment embeds the full provider directory as a
// <select id="ddlPsPrimaryPhysician"> with Active / Inactive optgroups.
// Parsed live so a newly hired peer resolves without a deploy.
async function getProviderDirectory(cookie) {
  const res = await fetch(`${BASE}/PatientSearch/GetAdvancedSearchFields?_=${Date.now()}`, {
    headers: { ...headers(cookie, `${BASE}/PatientSearch/Index`), 'Accept': 'text/html,*/*' },
  });
  const html = await res.text();
  if (/SIGN IN/.test(html.slice(0, 4000))) throw new Error('Provider directory: not authenticated to InSync');

  const select = html.match(/<select[^>]*id=["']ddlPsPrimaryPhysician["'][\s\S]*?<\/select>/i);
  if (!select) throw new Error('Provider directory: ddlPsPrimaryPhysician not found in the InSync response');

  const providers = [];
  let group = null;
  const token = /<optgroup[^>]*label=["']([^"']*)["'][^>]*>|<\/optgroup>|<option[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = token.exec(select[0])) !== null) {
    if (m[1] !== undefined) { group = m[1]; continue; }
    if (m[2] === undefined) { group = null; continue; }
    const id = m[2].trim();
    const name = decodeEntities(m[3].replace(/<[^>]+>/g, '')).trim();
    if (!id || id === '0' || !name) continue;
    providers.push({ id, name, active: !/inactive/i.test(group || 'Active') });
  }
  if (!providers.length) throw new Error('Provider directory parsed but contained no providers');
  return providers;
}

// --- patient search --------------------------------------------------------

const SEARCH_COLUMNS = [
  'PatientId', 'BlankData', 'LastName', 'FirstName', 'MRNNumber', 'DOB',
  'Gender', 'PrimaryProviderName', 'Address', 'MobileNo', 'PatientEmail', 'BlankData',
].map((data, i) => ({
  data, name: data, searchable: true, orderable: i !== 1, visible: true,
  search: { value: '', regex: false },
}));

function dobToIso(raw) {
  const m = String(raw || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

// Free-text patient search across the whole practice (admin login only — a
// peer's session sees a far narrower slice). Returns normalized rows; deciding
// whether a result set is unambiguous is the CALLER's job, on purpose.
async function searchPatients(cookie, { text, includeInactive = false } = {}) {
  const body = {
    draw: 1,
    columns: SEARCH_COLUMNS,
    order: [{ column: 2, dir: 'asc' }],
    start: 0,
    length: 100,
    search: { value: String(text || ''), regex: false },
    SearchText: String(text || ''),
    PatientDetails: JSON.stringify({
      IsAllowToSearchPatientOutsideOfBedBoard: 'True',
      IsAdvanceSearch: false,
      ServiceProvider: 0,
      PayerPlanId: 0,
      PatientStatus: '9,53,54',
      // 0 = every provider. The caseload pull in ooClients.js pins this to one
      // provider; resolution must not, because clients switch peers.
      PrimaryProvider: 0,
      PrimaryFacility: 0,
      IsSearchedWithSavedQuery: false,
      OrderingProviderID: 0,
      FamilyMemberID: 0,
      FamilyMemberName: '',
    }),
    PageName: '',
    IsIncludeInActive: includeInactive,
  };

  const res = await fetch(`${BASE}/PatientSearch/BindPatientList`, {
    method: 'POST',
    headers: { ...headers(cookie, `${BASE}/PatientSearch/Index`), 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });
  const data = await json(res, 'BindPatientList');
  if (!Array.isArray(data?.data)) throw new Error('Patient search returned no data array — the login may have failed');

  return data.data.map(r => ({
    patientId: String(r.PatientId),
    name: [r.FirstName, r.LastName].filter(Boolean).join(' ').trim() || String(r.PatientName || '').trim(),
    lastFirst: [r.LastName, r.FirstName].filter(Boolean).join(', ').trim(),
    mrn: String(r.MRNNumber || '').trim() || null,
    dob: dobToIso(r.DOB),
    primaryProvider: String(r.PrimaryProviderName || '').trim() || null,
  }));
}

// --- calendar (Phase B, peer login) ----------------------------------------

function mdy(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${m}/${d}/${y}`;
}

// The peer's own day view. This is the ONLY reliable "does this appointment
// already exist" signal — caseload is not, because clients move between peers.
async function loadCalendarView(cookie, { dateIso, resourceId, template }) {
  const params = { ...(template || {}) };
  params.visitDate = mdy(dateIso);
  params.ResourceId = String(resourceId);
  params.iViewType = params.iViewType || '1';

  const res = await post('/Scheduler/LoadCalendarView', params, cookie);
  const body = await json(res, 'LoadCalendarView');

  const list = Array.isArray(body?.Item3) ? body.Item3
             : Array.isArray(body?.result?.Item3) ? body.result.Item3
             : [];

  return list.map(a => ({
    visitId: String(a.VisitID ?? a.VisitId ?? ''),
    visitTypeId: String(a.VisitTypeID ?? ''),
    // StartTime is an object; TotalMinutes lines up exactly with the portal's
    // sessionStartMinutes, which is what makes time matching exact rather than
    // a string comparison against a formatted clock.
    startMinutes: Number(a.StartTime?.TotalMinutes ?? a.StartTime ?? NaN),
    endMinutes: Number(a.EndTime?.TotalMinutes ?? NaN),
    duration: Number(a.Duration) || 0,
    statusId: Number(a.VisitStatusID),
    cancelled: Number(a.VisitStatusID) === 4,
    appText: String(a.AppText || ''),
    participants: Array.isArray(a.Participants) ? a.Participants : [],
  }));
}

// Does an appointment for this client, at this minute-of-day, already exist and
// is it not cancelled? Cancelled (VisitStatusID 4) rows are invisible here by
// design — reusing one would attach the encounter to a dead appointment.
function findExistingAppointment(appointments, { patientId, startMinutes, clientName }) {
  const wanted = Number(startMinutes);
  return appointments.find(a => {
    if (a.cancelled) return false;
    if (a.startMinutes !== wanted) return false;
    const byId = a.participants.some(p =>
      String(p?.PatientId ?? p?.PatientID ?? '') === String(patientId));
    if (byId) return true;
    // Fallback for calendars that don't carry Participants: AppText leads with
    // "Last, First (Status, Type…)".
    if (!clientName) return false;
    const { normalizeName } = require('./portalMatch');
    const head = a.appText.split('(')[0].trim();
    return head && normalizeName(head) === normalizeName(clientName);
  }) || null;
}

module.exports = {
  getVisitTypes, getProviderDirectory, searchPatients,
  loadCalendarView, findExistingAppointment, dobToIso, mdy,
};

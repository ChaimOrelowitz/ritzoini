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

function mdy(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${m}/${d}/${y}`;
}

// --- encounter types -------------------------------------------------------

// Live GetVisitTypes. Called every run — the whole point is that a new encounter
// type appearing in InSync shows up here without a code change.
//
// It will NOT return the catalog for a bare POST: without an objbookAppointment
// context (ScheduleID and FacilityId in particular) it answers 200 with every
// array empty. So the captured request shell is replayed with the date moved to
// today. The patient-program filter is deliberately left blank — supplying one
// narrows the list to that program's types rather than the practice catalog.
async function getVisitTypes(cookie, { template, dateIso } = {}) {
  if (!template) {
    throw new Error(
      'No captured GetVisitTypes request is stored, and InSync returns an empty list without one. ' +
      'Run scripts/extract-insync-captures.js.');
  }
  const params = { ...template };
  const when = dateIso ? mdy(dateIso) : mdy(new Date().toISOString().slice(0, 10));
  for (const k of Object.keys(params)) {
    if (/visitdate/i.test(k)) params[k] = when;
  }
  const res = await post('/Scheduler/GetVisitTypes', params, cookie);
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

  if (!found || !found.length) {
    throw new Error(
      'GetVisitTypes returned an empty list. The captured request context is stale — ' +
      're-capture /Scheduler/GetVisitTypes and re-run the capture extractor.');
  }

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

// --- per-type billing (CPT map + POS) --------------------------------------

// Everything that follows from choosing an encounter type — CPT code, modifiers,
// units, the CPT-map row id — comes from InSync, per type, per run. The captured
// payloads carry ONE type's mapping (1273: map 418, modifier 338, POS 99), and
// replaying that for a different type bills the wrong thing: 1253 is map 401
// with no modifier. So none of it is ever taken from the capture.
//
// GetSchedulerCalendar answers with the whole practice's CPT map in
// AdditionalDetails.lstCPT, keyed by EncounterTypeID — the same call the browser
// makes to populate the booking form's CPT grid.
async function getSchedulerContext(cookie, { template, patientId, dateIso } = {}) {
  if (!template) {
    throw new Error(
      'No captured GetSchedulerCalendar request is stored, so per-type billing cannot be resolved. ' +
      'Run scripts/extract-insync-captures.js.');
  }
  const params = { ...template };
  const when = mdy(dateIso || new Date().toISOString().slice(0, 10));
  for (const k of Object.keys(params)) {
    if (/visitdate/i.test(k)) params[k] = when;
    if (patientId && /(^|\.|\[)patientid\]?$/i.test(k)) params[k] = String(patientId);
  }

  const res = await post('/Scheduler/GetSchedulerCalendar', params, cookie);
  const body = await json(res, 'GetSchedulerCalendar');
  const extra = body?.AdditionalDetails || {};

  const cptMap = new Map();
  for (const row of extra.lstCPT || []) {
    const id = String(row?.EncounterTypeID ?? '');
    if (!id || id === '0' || cptMap.has(id)) continue;
    cptMap.set(id, {
      cptMapId: String(row.EncounterTypeCPTMapID ?? ''),
      // The grid carries the code both bare and as "<CPT>#*#&*&<mapId>".
      cptCode: String(row.CPTCode ?? row.CPT_Code ?? '').split('#*#&*&')[0],
      cptDescription: String(row.CPT_Description ?? row.CPTDescription ?? '').trim(),
      m1: row.M1 == null ? '' : String(row.M1),
      m2: row.M2 == null ? '' : String(row.M2),
      m3: row.M3 == null ? '' : String(row.M3),
      m4: row.M4 == null ? '' : String(row.M4),
      units: Number(row.Units || 1).toFixed(2),
      cptMapTypeId: String(row.CPTMapTypeID ?? '1'),
    });
  }
  if (!cptMap.size) {
    throw new Error(
      'GetSchedulerCalendar returned no CPT map. The captured request context is stale — ' +
      're-capture /Scheduler/GetSchedulerCalendar and re-run the capture extractor.');
  }

  // The patient's program enrolment. The capture carries the captured patient's
  // (6519 / 18); using that for anyone else attaches the wrong program to a
  // billable encounter, so the caller blocks the note when this is absent.
  const book = body?.objbookAppointment || {};
  const num = v => (v == null || String(v) === '0' ? '' : String(v));
  const program = {
    programManagementDetailId: num(extra.ProgramManagementDetailID ?? book.ProgramManagementDetailID),
    programManagementId:       num(extra.ProgramManagementID ?? book.ProgramManagementID),
  };

  const posByType = new Map();
  for (const row of extra.lstPOSDetail || []) {
    const id = String(row?.EncounterTypeID ?? row?.POSID ?? '');
    if (id) posByType.set(id, row);
  }

  return { cptMap, program, posDetail: extra.lstPOSDetail || [], posByType };
}

// Place of service, per encounter type. 1253 (at Home) is POS 12; 1246/1252/1273
// (outside the clinic) are 99; 1241 (in the clinic) is 11. This endpoint takes a
// JSON body rather than form encoding, so it bypasses the post() helper.
async function getPosForType(cookie, visitTypeId) {
  const res = await fetch(`${BASE}/EncounterDetail/GetPosCodeByEncSpaceFacilityId`, {
    method: 'POST',
    headers: { ...headers(cookie), 'Content-Type': 'application/json; charset=UTF-8' },
    body: `{EncounterTypeId:'${String(visitTypeId)}', VisitId:'null'}`,
  });
  const body = await json(res, 'GetPosCodeByEncSpaceFacilityId');
  const code = String(body?.POSData ?? '').trim();
  if (!code) throw new Error(`InSync returned no place-of-service code for encounter type ${visitTypeId}`);
  return { posCode: code, posId: String(body?.POSID ?? '').trim() };
}

// Assemble everything the write chain needs for ONE encounter type.
async function resolveBilling(cookie, { template, patientId, providerId, dateIso, visitTypeId }) {
  const ctx = await getSchedulerContext(cookie, { template, patientId, dateIso });
  const row = ctx.cptMap.get(String(visitTypeId));
  if (!row) {
    throw new Error(
      `InSync has no CPT mapping for encounter type ${visitTypeId}. ` +
      `Refusing to fall back to the captured type's billing.`);
  }
  const facilityId = facilityFromTemplate(template);
  const [{ posCode, posId }, program] = await Promise.all([
    getPosForType(cookie, visitTypeId),
    getPatientProgram(cookie, { patientId, providerId, facilityId, dateIso }),
  ]);
  return { ...row, ...program, posCode, posId, posDescription: describePos(ctx.posDetail, posCode) };
}

// The booking context's facility, read from the captured request rather than
// hardcoded, so a second facility needs a re-capture and not a code change.
function facilityFromTemplate(template) {
  for (const [k, v] of Object.entries(template || {})) {
    if (/facilityid$/i.test(k.replace(/[[\]]+/g, '.').replace(/\.+$/, '')) && String(v).trim()) return String(v).trim();
  }
  return '';
}

// POS needs a display string ("12 - Home") alongside the code. The facility's
// configured list is the authority, but it only carries the codes that facility
// uses -- POS 12 is absent from it -- so fall back to the CMS standard names for
// the handful this system can produce. Display only: InSync recomputes it, and
// an empty string is safer than a wrong one.
const POS_NAMES = {
  '02': "Telehealth Provided Other than in Patient's Home",
  '10': "Telehealth Provided in Patient's Home",
  '11': 'Office',
  '12': 'Home',
  '99': 'Other Place of Service',
};

function describePos(posDetail, posCode) {
  const want = String(posCode).trim();
  for (const row of posDetail || []) {
    const code = String(row?.POS_Code ?? row?.POSCode ?? row?.POSData ?? '').trim();
    if (!code || code !== want) continue;
    const full = String(row?.POSDesc ?? '').trim();
    if (full) return full;
    const desc = String(row?.POS_Description ?? row?.POSCodeDescription ?? '').trim();
    if (desc) return `${want} - ${desc}`;
  }
  return POS_NAMES[want] ? `${want} - ${POS_NAMES[want]}` : '';
}

// The patient's program enrolment, per patient. The captured payloads carry the
// captured patient's (detail 6519); every real patient has their own -- 5996,
// 5309, 3604 for the first three checked -- so sending the captured one would
// attach the wrong program to a billable encounter.
async function getPatientProgram(cookie, { patientId, providerId, facilityId, dateIso }) {
  const res = await post('/ProgramManagement/ProgramManagementSearch', {
    ProgramManagementDetailID: '0',
    ProgramDisplayId: '1',
    PatientId: String(patientId),
    ProgramDate: mdy(dateIso || new Date().toISOString().slice(0, 10)),
    FacilityID: String(facilityId || ''),
    ProviderID: String(providerId || ''),
  }, cookie);

  let rows = [];
  try { rows = JSON.parse(await res.text()); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];

  const usable = rows.filter(r => Number(r?.ProgramManagementDetailID) > 0);
  // Only the ids and names travel onward — the raw rows carry the patient's name
  // and date of birth, which have no business in an API response or a log line.
  const programCount = usable.length;
  const programNames = [...new Set(usable.map(r => String(r.ProgramName ?? '').trim()).filter(Boolean))];

  // More than one enrolment is a human decision, not a coin toss.
  if (programCount !== 1) {
    return { programManagementDetailId: '', programManagementId: '', programName: '', programCount, programNames };
  }
  return {
    programManagementDetailId: String(usable[0].ProgramManagementDetailID),
    programManagementId: String(usable[0].ProgramManagementID ?? ''),
    programName: String(usable[0].ProgramName ?? ''),
    programCount, programNames,
  };
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
  getSchedulerContext, getPosForType, getPatientProgram, resolveBilling, describePos,
  loadCalendarView, findExistingAppointment, dobToIso, mdy,
};

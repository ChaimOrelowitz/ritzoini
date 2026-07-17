// Minimal read-only Airtable client for the DS Peer Management base.
// The PAT is scoped to data.records:read + schema.bases:read -- there is no
// write path here on purpose; Airtable is the source of truth.

const API = 'https://api.airtable.com/v0';

const KEY  = process.env.AIRTABLE_API_KEY;
const BASE = process.env.AIRTABLE_PEER_BASE_ID;

const TABLES = {
  peers:                'tblAw7MiEuA8utEGs',
  supervisors:          'tblxDAa8jGTpKwITU',
  supervisionSchedule:  'tblpDjzRkY8ChzaSt',
  supervisionSessions:  'tblF13XqYD3MD54Cl',
};

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dowIndex = name => { const i = DOW.indexOf(name); return i === -1 ? 99 : i; };
const first = v => Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

const PEER_FIELDS = [
  'Peer Name', 'Status', 'Supervision Cohort', 'Peer Email', 'Peer Phone',
  'Last Supervision',
];

async function call(path, params = []) {
  if (!KEY)  throw new Error('AIRTABLE_API_KEY is not set');
  if (!BASE) throw new Error('AIRTABLE_PEER_BASE_ID is not set');

  const qs  = params.length ? `?${params.join('&')}` : '';
  const res = await fetch(`${API}/${BASE}/${path}${qs}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const body = await res.json();

  if (!res.ok) {
    const msg = body?.error?.message || body?.error?.type || res.statusText;
    throw new Error(`Airtable ${res.status}: ${msg}`);
  }
  return body;
}

// The supervisor's Peers link field IS the caseload, by record ID. Reading it
// avoids matching on the supervisor's display name, which would silently
// return zero peers if anyone renamed the record.
// Note: the single-record endpoint rejects `fields[]` with a 422, unlike the
// list endpoint -- so this pulls the whole supervisor record and picks fields off it.
async function fetchCaseloadPeerIds(supervisorId) {
  const rec = await call(`${TABLES.supervisors}/${supervisorId}`);
  return {
    supervisorName: rec.fields?.['Supervisor Name'] || null,
    peerIds:        rec.fields?.['Peers'] || [],
  };
}

// Airtable caps formula length, so ask for peers in chunks rather than one
// OR() over the whole caseload.
async function fetchPeers(peerIds) {
  const out = [];

  for (let i = 0; i < peerIds.length; i += 50) {
    const chunk   = peerIds.slice(i, i + 50);
    const formula = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(',')})`;
    const params  = [
      `filterByFormula=${encodeURIComponent(formula)}`,
      `pageSize=50`,
      ...PEER_FIELDS.map(f => 'fields[]=' + encodeURIComponent(f)),
    ];

    let offset;
    do {
      const page = await call(TABLES.peers, offset ? [...params, `offset=${offset}`] : params);
      out.push(...page.records);
      offset = page.offset;
    } while (offset);
  }

  return out.map(r => ({
    airtable_id:      r.id,
    peer_name:        r.fields['Peer Name'] || null,
    status:           r.fields['Status'] || null,
    cohort:           r.fields['Supervision Cohort'] || null,
    email:            r.fields['Peer Email'] || null,
    phone:            r.fields['Peer Phone'] || null,
    last_supervision: r.fields['Last Supervision'] || null,
  }));
}

// The supervisor's recurring supervision slots (their "Supervision Schedule"
// link field), by record ID -- same rename-proof pattern as the caseload.
async function fetchSupervisionSchedule(supervisorId) {
  const rec     = await call(`${TABLES.supervisors}/${supervisorId}`);
  const slotIds = rec.fields?.['Supervision Schedule'] || [];
  if (!slotIds.length) return [];

  const formula = `OR(${slotIds.map(id => `RECORD_ID()='${id}'`).join(',')})`;
  const fields  = ['Session Slot Name', 'Day of Week', 'Start Time', 'End Time',
                   'Supervision Cohort', 'Frequency', 'Session Slot Active?',
                   'Manual Session', 'Session Zoom Link', 'Session Phone Number'];
  const params  = [
    `filterByFormula=${encodeURIComponent(formula)}`,
    'pageSize=50',
    ...fields.map(f => 'fields[]=' + encodeURIComponent(f)),
  ];
  const page = await call(TABLES.supervisionSchedule, params);

  return (page.records || []).map(r => ({
    airtable_id: r.id,
    name:        first(r.fields['Session Slot Name']),
    day:         first(r.fields['Day of Week']),
    start:       first(r.fields['Start Time']),
    end:         first(r.fields['End Time']),
    cohort:      first(r.fields['Supervision Cohort']),
    frequency:   first(r.fields['Frequency']),
    active:      r.fields['Session Slot Active?'] === true,
    manual:      r.fields['Manual Session'] === true,
    zoom:        first(r.fields['Session Zoom Link']),
    phone:       first(r.fields['Session Phone Number']),
  })).sort((a, b) => (dowIndex(a.day) - dowIndex(b.day)) || String(a.start).localeCompare(String(b.start)));
}

// Individual supervision sessions the supervisor runs -- matched via the slot's
// supervisor lookup and the manual-supervisor link, so both recurring and
// one-off sessions are caught. Newest first, capped to a recent window.
async function fetchSupervisionSessions(supervisorId, { limit = 100 } = {}) {
  const cond = f => `FIND("${supervisorId}",ARRAYJOIN({${f}}))>0`;
  const formula = `OR(${cond('Supervisor (from Session Slot)')},${cond('Supervisor (Manual)')})`;
  const fields  = ['Session Date', 'Status', 'Session Slot Name (from Session Slot)',
                   'Display Start Time', 'Display End Time', 'Day of Week',
                   'Supervision Cohort (from Session Slot)', 'Peers Attended'];
  const params  = [
    `filterByFormula=${encodeURIComponent(formula)}`,
    'sort[0][field]=Session Date', 'sort[0][direction]=desc',
    `pageSize=${Math.min(limit, 100)}`,
    ...fields.map(f => 'fields[]=' + encodeURIComponent(f)),
  ];

  const out = [];
  let offset;
  do {
    const page = await call(TABLES.supervisionSessions, offset ? [...params, `offset=${offset}`] : params);
    out.push(...page.records);
    offset = out.length < limit ? page.offset : undefined;
  } while (offset);

  return out.slice(0, limit).map(r => ({
    airtable_id: r.id,
    date:        r.fields['Session Date'] || null,
    day:         r.fields['Day of Week'] || null,
    start:       first(r.fields['Display Start Time']),
    end:         first(r.fields['Display End Time']),
    cohort:      first(r.fields['Supervision Cohort (from Session Slot)']),
    slot_name:   first(r.fields['Session Slot Name (from Session Slot)']),
    status:      r.fields['Status'] || null,
    attended:    r.fields['Peers Attended'] ?? null,
  }));
}

module.exports = {
  fetchCaseloadPeerIds, fetchPeers,
  fetchSupervisionSchedule, fetchSupervisionSessions,
  TABLES,
};

// Minimal read-only Airtable client for the DS Peer Management base.
// The PAT is scoped to data.records:read + schema.bases:read -- there is no
// write path here on purpose; Airtable is the source of truth.

const API = 'https://api.airtable.com/v0';

const KEY  = process.env.AIRTABLE_API_KEY;
const BASE = process.env.AIRTABLE_PEER_BASE_ID;

const TABLES = {
  peers:       'tblAw7MiEuA8utEGs',
  supervisors: 'tblxDAa8jGTpKwITU',
};

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

module.exports = { fetchCaseloadPeerIds, fetchPeers, TABLES };

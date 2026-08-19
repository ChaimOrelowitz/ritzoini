// Turns the two Supabase sources into one normalised contact shape, shared by
// the CardDAV books and the DSC recipient API so the phone and the Shortcut can
// never disagree about who is on the list.
//
// Field realities this has to absorb (verified against production):
//   • ps_peers.peer_name   is "Last, First"
//   • ps_peers.cohort      is a JSON-encoded array in a text column — `["A"]`,
//                          because Airtable returns Supervision Cohort as an
//                          array and the mirror stored it verbatim
//   • ps_peers.phone       is "(555) 555-5555"; a couple carry a leading 1
//   • instructors.phone    is bare digits, "5555555555"
//   • instructors          has NO email column and NO active/inactive flag

// ── phone ────────────────────────────────────────────────────────────────────

// Returns E.164 or null. Null means "no usable mobile" and the record is
// dropped rather than sent to Messages with a number that would silently fail.
function normalizePhone(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const hadPlus = s.startsWith('+');
  const digits  = s.replace(/\D/g, '');
  if (!digits) return null;

  if (hadPlus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// ── cohort ───────────────────────────────────────────────────────────────────

// Accepts `["A"]`, `A`, or a real array; returns "A" or null.
function parseCohort(raw) {
  if (raw == null) return null;

  let v = raw;
  if (Array.isArray(v)) v = v[0];
  if (v == null) return null;

  let s = String(v).trim();
  if (!s) return null;

  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      s = Array.isArray(arr) ? String(arr[0] ?? '').trim() : s;
    } catch {
      // Not valid JSON after all — fall through and use the raw text.
    }
  }
  return s || null;
}

// ── names ────────────────────────────────────────────────────────────────────

// "Last, First" is the ps_peers convention; anything else is treated as a
// display name we should not try to take apart.
function splitPeerName(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { first: '', last: '', display: '' };

  const i = s.indexOf(',');
  if (i === -1) return { first: '', last: s, display: s };

  const last  = s.slice(0, i).trim();
  const first = s.slice(i + 1).trim();
  return { first, last, display: [first, last].filter(Boolean).join(' ') || s };
}

// ── shaping ──────────────────────────────────────────────────────────────────

// Stable across syncs: airtable_id and the instructor uuid are both permanent
// primary keys, so iOS updates a contact in place instead of adding a twin.
const peerUid       = id => `ritzoini-peer-${id}`;
const instructorUid = id => `ritzoini-instructor-${id}`;

function peerToContact(peer, period) {
  const { first, last, display } = splitPeerName(peer.peer_name || period?.peer_name);
  const cohort = parseCohort(peer.cohort);
  return {
    uid:      peerUid(peer.airtable_id),
    sourceId: peer.airtable_id,
    kind:     'peer',
    first, last,
    display:  display || peer.airtable_id,
    phone:    normalizePhone(peer.phone),
    email:    (peer.email || '').trim() || null,
    cohort,
    org:      ['DSC Peer Supervision', cohort ? `Cohort ${cohort}` : null].filter(Boolean),
    categories: ['DSC Peer', cohort ? `Cohort ${cohort}` : null].filter(Boolean),
    rev:      peer.updated_at || null,
    enteredOn: period?.entered_on || null,
  };
}

function instructorToContact(row) {
  const first = String(row.first_name || '').trim();
  const last  = String(row.last_name  || '').trim();
  return {
    uid:      instructorUid(row.id),
    sourceId: row.id,
    kind:     'instructor',
    first, last,
    display:  [first, last].filter(Boolean).join(' ') || `Instructor ${row.id}`,
    phone:    normalizePhone(row.phone),
    // The instructors table has no email column; there is nothing to emit.
    email:    (row.email || '').trim() || null,
    cohort:   null,
    org:        ['Ritzoini', 'Instructor'],
    categories: ['Ritzoini Instructor'],
    rev:      row.created_at || null,
    enteredOn: null,
  };
}

// ── ordering / dedup ─────────────────────────────────────────────────────────

// Sort by last, then first, then uid, so two runs a second apart produce byte
// identical output — which is what keeps the collection ETag stable.
function compareContacts(a, b) {
  return (a.last || '').localeCompare(b.last || '')
      || (a.first || '').localeCompare(b.first || '')
      || String(a.uid).localeCompare(String(b.uid));
}

// One conversation per human. Two records sharing a mobile are the same phone,
// so the later one (in sort order) is dropped rather than texted twice.
function dedupeByPhone(contacts) {
  const seen = new Set();
  const out  = [];
  for (const c of [...contacts].sort(compareContacts)) {
    if (!c.phone) continue;
    if (seen.has(c.phone)) continue;
    seen.add(c.phone);
    out.push(c);
  }
  return out;
}

module.exports = {
  normalizePhone, parseCohort, splitPeerName,
  peerToContact, instructorToContact, peerUid, instructorUid,
  compareContacts, dedupeByPhone,
};

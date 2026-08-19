// The single definition of "who is on my caseload right now", shared by the
// CardDAV address book and the DSC recipient API so the phone's contacts and
// the Shortcut's recipient list can never drift apart.
//
// The rule refines — it does not replace — the one behind GET /api/ps/caseload,
// which selects open periods alone. Two extra guards matter when the output is
// going to send text messages rather than render a table:
//
//   • entered_on must have arrived. A hand-entered future assignment is on the
//     caseload eventually, not today.
//   • left_on, when set, must still be ahead of us. syncCaseload stamps left_on
//     with today's date the moment a peer drops off Airtable, so a period
//     closed today is already over.
//
// ps_peers.status is deliberately NOT consulted. Caseload membership is the
// whole rule: if someone is on the list they belong in the supervisor's phone,
// whatever Airtable's Status field happens to say about them.

const supabase = require('../db/supabase');
const { todayET } = require('./caseloadSync');
const {
  peerToContact, instructorToContact, compareContacts,
} = require('./contactDirectory');

// ── pure selection ───────────────────────────────────────────────────────────

function isCurrentPeriod(period, asOf) {
  if (!period?.entered_on) return false;
  if (period.entered_on > asOf) return false;                 // starts later
  if (period.left_on && period.left_on <= asOf) return false; // already ended
  return true;
}

// Pure so the date rules can be tested without a database. periods/peers are
// raw Supabase rows; returns contact shapes, name-ordered.
function selectActiveCaseload({ periods = [], peers = [], asOf }) {
  const peerById = new Map(peers.map(p => [p.airtable_id, p]));

  const contacts = [];
  const seen = new Set();

  for (const period of periods) {
    if (!isCurrentPeriod(period, asOf)) continue;

    const peer = peerById.get(period.peer_airtable_id);
    if (!peer) continue; // no mirrored attributes — nothing to put on a card

    // A peer can hold only one open period per supervisor, but a re-entry row
    // plus a hand-added row could both qualify; the contact is still one person.
    if (seen.has(peer.airtable_id)) continue;
    seen.add(peer.airtable_id);

    contacts.push(peerToContact(peer, period));
  }

  return contacts.sort(compareContacts);
}

// ── fetch ────────────────────────────────────────────────────────────────────

async function fetchActiveCaseload({ supervisorId, asOf } = {}) {
  const sup = supervisorId || process.env.AIRTABLE_SUPERVISOR_RECORD_ID;
  if (!sup) throw new Error('No supervisor record id configured');

  const { data: periods, error: pe } = await supabase
    .from('ps_caseload_periods')
    .select('peer_airtable_id, peer_name, entered_on, left_on')
    .eq('supervisor_airtable_id', sup);
  if (pe) throw new Error(`Reading caseload periods: ${pe.message}`);

  const { data: peers, error: qe } = await supabase
    .from('ps_peers')
    .select('airtable_id, peer_name, status, cohort, email, phone, updated_at');
  if (qe) throw new Error(`Reading peers: ${qe.message}`);

  return selectActiveCaseload({
    periods: periods || [],
    peers:   peers   || [],
    asOf:    asOf || todayET(),
  });
}

// The instructors table defines no active/inactive column and no end date, so
// there is no activity rule to honour here — every row is a current instructor.
async function fetchInstructors() {
  const { data, error } = await supabase
    .from('instructors')
    .select('id, first_name, last_name, phone, created_at')
    .order('last_name');
  if (error) throw new Error(`Reading instructors: ${error.message}`);

  return (data || []).map(instructorToContact).sort(compareContacts);
}

// ── cohorts ──────────────────────────────────────────────────────────────────

// The set of cohorts actually present on the current caseload. Audience keys
// are matched against this exactly — an arbitrary query fragment can never
// reach a database filter.
function cohortsOf(contacts) {
  return [...new Set(contacts.map(c => c.cohort).filter(Boolean))].sort();
}

module.exports = {
  isCurrentPeriod, selectActiveCaseload,
  fetchActiveCaseload, fetchInstructors, cohortsOf,
};

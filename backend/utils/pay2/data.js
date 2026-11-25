// Payments 2.0 — shared data loading. Supabase caps a query at 1,000 rows, so
// every "load everything" read here pages through with .range().

const supabase = require('../../db/supabase');

async function all(build, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < pageSize) return out;
  }
}

// Test / scratch groups never count toward money.
function isTestGroup(g) {
  const names = [g?.internal_name, g?.group_name, g?.name].map(n => String(n || '').trim().toLowerCase());
  return names.some(n => n === 'asdf' || /\btest/.test(n));
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9: ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Rates sorted newest-first; rateFor picks the latest effective on/before date.
async function loadRates() {
  const { data, error } = await supabase.from('pay_rates').select('*').order('effective_date', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}
function rateFor(date, rates) {
  const r = rates.find(x => x.effective_date <= date);
  return r ? r.amount_cents : null;
}

const SESSION_COLS = 'id, group_id, session_number, session_date, scheduled_date, scheduled_time, start_time, ecw_time, status, locked, locked_at, zoho_posted, zoho_posted_at, zoho_note_id, paid';
const GROUP_COLS   = 'id, internal_name, group_name, name, billing_name, zoho_session_id, instructor_id, status';

async function loadGroups() {
  const [groups, zoho] = await Promise.all([
    all(() => supabase.from('groups').select(GROUP_COLS).order('id')),
    all(() => supabase.from('zoho_groups').select('id, group_activity, session_code').order('id')),
  ]);
  const zById = Object.fromEntries(zoho.map(z => [z.id, z]));
  for (const g of groups) {
    const z = zById[g.zoho_session_id];
    g.activity = z?.group_activity || null;
    g.is_test = isTestGroup(g);
  }
  return groups;
}

async function loadAliases() {
  return all(() => supabase.from('group_aliases').select('group_id, alias, alias_norm').order('id'));
}

async function loadItems() {
  return all(() => supabase.from('payday_items')
    .select('id, payday_id, session_id, session_date, amount_cents, match_status, billing_name_raw, raw_line, match_confidence')
    .order('id'));
}

async function loadPaydays() {
  const { data, error } = await supabase.from('paydays').select('*').order('pay_date', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function loadAllSessions() {
  return all(() => supabase.from('sessions').select(SESSION_COLS).order('id'));
}

// Sessions on any of the given dates (session_date, or scheduled_date when the
// session has no session_date).
async function loadSessionsOnDates(dates) {
  const uniq = [...new Set(dates)].filter(Boolean);
  const out = new Map();
  for (let i = 0; i < uniq.length; i += 60) {
    const chunk = uniq.slice(i, i + 60);
    const [a, b] = await Promise.all([
      all(() => supabase.from('sessions').select(SESSION_COLS).in('session_date', chunk).order('id')),
      all(() => supabase.from('sessions').select(SESSION_COLS).is('session_date', null).in('scheduled_date', chunk).order('id')),
    ]);
    for (const s of [...a, ...b]) out.set(s.id, s);
  }
  return [...out.values()];
}

const sessionDate = s => s.session_date || s.scheduled_date;

module.exports = { supabase, all, isTestGroup, norm, loadRates, rateFor, loadGroups, loadAliases, loadItems, loadPaydays, loadAllSessions, loadSessionsOnDates, sessionDate };

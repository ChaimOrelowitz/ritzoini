// Auto-create Ritzoini groups for new Zoho groups.
//
// A new group used to be added by hand from the Roster page ("Add to
// Ritzoini"), which pre-fills the create form from the Zoho record and then
// links it. This does exactly the same thing on the server, for every Zoho
// group that:
//   • belongs to the roster therapist (getRoster() already filters to them),
//   • is Status "Active" in Zoho and hasn't already ended,
//   • has a start date, a start time and a session count or end date,
//   • isn't linked to a Ritzoini group yet, and
//   • was never auto-created before (see the ledger below).
// Each one is assigned to the roster supervisor account, has AI notes on, and
// is linked to its Zoho record. It only ever CREATES groups — existing groups
// are never touched.
//
// The ledger (`app_config.zoho_autocreated_ids`) remembers every Zoho id this
// has created a group for, so a group that's later unlinked or reworked by hand
// is not created a second time on the next hourly run.
//
// Kill switch: ZOHO_AUTOCREATE=off.

const supabase = require('../db/supabase');
const { getRoster } = require('./zohoCrm');
const { todayET } = require('./caseloadSync');

// The account new groups are assigned to — the same one the Roster page's
// manual "Add" pre-selects.
const SUPERVISOR_NAME = 'Chaim Orelowitz Supervisor';
const LEDGER_KEY = 'zoho_autocreated_ids';
const DEFAULT_DURATION = 45;
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function autoCreateEnabled() {
  return String(process.env.ZOHO_AUTOCREATE || '').toLowerCase() !== 'off';
}

const norm = v => String(v || '').trim().toLowerCase();

function dayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addMinutes(timeStr, mins) {
  const [h, m] = timeStr.slice(0, 5).split(':').map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Same session count routes/groups.js derives from a start + end date.
function sessionsBetween(startDate, endDate, dowInt) {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const startMs = Date.UTC(sy, sm - 1, sd), endMs = Date.UTC(ey, em - 1, ed);
  const firstMs = startMs + ((dowInt - new Date(startMs).getUTCDay() + 7) % 7) * 864e5;
  if (firstMs > endMs) return 0;
  return Math.floor((endMs - firstMs) / (7 * 864e5)) + 1;
}

// Activity minus the numbers, e.g. "Surprise Crafts 5:20" → "Surprise Crafts"
// (same as the Roster page's description pre-fill).
function activityText(a) {
  return String(a || '').replace(/\d[\d:.]*/g, '').replace(/\s+/g, ' ').trim();
}

async function readLedger() {
  const { data } = await supabase.from('app_config').select('value').eq('key', LEDGER_KEY).maybeSingle();
  try { const ids = JSON.parse(data?.value || '[]'); return new Set(Array.isArray(ids) ? ids : []); }
  catch { return new Set(); }
}

async function writeLedger(ids) {
  const { error } = await supabase.from('app_config')
    .upsert({ key: LEDGER_KEY, value: JSON.stringify([...ids]) }, { onConflict: 'key' });
  if (error) throw new Error(`ledger write failed: ${error.message}`);
}

async function findSupervisor() {
  const { data, error } = await supabase.from('profiles')
    .select('id, first_name, last_name').eq('role', 'supervisor');
  if (error) throw new Error(error.message);
  const hits = (data || []).filter(p => norm(`${p.first_name || ''} ${p.last_name || ''}`) === norm(SUPERVISOR_NAME));
  // Fail closed: never create unassigned groups, or guess between two accounts.
  if (hits.length !== 1) throw new Error(`expected exactly one "${SUPERVISOR_NAME}" profile, found ${hits.length}`);
  return hits[0].id;
}

// Build the row a new group would get, or the reason it's skipped.
function plan(g, today, existingNames) {
  if (g.on_ritzoini)              return { skip: 'already in Ritzoini' };
  if (norm(g.status) !== 'active') return { skip: `Zoho status is ${g.status || 'blank'}` };
  if (!g.start_date || !g.start_time) return { skip: 'no start date/time in Zoho' };
  if (g.end_date && g.end_date < today) return { skip: `already ended (${g.end_date})` };
  if (existingNames.has(norm(g.group_name))) return { skip: 'a Ritzoini group already has this name — link it by hand' };

  const dowInt = dayOfWeek(g.start_date);
  const total  = parseInt(g.how_many_sessions, 10)
    || (g.end_date ? sessionsBetween(g.start_date, g.end_date, dowInt) : 0);
  if (!total) return { skip: 'no session count or end date in Zoho' };

  const start = g.start_time.slice(0, 5);
  const name  = g.group_name || g.session_code;
  const description = [g.group_name, activityText(g.group_activity), g.group_type, g.age_range && `Ages ${g.age_range}`]
    .filter(Boolean).join(' · ');

  return {
    row: {
      internal_name:    g.session_code || name,
      group_name:       name,
      name,
      description:      description || null,
      instructor_id:    g.ritzoini_instructor_id || null,
      start_date:       g.start_date,
      end_date:         g.end_date || null,
      day_of_week_int:  dowInt,
      day_of_week:      DAY_NAMES[dowInt],
      start_time:       start,
      session_time:     start,
      end_time:         addMinutes(start, DEFAULT_DURATION),
      ecw_time:         start,
      ecw_end_time:     addMinutes(start, DEFAULT_DURATION),
      total_sessions:   total,
      default_duration: DEFAULT_DURATION,
      ai_notes:         true,
      zoho_session_id:  g.id,
    },
  };
}

// apply=false is a dry run: reports what WOULD be created and changes nothing.
async function autoCreateZohoGroups({ apply = false } = {}) {
  const [roster, ledger, { data: groups, error }] = await Promise.all([
    getRoster(),
    readLedger(),
    supabase.from('groups').select('group_name, name'),
  ]);
  if (error) throw new Error(error.message);
  const existingNames = new Set((groups || []).flatMap(g => [norm(g.group_name), norm(g.name)]).filter(Boolean));
  const today = todayET();

  const toCreate = [], skipped = [];
  for (const g of roster) {
    if (g.on_ritzoini) continue;                         // the normal case — not worth listing
    if (ledger.has(g.id)) { skipped.push({ zoho_id: g.id, name: g.group_name, reason: 'auto-created before (since unlinked) — not re-creating' }); continue; }
    const p = plan(g, today, existingNames);
    if (p.skip) skipped.push({ zoho_id: g.id, name: g.group_name, reason: p.skip });
    else toCreate.push(p.row);
  }

  const summary = g => ({ zoho_id: g.zoho_session_id, name: g.group_name, start_date: g.start_date, start_time: g.start_time, sessions: g.total_sessions, instructor_linked: !!g.instructor_id });
  if (!apply || !toCreate.length) {
    return { applied: false, wouldCreate: toCreate.map(summary), skipped };
  }

  const supervisorId = await findSupervisor();
  const created = [], errors = [];
  for (const row of toCreate) {
    try {
      const { data: group, error: insErr } = await supabase.from('groups')
        .insert({ ...row, supervisor_id: supervisorId, created_by: supervisorId })
        .select('id, group_name').single();
      if (insErr) throw new Error(insErr.message);
      // Record it before generating sessions, so a failure below can never
      // lead to a second copy on the next run.
      ledger.add(row.zoho_session_id);
      await writeLedger(ledger);
      const { error: rpcErr } = await supabase.rpc('generate_sessions_for_group', { p_group_id: group.id });
      if (rpcErr) throw new Error(`created, but session generation failed: ${rpcErr.message}`);
      created.push({ ...summary(row), group_id: group.id });
    } catch (e) {
      errors.push({ name: row.group_name, error: e.message });
    }
  }
  if (created.length || errors.length) {
    console.log(`[zoho autocreate] created ${created.length}${errors.length ? `, ${errors.length} failed` : ''}: ${created.map(c => c.name).join(', ')}`);
  }
  return { applied: true, created, errors, skipped };
}

module.exports = { autoCreateZohoGroups, autoCreateEnabled };

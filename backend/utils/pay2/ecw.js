// Payments 2.0 — eCW encounter export: import, change tracking, and the
// per-session "was I paid for this locked session?" view.
//
// Tables: backend/db/migrations/2026-11-26_ecw_encounters.sql
//
// Rules
//   • An encounter is keyed on eCW's encounter_id. Re-uploading an identical
//     row changes nothing; a row that comes back different is updated and
//     every differing field is logged to ecw_changes for the owner to see.
//   • Pay is per session, so encounters roll up by ecw_group_id (eCW's id for
//     one group session). A session counts once no matter how many patients
//     or duplicate entries it has.
//   • A session is payable once at least one encounter is locked + billed
//     (and the claim not voided). Whether it was paid is read only from the
//     pay reports: it's paid if its Ritzoini session is on a payday's list.
//     Nothing predicts which payday it should have landed on.
//   • Nothing here writes to sessions or any existing table.

const XLSX = require('xlsx');
const D = require('./data');
const { supabase, rateFor } = D;
const { todayET } = require('../caseloadSync');

const OWED_FROM = '2026-04-01';
const MATCH_WINDOW_MIN = 45;

const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };

// ── Parsing ────────────────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(v => v !== '')) rows.push(row);
  return rows;
}

const pad = n => String(n).padStart(2, '0');
function normDate(v) {
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(m[1])}-${pad(m[2])}`;
  return null;
}
function normTime(v) {
  if (v instanceof Date) return `${pad(v.getHours())}:${pad(v.getMinutes())}`;
  const s = String(v || '').trim();
  const m = s.match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3]) { const pm = /p/i.test(m[3]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  return `${pad(h)}:${m[2]}`;
}
function normTs(v) {
  if (v == null || v === '') return null;
  const d = normDate(v);
  if (!d) return null;
  const rest = v instanceof Date ? v : String(v).replace(/^\S+/, '');
  const t = normTime(rest) || '00:00';
  return `${d} ${t}`;
}
const yes = v => /^(y|yes|true|1)$/i.test(String(v || '').trim());
const txt = v => { const s = String(v ?? '').trim(); return s || null; };

const REQUIRED = ['encounter_id', 'date', 'start_time', 'group_id', 'locked', 'billed', 'visit_status'];

// Buffer (CSV or Excel) → { rows, problems }
function parseExport(buffer, filename = '') {
  let table;
  if (/\.(xlsx|xls)$/i.test(filename) || buffer.slice(0, 2).toString() === 'PK') {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  } else {
    table = parseCsv(buffer.toString('utf8').replace(/^﻿/, ''));
  }
  if (!table.length) throw new Error('the file is empty');
  const head = table[0].map(h => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
  const missing = REQUIRED.filter(c => !head.includes(c));
  if (missing.length) throw new Error(`this doesn't look like the eCW export — missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  const get = (r, k) => (col[k] == null ? '' : r[col[k]]);

  const rows = [], problems = [];
  table.slice(1).forEach((r, i) => {
    const encounter_id = txt(get(r, 'encounter_id'));
    const visit_date = normDate(get(r, 'date'));
    const ecw_group_id = txt(get(r, 'group_id'));
    if (!encounter_id || !visit_date || !ecw_group_id) { problems.push(`row ${i + 2}: missing encounter id, date or group id`); return; }
    rows.push({
      encounter_id, ecw_group_id, visit_date,
      start_time: normTime(get(r, 'start_time')), end_time: normTime(get(r, 'end_time')),
      group_name: txt(get(r, 'group_name')),
      locked: yes(get(r, 'locked')), locked_at: normTs(get(r, 'locked_at')),
      signed: yes(get(r, 'signed')), signed_at: normTs(get(r, 'signed_at')),
      billed: yes(get(r, 'billed')), billed_at: normTs(get(r, 'billed_at')),
      patient_id: txt(get(r, 'patient_id')), provider: txt(get(r, 'provider')),
      visit_type: txt(get(r, 'visit_type')), cpt: txt(get(r, 'cpt')),
      visit_status: txt(get(r, 'visit_status'))?.toUpperCase() || null,
      claim_number: txt(get(r, 'claim_number')), claim_voided: yes(get(r, 'claim_voided')),
    });
  });
  return { rows, problems };
}

// ── Change detection ───────────────────────────────────────────────────────
const FIELDS = ['ecw_group_id', 'visit_date', 'start_time', 'end_time', 'group_name', 'locked', 'locked_at', 'signed', 'signed_at',
  'billed', 'billed_at', 'patient_id', 'provider', 'visit_type', 'cpt', 'visit_status', 'claim_number', 'claim_voided'];
const asText = v => (v == null || v === '' ? '' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));

// 'filled' = the ordinary way an encounter moves along; everything else is 'changed'.
function kindOf(field, oldV, newV) {
  if (oldV === '') return 'filled';
  if (['locked', 'signed', 'billed'].includes(field) && oldV === 'no' && newV === 'yes') return 'filled';
  if (field === 'visit_status' && oldV === 'PEN') return 'filled';
  return 'changed';
}
function diff(oldRow, newRow) {
  const out = [];
  for (const f of FIELDS) {
    const a = asText(f === 'visit_date' ? String(oldRow[f] || '').slice(0, 10) : oldRow[f]);
    const b = asText(newRow[f]);
    if (a !== b) out.push({ field: f, old_value: a || null, new_value: b || null, kind: kindOf(f, a, b) });
  }
  return out;
}

const SETUP_MSG = 'the eCW tables are not set up yet — run backend/db/migrations/2026-11-26_ecw_encounters.sql in the Supabase SQL editor first';
const friendly = e => (/ecw_(imports|encounters|changes)/.test(e.message) && /schema cache|does not exist/.test(e.message) ? new Error(SETUP_MSG) : e);

async function loadEncountersByIds(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await supabase.from('ecw_encounters').select('*').in('encounter_id', ids.slice(i, i + 300));
    if (error) throw friendly(new Error(error.message));
    for (const r of data || []) out.set(r.encounter_id, r);
  }
  return out;
}

async function insertChunks(table, rows, opts) {
  for (let i = 0; i < rows.length; i += 500) {
    const q = opts?.upsert ? supabase.from(table).upsert(rows.slice(i, i + 500), opts.upsert) : supabase.from(table).insert(rows.slice(i, i + 500));
    const { error } = await q;
    if (error) throw new Error(error.message);
  }
}

// Import one export. Returns counts and the 'changed' differences found.
// A blank in a new export never erases a value we already have — exports can
// come back incomplete (a big pull once lost a third of its claim numbers).
// The exception is a date whose flag went false (billed yes→no clears billed_at).
const KEEP_IF_BLANK = ['start_time', 'end_time', 'group_name', 'locked_at', 'signed_at', 'billed_at', 'patient_id', 'provider', 'visit_type', 'cpt', 'visit_status', 'claim_number'];
const CLEARED_BY = { locked_at: 'locked', signed_at: 'signed', billed_at: 'billed' };
function keepStored(old, r) {
  const out = { ...r };
  for (const f of KEEP_IF_BLANK) {
    if (out[f] != null && out[f] !== '') continue;
    if (old[f] == null || old[f] === '') continue;
    if (CLEARED_BY[f] && !out[CLEARED_BY[f]]) continue;
    out[f] = old[f];
  }
  return out;
}

// opts.skipMissingDates: days the export says it couldn't load — rows on those
// days aren't flagged as gone from eCW.
async function importExport(buffer, filename, opts = {}) {
  const { rows: parsed, problems } = parseExport(buffer, filename);
  if (!parsed.length) throw new Error('no encounter rows found in the file');

  // Same encounter twice inside one file: identical copies collapse; differing copies are reported.
  const byId = new Map(), inFileConflicts = [];
  for (const r of parsed) {
    const prev = byId.get(r.encounter_id);
    if (!prev) { byId.set(r.encounter_id, r); continue; }
    if (diff(prev, r).length) inFileConflicts.push(r.encounter_id);
  }
  const rows = [...byId.values()];
  const dates = rows.map(r => r.visit_date).sort();
  const date_from = dates[0], date_to = dates[dates.length - 1];

  const existing = await loadEncountersByIds(rows.map(r => r.encounter_id));
  const { data: imp, error: impErr } = await supabase.from('ecw_imports')
    .insert({ filename, row_count: rows.length, date_from, date_to }).select('id').single();
  if (impErr) throw new Error(impErr.message);
  const import_id = imp.id;
  const now = new Date().toISOString();

  const fresh = [], updated = [], unchanged = [], changes = [];
  for (const r of rows) {
    const old = existing.get(r.encounter_id);
    if (!old) { fresh.push({ ...r, first_import_id: import_id, last_import_id: import_id }); continue; }
    const merged = keepStored(old, r);
    const d = diff(old, merged);
    if (old.absent_import_id) d.push({ field: 'present', old_value: 'not in an earlier export', new_value: 'back in this export', kind: 'changed' });
    if (!d.length) { unchanged.push(r.encounter_id); continue; }
    updated.push({ ...merged, last_import_id: import_id, absent_import_id: null, updated_at: now });
    for (const c of d) changes.push({ ...c, encounter_id: r.encounter_id, import_id });
  }

  await insertChunks('ecw_encounters', fresh);
  await insertChunks('ecw_encounters', updated, { upsert: { onConflict: 'encounter_id' } });
  for (let i = 0; i < unchanged.length; i += 300) {
    await supabase.from('ecw_encounters').update({ last_import_id: import_id }).in('encounter_id', unchanged.slice(i, i + 300));
  }

  // Encounters on file for dates this export covers, but missing from it.
  const inFile = new Set(rows.map(r => r.encounter_id));
  const onFile = await D.all(() => supabase.from('ecw_encounters').select('encounter_id, absent_import_id, visit_date')
    .gte('visit_date', date_from).lte('visit_date', date_to).order('encounter_id'));
  const skip = new Set(opts.skipMissingDates || []);
  const gone = onFile.filter(e => !inFile.has(e.encounter_id) && !e.absent_import_id && !skip.has(String(e.visit_date).slice(0, 10))).map(e => e.encounter_id);
  for (let i = 0; i < gone.length; i += 300) {
    await supabase.from('ecw_encounters').update({ absent_import_id: import_id }).in('encounter_id', gone.slice(i, i + 300));
  }
  for (const id of gone) changes.push({ encounter_id: id, import_id, field: 'present', old_value: 'in earlier export', new_value: 'not in this export', kind: 'missing' });

  await insertChunks('ecw_changes', changes);
  const changedEnc = new Set(changes.filter(c => c.kind === 'changed').map(c => c.encounter_id));
  const filledEnc = new Set(changes.filter(c => c.kind === 'filled').map(c => c.encounter_id));
  const counts = { new_count: fresh.length, unchanged_count: unchanged.length, changed_count: updated.length, missing_count: gone.length };
  await supabase.from('ecw_imports').update(counts).eq('id', import_id);

  return {
    ok: true, import_id, filename, date_from, date_to, rows: rows.length, ...counts,
    changed_encounters: changedEnc.size, progressed_encounters: [...filledEnc].filter(id => !changedEnc.has(id)).length,
    duplicate_rows_in_file: parsed.length - rows.length, in_file_conflicts: inFileConflicts.length, problems: problems.slice(0, 20),
  };
}

// ── Per-session view ───────────────────────────────────────────────────────
const cleanName = n => String(n || '').replace(/^\s*(ecw name|group name)\s*:\s*/i, '').trim();
// A start time before 8 AM is an AM/PM typo (6/14 2:30 entered as 02:30).
const fixedTime = t => (t && t < '08:00' ? `${pad(Number(t.slice(0, 2)) + 12)}${t.slice(2)}` : t);

// Pay reports we should have but don't. Paydays are biweekly Thursdays
// (sometimes moved a day for a holiday); each pays the period that runs from
// 16 days before it to 3 days before it, as printed on the stubs. Every
// biweekly slot from the first eCW session through today is checked against
// what's on file: a stub, a session list, or both missing.
// This only finds gaps in the paperwork — it never decides which payday a
// session belongs on; the reports do that.
// Every payday slot from fromDate through today (+ the next one), each with
// what's on file. Slots skipped by the office (a stub's printed period already
// covers them) are left out.
function paydaySlots(paydays, fromDate, today) {
  const actual = paydays.slice().sort((a, b) => a.pay_date.localeCompare(b.pay_date));
  const anchor = actual.map(p => p.pay_date).filter(d => new Date(d + 'T12:00:00Z').getUTCDay() === 4).pop();
  if (!anchor) return [];
  const from = fromDate && fromDate < actual[0].pay_date ? fromDate : actual[0].pay_date;
  const out = [];
  let k = Math.floor(daysBetween(anchor, from) / 14);
  for (;; k++) {
    const thu = addDays(anchor, 14 * k);
    if (thu > addDays(today, 14)) break;
    if (addDays(thu, -3) < from) continue;
    const p = actual.find(x => Math.abs(daysBetween(thu, x.pay_date)) <= 3);
    if (!p && actual.some(x => x.period_start && x.period_end && x.period_start <= addDays(thu, -16) && x.period_end >= addDays(thu, -3))) continue;
    const has_stub = p?.gross_cents != null, has_list = p?.list_raw != null;
    out.push({
      pay_date: p?.pay_date || thu, payday_id: p?.id || null, future: thu > today, has_stub, has_list,
      period_start: p?.period_start || addDays(thu, -16), period_end: p?.period_end || addDays(thu, -3),
      missing: has_stub && has_list ? null : !p ? 'stub and session list' : !has_stub ? 'pay stub' : 'session list',
      gross_cents: p?.gross_cents ?? null, stub_sessions: p?.stub_hours ?? null,
    });
  }
  return out;
}
// Pay reports we should have but don't — what to ask the office for.
const missingReports = (paydays, fromDate, today) => paydaySlots(paydays, fromDate, today).filter(x => x.missing && !x.future && x.pay_date >= addDays(fromDate, 3));

// Earliest eCW session on file (null before the eCW tables exist).
async function firstEcwDate() {
  const { data, error } = await supabase.from('ecw_encounters').select('visit_date').order('visit_date').limit(1);
  return error ? null : (data?.[0]?.visit_date ? String(data[0].visit_date).slice(0, 10) : null);
}

function rollup(encs) {
  const live = encs.filter(e => !e.absent_import_id);
  const use = live.length ? live : encs;
  const first = use[0];
  const payable = use.filter(e => e.billed && e.locked && !e.claim_voided);
  const attended = use.filter(e => e.visit_status !== 'CANC');
  // Checked in (the office has put the note in eCW) but not locked — waiting on you to lock.
  const toLock = use.filter(e => !e.locked && e.visit_status && !['CANC', 'PEN'].includes(e.visit_status) && !/^CANC|^N\/S|^R\/S/.test(e.visit_status));
  const pendingCheckin = use.filter(e => !e.locked && e.visit_status === 'PEN');
  // Locked on = the lock date, or the billed date when eCW shows a re-lock
  // after billing (locked_at is the latest lock). Shown for reference only.
  const readyDates = payable.map(e => {
    const l = (e.locked_at || '').slice(0, 10), b = (e.billed_at || '').slice(0, 10);
    return b && l && b < l ? b : (l || b);
  }).filter(Boolean).sort();
  const byPatient = new Map();
  for (const e of use) { if (!e.patient_id) continue; (byPatient.get(e.patient_id) || byPatient.set(e.patient_id, []).get(e.patient_id)).push(e); }
  const repeats = [...byPatient.values()].filter(l => l.length > 1);
  const doubleBilled = repeats.filter(l => l.filter(e => e.billed && !e.claim_voided).length > 1).length;
  const times = use.map(e => e.start_time).filter(Boolean).sort();
  return {
    ecw_group_id: first.ecw_group_id, date: String(first.visit_date).slice(0, 10),
    time: fixedTime(times[0] || null), time_raw: times[0] || null, end_time: use.map(e => e.end_time).filter(Boolean).sort().pop() || null,
    group: cleanName(first.group_name), encounters: use.length, patients: byPatient.size || use.length,
    attended: attended.length, locked: use.filter(e => e.locked).length, billed: payable.length,
    to_lock: toLock.length, pending_checkin: pendingCheckin.length,
    all_cancelled: !attended.length, ready_date: readyDates[0] || null,
    double_billed: doubleBilled, entered_twice: repeats.length - doubleBilled,
    am_typo: !!(times[0] && times[0] < '08:00'), missing_from_export: live.length < encs.length,
    encounter_ids: encs.map(e => e.encounter_id),
  };
}

// Pair eCW sessions with Ritzoini sessions: same date, start times within 45
// minutes, closest first, one-to-one. A paid Ritzoini session wins over an
// unpaid twin; cancelled / duplicate ones are used only when nothing fits.
function pairWithRitzoini(sessions, ledgerRows) {
  const byDate = new Map();
  for (const r of ledgerRows) if (r.time) (byDate.get(r.date) || byDate.set(r.date, []).get(r.date)).push(r);
  const pairs = [];
  for (const s of sessions) {
    if (!s.time) continue;
    for (const r of byDate.get(s.date) || []) {
      const d = Math.abs(toMin(s.time) - toMin(r.time));
      if (d > MATCH_WINDOW_MIN) continue;
      // Prefer a paid twin over an unrun or cancelled one at nearly the same time.
      const penalty = ['cancelled', 'duplicate'].includes(r.status) ? 60 : r.status === 'paid' ? 0 : 20;
      pairs.push({ s, r, score: d + penalty });
    }
  }
  pairs.sort((a, b) => a.score - b.score);
  const usedS = new Set(), usedR = new Set(), out = new Map();
  for (const p of pairs) {
    if (usedS.has(p.s.ecw_group_id) || usedR.has(p.r.id)) continue;
    usedS.add(p.s.ecw_group_id); usedR.add(p.r.id); out.set(p.s.ecw_group_id, p.r);
  }
  return { byEcw: out, usedRitz: usedR };
}

// status:
//   paid           matched Ritzoini session is on a payday's list (or marked paid)
//   unpaid         locked + billed in eCW, on no payday's list
//   to_lock        checked in to eCW (note is there) but not locked — yours to lock
//   not_checked_in in eCW but every open visit is still PEN (the office hasn't checked it in)
//   not_billed     locked in eCW but no billed encounter
//   not_locked     not locked yet
//   cancelled      every patient cancelled
//   unmatched      payable but no Ritzoini session to check payment against
//   maybe_paid     unpaid here, but a paid Ritzoini entry within a day has no eCW session — likely the same one
//   history        unpaid, before Apr 1 2026 (not counted)
async function sessionView() {
  const S = require('./service');
  const [encs, ledgerData, openChanges] = await Promise.all([
    D.all(() => supabase.from('ecw_encounters').select('*').order('encounter_id')),
    S.buildLedger(),
    D.all(() => supabase.from('ecw_changes').select('encounter_id, kind').is('acknowledged_at', null).order('id')),
  ]).catch(e => { throw friendly(e); });
  const view = computeView(encs, ledgerData, openChanges);
  const { data: imports } = await supabase.from('ecw_imports').select('*').order('uploaded_at', { ascending: false }).limit(20);
  return { ...view, imports: imports || [] };
}

function computeView(encs, { rows: ledger, paydays, rates, today }, openChanges) {
  const groups = new Map();
  for (const e of encs) (groups.get(e.ecw_group_id) || groups.set(e.ecw_group_id, []).get(e.ecw_group_id)).push(e);
  const sessions = [...groups.values()].map(rollup);

  const { byEcw, usedRitz } = pairWithRitzoini(sessions, ledger);
  const changedEnc = new Map();
  for (const c of openChanges) if (c.kind !== 'filled') changedEnc.set(c.encounter_id, (changedEnc.get(c.encounter_id) || 0) + 1);

  // Same group name, date and time under two eCW group ids → entered twice.
  const twinKey = s => `${s.date}|${s.time}|${s.group.toLowerCase()}`;
  const twinCount = new Map();
  for (const s of sessions) if (!s.all_cancelled) twinCount.set(twinKey(s), (twinCount.get(twinKey(s)) || 0) + 1);

  for (const s of sessions) {
    const r = byEcw.get(s.ecw_group_id);
    s.ritzoini = r ? { id: r.id, group_id: r.group_id, group: r.group, time: r.time, status: r.status, note_sent: r.zoho_posted } : null;
    // Lock in eCW: the office checked it in but hasn't told you through Zoho (ready to lock) → their miss.
    s.office_flagged = !!r?.ready_to_lock;
    // Your Ritzoini "Locked" click (which tells Zoho) vs. the real lock in eCW.
    const ecwLocked = s.locked > 0 && !s.to_lock && !s.pending_checkin;
    s.ritz_locked = !!r?.locked;
    s.lock_not_marked = !!r && ecwLocked && !r.locked;            // locked in eCW, not marked in Ritzoini
    s.lock_marked_not_done = !!r && r.locked && (s.to_lock > 0 || s.pending_checkin > 0);   // marked in Ritzoini, still open in eCW
    s.paid_on = r?.payday || null;
    s.paid = !!(r && (r.payday || r.paid));
    s.amount_cents = rateFor(s.date, rates);
    s.twin = (twinCount.get(twinKey(s)) || 0) > 1;
    s.open_changes = s.encounter_ids.reduce((t, id) => t + (changedEnc.get(id) || 0), 0);
    delete s.encounter_ids;

    let st;
    if (s.all_cancelled) st = 'cancelled';
    else if (s.paid) st = 'paid';
    else if (s.to_lock) st = 'to_lock';
    else if (s.pending_checkin) st = 'not_checked_in';
    else if (!s.locked) st = 'not_locked';
    else if (!s.billed) st = 'not_billed';
    else if (!r) st = 'unmatched';
    else st = 'unpaid';
    if (['unpaid', 'to_lock', 'not_checked_in', 'not_billed', 'not_locked', 'unmatched'].includes(st) && s.date < OWED_FROM) st = 'history';
    if (s.date < OWED_FROM) { s.lock_not_marked = false; s.lock_marked_not_done = false; }
    s.status = st;
    s.days_since_lock = s.ready_date ? daysBetween(s.ready_date, today) : null;
    s.paid_legacy_only = st === 'paid' && !s.paid_on;
  }
  sessions.sort((a, b) => b.date.localeCompare(a.date) || String(a.time).localeCompare(String(b.time)));

  // Ritzoini sessions paid on a payday, inside the dates eCW covers, with no eCW session behind them.
  const covered = sessions.length ? [sessions[sessions.length - 1].date, sessions[0].date] : null;
  const paidNoEcw = covered ? ledger.filter(r => r.payday && r.date >= covered[0] && r.date <= covered[1] && !usedRitz.has(r.id))
    .map(r => ({ id: r.id, date: r.date, time: r.time, group: r.group, group_id: r.group_id, payday: r.payday, amount_cents: r.amount_cents }))
    .sort((a, b) => a.date.localeCompare(b.date)) : [];

  // An unpaid eCW session with a paid, unpaired Ritzoini session within a day
  // of it was most likely paid under that entry (Ritzoini has the wrong time
  // or date). Shown as 'maybe_paid' and kept out of the owed total.
  const open = sessions.filter(s => ['unpaid', 'unmatched'].includes(s.status) && s.time);
  const hints = [];
  for (const r of paidNoEcw) for (const s of open) {
    const dd = Math.abs(daysBetween(r.date, s.date));
    if (dd > 1) continue;
    const dt = r.time ? Math.abs(toMin(r.time) - toMin(s.time)) : 600;
    hints.push({ r, s, score: dd * 1440 + dt });
  }
  hints.sort((x, y) => x.score - y.score);
  const hintedS = new Set(), hintedR = new Set();
  for (const h of hints) {
    if (hintedS.has(h.s.ecw_group_id) || hintedR.has(h.r.id)) continue;
    hintedS.add(h.s.ecw_group_id); hintedR.add(h.r.id);
    h.s.maybe_paid_as = h.r; h.s.status = 'maybe_paid'; h.r.maybe_for = { date: h.s.date, time: h.s.time, group: h.s.group };
  }

  const sum = st => sessions.filter(s => s.status === st);
  const total = list => list.reduce((t, s) => t + (s.amount_cents || 0), 0);
  return {
    today, covered, sessions, paid_no_ecw: paidNoEcw,
    missing_reports: covered ? missingReports(paydays, covered[0], today) : [],
    totals: Object.fromEntries(['unpaid', 'maybe_paid', 'to_lock', 'not_checked_in', 'not_billed', 'not_locked', 'unmatched', 'paid', 'cancelled', 'history']
      .map(st => [st, { count: sum(st).length, cents: total(sum(st)) }])),
    flags: {
      double_billed: sessions.filter(s => s.double_billed).length,
      entered_twice: sessions.filter(s => s.entered_twice || s.twin).length,
      am_typo: sessions.filter(s => s.am_typo).length,
      to_lock: sessions.filter(s => s.status === 'to_lock').length,
      to_lock_not_flagged: sessions.filter(s => s.status === 'to_lock' && !s.office_flagged).length,
      not_checked_in: sessions.filter(s => s.status === 'not_checked_in').length,
      lock_not_marked: sessions.filter(s => s.lock_not_marked).length,
      lock_marked_not_done: sessions.filter(s => s.lock_marked_not_done).length,
      open_changes: openChanges.filter(c => c.kind !== 'filled').length,
      open_progress: openChanges.filter(c => c.kind === 'filled').length,
    },
  };
}

// Unacknowledged differences, with enough context to read them.
async function openChanges() {
  const changes = await D.all(() => supabase.from('ecw_changes').select('*').is('acknowledged_at', null).order('detected_at', { ascending: false }));
  const ids = [...new Set(changes.map(c => c.encounter_id))];
  const encs = await loadEncountersByIds(ids);
  return changes.map(c => {
    const e = encs.get(c.encounter_id) || {};
    return { ...c, visit_date: String(e.visit_date || '').slice(0, 10), start_time: e.start_time, group: cleanName(e.group_name), patient_id: e.patient_id, ecw_group_id: e.ecw_group_id };
  });
}

async function acknowledge({ ids, kind }) {
  let q = supabase.from('ecw_changes').update({ acknowledged_at: new Date().toISOString() }).is('acknowledged_at', null);
  if (Array.isArray(ids) && ids.length) q = q.in('id', ids);
  else if (kind) q = q.eq('kind', kind);
  else throw new Error('nothing to acknowledge');
  const { error } = await q;
  if (error) throw new Error(error.message);
  return { ok: true };
}

module.exports = { parseExport, importExport, sessionView, openChanges, acknowledge, paydaySlots, firstEcwDate, _test: { keepStored, computeView, diff, kindOf, missingReports, rollup, normDate, normTime, normTs } };

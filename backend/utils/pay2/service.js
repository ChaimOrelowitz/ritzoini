// Payments 2.0 — paydays, matching, and the derived session ledger.
//
// The only writes this makes to existing tables are the two the design allows:
//   • sessions.paid = true when a session is linked to a payday line
//   • sessions.status = 'cancelled' (with status_manual_override, as the
//     Group page's own cancel does) — only from the explicit "mark cancelled"
// Everything else lives in the new tables (paydays, payday_items,
// group_aliases, pay_rates).

const D = require('./data');
const { supabase, norm, rateFor, sessionDate } = D;
const { matchLines, buildContext, findDuplicates, scorePair } = require('./match');
const { todayET } = require('../caseloadSync');

const BUCKET = 'payments';
const OWED_FROM = '2026-04-01';      // Owed / Needs action only count from here
const GRACE_DAYS = 7;

const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
const dow = iso => new Date(iso + 'T12:00:00Z').getUTCDay();

// ── Storage ────────────────────────────────────────────────────────────────
async function storeFile(folder, filename, buffer, contentType) {
  const safe = String(filename || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safe}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType: contentType || 'application/octet-stream', upsert: false });
  if (error) throw new Error(`file upload failed: ${error.message}`);
  return path;
}
async function signedUrl(path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

// ── Paydays ────────────────────────────────────────────────────────────────
async function getPaydayByDate(pay_date) {
  const { data, error } = await supabase.from('paydays').select('*').eq('pay_date', pay_date).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function recomputePayday(id) {
  const [{ data: p }, { data: items }] = await Promise.all([
    supabase.from('paydays').select('*').eq('id', id).single(),
    supabase.from('payday_items').select('amount_cents').eq('payday_id', id),
  ]);
  if (!p) return null;
  const hasStub = p.gross_cents != null;
  const hasList = p.list_raw != null || (items || []).length > 0;
  const expected = (items || []).reduce((t, i) => t + (i.amount_cents || 0), 0);
  const status = hasStub && hasList ? (expected === p.gross_cents ? 'complete' : 'mismatch')
    : hasList ? 'list_only' : 'stub_only';
  await supabase.from('paydays').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
  return { ...p, status, expected_cents: expected };
}

// stub: { pay_date, period_start, period_end, gross_cents, stub_hours }
async function attachStub(stub, file) {
  if (!stub.pay_date) return { ok: false, reason: 'could not find a Pay Date on the stub' };
  const existing = await getPaydayByDate(stub.pay_date);
  if (existing?.gross_cents != null) {
    if (existing.gross_cents === stub.gross_cents) return { ok: true, skipped: true, pay_date: stub.pay_date, reason: 'this payday already has this stub' };
    return { ok: false, pay_date: stub.pay_date, reason: `this payday already has a stub with a different gross ($${(existing.gross_cents / 100).toFixed(2)})` };
  }
  const path = file ? await storeFile('stubs', file.filename, file.buffer, file.contentType) : null;
  const fields = {
    pay_date: stub.pay_date, period_start: stub.period_start, period_end: stub.period_end,
    gross_cents: stub.gross_cents, stub_hours: stub.stub_hours,
    stub_file: path, stub_filename: file?.filename || null,
  };
  let id = existing?.id;
  if (id) {
    const { error } = await supabase.from('paydays').update(fields).eq('id', id);
    if (error) throw new Error(error.message);
  } else {
    const { data, error } = await supabase.from('paydays').insert(fields).select('id').single();
    if (error) throw new Error(error.message);
    id = data.id;
  }
  const p = await recomputePayday(id);
  return { ok: true, pay_date: stub.pay_date, payday_id: id, status: p.status, gross_cents: stub.gross_cents };
}

// Which payday does a list belong to? Never the stub's printed period —
// only the payday itself. Priority:
//   1. a date inside the file: the stub's Pay Date (a stub that carries its
//      own list) or a "Check date" line                      → certain
//   2. the email subject's date, then the email's sent date: certain only
//      when a payday near that date is waiting for its list and its stub
//      gross equals this list's total (subjects are sometimes wrong)
//   3. otherwise → review, with the best guess pre-filled
// Returns { pay_date, how } when certain, or { pay_date: null, suggested, how }.
async function resolveListPayday({ check_date, subject_date, email_date, amount_cents }) {
  if (check_date) return { pay_date: check_date, how: 'date inside the file' };
  const anchors = [subject_date, email_date].filter(Boolean);
  if (!anchors.length) return { pay_date: null, suggested: null, how: 'no date found' };
  const paydays = await D.loadPaydays();
  for (const a of anchors) {
    const exact = paydays.find(p => {
      const d = daysBetween(a, p.pay_date);
      return d >= -10 && d <= 14 && p.list_raw == null && p.gross_cents != null && p.gross_cents === amount_cents;
    });
    if (exact) return { pay_date: exact.pay_date, how: `${a === subject_date ? 'subject' : 'email'} date + stub gross matches` };
  }
  // Best guess for the review screen.
  const a = anchors[0];
  const waiting = paydays.filter(p => p.list_raw == null && daysBetween(a, p.pay_date) >= -7 && daysBetween(a, p.pay_date) <= 10)
    .sort((x, y) => Math.abs(daysBetween(a, x.pay_date)) - Math.abs(daysBetween(a, y.pay_date)));
  if (waiting.length) return { pay_date: null, suggested: waiting[0].pay_date, how: 'nearest payday waiting for a list (totals differ — check)' };
  let t = a;
  while (dow(t) !== 4) t = addDays(t, 1);           // next Thursday on/after
  const anchor = paydays[0]?.pay_date;
  if (anchor && (Math.abs(daysBetween(anchor, t)) / 7) % 2 === 1) t = addDays(t, 7);
  return { pay_date: null, suggested: t, how: 'next biweekly Thursday after the email — check' };
}

const lineKey = i => `${norm(i.billing_name_raw)}|${i.session_date}`;

// How many of these lines are already on some payday (same text, same date).
async function alreadyImported(items) {
  const [existing, paydays] = await Promise.all([D.loadItems(), D.loadPaydays()]);
  const dateOf = new Map(paydays.map(p => [p.id, p.pay_date]));
  const have = new Map(existing.map(i => [lineKey(i), dateOf.get(i.payday_id)]));
  const keys = [...new Set(items.map(lineKey))];
  const hits = keys.filter(k => have.has(k));
  return { total: keys.length, already: hits.length, paydays: [...new Set(hits.map(k => have.get(k)))] };
}

// Save a list for a payday and auto-match it. A line already present on ANY
// payday (same text, same date) is skipped, so replies that quote the list
// again and lists re-sent in a later email never create duplicates. A second
// list for the same payday is merged in on the same rule.
// file: a fresh upload { filename, buffer, contentType }, or stored: a file
// already in the bucket { path, filename } (a list that waited for its date).
async function attachList({ pay_date, text, items, file, stored }) {
  if (!items.length) return { ok: false, reason: 'no "<group> <M/D/YYYY>" lines found' };
  const [rates, existingItems] = await Promise.all([D.loadRates(), D.loadItems()]);
  const paydayDates = new Map((await D.loadPaydays()).map(p => [p.id, p.pay_date]));
  const have = new Map(existingItems.map(i => [lineKey(i), paydayDates.get(i.payday_id)]));
  const seen = new Set();
  const fresh = [], already = [];
  for (const i of items) {
    const k = lineKey(i);
    if (seen.has(k)) continue;                       // repeated within this list
    seen.add(k);
    if (have.has(k)) already.push(have.get(k)); else fresh.push(i);
  }
  if (!fresh.length) {
    const where = [...new Set(already)].join(', ');
    return { ok: true, skipped: true, pay_date, reason: `all ${seen.size} lines are already imported${where ? ` (payday ${where})` : ''}` };
  }

  let p = await getPaydayByDate(pay_date);
  const path = file ? await storeFile('lists', file.filename, file.buffer, file.contentType) : (stored?.path || null);
  if (p) {
    const fields = p.list_raw == null
      ? { list_raw: text, list_file: path, list_filename: file?.filename || stored?.filename || null }
      : { list_raw: `${p.list_raw}\n\n--- merged from ${file?.filename || stored?.filename || 'another upload'} ---\n${text}` };
    const { error } = await supabase.from('paydays').update(fields).eq('id', p.id);
    if (error) throw new Error(error.message);
  } else {
    const { data, error } = await supabase.from('paydays')
      .insert({ pay_date, status: 'list_only', list_raw: text, list_file: path, list_filename: file?.filename || stored?.filename || null })
      .select('*').single();
    if (error) throw new Error(error.message);
    p = data;
  }
  const { data: maxRow } = await supabase.from('payday_items').select('line_no').eq('payday_id', p.id).order('line_no', { ascending: false }).limit(1);
  const base = maxRow?.[0]?.line_no || 0;
  const rows = fresh.map((i, n) => ({
    payday_id: p.id, line_no: base + n + 1, raw_line: i.raw_line, billing_name_raw: i.billing_name_raw,
    session_date: i.session_date, amount_cents: rateFor(i.session_date, rates), match_status: 'unmatched',
  }));
  const { data: inserted, error: insErr } = await supabase.from('payday_items').insert(rows).select('id, billing_name_raw, session_date');
  if (insErr) throw new Error(insErr.message);
  const m = await autoMatch(inserted);
  const pd = await recomputePayday(p.id);
  return { ok: true, pay_date, payday_id: p.id, status: pd.status, lines: rows.length, already_imported: already.length,
    auto_matched: m.linked, needs_review: rows.length - m.linked,
    list_cents: pd.expected_cents, gross_cents: pd.gross_cents };
}

// Candidate sessions for a set of item dates: non-test groups, not already
// linked to some other payday line.
async function candidatesFor(dates, exceptItemIds = []) {
  const [groups, aliases, sessions, linked] = await Promise.all([
    D.loadGroups(), D.loadAliases(), D.loadSessionsOnDates(dates),
    D.all(() => supabase.from('payday_items').select('id, session_id').not('session_id', 'is', null).order('id')),
  ]);
  const ctx = buildContext(groups, aliases);
  const except = new Set(exceptItemIds);
  const taken = new Map(linked.filter(l => !except.has(l.id)).map(l => [l.session_id, l.id]));
  const usable = sessions.filter(s => !ctx.groupById.get(s.group_id)?.is_test);
  return { ctx, usable, taken };
}

// Auto-link confident matches for the given items.
async function autoMatch(items) {
  if (!items.length) return { linked: 0 };
  const { ctx, usable, taken } = await candidatesFor(items.map(i => i.session_date), items.map(i => i.id));
  const free = usable.filter(s => !taken.has(s.id));
  const lines = items.map(i => ({ key: i.id, billing_name_raw: i.billing_name_raw, session_date: i.session_date }));
  const { result } = matchLines(lines, free, ctx);
  let linked = 0;
  const paidIds = [];
  for (const [itemId, r] of result) {
    if (!r.session_id) {
      await supabase.from('payday_items').update({ match_confidence: r.score || null }).eq('id', itemId);
      continue;
    }
    const { error } = await supabase.from('payday_items')
      .update({ session_id: r.session_id, match_status: 'auto', match_confidence: r.score }).eq('id', itemId);
    if (error) continue;          // unique index: session already linked elsewhere
    paidIds.push(r.session_id); linked++;
  }
  if (paidIds.length) await supabase.from('sessions').update({ paid: true }).in('id', paidIds);
  return { linked };
}

async function rematchPayday(paydayId) {
  const { data: items } = await supabase.from('payday_items').select('id, billing_name_raw, session_date')
    .eq('payday_id', paydayId).is('session_id', null);
  const r = await autoMatch(items || []);
  await recomputePayday(paydayId);
  return r;
}

// Manual pick from the review screen. Saves the line's name as an alias of
// the chosen group so the next list matches it automatically.
async function linkItem(itemId, sessionId) {
  const { data: item } = await supabase.from('payday_items').select('*').eq('id', itemId).single();
  if (!item) throw new Error('line not found');
  if (item.session_id) throw new Error('this line is already linked');
  const { data: s } = await supabase.from('sessions').select('id, group_id, session_date, scheduled_date').eq('id', sessionId).single();
  if (!s) throw new Error('session not found');
  if (sessionDate(s) !== item.session_date) throw new Error('that session is on a different date');
  const { error } = await supabase.from('payday_items')
    .update({ session_id: sessionId, match_status: 'confirmed', match_confidence: 1 }).eq('id', itemId);
  if (error) throw new Error(/payday_items_session_uniq|duplicate key/.test(error.message) ? 'that session is already paid on another payday line' : error.message);
  await supabase.from('sessions').update({ paid: true }).eq('id', sessionId);
  const alias = String(item.billing_name_raw || '').trim();
  if (alias) {
    await supabase.from('group_aliases')
      .upsert({ group_id: s.group_id, alias, alias_norm: norm(alias) }, { onConflict: 'group_id,alias_norm', ignoreDuplicates: true });
  }
  return { ok: true };
}

// Candidates for one unlinked line (review screen).
async function itemCandidates(item) {
  const { ctx, usable, taken } = await candidatesFor([item.session_date], [item.id]);
  const line = { billing_name_raw: item.billing_name_raw, session_date: item.session_date };
  return usable.map(s => {
    const g = ctx.groupById.get(s.group_id);
    return {
      session_id: s.id, score: scorePair(line, s, ctx).score,
      group: g?.internal_name || g?.group_name, billing_name: g?.billing_name || null,
      time: (s.ecw_time || s.start_time || s.scheduled_time || '').slice(0, 5),
      status: s.status, locked: s.locked, taken: taken.has(s.id),
    };
  }).sort((a, b) => b.score - a.score);
}

// ── Ledger ─────────────────────────────────────────────────────────────────
// Every session's payment status, derived (never stored):
//   paid         linked to a payday line, or the legacy paid flag
//   cancelled    Ritzoini says it didn't happen
//   duplicate    same real session as another group's session that counts
//   upcoming     in the future
//   owed         locked, unpaid, more than 7 days old
//   needs_action posted to Zoho but not locked
//   not_run      no Zoho post, not locked, more than 7 days old
//   pending      within the 7-day grace window
//   history      unresolved, but before 2026-04-01 (not counted)
async function buildLedger() {
  const [sessions, groups, items, paydays, rates] = await Promise.all([
    D.loadAllSessions(), D.loadGroups(), D.loadItems(), D.loadPaydays(), D.loadRates(),
  ]);
  const today = todayET();
  const groupById = new Map(groups.map(g => [g.id, g]));
  const paydayById = new Map(paydays.map(p => [p.id, p]));
  const itemBySession = new Map(items.filter(i => i.session_id).map(i => [i.session_id, i]));
  const dups = findDuplicates(sessions, groupById);

  const rows = [];
  for (const s of sessions) {
    const g = groupById.get(s.group_id);
    const date = sessionDate(s);
    if (!g || g.is_test || !date) continue;
    const item = itemBySession.get(s.id);
    const paid = !!item || s.paid === true;
    rows.push({
      id: s.id, date, group_id: g.id,
      group: g.internal_name || g.group_name, group_name: g.group_name, billing_name: g.billing_name || null,
      time: (s.ecw_time || s.start_time || s.scheduled_time || '').slice(0, 5) || null,
      session_status: s.status, locked: !!s.locked, locked_at: s.locked_at,
      zoho_posted: !!(s.zoho_posted || s.zoho_note_id), zoho_note_id: s.zoho_note_id,
      paid, paid_legacy_only: paid && !item,
      payday: item ? paydayById.get(item.payday_id)?.pay_date || null : null,
      amount_cents: rateFor(date, rates),
      days_waiting: daysBetween(date, today),
    });
  }

  // Duplicates: within each set of twins, one row counts — the paid one, else
  // the locked one, else the Zoho-posted one. The rest are 'duplicate'.
  const rowById = new Map(rows.map(r => [r.id, r]));
  const dupOf = new Map();
  const seen = new Set();
  for (const [id, others] of dups) {
    if (seen.has(id)) continue;
    const set = [id, ...others].map(x => rowById.get(x)).filter(Boolean);
    set.forEach(r => seen.add(r.id));
    if (set.length < 2) continue;
    const rank = r => (r.paid ? 4 : 0) + (r.locked ? 2 : 0) + (r.zoho_posted ? 1 : 0);
    const keep = set.slice().sort((a, b) => rank(b) - rank(a))[0];
    for (const r of set) if (r.id !== keep.id && !r.paid) dupOf.set(r.id, keep.id);
  }

  for (const r of rows) {
    const old = r.days_waiting > GRACE_DAYS;
    let st;
    if (r.paid) st = 'paid';
    else if (['cancelled', 'skipped', 'group_ended'].includes(r.session_status)) st = 'cancelled';
    else if (dupOf.has(r.id)) { st = 'duplicate'; r.duplicate_of = dupOf.get(r.id); }
    else if (r.date > today) st = 'upcoming';
    else if (r.locked) st = old ? 'owed' : 'pending';
    else if (r.zoho_posted) st = 'needs_action';
    else st = old ? 'not_run' : 'pending';
    if (['owed', 'needs_action', 'not_run'].includes(st) && r.date < OWED_FROM) st = 'history';
    r.status = st;
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || String(a.time).localeCompare(String(b.time)));
  return { rows, paydays, rates, today };
}

function nextPayday(paydays, today) {
  if (!paydays.length) return null;
  let p = paydays[0].pay_date;                    // newest known payday
  while (p < today) p = addDays(p, 14);
  return p;
}

async function summary() {
  const { rows, paydays, rates, today } = await buildLedger();
  const owed = rows.filter(r => r.status === 'owed').sort((a, b) => a.date.localeCompare(b.date));
  const sum = list => list.reduce((t, r) => t + (r.amount_cents || 0), 0);
  const year = today.slice(0, 4);

  const items = await D.loadItems();
  const listCents = new Map();
  for (const i of items) listCents.set(i.payday_id, (listCents.get(i.payday_id) || 0) + (i.amount_cents || 0));
  const itemCount = new Map();
  for (const i of items) itemCount.set(i.payday_id, (itemCount.get(i.payday_id) || 0) + 1);
  const unmatchedByPayday = new Map();
  for (const i of items) if (!i.session_id) unmatchedByPayday.set(i.payday_id, (unmatchedByPayday.get(i.payday_id) || 0) + 1);

  const paidThisYear = paydays.filter(p => p.pay_date.startsWith(year))
    .reduce((t, p) => t + (p.gross_cents ?? listCents.get(p.id) ?? 0), 0);

  // Next payday: everything locked by the Tuesday payroll run gets paid.
  const next = nextPayday(paydays, today);
  const cutoff = next ? addDays(next, -2) : null;
  const expectedRows = next ? rows.filter(r => ['owed', 'pending'].includes(r.status) && r.locked
    && (!r.locked_at || r.locked_at.slice(0, 10) <= cutoff)) : [];

  const paydayCards = paydays.map(p => ({
    id: p.id, pay_date: p.pay_date, period_start: p.period_start, period_end: p.period_end,
    status: p.status, gross_cents: p.gross_cents, list_cents: listCents.get(p.id) ?? null,
    sessions: itemCount.get(p.id) || 0, unmatched: unmatchedByPayday.get(p.id) || 0,
    has_stub: p.gross_cents != null, has_list: p.list_raw != null, stub_file: !!p.stub_file, list_file: !!p.list_file, notes: p.notes,
  }));

  const count = st => rows.filter(r => r.status === st).length;
  return {
    today,
    cards: {
      owed_cents: sum(owed), owed_count: owed.length, owed_oldest: owed[0]?.date || null,
      paid_this_year_cents: paidThisYear, year,
      next_payday: next, next_cutoff: cutoff, next_expected_cents: sum(expectedRows), next_expected_count: expectedRows.length,
      current_rate_cents: rateFor(today, rates),
    },
    attention: {
      mismatches: paydayCards.filter(p => p.status === 'mismatch'),
      waiting_for_list: paydayCards.filter(p => p.status === 'stub_only'),
      waiting_for_stub: paydayCards.filter(p => p.status === 'list_only'),
      unmatched_lines: paydayCards.filter(p => p.unmatched > 0).map(p => ({ id: p.id, pay_date: p.pay_date, unmatched: p.unmatched })),
      needs_action: count('needs_action'),
      not_run: count('not_run'),
      duplicates: count('duplicate'),
    },
    owed,
    paydays: paydayCards,
  };
}

async function markCancelled(sessionId) {
  const { data: s } = await supabase.from('sessions').select('id, locked, paid, zoho_note_id').eq('id', sessionId).single();
  if (!s) throw new Error('session not found');
  if (s.locked || s.paid) throw new Error('a locked or paid session can’t be marked cancelled here');
  const { error } = await supabase.from('sessions').update({ status: 'cancelled', status_manual_override: true }).eq('id', sessionId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

module.exports = {
  storeFile, signedUrl, attachStub, attachList, resolveListPayday, recomputePayday, rematchPayday,
  linkItem, itemCandidates, alreadyImported, buildLedger, summary, markCancelled, getPaydayByDate, OWED_FROM,
};

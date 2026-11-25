// Payments 2.0 — matching session-list lines to Ritzoini sessions.
//
// A line is only ever matched to a session on the SAME date. Each candidate
// gets a score from three signals:
//   name     — the line text equals the group's billing_name or a learned
//              alias (or contains the billing name)          weight 0.5
//   time     — a time in the line (incl. "group time X") equals the session's
//              ecw_time / start_time / scheduled_time         weight 0.3
//   activity — activity words in the line (sensory, painting…) also appear
//              in the group's internal name / Zoho activity   weight 0.2
// A time or activity that contradicts the session counts against it.
// Lines and sessions are then paired greedily per date (best score first, one
// session per line). A pairing auto-links only when it scores well AND clearly
// beats the next-best session for that line; everything else is left for the
// review screen.

const { lineTimes } = require('./parse');
const { norm, sessionDate } = require('./data');

const AUTO_MIN_SCORE  = 0.45;
const AUTO_MIN_MARGIN = 0.15;

// line regex → group regex. Group side looks only at internal_name + Zoho
// activity (the billing-name era uses words like "Sensitivity" that would
// false-match "sen").
const ACTIVITIES = [
  ['sensory',     /sensory/,          /sensory|(^|[^a-z])sen/],
  ['aqua',        /aqua/,             /aqua/],
  ['gymnastics',  /gymnast/,          /gymnast/],
  ['art',         /(^|[^a-z])art(s)?([^a-z]|$)/, /(^|[^a-z])art/],
  ['baking',      /bak(e|ing)/,       /bak/],
  ['hairstyling', /hair/,             /hair/],
  ['braingym',    /brain/,            /brain/],
  ['painting',    /paint/,            /paint/],
  ['sofres',      /sofres/,           /sofres/],
  ['exercise',    /exercis/,          /exercis/],
  ['aerobics',    /aerobic/,          /aerobic/],
  ['phone',       /phone/,            /phone/],
  ['mertzbach',   /mertz/,            /mertz/],
  ['clay',        /clay/,             /clay/],
  ['crafts',      /craft/,            /craft/],
  ['tropen',      /tropen/,           /tropen/],
];

function lineActivities(text) {
  const t = String(text || '').toLowerCase();
  return new Set(ACTIVITIES.filter(([, re]) => re.test(t)).map(([k]) => k));
}
function groupActivities(g) {
  const t = `${g.internal_name || ''} ${g.activity || ''}`.toLowerCase();
  return new Set(ACTIVITIES.filter(([, , re]) => re.test(t)).map(([k]) => k));
}

const toMin = t => { if (!t) return null; const [h, m] = String(t).split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; };
function sessionMinutes(s, g) {
  return [...new Set([s.ecw_time, s.start_time, s.scheduled_time, g?.ecw_time].map(toMin).filter(v => v != null))];
}

// The line's name with times and "(group time …)" removed.
function nameOnly(text) {
  return norm(String(text || '')
    .replace(/\(?\s*group\s*time[^)]*\)?/gi, ' ')
    .replace(/\d{1,2}:\d{2}\s*([ap]\.?m\.?)?/gi, ' '));
}

// Prepared once per batch: aliases by group, groups by id.
function buildContext(groups, aliases) {
  const groupById = new Map(groups.map(g => [g.id, g]));
  const aliasesByGroup = new Map();
  for (const a of aliases) {
    if (!aliasesByGroup.has(a.group_id)) aliasesByGroup.set(a.group_id, new Set());
    aliasesByGroup.get(a.group_id).add(a.alias_norm);
  }
  for (const g of groups) g._acts = groupActivities(g);
  return { groupById, aliasesByGroup };
}

function scorePair(line, session, ctx) {
  const g = ctx.groupById.get(session.group_id);
  if (!g) return { score: -1 };
  const raw = line.billing_name_raw || '';
  const full = norm(raw), bare = nameOnly(raw);

  // name
  let name = 0;
  const aliases = ctx.aliasesByGroup.get(g.id);
  const bn = norm(g.billing_name);
  if (aliases && (aliases.has(full) || aliases.has(bare))) name = 1;
  else if (bn && (full === bn || bare === bn)) name = 1;
  else if (bn && bn.length >= 8 && full.includes(bn)) name = 0.85;
  else if (bare && [g.internal_name, g.group_name].some(n => norm(n) === bare)) name = 0.9;

  // time
  const lt = line._times || (line._times = lineTimes(raw));
  const st = sessionMinutes(session, g);
  let time = 0;
  if (lt.length && st.length) {
    const diff = Math.min(...lt.flatMap(a => st.map(b => Math.abs(a - b))));
    time = diff === 0 ? 1 : diff <= 5 ? 0.7 : diff <= 15 ? 0.3 : -0.5;
  }

  // activity
  const la = line._acts || (line._acts = lineActivities(raw));
  let act = 0;
  if (la.size) {
    const hit = [...la].filter(k => g._acts.has(k)).length;
    act = hit ? hit / la.size : (g._acts.size ? -0.3 : 0);
  }

  let score = 0.5 * name + 0.3 * time + 0.2 * act;
  if (['cancelled', 'skipped', 'group_ended'].includes(session.status)) score -= 0.1;
  return { score: Math.round(score * 1000) / 1000, name, time, act };
}

// Same real session entered under two Ritzoini groups: same date, same time,
// and the same instructor (or identical group name).
function duplicateKey(s, g) {
  const t = sessionMinutes(s, g)[0];
  const who = g?.instructor_id || norm(g?.group_name);
  return t == null || !who ? null : `${sessionDate(s)}|${t}|${who}`;
}
function findDuplicates(sessions, groupById) {
  const byKey = new Map();
  for (const s of sessions) {
    const g = groupById.get(s.group_id);
    if (!g || g.is_test || ['cancelled', 'skipped', 'group_ended'].includes(s.status)) continue;
    const k = duplicateKey(s, g);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(s);
  }
  const partners = new Map();   // session id → [other session ids]
  for (const list of byKey.values()) {
    if (new Set(list.map(s => s.group_id)).size < 2) continue;
    for (const s of list) partners.set(s.id, list.filter(o => o.id !== s.id).map(o => o.id));
  }
  return partners;
}

// lines: [{ key, billing_name_raw, session_date }]
// sessions: candidates on those dates (test groups and sessions already paid
//           on another payday line already removed by the caller)
// → Map(key → { session_id, score, status, candidates })
function matchLines(lines, sessions, ctx) {
  const dups = findDuplicates(sessions, ctx.groupById);
  const byDate = new Map();
  for (const s of sessions) {
    const d = sessionDate(s);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(s);
  }
  const result = new Map();
  const linesByDate = new Map();
  for (const l of lines) {
    if (!linesByDate.has(l.session_date)) linesByDate.set(l.session_date, []);
    linesByDate.get(l.session_date).push(l);
  }

  for (const [date, dayLines] of linesByDate) {
    const cands = byDate.get(date) || [];
    const pairs = [];
    const perLine = new Map();
    for (const l of dayLines) {
      const scored = cands.map(s => ({ session_id: s.id, ...scorePair(l, s, ctx) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score);
      perLine.set(l.key, scored);
      for (const x of scored) pairs.push({ line: l, ...x });
    }
    // Ties (typically the same real session entered under two groups) go to
    // the copy that's locked / posted to Zoho — that's the one that got billed.
    const rank = new Map(cands.map(s => [s.id, (s.locked ? 2 : 0) + (s.zoho_note_id || s.zoho_posted ? 1 : 0)]));
    pairs.sort((a, b) => b.score - a.score || rank.get(b.session_id) - rank.get(a.session_id));
    const usedLines = new Set(), usedSessions = new Set();
    for (const p of pairs) {
      if (usedLines.has(p.line.key) || usedSessions.has(p.session_id)) continue;
      usedLines.add(p.line.key); usedSessions.add(p.session_id);
      // Margin over the next-best session for this line, ignoring sessions
      // that are duplicates of the chosen one (same real session).
      const twins = new Set(dups.get(p.session_id) || []);
      const runnerUp = perLine.get(p.line.key).find(x => x.session_id !== p.session_id && !twins.has(x.session_id));
      const margin = p.score - (runnerUp ? runnerUp.score : 0);
      const auto = p.score >= AUTO_MIN_SCORE && margin >= AUTO_MIN_MARGIN;
      result.set(p.line.key, {
        session_id: auto ? p.session_id : null,
        suggested_session_id: p.session_id,
        score: p.score,
        status: auto ? 'auto' : 'unmatched',
      });
    }
    for (const l of dayLines) {
      if (!result.has(l.key)) result.set(l.key, { session_id: null, suggested_session_id: null, score: 0, status: 'unmatched' });
      result.get(l.key).candidates = perLine.get(l.key).slice(0, 6);
    }
  }
  return { result, dups };
}

module.exports = { matchLines, scorePair, buildContext, findDuplicates, lineActivities, nameOnly, AUTO_MIN_SCORE, AUTO_MIN_MARGIN };

// Peer Supervision — learning from the Reviewer's calls on AI findings.
//
// Every note the Reviewer signs or reopens records a call on each issue the AI
// raised: "real" or "fine" (ai_flags.human_review). An issue the Reviewer did not
// mark follows the button they pressed — Reopen makes it real, Sign makes it fine
// — and issues the AI missed are recorded as "added".
//
// Before each review batch, if there are calls the instructions haven't been
// updated from, one AI call reads the recorded calls, finds the patterns, and
// makes targeted edits to the two Settings prompts themselves (main review and
// off-site). There is no separate rules layer. Lessons are never refused for
// length. When the instructions have grown ~15% since the last tidy-up, a
// tidy-up pass rewrites them tighter, and it is kept only if, re-run on notes the
// supervisor already decided, it agrees with those decisions at least as often.
//
// Storage is app_settings, so nothing needs a migration:
//   ps_prompt_core_review / ps_prompt_offsite — the instructions (as before)
//   ps_prompt_history   — the instructions before each change, newest first
//   ps_learning_state   — which calls have been learned from, tidy-up baseline

const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../db/supabase');

const HISTORY_KEY = 'ps_prompt_history';
const STATE_KEY   = 'ps_learning_state';
const HISTORY_MAX = 25;
const LEARN_MODEL = 'claude-opus-5-5';
const MAX_ITEMS   = 300;      // calls sent to the learner per step
const EXCERPT_MAX = 1200;     // note text kept per call, for context
const TIDY_GROWTH = 1.15;     // tidy up once the instructions grow this much
const TIDY_SAMPLE = 20;       // decided notes the tidy-up is tested on
const TIDY_MIN_SAMPLE = 10;   // fewer than this and the tidy-up waits

// ── Recording ─────────────────────────────────────────────────────────────────

// The note text an issue's section refers to, from the stored note — kept with
// the call so the learner sees what the Reviewer was looking at.
function sectionExcerpt(noteData, section) {
  if (!noteData || !section) return '';
  // Lazy require: the engine module is large and pulls in the InSync client.
  const { buildReviewPayload } = require('./peerSupervisorEngine');
  let p;
  try { p = buildReviewPayload(noteData, []); } catch { return ''; }
  const v = p.note_sections?.[section] ?? p[section];
  const text = Array.isArray(v) ? v.join('; ')
    : v && typeof v === 'object' ? JSON.stringify(v) : String(v || '');
  return text.slice(0, EXCERPT_MAX);
}

// Build the stored record for one note. `final` is 'signed' | 'reopened'.
// `input` is what the browser sent: { calls: [{ n, verdict, why }], added: [{ section, text }] }
// — n is the issue's index in review.issues. The AI's own text always comes from
// the stored review, never from the browser.
function buildHumanReview(row, final, input, user) {
  const review = row.ai_flags?.review;
  const issues = Array.isArray(review?.issues) ? review.issues : [];
  const byN = new Map((input?.calls || []).map(c => [Number(c.n), c]));
  const implicit = final === 'reopened' ? 'real' : 'fine';
  const nd = row.note_data || {};

  const calls = issues.map((iss, n) => {
    const c = byN.get(n);
    const explicit = c && (c.verdict === 'real' || c.verdict === 'fine');
    return {
      n,
      source:   iss.source || null,
      section:  iss.section || null,
      code:     iss.code || null,
      severity: iss.severity || null,
      ai_explanation: iss.explanation || '',
      evidence: iss.evidence_from_note || '',
      excerpt:  sectionExcerpt(nd, iss.section),
      verdict:  explicit ? c.verdict : implicit,
      explicit: !!explicit,
      why:      explicit ? String(c.why || '').slice(0, 1000) : '',
    };
  });

  const added = (input?.added || [])
    .filter(a => a && String(a.text || '').trim())
    .map(a => ({
      section: a.section || 'other',
      text:    String(a.text).slice(0, 1000),
      excerpt: sectionExcerpt(nd, a.section),
    }));

  return {
    final,
    at: new Date().toISOString(),
    by: user?.email || user?.id || null,
    ai_decision: review?.decision || null,
    review_fingerprint: review?.fingerprint || null,
    calls,
    added,
  };
}

// Record the Reviewer's calls on the live (pending) rows for these eids, before
// their status changes. Notes with no AI issues and nothing added still get a
// record, so the learner sees the notes the AI passed and the Reviewer agreed.
async function recordHumanReviews(eids, final, inputByEid = {}, user = null) {
  if (!eids.length) return;
  for (let i = 0; i < eids.length; i += 100) {
    const { data } = await supabase.from('ps_notes')
      .select('id, eid, ai_flags, note_data')
      .in('eid', eids.slice(i, i + 100)).eq('status', 'pending');
    for (const row of (data || [])) {
      const hr = buildHumanReview(row, final, inputByEid[row.eid], user);
      await supabase.from('ps_notes')
        .update({ ai_flags: { ...(row.ai_flags || {}), human_review: hr } })
        .eq('id', row.id);
    }
  }
}

// ── Prompt storage ────────────────────────────────────────────────────────────
//
// The learning step edits the two Settings prompts themselves — the main review
// instructions and the off-site instructions. There is no separate rules layer:
// what Settings shows is exactly what the reviewer runs on. The fixed output
// format (REVIEW_OUTPUT_CONTRACT in the engine) is never edited.

const PROMPT_KEYS = { core: 'ps_prompt_core_review', offsite: 'ps_prompt_offsite' };

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

async function getSetting(key, fallback) {
  const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
  return parseJson(data?.value, fallback);
}
async function putSetting(key, value) {
  await supabase.from('app_settings').upsert({ key, value: JSON.stringify(value) }, { onConflict: 'key' });
}

const loadState = () => getSetting(STATE_KEY, {});
const saveState = s => putSetting(STATE_KEY, s);

// Save the prompts as they are BEFORE a change, so any change can be undone by
// restoring the entry's `core` / `offsite`. Newest first, capped.
async function snapshotPrompts({ core, offsite }, kind, summary = '') {
  const history = await getSetting(HISTORY_KEY, []);
  history.unshift({ at: new Date().toISOString(), kind, summary, core, offsite });
  await putSetting(HISTORY_KEY, history.slice(0, HISTORY_MAX));
}

async function writePrompts(before, after, kind, summary) {
  await snapshotPrompts(before, `before ${kind}`, summary);
  for (const which of ['core', 'offsite'])
    if (after[which] !== before[which])
      await supabase.from('app_settings')
        .upsert({ key: PROMPT_KEYS[which], value: after[which] }, { onConflict: 'key' });
}

// ── Edits ─────────────────────────────────────────────────────────────────────

const escRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Where `needle` occurs in `hay`, exactly once. Exact match first, then one
// that ignores differences in whitespace. null when absent or ambiguous.
function locateOnce(hay, needle) {
  if (!needle || !needle.trim()) return null;
  const first = hay.indexOf(needle);
  if (first !== -1 && hay.indexOf(needle, first + 1) === -1) return [first, first + needle.length];
  const re = new RegExp(needle.trim().split(/\s+/).map(escRe).join('\\s+'), 'g');
  const hits = [...hay.matchAll(re)];
  return hits.length === 1 ? [hits[0].index, hits[0].index + hits[0][0].length] : null;
}

// Apply targeted edits: { prompt: 'core'|'offsite', op: 'replace'|'insert_after'|'delete',
// find, replace, after, insert }. Everything an edit doesn't touch stays word for word.
function applyEdits(texts, edits) {
  const out = { ...texts }, applied = [], failed = [];
  for (const e of edits || []) {
    const which = e?.prompt === 'offsite' ? 'offsite' : e?.prompt === 'core' ? 'core' : null;
    if (!which) { failed.push({ edit: e, reason: 'prompt must be "core" or "offsite"' }); continue; }
    const anchorText = e.op === 'insert_after' ? e.after : e.find;
    const at = locateOnce(out[which], anchorText);
    if (!at) {
      failed.push({ edit: e, reason: out[which].includes(anchorText || '\u0000')
        ? 'anchor text appears more than once — quote more of it' : 'anchor text not found — copy it exactly' });
      continue;
    }
    const [s, t] = at, cur = out[which];
    if (e.op === 'insert_after') out[which] = cur.slice(0, t) + (e.insert || '') + cur.slice(t);
    else if (e.op === 'delete') out[which] = cur.slice(0, s) + cur.slice(t);
    else out[which] = cur.slice(0, s) + (e.replace ?? '') + cur.slice(t);
    applied.push(e);
  }
  return { texts: out, applied, failed };
}

// ── Learning ─────────────────────────────────────────────────────────────────

// Every recorded call, newest first, flattened into learner items. `since`
// marks the calls the instructions have not been updated from yet.
async function collectFeedback(since = null) {
  const items = [];
  let latest = null;
  const PAGE = 500;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('ps_notes')
      .select('peer_name, hr:ai_flags->human_review')
      .not('ai_flags->human_review', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of (data || [])) {
      const hr = r.hr;
      if (!hr) continue;
      if (!latest || hr.at > latest) latest = hr.at;
      const isNew = !since || hr.at > since;
      for (const c of (hr.calls || [])) items.push({
        at: hr.at, new: isNew, kind: c.verdict === 'real' ? 'confirmed' : 'overruled', explicit: c.explicit,
        area: c.source, section: c.section, severity: c.severity,
        ai_finding: c.ai_explanation, evidence: c.evidence, note_text: c.excerpt,
        reviewer_why: c.why || undefined, final: hr.final,
      });
      for (const a of (hr.added || [])) items.push({
        at: hr.at, new: isNew, kind: 'missed_by_ai', explicit: true, section: a.section,
        reviewer_issue: a.text, note_text: a.excerpt, final: hr.final,
      });
    }
    if (!data || data.length < PAGE) break;
  }
  items.sort((a, b) => (a.at < b.at ? 1 : -1));
  // New calls first, then explicit ones, then implicit ones (which only
  // followed the final button), up to the cap.
  const rank = i => (i.new ? 0 : 2) + (i.explicit ? 0 : 1);
  const chosen = [...items].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_ITEMS);
  return { items: chosen, total: items.length, fresh: items.filter(i => i.new).length, latest };
}

const LEARN_SYSTEM = `You maintain the instructions an AI reviewer follows when it checks Peer Support progress notes at a mental health center before a supervisor co-signs them. There are two instruction documents: "core" (the main review instructions) and "offsite" (service type, location and off-site rules). You improve them from the supervisor's recorded calls on the reviewer's findings.

Each call is one data point:
- "confirmed": the reviewer flagged it and the supervisor agreed it is a real issue.
- "overruled": the reviewer flagged it and the supervisor said it is not an issue.
- "missed_by_ai": the supervisor flagged something the reviewer did not.
"explicit": false means the supervisor did not mark that issue individually; it followed their final action (reopening the note counts its issues as real, signing counts them as fine). Weigh explicit calls more heavily. "reviewer_why", when present, is the supervisor's own reason. "new": true marks calls made since the instructions were last updated; the instructions should already reflect the older ones.

Look across the calls for the supervisor's actual standard: what they consistently overrule, what they consistently confirm, and what they catch that the reviewer misses. Then edit the instructions so the reviewer would rule the way the supervisor does. Write general rules, never descriptions of single cases, and never put client or peer names, dates or other identifying details into the instructions.

How to edit:
- Put each lesson where it belongs. Prefer changing the existing sentence that caused the wrong ruling over adding new text. Keep each rule in one place; don't restate it elsewhere.
- When a lesson makes existing text redundant or wrong, replace or delete that text.
- One or two calls is thin evidence: change the wording only as far as those calls clearly show.
- Leave alone anything the calls don't bear on, and anything that already produces the supervisor's rulings. Don't edit for style.
- If no change is warranted, return no edits.

Each edit quotes text from the current document. The quoted text must be copied exactly and must appear only once in that document; quote enough of it to be unique.

Respond with ONE JSON object and nothing else:
{"edits":[{"prompt":"core | offsite","op":"replace | insert_after | delete","find":"exact text to replace or delete","replace":"new text","after":"exact text to insert after","insert":"text to insert (start it with a newline or space as needed)","reason":"which pattern in the calls this edit follows"}],"summary":"one sentence on what changed"}
Use "find" + "replace" for replace, "find" for delete, "after" + "insert" for insert_after.`;

const TIDY_SYSTEM = `You maintain the instructions an AI reviewer follows when it checks Peer Support progress notes before a supervisor co-signs them. There are two documents, "core" and "offsite". They have grown as lessons were added. Rewrite both to be tighter without changing what they require.

- Keep every rule, threshold, date, code, defined term and section heading that something else may refer to. The meaning of every rule must survive exactly.
- Merge rules that say the same thing, cut repetition between the two documents (keep each rule in the document where it belongs), and remove wordiness.
- Keep the same overall structure and order so the documents stay easy to compare with the previous version.
- Do not add new rules or loosen or tighten existing ones.

Respond with ONE JSON object and nothing else: {"core":"full rewritten core document","offsite":"full rewritten offsite document","summary":"one sentence on what was tightened"}`;

function parseModelJson(msg) {
  if (msg.stop_reason === 'refusal') throw new Error('the model declined the request');
  if (msg.stop_reason === 'max_tokens') throw new Error('the response was cut off');
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(text);
}

async function callModel(apiKey, system, content, maxTokens) {
  const anthropic = new Anthropic({ apiKey });
  // Streamed: these requests carry the full instructions and can run long.
  const msg = await anthropic.beta.messages.stream({
    model: LEARN_MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system,
    messages: [{ role: 'user', content }],
  }).finalMessage();
  return parseModelJson(msg);
}

// One learning step: edit the instructions from the calls. Lessons are never
// dropped for length; an edit whose quoted text can't be found gets one retry
// with the reason, against the instructions as already edited.
async function learnEdits(engine, fb) {
  let texts = { core: engine.coreReviewPrompt, offsite: engine.offsitePrompt };
  const content = JSON.stringify({
    core: texts.core, offsite: texts.offsite,
    calls: fb.items.map(({ at, ...rest }) => rest),
  });
  const first = await callModel(engine.anthropicKey, LEARN_SYSTEM, content, 32000);
  let r = applyEdits(texts, first.edits);
  texts = r.texts;
  const applied = [...r.applied];
  let failed = r.failed;
  if (failed.length) {
    const retry = await callModel(engine.anthropicKey, LEARN_SYSTEM, JSON.stringify({
      core: texts.core, offsite: texts.offsite,
      note: 'Your other edits were applied. These could not be placed, for the reason given. '
        + 'Return corrected versions of only these edits, quoting the current text exactly.',
      failed_edits: failed,
    }), 16000);
    r = applyEdits(texts, retry.edits);
    texts = r.texts;
    applied.push(...r.applied);
    failed = r.failed;
  }
  return { texts, applied, failed, summary: String(first.summary || '') };
}

// Did the reviewer's decision match what the supervisor did with the note?
// Reopened → the reviewer should not have passed it; signed → it should have.
function agrees(review, final) {
  if (!review || !review.decision || review.decision === 'AI_REVIEW_ERROR') return false;
  return final === 'reopened' ? review.decision !== 'PASS' : review.decision === 'PASS';
}

// Notes the supervisor has already decided, newest first, preferring ones where
// they marked issues themselves. The test set for a tidy-up.
async function decidedSample(n) {
  const { data } = await supabase.from('ps_notes')
    .select('eid, note_data, ai_flags, actioned_at')
    .in('status', ['signed', 'reopened', 'superseded'])
    .not('ai_flags->human_review', 'is', null)
    .order('actioned_at', { ascending: false }).limit(n * 4);
  const rows = (data || []).filter(r => r.note_data?.fullNoteText);
  const marked = r => (r.ai_flags.human_review.calls || []).some(c => c.explicit) || (r.ai_flags.human_review.added || []).length;
  return [...rows.filter(marked), ...rows.filter(r => !marked(r))].slice(0, n);
}

// Score one version of the instructions against the supervisor's decisions.
async function scorePrompts(texts, sample, apiKey, report, label) {
  const { InsyncCoSignEngine } = require('./peerSupervisorEngine');
  const engine = new InsyncCoSignEngine({ anthropicKey: apiKey, coreReviewPrompt: texts.core, offsitePrompt: texts.offsite });
  let ok = 0, done = 0;
  const run = async row => {
    const note = { ...row.note_data, eid: row.eid };
    note.visitDateObj = engine._parseDate(note.visitDatetime);
    const review = await engine.aiReview(note, row.ai_flags.machine || []).catch(() => null);
    if (agrees(review, row.ai_flags.human_review.final)) ok++;
    done++;
    report(`Testing the tidied instructions (${label}): ${done} of ${sample.length}...`);
  };
  if (sample.length) await run(sample[0]);       // writes the prompt cache
  for (let i = 1; i < sample.length; i += 5) await Promise.all(sample.slice(i, i + 5).map(run));
  return ok;
}

// The tidy-up: when the instructions have grown, rewrite them tighter, test
// both versions on notes the supervisor already decided, and keep the tighter
// one only if it agrees with the supervisor at least as often. A failed or
// rejected tidy-up just leaves the instructions as they were.
async function maybeTidy(engine, state, report) {
  const texts = { core: engine.coreReviewPrompt, offsite: engine.offsitePrompt };
  const size = texts.core.length + texts.offsite.length;
  const baseline = state.tidy_baseline_chars || size;
  const threshold = Math.max(baseline * TIDY_GROWTH, state.tidy_retry_after_chars || 0);
  if (size <= threshold) return { tidied: false };

  const sample = await decidedSample(TIDY_SAMPLE);
  if (sample.length < TIDY_MIN_SAMPLE) return { tidied: false, waiting: 'not enough decided notes to test a tidy-up yet' };

  report('Tidying up the instructions...');
  const t = await callModel(engine.anthropicKey, TIDY_SYSTEM, JSON.stringify(texts), 64000);
  if (typeof t.core !== 'string' || typeof t.offsite !== 'string' || !t.core.trim() || !t.offsite.trim())
    throw new Error('tidy-up returned no documents');
  const tidy = { core: t.core.trim(), offsite: t.offsite.trim() };

  const oldScore = await scorePrompts(texts, sample, engine.anthropicKey, report, 'current');
  const newScore = await scorePrompts(tidy, sample, engine.anthropicKey, report, 'tidied');
  const result = { at: new Date().toISOString(), oldScore, newScore, sample: sample.length,
                   before_chars: size, after_chars: tidy.core.length + tidy.offsite.length };
  if (newScore >= oldScore) {
    await writePrompts(texts, tidy, 'tidy-up', `${t.summary || 'Tightened wording'} (matched ${newScore}/${sample.length} vs ${oldScore})`);
    return { tidied: true, result: { ...result, kept: true }, newBaseline: result.after_chars };
  }
  // Rejected: don't try again until the instructions have grown some more.
  return { tidied: false, result: { ...result, kept: false }, retryAfter: Math.round(size * 1.1) };
}

// Runs before each review batch. Edits the instructions when there are calls
// they haven't been updated from, then tidies them if they've grown. Never
// throws: a failure leaves the instructions as they were and the batch runs.
async function maybeLearn(engine, { report = () => {} } = {}) {
  const out = { learned: false, tidied: false };
  if (!engine.anthropicKey) return { ...out, error: 'No Anthropic API key' };
  const state = await loadState();
  try {
    const fb = await collectFeedback(state.through || null);
    if (fb.fresh) {
      report(`Learning from your ${fb.fresh} new call${fb.fresh === 1 ? '' : 's'}...`);
      const before = { core: engine.coreReviewPrompt, offsite: engine.offsitePrompt };
      if (!state.tidy_baseline_chars) state.tidy_baseline_chars = before.core.length + before.offsite.length;
      const r = await learnEdits(engine, fb);
      if (r.applied.length) {
        await writePrompts(before, r.texts, 'learning', r.summary);
        engine.coreReviewPrompt = r.texts.core;
        engine.offsitePrompt = r.texts.offsite;
        out.learned = true;
      }
      state.through = fb.latest;
      state.last_learn = { at: new Date().toISOString(), summary: r.summary, applied: r.applied.length,
                           failed: r.failed.map(f => ({ reason: f.reason, edit: f.edit })) };
      if (r.failed.length) console.warn(`[PS learn] ${r.failed.length} edit(s) could not be placed`);
      console.log(`[PS learn] ${r.applied.length} edit(s) from ${fb.fresh} new calls: ${r.summary}`);
      await saveState(state);
    }
  } catch (err) {
    console.error('[PS learn] failed:', err.message);
    out.error = err.message;
    return out;
  }
  try {
    const t = await maybeTidy(engine, state, report);
    if (t.result) state.last_tidy = t.result;
    if (t.tidied) { state.tidy_baseline_chars = t.newBaseline; delete state.tidy_retry_after_chars; out.tidied = true; }
    if (t.retryAfter) state.tidy_retry_after_chars = t.retryAfter;
    if (t.result) await saveState(state);
  } catch (err) {
    console.error('[PS tidy] failed:', err.message);
    out.tidyError = err.message;
    // Don't retry on every batch; wait until the instructions grow some more.
    const size = engine.coreReviewPrompt.length + engine.offsitePrompt.length;
    state.tidy_retry_after_chars = Math.round(size * 1.1);
    state.last_tidy = { at: new Date().toISOString(), error: err.message };
    await saveState(state).catch(() => {});
  }
  return out;
}

module.exports = {
  recordHumanReviews, buildHumanReview, collectFeedback, maybeLearn, applyEdits, locateOnce,
  snapshotPrompts, loadState, getSetting, HISTORY_KEY, STATE_KEY,
};

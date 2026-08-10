// Peer Supervision — incremental co-sign ingest.
//
// Pulls the InSync co-sign queue and lands each note as a durable, versioned row
// in ps_notes (see db/ps_notes.sql). Notes are downloaded ONCE: a note already
// stored is skipped unless it's a genuine revision. This is the orchestration
// layer — the InSync/AI work lives on the engine (utils/peerSupervisorEngine),
// the persistence lives here — mirroring how caseloadSync composes Airtable +
// Supabase.
//
// Judging scope (per product spec):
//   • A note is judged only when it's new or revised — never re-litigated.
//   • The clone comparison pool is ONLY status='pending' notes — the live queue
//     you can actually act on. Signed / reopened / superseded notes are out.
//   • The pending pool grows progressively within a batch, so two duplicates
//     arriving in the same pull still catch each other.
//   • Option (b): when a new note is judged a copy of a still-pending note, that
//     partner is ALSO flagged, so neither half can be bulk-signed by accident.

const crypto = require('crypto');
const supabase = require('../db/supabase');

// Hash of the note's full parsed text — the fingerprint used to tell "already
// have this" from "this came back revised".
function contentHash(note) {
  const basis = note.fullNoteText || note.noteText || '';
  return crypto.createHash('sha256').update(basis).digest('hex');
}

// Pure dedup decision, given the latest stored version for an eid (or null) and
// the incoming note's content hash. Exported for unit testing.
//   'new'       — never seen this eid → insert v1
//   'revised'   — reopened-and-resigned, or content changed → insert v+1, supersede
//   'reconcile' — we marked it signed, but it's back in InSync's pending queue
//                 (unchanged) → it was never really signed → flip to pending.
//                 Direction-A reconciliation: catches optimistic sign-flips that
//                 InSync actually rejected, without needing per-note sign results.
//   'skip'      — already have this exact content, nothing to do
function decideAction(existing, hash) {
  if (!existing) return 'new';
  if (existing.status === 'reopened') return 'revised';    // peer resigned it
  if (existing.content_hash !== hash) return 'revised';    // content changed
  if (existing.status === 'signed') return 'reconcile';    // in queue but we think signed
  return 'skip';
}

// Judging a note runs three independent tracks, ALL of which always run — a
// possible duplicate never suppresses the AI review, and a mechanical failure
// never suppresses it either:
//   1. deterministic machine checks (duration / minor rules)   — 0 AI calls
//   2. mechanical duplicate awareness vs the pending pool      — 0 AI calls
//   3. exactly one AI documentation review                     — 1 AI call
// judgeNote (below) runs all three; ingestQueue drives them separately so track
// 3 can be parallelised. Exported for testing with a fake engine.

// Track 3 alone: one AI call, or the stored review when nothing that affects it
// has changed. Split out of judgeNote so ingestQueue can run this — the only
// slow, network-bound track — in parallel, while tracks 1 and 2 stay strictly
// serial (the duplicate corpus is order-dependent; the AI never sees it).
async function reviewFor(engine, note, machine, { priorReview = null, force = false } = {}) {
  const fingerprint = engine.fingerprintFor(note, machine);
  const reusable = !force && priorReview
    && priorReview.fingerprint === fingerprint
    && priorReview.decision && priorReview.decision !== 'AI_REVIEW_ERROR';
  if (reusable) return { review: { ...priorReview, reused: true }, reused: true };
  return { review: await engine.aiReview(note, machine), reused: false };
}

// Fold the three tracks into one verdict. Pure — no I/O — so it can run after a
// parallel review wave without changing anything about the outcome.
function assembleJudged(machine, dupe, review, reused) {
  const flags = {
    machine,
    clone:     dupe || null,
    // Backward-compatible short line for components not yet reading `review`.
    coherence: summaryFlagOf(review),
    offsite:   offsiteSummary(review),
    review:    review || null,
  };

  // Needs human attention when ANY track says so. The duplicate is deliberately
  // part of this OR — but it is not folded into the AI decision.
  const needsAttention = machine.length > 0
    || !!dupe
    || (review && review.decision && review.decision !== 'PASS');
  return {
    verdict: needsAttention ? 'flagged' : 'clean',
    flags,
    clonePartnerEid: dupe?.partnerEid || null,
    aiCalled: !reused && !!review,
  };
}

async function judgeNote(engine, note, corpus, { priorReview = null, force = false } = {}) {
  const machine = engine.checkNote(note);            // 1
  const dupe    = engine.findDupe(note, corpus);     // 2 — synchronous, no network
  const { review, reused } = await reviewFor(engine, note, machine, { priorReview, force }); // 3
  return assembleJudged(machine, dupe, review, reused);
}

// Compact `offsite` mirror kept at the top level of ai_flags for the UI.
function offsiteSummary(review) {
  const o = review?.offsite_review;
  if (!o) return null;
  return {
    applicable:      o.applicable !== false,
    serviceType:     o.service_type || null,
    status:          o.status || null,
    rationaleStatus: o.rationale_status || null,
  };
}

// Local fallback of the engine's summary line (kept here so judgeNote can be
// unit-tested against a fake engine that doesn't implement it).
function summaryFlagOf(review) {
  if (!review) return null;
  if (review.decision === 'AI_REVIEW_ERROR') return 'AI review error — response could not be parsed';
  if (!review.decision || review.decision === 'PASS') return null;
  return `${review.decision.replace(/_/g, ' ')}: ${review.review_summary || review.reopen_message_to_peer || review.supervisor_message || 'see review'}`;
}

// Full parsed note for storage: everything needed to re-judge, show side-by-side,
// and drive sign/reopen actions — minus the non-serializable Date.
function serializeNote(note) {
  const nd = { ...note };
  delete nd.visitDateObj;
  return nd;
}

// Option (b): drag a duplicate's still-pending partner out of the clean stack.
async function flagPartner(partnerEid, sourceEid, cloneMeta) {
  const { data: row } = await supabase.from('ps_notes')
    .select('id, ai_flags')
    .eq('eid', partnerEid).eq('status', 'pending')
    .order('version', { ascending: false }).limit(1).maybeSingle();
  if (!row) return;
  const flags = row.ai_flags || {};
  if (flags.clone) return;   // already carries a clone flag
  flags.clone = {
    partnerEid: sourceEid,
    pct:        cloneMeta?.pct ?? null,
    reason:     cloneMeta?.reason || 'Appears copied — not individualized to this session',
  };
  await supabase.from('ps_notes')
    .update({ ai_verdict: 'flagged', ai_flags: flags })
    .eq('id', row.id);
}

// A note InSync wouldn't hand us the content for — record it once as a flagged
// pending row so it isn't silently lost.
async function ingestCantLoad(row, stats) {
  const { data: existing } = await supabase.from('ps_notes')
    .select('id, status').eq('eid', row.eid)
    .order('version', { ascending: false }).limit(1).maybeSingle();
  if (existing && ['pending', 'reopened'].includes(existing.status)) return;
  await supabase.from('ps_notes').insert({
    eid: row.eid, version: (existing?.version || 0) + 1, pid: row.pid,
    peer_name: row.peerName, patient_name: row.patientName,
    visit_date: row.visitDate, visit_datetime: row.visitDatetime,
    content_hash: `cantload:${row.eid}`,
    ai_verdict: 'flagged',
    ai_flags: { machine: ['Could not load note — manual review required'],
                clone: null, coherence: null, offsite: null, review: null },
    status: 'pending', note_data: row, judged_at: new Date().toISOString(),
  });
  stats.cantLoad++;
}

// Main entry: login → download → dedup → judge new/revised → persist.
// `dates` (optional) is an array of MM/DD/YYYY keys from the date picker; only
// those visit dates are downloaded and judged. Everything else is untouched —
// notes on other dates are neither pulled nor altered.
async function ingestQueue(engine, { onProgress, dates = null } = {}) {
  const report = (m, p) => { if (onProgress) onProgress(m, p); };

  report('Logging into InSync...', 2);
  await engine.login();

  report('Fetching co-sign queue...', 5);
  const dateSet = dates && dates.length ? new Set(dates) : null;
  const { notes, cantLoad } = await engine.fetchNotes(report, { dates: dateSet });

  // Pending pool for duplicate comparison (status='pending' ONLY, per spec).
  // Section bigrams are precomputed ONCE here via prepareDupeEntry and reused for
  // every comparison in this pull — never recomputed per pair.
  const { data: pendingRows } = await supabase.from('ps_notes')
    .select('eid, mrn, patient_name, visit_date, note_data').eq('status', 'pending');
  const corpus = (pendingRows || []).map(r => engine.prepareDupeEntry({
    eid:          r.eid,
    mrn:          r.mrn || r.note_data?.mrn || '',
    patientName:  r.note_data?.patientName || r.patient_name || '',
    visitDate:    r.note_data?.visitDate   || r.visit_date   || '',
    fullNoteText: r.note_data?.fullNoteText || '',
    structuredText: r.note_data?.structuredText || '',
  }));

  const stats = { pulled: notes.length, new: 0, revised: 0, skipped: 0,
                  reconciled: 0, flagged: 0, clean: 0, cantLoad: 0,
                  aiCalls: 0, aiReused: 0 };
  const aiCallsAtStart = engine.aiCallCount || 0;

  // ── Pass 1 — dedup + the two mechanical tracks. Strictly serial and in order:
  // the duplicate corpus grows as we go, so note i must see notes 0..i-1 exactly
  // as it does today. No network here beyond quick DB lookups, so it's fast.
  const work = [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    report(`Checking ${i + 1} of ${notes.length}...`,
      78 + Math.floor((i / Math.max(notes.length, 1)) * 4));

    const hash = contentHash(note);
    const { data: existing } = await supabase.from('ps_notes')
      .select('id, version, status, content_hash')
      .eq('eid', note.eid).order('version', { ascending: false }).limit(1).maybeSingle();

    const action = decideAction(existing, hash);
    if (action === 'skip') { stats.skipped++; continue; }

    // Direction-A reconciliation: it's back in the pending queue unchanged, so
    // our 'signed' was wrong. Flip it back to pending, keep its prior verdict
    // (content didn't change — no need to re-judge), and return it to the pool.
    if (action === 'reconcile') {
      await supabase.from('ps_notes')
        .update({ status: 'pending', actioned_at: null }).eq('id', existing.id);
      stats.reconciled++;
      corpus.push(engine.prepareDupeEntry(note));
      continue;
    }

    const machine = engine.checkNote(note);        // track 1
    const dupe    = engine.findDupe(note, corpus); // track 2 — order-dependent
    // Progressive pending pool: later notes in this same batch compare against it.
    corpus.push(engine.prepareDupeEntry(note));
    work.push({ note, hash, existing, action, machine, dupe });
  }

  // ── Pass 2 — the AI reviews, in parallel. This is the whole runtime of a pull
  // (~20s each, serial before this), and nothing about it is order-dependent.
  // The first note runs alone so it writes the shared prompt-cache entry; the
  // rest then read it instead of each paying a cache write.
  const concurrency = Math.max(1, Number(process.env.PS_AI_CONCURRENCY) || 5);
  let reviewed = 0;
  async function runReview(w) {
    try {
      // A revision keeps the prior version's review only if the fingerprint still
      // matches (it won't, if the content changed) — this is what makes a re-pull
      // of an unchanged note cost zero AI calls.
      const priorReview = w.existing ? await priorReviewFor(w.note.eid) : null;
      const { review, reused } = await reviewFor(engine, w.note, w.machine, { priorReview });
      w.judged = assembleJudged(w.machine, w.dupe, review, reused);
    } catch (err) {
      // A single failed review must not sink the wave — record it as an error
      // verdict so the note still lands in the queue for a human.
      w.judged = assembleJudged(w.machine, w.dupe,
        { decision: 'AI_REVIEW_ERROR', error: `Review failed: ${err.message}` }, false);
    }
    reviewed++;
    report(`AI review ${reviewed} of ${work.length}...`,
      82 + Math.floor((reviewed / Math.max(work.length, 1)) * 16));
  }
  if (work.length) await runReview(work[0]);
  for (let i = 1; i < work.length; i += concurrency)
    await Promise.all(work.slice(i, i + concurrency).map(runReview));

  // ── Pass 3 — persist, serially and in the original order, so stats and the
  // partner-flag writes stay deterministic.
  for (const { note, hash, existing, action, judged } of work) {
    if (judged.aiCalled) stats.aiCalls++; else if (judged.flags.review) stats.aiReused++;

    // Option (b): a possible duplicate pulls its pending partner into the
    // flagged queue too, so neither half can be bulk-signed by accident. This
    // never reopens anything on its own — a human still adjudicates.
    if (judged.clonePartnerEid)
      await flagPartner(judged.clonePartnerEid, note.eid, judged.flags.clone);

    if (action === 'revised')
      await supabase.from('ps_notes').update({ status: 'superseded' }).eq('id', existing.id);

    await supabase.from('ps_notes').insert({
      eid: note.eid, version: existing ? existing.version + 1 : 1, pid: note.pid,
      peer_name: note.peerName, patient_name: note.patientName, mrn: note.mrn,
      visit_date: note.visitDate, visit_datetime: note.visitDatetime,
      start_time: note.startTimeStr, end_time: note.endTimeStr, total_time: note.totalTime,
      content_hash: hash,
      ai_verdict: judged.verdict, ai_flags: judged.flags,
      status: 'pending', note_data: serializeNote(note),
      judged_at: new Date().toISOString(),
    });

    stats[action]++;            // new | revised
    stats[judged.verdict]++;    // flagged | clean
  }

  for (const row of cantLoad) await ingestCantLoad(row, stats);

  // Invariant: the engine's own AI counter must equal the number of reviews we
  // believe we requested. Duplicate detection contributes zero to both.
  stats.engineAiCalls = (engine.aiCallCount || 0) - aiCallsAtStart;
  console.log(`[PS ingest] AI calls: ${stats.engineAiCalls} (accounted ${stats.aiCalls}, reused ${stats.aiReused}) over ${stats.new + stats.revised} new/revised notes`);

  report('Done!', 100);
  return stats;
}

// Latest stored review for an eid, whatever version it sits on — the reuse
// check compares its fingerprint against the incoming note's.
async function priorReviewFor(eid) {
  const { data } = await supabase.from('ps_notes')
    .select('ai_flags').eq('eid', eid)
    .order('version', { ascending: false }).limit(1).maybeSingle();
  return data?.ai_flags?.review || null;
}

module.exports = { ingestQueue, decideAction, judgeNote, reviewFor, assembleJudged,
                   contentHash, serializeNote, priorReviewFor };

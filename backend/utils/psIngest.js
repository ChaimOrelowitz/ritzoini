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
//   'new'     — never seen this eid → insert v1
//   'revised' — reopened-and-resigned, or content changed → insert v+1, supersede
//   'skip'    — already have this exact content, nothing to do
function decideAction(existing, hash) {
  if (!existing) return 'new';
  if (existing.status === 'reopened') return 'revised';   // peer resigned it
  if (existing.content_hash !== hash) return 'revised';   // content changed
  return 'skip';
}

// Judge a single new/revised note: deterministic machine checks + incremental
// clone check (against the pending pool) + AI coherence review. Exported for
// testing with a fake engine.
async function judgeNote(engine, note, corpus) {
  const machine   = engine.checkNote(note);                 // duration / minor rules
  const clone     = await engine.findClone(note, corpus);   // vs pending pool only
  const coherence = await engine.aiReview(note, machine);   // content QA

  const flags = {
    machine:   machine,
    clone:     clone || null,
    coherence: coherence || null,
  };
  const verdict = (machine.length || clone || coherence) ? 'flagged' : 'clean';
  return { verdict, flags, clonePartnerEid: clone?.partnerEid || null };
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
    ai_flags: { machine: ['Could not load note — manual review required'], clone: null, coherence: null },
    status: 'pending', note_data: row, judged_at: new Date().toISOString(),
  });
  stats.cantLoad++;
}

// Main entry: login → download → dedup → judge new/revised → persist.
async function ingestQueue(engine, { onProgress } = {}) {
  const report = (m, p) => { if (onProgress) onProgress(m, p); };

  report('Logging into InSync...', 2);
  await engine.login();

  report('Fetching co-sign queue...', 5);
  const { notes, cantLoad } = await engine.fetchNotes(report);

  // Pending pool for clone comparison (status='pending' ONLY, per spec).
  const { data: pendingRows } = await supabase.from('ps_notes')
    .select('eid, note_data').eq('status', 'pending');
  const corpus = (pendingRows || []).map(r => ({
    eid:            r.eid,
    patientName:    r.note_data?.patientName    || '',
    sessionContent: r.note_data?.sessionContent || '',
    visitDate:      r.note_data?.visitDate      || '',
  }));

  const stats = { pulled: notes.length, new: 0, revised: 0, skipped: 0,
                  flagged: 0, clean: 0, cantLoad: 0 };

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    report(`Processing ${i + 1} of ${notes.length}...`,
      80 + Math.floor((i / Math.max(notes.length, 1)) * 18));

    const hash = contentHash(note);
    const { data: existing } = await supabase.from('ps_notes')
      .select('id, version, status, content_hash')
      .eq('eid', note.eid).order('version', { ascending: false }).limit(1).maybeSingle();

    const action = decideAction(existing, hash);
    if (action === 'skip') { stats.skipped++; continue; }

    const judged = await judgeNote(engine, note, corpus);

    // Option (b): a confirmed copy pulls its pending partner into the flagged
    // queue too — must happen before we (possibly) count/close anything out.
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

    // Progressive pending pool: later notes in this same batch compare against it.
    corpus.push({
      eid: note.eid, patientName: note.patientName,
      sessionContent: note.sessionContent, visitDate: note.visitDate,
    });

    stats[action]++;            // new | revised
    stats[judged.verdict]++;    // flagged | clean
  }

  for (const row of cantLoad) await ingestCantLoad(row, stats);

  report('Done!', 100);
  return stats;
}

module.exports = { ingestQueue, decideAction, judgeNote, contentHash, serializeNote };

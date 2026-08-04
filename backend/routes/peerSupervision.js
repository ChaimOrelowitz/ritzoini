const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth, requireAdmin, requireCoSign } = require('../middleware/auth');
const { InsyncCoSignEngine, DEFAULT_CORE_REVIEW_PROMPT, DEFAULT_OFFSITE_PROMPT } = require('../utils/peerSupervisorEngine');
const { sendReopenNotification } = require('../utils/reopenNotify');
const { ingestQueue, judgeNote, serializeNote, contentHash } = require('../utils/psIngest');
const { syncCaseload, logFailure } = require('../utils/caseloadSync');
const { fetchSupervisionSchedule, fetchSupervisionSessions } = require('../utils/airtable');

// ── Co-Sign ───────────────────────────────────────────────────────────────────

async function buildEngine() {
  const { data: rows } = await supabase.from('app_settings').select('key, value')
    .in('key', ['insync_username','insync_password','insync_provider_id',
                'ps_no_school_start','ps_no_school_end','anthropic_api_key',
                'ps_prompt_core_review','ps_prompt_offsite']);
  const S = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
  return new InsyncCoSignEngine({
    username:      S.insync_username    || process.env.INSYNC_USERNAME      || '',
    password:      S.insync_password    || process.env.INSYNC_PASSWORD      || '',
    anthropicKey:  S.anthropic_api_key  || process.env.ANTHROPIC_API_KEY    || '',
    providerId:    S.insync_provider_id || process.env.INSYNC_PROVIDER_ID   || '2317',
    noSchoolStart: S.ps_no_school_start || '',
    noSchoolEnd:   S.ps_no_school_end   || '',
    coreReviewPrompt: S.ps_prompt_core_review || '',
    offsitePrompt:    S.ps_prompt_offsite     || '',
  });
}

// GET /api/ps/cosign/scan — SSE: streams progress + delivers final result
// Auth via ?token= query param because EventSource can't set headers
router.get('/cosign/scan', async (req, res) => {
  // Verify JWT from query param (EventSource can't set Authorization header)
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  try {
    const engine = await buildEngine();
    const { flagged, clean } = await engine.fullScan((msg, pct) => send('progress', { msg, pct }));

    const { data: run } = await supabase.from('ps_scan_runs').insert({
      total:         flagged.length + clean.length,
      clean_count:   clean.length,
      flagged_count: flagged.length,
      signed_count:  0,
      flagged_notes: flagged,
      clean_eids:    clean.map(n => n.eid),
    }).select('id').single();

    send('done', { flagged, clean, runId: run?.id });
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

// POST /api/ps/cosign/sign — sign a list of notes; body: { notes, runId, delta }
router.post('/cosign/sign', requireAuth, requireCoSign, async (req, res) => {
  try {
    const { notes, runId, delta = 0 } = req.body;
    if (!notes?.length) return res.status(400).json({ error: 'notes required' });

    const engine = await buildEngine();
    await engine.login();
    const { signed, failed } = await engine.bulkSign(notes);

    if (runId && signed > 0) {
      const { data: run } = await supabase.from('ps_scan_runs').select('signed_count').eq('id', runId).maybeSingle();
      await supabase.from('ps_scan_runs').update({ signed_count: (run?.signed_count || 0) + signed + delta }).eq('id', runId);
    }

    // Flip the persistent queue: the notes we just signed leave 'pending'.
    const eids = notes.map(n => n.eid).filter(Boolean);
    if (eids.length)
      await supabase.from('ps_notes')
        .update({ status: 'signed', actioned_at: new Date().toISOString() })
        .in('eid', eids).eq('status', 'pending');

    res.json({ signed, failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ps/cosign/reopen — reopen (send back to peer for revision) one or
// more notes. Body: { notes: [{ eid, pid, reason }] }. Each note is gated on
// InSync's claim-generated check, so billed encounters are refused per-note.
router.post('/cosign/reopen', requireAuth, requireCoSign, async (req, res) => {
  try {
    const { notes } = req.body;
    if (!notes?.length) return res.status(400).json({ error: 'notes required' });

    const engine = await buildEngine();
    await engine.login();

    // Email settings for the reopen notification (editable in Settings tab).
    // ps_reopen_email_enabled is the Reviewer's master on/off switch: with it
    // off, notes still reopen in InSync and still move to 'reopened' here — only
    // the outbound email is suppressed, so quiet fixes don't clutter an inbox.
    const { data: srows } = await supabase.from('app_settings').select('key, value')
      .in('key', ['ps_qa_email', 'ps_qa_cc', 'ps_reopen_from', 'ps_reopen_reply_to',
                  'ps_reopen_email_enabled']);
    const emailSettings = Object.fromEntries((srows || []).map(r => [r.key, r.value]));
    // Default ON: absent setting keeps today's behaviour.
    const emailEnabled = emailSettings.ps_reopen_email_enabled !== 'false';
    // Per-request override so the Reviewer can silence one batch without
    // flipping the global switch. Body: { notes, sendEmail: false }.
    const sendEmail = req.body.sendEmail === undefined ? emailEnabled : !!req.body.sendEmail;

    const results = [];
    for (const n of notes) {
      if (!n.eid || !n.pid) { results.push({ eid: n.eid || null, ok: false, message: 'Missing encounter id' }); continue; }
      let r;
      try {
        r = { eid: n.eid, ...(await engine.reopenNote({ eid: n.eid, pid: n.pid, reason: n.reason || '' })) };
      } catch (e) {
        results.push({ eid: n.eid, ok: false, message: e.message });
        continue;
      }
      // Reopen succeeded — notify. Email failure NEVER rolls back the reopen,
      // and neither does the toggle being off.
      if (r.ok) {
        if (sendEmail) {
          const em = await sendReopenNotification({ note: n, reason: n.reason || '', settings: emailSettings });
          r.emailSent = em.emailSent;
          r.emailError = em.emailError;
        } else {
          r.emailSent = false;
          r.emailSkipped = true;
        }
        // Persistent queue: this note is now waiting on the peer.
        await supabase.from('ps_notes')
          .update({ status: 'reopened', reopen_reason: n.reason || '', actioned_at: new Date().toISOString() })
          .eq('eid', n.eid).eq('status', 'pending');
      }
      results.push(r);
    }
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Persistent queue (ps_notes) ─────────────────────────────────────────────────

// Shape a stored ps_notes row into the note object the frontend components
// expect (same fields the old live scan produced), so NoteBody / CompareModal /
// ReopenModal / sign all work unchanged.
function psNoteView(row) {
  const nd = row.note_data || {};
  const f  = row.ai_flags  || {};
  const flags = [...(f.machine || [])];
  if (f.clone) flags.push(f.clone.reason);
  return {
    id: row.id, eid: row.eid, version: row.version,
    status: row.status, verdict: row.ai_verdict,
    patientName: row.patient_name, peerName: row.peer_name,
    visitDatetime: row.visit_datetime, visitDate: row.visit_date, mrn: row.mrn,
    startTimeStr: row.start_time, endTimeStr: row.end_time, totalTime: row.total_time,
    pid: row.pid, cosignId: nd.cosignId, cosignReqId: nd.cosignReqId,
    fullNoteText: nd.fullNoteText || '',
    flags, aiFlag: f.coherence || null,
    // Duplicate awareness — mechanical, and deliberately NOT part of the AI
    // decision. `dupeStatus` drives its own chip so the two never merge.
    clonePartnerEid: f.clone?.partnerEid || null,
    clonePct:        f.clone?.pct || null,
    cloneSections:   f.clone?.sections || null,
    dupeStatus:      f.clone?.status || null,
    // Human adjudication lives inside ai_flags (JSON) — no schema migration.
    dupeDecision:    f.clone?.decision || null,   // confirmed | dismissed | null
    // Full AI review — the source of truth for everything the model decided.
    review:  f.review || null,
    offsite: f.offsite || null,
    aiDecision: f.review?.decision || null,
    suggestedReopenMessage: composeSuggestedReopenMessage(
      f.machine || [], f.review || null, f.clone?.decision === 'confirmed' ? f.clone : null),
    reopenReason: row.reopen_reason || null,
    ingestedAt: row.ingested_at, actionedAt: row.actioned_at,
  };
}

// Deterministic mechanical text + the AI's peer-facing message + (only once a
// human has CONFIRMED the duplicate concern) the duplicate paragraph. The
// reviewer edits this before it is ever sent.
function composeSuggestedReopenMessage(machineFlags, review, confirmedDuplicate) {
  const parts = [];

  if ((machineFlags || []).some(f => /min|hour|duration|session exceeds|3-hour/i.test(f)))
    parts.push('The documented duration does not meet the permitted time requirement for this meeting type. '
      + 'Please correct the recorded duration only if it was entered incorrectly. Do not change the time unless '
      + 'the corrected time reflects the service that actually occurred.');

  if (review?.reopen_message_to_peer) parts.push(review.reopen_message_to_peer.trim());

  if (confirmedDuplicate)
    parts.push(`This note substantially matches the note from ${confirmedDuplicate.partnerDate || 'another date'}. `
      + 'Please revise it to reflect what specifically occurred during this service, including the date-specific '
      + 'intervention, client response, and progress. Do not simply reword the earlier note.');

  return parts.join('\n\n');
}

// GET /api/ps/cosign/notes — the durable queue/archive.
// Params: status (default 'pending'; comma-list or 'all'), verdict, q (text
// search on patient/peer name).
router.get('/cosign/notes', requireAuth, requireCoSign, async (req, res) => {
  try {
    const { status = 'pending', verdict, q } = req.query;
    let query = supabase.from('ps_notes').select('*');
    if (status && status !== 'all') {
      const arr = String(status).split(',').map(s => s.trim()).filter(Boolean);
      query = arr.length > 1 ? query.in('status', arr) : query.eq('status', arr[0]);
    }
    if (verdict) query = query.eq('ai_verdict', verdict);
    if (q) {
      const safe = String(q).replace(/[,()%]/g, ' ').trim();
      if (safe) query = query.or(`patient_name.ilike.%${safe}%,peer_name.ilike.%${safe}%`);
    }
    const { data, error } = await query.order('visit_date', { ascending: false }).limit(500);
    if (error) throw error;
    res.json((data || []).map(psNoteView));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ps/cosign/notes/:eid/versions — every version of one note, oldest
// first, for the side-by-side old-vs-new view of a revised reopened note.
router.get('/cosign/notes/:eid/versions', requireAuth, requireCoSign, async (req, res) => {
  const { data, error } = await supabase.from('ps_notes').select('*')
    .eq('eid', req.params.eid).order('version', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(psNoteView));
});

// GET /api/ps/cosign/pull — SSE: incremental ingest (login → download → dedup →
// judge new/revised → persist). Read-only against InSync (no sign/reopen). Auth
// via ?token= because EventSource can't set headers.
router.get('/cosign/pull', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });
  // Same rule as requireCoSign, hand-rolled because the middleware chain can't
  // run here (no Authorization header). Payroll-only accounts stay locked out —
  // requireAuth's chokepoint never sees this request.
  const { data: profile } = await supabase.from('profiles')
    .select('role, ps_cosign, ps_payroll_only').eq('id', user.id).single();
  const mayCoSign = (profile?.role === 'admin' || profile?.ps_cosign === true) && !profile?.ps_payroll_only;
  if (!mayCoSign) return res.status(403).json({ error: 'Co-Sign Review access required' });

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  try {
    const engine = await buildEngine();
    const stats = await ingestQueue(engine, { onProgress: (msg, pct) => send('progress', { msg, pct }) });
    send('done', { stats });
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

// POST /api/ps/cosign/rejudge — re-run the AI on ONE already-stored note (new
// prompt / fresh verdict) with NO InSync round-trip. Body: { id }.
router.post('/cosign/rejudge', requireAuth, requireCoSign, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    const { data: row } = await supabase.from('ps_notes').select('*').eq('id', id).maybeSingle();
    if (!row) return res.status(404).json({ error: 'Note not found' });

    const engine = await buildEngine();
    const note = { ...(row.note_data || {}), eid: row.eid };
    note.visitDateObj = engine._parseDate(note.visitDatetime || row.visit_datetime);

    // Duplicate pool = current pending notes, minus this one (per spec).
    // Prepared once; the comparison itself makes no AI calls.
    const { data: pend } = await supabase.from('ps_notes')
      .select('eid, mrn, patient_name, visit_date, note_data').eq('status', 'pending').neq('id', id);
    const corpus = (pend || []).map(r => engine.prepareDupeEntry({
      eid: r.eid, mrn: r.mrn || r.note_data?.mrn || '',
      patientName: r.note_data?.patientName || r.patient_name || '',
      visitDate: r.note_data?.visitDate || r.visit_date || '',
      fullNoteText: r.note_data?.fullNoteText || '',
    }));

    // force: a manual rejudge deliberately bypasses fingerprint reuse — the
    // operator asked for a fresh opinion. Exactly one AI call either way.
    const judged = await judgeNote(engine, note, corpus, { force: true });
    // Preserve any human duplicate adjudication across a rejudge.
    const priorDecision = row.ai_flags?.clone?.decision || null;
    if (priorDecision && judged.flags.clone) judged.flags.clone.decision = priorDecision;
    console.log(`[PS rejudge] eid=${row.eid} aiCalls=${engine.aiCallCount} decision=${judged.flags.review?.decision}`);

    await supabase.from('ps_notes')
      .update({ ai_verdict: judged.verdict, ai_flags: judged.flags, judged_at: new Date().toISOString() })
      .eq('id', id);
    const { data: updated } = await supabase.from('ps_notes').select('*').eq('id', id).maybeSingle();
    res.json(psNoteView(updated));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ps/cosign/notes/:id/dupe-decision — the HUMAN adjudicates a possible
// duplicate. Body: { decision: 'confirmed' | 'dismissed' | null }. The mechanical
// score never decides on its own; this is what records the reviewer's call.
// Stored inside ai_flags.clone so no schema migration is needed.
router.post('/cosign/notes/:id/dupe-decision', requireAuth, requireCoSign, async (req, res) => {
  try {
    const { decision } = req.body;
    if (![null, 'confirmed', 'dismissed'].includes(decision ?? null))
      return res.status(400).json({ error: "decision must be 'confirmed', 'dismissed', or null" });

    const { data: row } = await supabase.from('ps_notes').select('*').eq('id', req.params.id).maybeSingle();
    if (!row) return res.status(404).json({ error: 'Note not found' });
    if (!row.ai_flags?.clone) return res.status(400).json({ error: 'Note has no duplicate finding' });

    const flags = { ...row.ai_flags, clone: { ...row.ai_flags.clone, decision: decision ?? null } };
    await supabase.from('ps_notes').update({ ai_flags: flags }).eq('id', req.params.id);
    const { data: updated } = await supabase.from('ps_notes').select('*').eq('id', req.params.id).maybeSingle();
    res.json(psNoteView(updated));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ps/cosign/history — last 50 scan runs
router.get('/cosign/history', requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('ps_scan_runs')
    .select('id, created_at, total, clean_count, flagged_count, signed_count, flagged_notes, clean_eids')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/ps/cosign/settings
router.post('/cosign/settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { no_school_start, no_school_end, provider_id, insync_username, insync_password,
            anthropic_api_key, prompt_core_review, prompt_offsite,
            qa_email, qa_cc, reopen_from, reopen_reply_to, reopen_email_enabled } = req.body;
    const map = {
      ps_no_school_start: no_school_start,
      ps_no_school_end:   no_school_end,
      insync_provider_id: provider_id,
      insync_username,
      insync_password,
      anthropic_api_key,
      // Empty string is meaningful: it clears the override and reverts to the
      // shipped default (the engine falls back when the stored value is blank).
      ps_prompt_core_review: prompt_core_review,
      ps_prompt_offsite:     prompt_offsite,
      // Reopen notification email.
      ps_qa_email:         qa_email,
      ps_qa_cc:            qa_cc,
      ps_reopen_from:      reopen_from,
      ps_reopen_reply_to:  reopen_reply_to,
      ps_reopen_email_enabled: reopen_email_enabled === undefined ? undefined : String(!!reopen_email_enabled),
    };
    for (const [key, value] of Object.entries(map))
      if (value !== undefined && value !== null)
        await supabase.from('app_settings').upsert({ key, value }, { onConflict: 'key' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ps/cosign/prompt-preview — the EXACT system prompt the next AI review
// will send, built by the same buildEngine() the ingest and rejudge paths use.
// This is the provenance check: if what you saved in Settings is what runs, it
// appears here verbatim. `source` says whether each module is your saved custom
// text or the shipped default.
router.get('/cosign/prompt-preview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const crypto = require('crypto');
    const { data: rows } = await supabase.from('app_settings').select('key, value')
      .in('key', ['ps_prompt_core_review', 'ps_prompt_offsite']);
    const S = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
    const engine = await buildEngine();
    const systemPrompt = engine.systemPrompt();
    const h = t => crypto.createHash('sha256').update(String(t || '')).digest('hex').slice(0, 16);
    res.json({
      systemPrompt,
      chars: systemPrompt.length,
      core: {
        source: (S.ps_prompt_core_review || '').trim() ? 'custom (saved in Settings)' : 'built-in default',
        chars:  engine.coreReviewPrompt.length,
        hash:   h(engine.coreReviewPrompt),
        matchesSaved: (S.ps_prompt_core_review || '').trim()
          ? (S.ps_prompt_core_review || '').trim() === engine.coreReviewPrompt : null,
      },
      offsite: {
        source: (S.ps_prompt_offsite || '').trim() ? 'custom (saved in Settings)' : 'built-in default',
        chars:  engine.offsitePrompt.length,
        hash:   h(engine.offsitePrompt),
        matchesSaved: (S.ps_prompt_offsite || '').trim()
          ? (S.ps_prompt_offsite || '').trim() === engine.offsitePrompt : null,
      },
      note: 'The fixed JSON output contract is appended after both modules and is not editable.',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ps/cosign/settings
router.get('/cosign/settings', requireAuth, requireAdmin, async (req, res) => {
  const { data } = await supabase.from('app_settings').select('key, value')
    .in('key', ['ps_no_school_start','ps_no_school_end','insync_provider_id',
                'insync_username','insync_password','anthropic_api_key',
                'ps_prompt_core_review','ps_prompt_offsite',
                'ps_qa_email','ps_qa_cc','ps_reopen_from','ps_reopen_reply_to',
                'ps_reopen_email_enabled']);
  const S = Object.fromEntries((data || []).map(r => [r.key, r.value]));
  res.json({
    no_school_start:   S.ps_no_school_start || '07/01',
    no_school_end:     S.ps_no_school_end   || '08/31',
    provider_id:       S.insync_provider_id  || '2317',
    insync_username:   S.insync_username     || '',
    insync_password:   S.insync_password     || '',
    anthropic_api_key: S.anthropic_api_key   || '',
    prompt_core_review: S.ps_prompt_core_review || DEFAULT_CORE_REVIEW_PROMPT,
    prompt_offsite:     S.ps_prompt_offsite     || DEFAULT_OFFSITE_PROMPT,
    qa_email:          S.ps_qa_email        || '',
    qa_cc:             S.ps_qa_cc           || '',
    reopen_from:       S.ps_reopen_from     || '',
    reopen_reply_to:   S.ps_reopen_reply_to || '',
    reopen_email_enabled: S.ps_reopen_email_enabled !== 'false',
    default_prompt_core_review: DEFAULT_CORE_REVIEW_PROMPT,
    default_prompt_offsite:     DEFAULT_OFFSITE_PROMPT,
  });
});

// POST /api/ps/cosign/cron — runs a scan, saves to DB (cron-secret protected)
router.post('/cosign/cron', async (req, res) => {
  const secret   = process.env.CRON_SECRET;
  const provided = req.headers['x-cron-secret'] || req.query.secret;
  if (!secret || provided !== secret) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const engine = await buildEngine();
    const { flagged, clean } = await engine.fullScan();
    await supabase.from('ps_scan_runs').insert({
      total: flagged.length + clean.length,
      clean_count: clean.length, flagged_count: flagged.length, signed_count: 0,
      flagged_notes: flagged, clean_eids: clean.map(n => n.eid),
    });
    res.json({ ok: true, total: flagged.length + clean.length, flagged: flagged.length, clean: clean.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Caseload ──────────────────────────────────────────────────────

const SUPERVISOR = () => process.env.AIRTABLE_SUPERVISOR_RECORD_ID;

// GET /api/ps/caseload — peers currently on the caseload, with entry dates
router.get('/caseload', requireAuth, async (req, res) => {
  try {
    const sup = req.query.supervisor_id || SUPERVISOR();

    const { data: periods, error: pe } = await supabase
      .from('ps_caseload_periods')
      .select('*')
      .eq('supervisor_airtable_id', sup)
      .is('left_on', null);
    if (pe) throw new Error(pe.message);

    const ids = (periods || []).map(p => p.peer_airtable_id);
    const { data: peers, error: qe } = ids.length
      ? await supabase.from('ps_peers').select('*').in('airtable_id', ids)
      : { data: [], error: null };
    if (qe) throw new Error(qe.message);

    const byId = new Map((peers || []).map(p => [p.airtable_id, p]));
    const rows = (periods || [])
      .map(p => ({ ...(byId.get(p.peer_airtable_id) || {}), ...p, period_id: p.id }))
      .sort((a, b) => (a.peer_name || '').localeCompare(b.peer_name || ''));

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ps/caseload/history — every stint, open and closed (payroll view)
router.get('/caseload/history', requireAuth, async (req, res) => {
  try {
    const sup = req.query.supervisor_id || SUPERVISOR();
    const { data, error } = await supabase
      .from('ps_caseload_periods')
      .select('*')
      .eq('supervisor_airtable_id', sup)
      .order('entered_on', { ascending: false });
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ps/caseload/periods — add an assignment by hand
router.post('/caseload/periods', requireAuth, async (req, res) => {
  try {
    const { peer_airtable_id, peer_name, entered_on, left_on, note } = req.body;
    if (!peer_airtable_id || !entered_on) {
      return res.status(400).json({ error: 'peer_airtable_id and entered_on are required' });
    }
    if (left_on && left_on < entered_on) {
      return res.status(400).json({ error: 'left_on cannot be before entered_on' });
    }

    const { data, error } = await supabase.from('ps_caseload_periods').insert({
      peer_airtable_id,
      peer_name:              peer_name || null,
      supervisor_airtable_id: SUPERVISOR(),
      entered_on,
      left_on:                left_on || null,
      source:                 'manual',
      note:                   note || null,
    }).select().single();

    // The partial unique index allows repeat stints but only one open at a
    // time, so this is a duplicate open assignment rather than a real clash.
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'That peer already has an open assignment. Close it first.' });
    }
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ps/caseload/periods/:id — remove an assignment row outright
router.delete('/caseload/periods/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('ps_caseload_periods').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ps/caseload/known-peers — every peer we've seen, for the add form
router.get('/caseload/known-peers', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ps_peers').select('airtable_id, peer_name, status, cohort').order('peer_name');
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/ps/caseload/periods/:id — hand-correct an entry/exit date
router.patch('/caseload/periods/:id', requireAuth, async (req, res) => {
  try {
    const { entered_on, left_on, note } = req.body;
    const updates = { updated_at: new Date().toISOString(), source: 'manual' };
    if (entered_on !== undefined) updates.entered_on = entered_on;
    if (left_on    !== undefined) updates.left_on    = left_on || null;
    if (note       !== undefined) updates.note       = note;

    const { data, error } = await supabase
      .from('ps_caseload_periods')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ps/caseload/runs — recent poll history
router.get('/caseload/runs', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ps_sync_runs').select('*').order('ran_at', { ascending: false }).limit(30);
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ps/supervision — the supervisor's recurring schedule + their
// individual supervision sessions, live from Airtable (read-only).
router.get('/supervision', requireAuth, async (req, res) => {
  try {
    const sup = req.query.supervisor_id || SUPERVISOR();
    if (!sup) return res.status(400).json({ error: 'No supervisor configured' });

    const [schedule, sessions] = await Promise.all([
      fetchSupervisionSchedule(sup),
      fetchSupervisionSessions(sup, { limit: 100 }),
    ]);
    res.json({ schedule, sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ps/caseload/sync — manual "Sync now"; ?dry=1 to preview
router.post('/caseload/sync', requireAuth, async (req, res) => {
  try {
    const result = await syncCaseload({
      dryRun:     req.query.dry === '1',
      allowEmpty: req.query.allow_empty === '1',
    });
    res.json(result);
  } catch (err) {
    await logFailure(SUPERVISOR(), err).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ps/caseload/cron — the daily poll (cron-secret protected)
router.post('/caseload/cron', async (req, res) => {
  const secret   = process.env.CRON_SECRET;
  const provided = req.headers['x-cron-secret'] || req.query.secret;
  if (!secret || provided !== secret) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await syncCaseload({});
    res.json({ ok: true, ...result });
  } catch (err) {
    await logFailure(SUPERVISOR(), err).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

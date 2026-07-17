const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { InsyncCoSignEngine } = require('../utils/peerSupervisorEngine');
const { syncCaseload, logFailure } = require('../utils/caseloadSync');

// ── Co-Sign ───────────────────────────────────────────────────────────────────

async function buildEngine() {
  const { data: rows } = await supabase.from('app_settings').select('key, value')
    .in('key', ['insync_username','insync_password','insync_provider_id',
                'ps_no_school_start','ps_no_school_end','anthropic_api_key']);
  const S = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
  return new InsyncCoSignEngine({
    username:      S.insync_username    || process.env.INSYNC_USERNAME      || '',
    password:      S.insync_password    || process.env.INSYNC_PASSWORD      || '',
    anthropicKey:  S.anthropic_api_key  || process.env.ANTHROPIC_API_KEY    || '',
    providerId:    S.insync_provider_id || process.env.INSYNC_PROVIDER_ID   || '2317',
    noSchoolStart: S.ps_no_school_start || '',
    noSchoolEnd:   S.ps_no_school_end   || '',
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
router.post('/cosign/sign', requireAuth, requireAdmin, async (req, res) => {
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

    res.json({ signed, failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ps/cosign/reopen — reopen (send back to peer for revision) one or
// more notes. Body: { notes: [{ eid, pid, reason }] }. Each note is gated on
// InSync's claim-generated check, so billed encounters are refused per-note.
router.post('/cosign/reopen', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { notes } = req.body;
    if (!notes?.length) return res.status(400).json({ error: 'notes required' });

    const engine = await buildEngine();
    await engine.login();

    const results = [];
    for (const n of notes) {
      if (!n.eid || !n.pid) { results.push({ eid: n.eid || null, ok: false, message: 'Missing encounter id' }); continue; }
      try {
        results.push({ eid: n.eid, ...(await engine.reopenNote({ eid: n.eid, pid: n.pid, reason: n.reason || '' })) });
      } catch (e) {
        results.push({ eid: n.eid, ok: false, message: e.message });
      }
    }
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const { no_school_start, no_school_end, provider_id, insync_username, insync_password, anthropic_api_key } = req.body;
    const map = {
      ps_no_school_start: no_school_start,
      ps_no_school_end:   no_school_end,
      insync_provider_id: provider_id,
      insync_username,
      insync_password,
      anthropic_api_key,
    };
    for (const [key, value] of Object.entries(map))
      if (value !== undefined && value !== null)
        await supabase.from('app_settings').upsert({ key, value }, { onConflict: 'key' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ps/cosign/settings
router.get('/cosign/settings', requireAuth, requireAdmin, async (req, res) => {
  const { data } = await supabase.from('app_settings').select('key, value')
    .in('key', ['ps_no_school_start','ps_no_school_end','insync_provider_id',
                'insync_username','insync_password','anthropic_api_key']);
  const S = Object.fromEntries((data || []).map(r => [r.key, r.value]));
  res.json({
    no_school_start:   S.ps_no_school_start || '07/01',
    no_school_end:     S.ps_no_school_end   || '08/31',
    provider_id:       S.insync_provider_id  || '2317',
    insync_username:   S.insync_username     || '',
    insync_password:   S.insync_password     || '',
    anthropic_api_key: S.anthropic_api_key   || '',
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

const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { InsyncCoSignEngine } = require('../utils/peerSupervisorEngine');

// ── Cohorts ───────────────────────────────────────────────────────

router.get('/cohorts', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('ps_cohorts').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/cohorts', requireAuth, async (req, res) => {
  const { name, day_of_week, time } = req.body;
  if (!name || day_of_week == null || !time) return res.status(400).json({ error: 'name, day_of_week, time required' });
  const { data, error } = await supabase.from('ps_cohorts')
    .insert({ name: name.trim(), day_of_week: parseInt(day_of_week), time })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.put('/cohorts/:id', requireAuth, async (req, res) => {
  const { name, day_of_week, time } = req.body;
  const updates = {};
  if (name       !== undefined) updates.name        = name.trim();
  if (day_of_week != null)      updates.day_of_week = parseInt(day_of_week);
  if (time       !== undefined) updates.time        = time;
  const { data, error } = await supabase.from('ps_cohorts').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/cohorts/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('ps_cohorts').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// POST /cohorts/:id/generate — create N sessions every 2 weeks, skipping existing dates
router.post('/cohorts/:id/generate', requireAuth, async (req, res) => {
  const { start_date, occurrences } = req.body;
  if (!start_date || !occurrences) return res.status(400).json({ error: 'start_date and occurrences required' });

  const { data: cohort, error: ce } = await supabase.from('ps_cohorts').select('*').eq('id', req.params.id).single();
  if (ce || !cohort) return res.status(404).json({ error: 'Cohort not found' });

  // Find the first occurrence of cohort.day_of_week on or after start_date
  const base = new Date(start_date + 'T12:00:00');
  const diff = (cohort.day_of_week - base.getDay() + 7) % 7;
  base.setDate(base.getDate() + diff);

  const dates = [];
  for (let i = 0; i < parseInt(occurrences, 10); i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i * 14);
    dates.push(d.toISOString().split('T')[0]);
  }

  // Skip dates already in DB for this cohort
  const { data: existing } = await supabase.from('ps_sessions').select('date').eq('cohort_id', cohort.id);
  const existingDates = new Set((existing || []).map(s => s.date));
  const toInsert = dates.filter(d => !existingDates.has(d)).map(d => ({
    cohort_id: cohort.id, date: d, status: 'scheduled',
  }));

  if (toInsert.length) {
    const { error: ie } = await supabase.from('ps_sessions').insert(toInsert);
    if (ie) return res.status(500).json({ error: ie.message });
  }

  res.json({ ok: true, generated: toInsert.length, skipped: dates.length - toInsert.length });
});

// ── Sessions ──────────────────────────────────────────────────────

router.get('/sessions', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('ps_sessions')
    .select('*, cohort:ps_cohorts(id, name, day_of_week, time)')
    .order('date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/sessions/:id', requireAuth, async (req, res) => {
  const { status } = req.body;
  const { data, error } = await supabase.from('ps_sessions')
    .update({ status })
    .eq('id', req.params.id)
    .select('*, cohort:ps_cohorts(id, name, day_of_week, time)')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/sessions/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('ps_sessions').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

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

module.exports = router;

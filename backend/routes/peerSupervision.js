const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');

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

module.exports = router;

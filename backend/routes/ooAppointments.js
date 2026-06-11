const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');

// GET all appointments (with client info)
router.get('/', requireAuth, async (req, res) => {
  const { client_id, week_start, week_end } = req.query;
  let query = supabase
    .from('oo_appointments')
    .select('*, oo_clients(id, first_name, last_name, mrn, status, referral_source_id, oo_referral_sources(id, name, notes_email))')
    .order('date').order('time');

  if (client_id)  query = query.eq('client_id', client_id);
  if (week_start) query = query.gte('date', week_start);
  if (week_end)   query = query.lte('date', week_end);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET calls page data — all active clients with appointment in rolling 7-day window
router.get('/calls', requireAuth, async (req, res) => {
  const now = new Date();
  const windowEnd = new Date(now);
  windowEnd.setDate(now.getDate() + 6);
  const ws = now.toISOString().split('T')[0];
  const we = windowEnd.toISOString().split('T')[0];

  const [{ data: clients }, { data: appts }] = await Promise.all([
    supabase.from('oo_clients').select('id, first_name, last_name, mrn, referral_source_id, oo_referral_sources(name)').eq('status', 'active').order('last_name'),
    supabase.from('oo_appointments').select('*').gte('date', ws).lte('date', we).eq('status', 'scheduled'),
  ]);

  const apptByClient = {};
  for (const a of (appts || [])) {
    if (!apptByClient[a.client_id]) apptByClient[a.client_id] = [];
    apptByClient[a.client_id].push(a);
  }

  const result = (clients || []).map(c => {
    const clientAppts = (apptByClient[c.id] || []).sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.time.localeCompare(b.time);
    });
    const nextAppt = clientAppts[0] || null;
    const called = nextAppt && nextAppt.raw_notes && nextAppt.raw_notes.trim().length > 0;
    return { ...c, next_appointment: nextAppt, called: !!called };
  });

  res.json({ clients: result, week_start: ws, week_end: we });
});

// POST create appointments (with repeat)
router.post('/', requireAuth, async (req, res) => {
  const { client_id, date, time, duration, repeat_weeks } = req.body;
  if (!client_id || !date || !time) return res.status(400).json({ error: 'client_id, date, time required' });

  const weeks = Math.max(1, parseInt(repeat_weeks) || 1);
  const dur   = parseInt(duration) || 45;
  const rows  = [];

  for (let i = 0; i < weeks; i++) {
    const d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + i * 7);
    rows.push({
      client_id,
      date: d.toISOString().split('T')[0],
      time,
      duration: dur,
      status: 'scheduled',
    });
  }

  // Check for time conflicts: same time slot, any client (including this one)
  const dates = rows.map(r => r.date);
  const { data: existing } = await supabase
    .from('oo_appointments')
    .select('date, time, client_id, oo_clients(first_name, last_name)')
    .in('date', dates)
    .eq('time', time)
    .eq('status', 'scheduled');

  const conflicts = (existing || []).map(a => {
    const who = a.client_id === client_id
      ? 'same client already booked'
      : `${a.oo_clients?.first_name} ${a.oo_clients?.last_name}`;
    return `${a.date} ${time} — ${who}`;
  });

  const { data, error } = await supabase.from('oo_appointments').insert(rows).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ appointments: data, conflicts });
});

// PATCH update appointment (notes, status)
router.patch('/:id', requireAuth, async (req, res) => {
  const allowed = ['raw_notes', 'status', 'duration', 'date', 'time', 'note_sent_at', 'note_sent_email_id'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('oo_appointments')
    .update(updates)
    .eq('id', req.params.id)
    .select('*, oo_clients(id, first_name, last_name, mrn)')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE
router.delete('/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('oo_appointments').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;

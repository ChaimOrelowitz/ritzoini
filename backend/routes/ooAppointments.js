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
    supabase.from('oo_clients').select('id, first_name, last_name, mrn, referral_source_id, insync_data, oo_referral_sources(name)').eq('status', 'active').order('last_name'),
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

// POST bulk schedule — assign multiple clients to days of the week, auto-assign times back-to-back
router.post('/bulk-schedule', requireAuth, async (req, res) => {
  const { assignments, weeks, start_date, start_time } = req.body;
  if (!assignments?.length || !weeks || !start_date || !start_time) {
    return res.status(400).json({ error: 'assignments, weeks, start_date, start_time required' });
  }

  // Find the Sunday of the week containing start_date
  const anchor = new Date(start_date + 'T12:00:00Z');
  const weekSunday = new Date(anchor);
  weekSunday.setUTCDate(anchor.getUTCDate() - anchor.getUTCDay());

  // Build date -> [{client_id, duration}] map
  const dateMap = {};
  for (const a of assignments) {
    for (const day of a.days) { // 0=Sun … 5=Fri
      for (let w = 0; w < weeks; w++) {
        const d = new Date(weekSunday);
        d.setUTCDate(weekSunday.getUTCDate() + w * 7 + day);
        const dateStr = d.toISOString().split('T')[0];
        if (dateStr < start_date) continue;
        if (!dateMap[dateStr]) dateMap[dateStr] = [];
        dateMap[dateStr].push({ client_id: a.client_id, duration: parseInt(a.duration) || 45 });
      }
    }
  }

  const allDates = Object.keys(dateMap);
  if (!allDates.length) return res.json({ created: 0, conflicts: [] });

  // Fetch existing scheduled appointments on these dates
  const { data: existing } = await supabase
    .from('oo_appointments')
    .select('date, time, duration, client_id')
    .in('date', allDates)
    .eq('status', 'scheduled');

  const existingByDate = {};
  for (const a of (existing || [])) {
    if (!existingByDate[a.date]) existingByDate[a.date] = [];
    existingByDate[a.date].push(a);
  }

  function timeToMins(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
  function minsToTime(m) { return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:00`; }

  const startMins = timeToMins(start_time);
  const rows = [];

  for (const date of allDates.sort()) {
    // Build sorted list of occupied intervals for this date
    const occupied = (existingByDate[date] || []).map(a => ({
      start: timeToMins(a.time),
      end:   timeToMins(a.time) + (a.duration || 45),
    })).sort((a, b) => a.start - b.start);

    let cursor = startMins;

    for (const { client_id, duration } of dateMap[date]) {
      let slotStart = cursor;
      // Push past any overlapping existing interval
      let moved = true;
      while (moved) {
        moved = false;
        for (const iv of occupied) {
          if (slotStart < iv.end && slotStart + duration > iv.start) {
            slotStart = iv.end;
            moved = true;
            break;
          }
        }
      }
      const slotEnd = slotStart + duration;
      rows.push({ client_id, date, time: minsToTime(slotStart), duration, status: 'scheduled' });
      // Reserve this slot so the next client on the same day starts after it
      occupied.push({ start: slotStart, end: slotEnd });
      occupied.sort((a, b) => a.start - b.start);
      cursor = slotEnd;
    }
  }

  const { data: inserted, error } = await supabase.from('oo_appointments').insert(rows).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ created: inserted.length, total_dates: allDates.length });
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

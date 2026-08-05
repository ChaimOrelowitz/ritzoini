const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtLabel(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${MONTHS[parseInt(m)-1]} ${parseInt(d)}, ${y}`;
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pay_periods').select('*').order('start_date', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { start_date, end_date, label, gross_amount } = req.body;
    if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
    const autoLabel = label || `${fmtLabel(start_date)} – ${fmtLabel(end_date)}`;
    const { data, error } = await supabase
      .from('pay_periods')
      .insert({ start_date, end_date, label: autoLabel, gross_amount: gross_amount || null })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/generate', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { count = 13, anchor_date = '2026-01-06' } = req.body;

    // Continue the biweekly cadence forward from the most recent existing
    // period. If none exist yet, start at the anchor date.
    const { data: latest, error: latestErr } = await supabase
      .from('pay_periods')
      .select('start_date')
      .order('start_date', { ascending: false })
      .limit(1);
    if (latestErr) throw latestErr;

    const cur = (latest && latest.length)
      ? new Date(latest[0].start_date + 'T00:00:00Z')
      : new Date(anchor_date + 'T00:00:00Z');
    // First new period starts one cadence (14 days) after the latest one;
    // when starting from the anchor we use the anchor itself as-is.
    if (latest && latest.length) cur.setUTCDate(cur.getUTCDate() + 14);

    const existingStarts = new Set((latest || []).map(p => p.start_date));
    const toInsert = [];
    for (let i = 0; i < count; i++) {
      const end = new Date(cur);
      end.setUTCDate(end.getUTCDate() + 13);
      const s = cur.toISOString().split('T')[0];
      const e = end.toISOString().split('T')[0];
      if (!existingStarts.has(s)) {
        toInsert.push({ start_date: s, end_date: e, label: `${fmtLabel(s)} – ${fmtLabel(e)}` });
      }
      cur.setUTCDate(cur.getUTCDate() + 14);
    }

    if (!toInsert.length) return res.json({ inserted: 0, message: 'All periods already exist' });

    const { data, error } = await supabase.from('pay_periods').insert(toInsert).select();
    if (error) throw error;
    res.json({ inserted: data.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { start_date, end_date, label, gross_amount } = req.body;
    const updates = {};
    if (start_date  !== undefined) updates.start_date  = start_date;
    if (end_date    !== undefined) updates.end_date    = end_date;
    if (label       !== undefined) updates.label       = label;
    if (gross_amount !== undefined) updates.gross_amount = gross_amount;
    if (start_date && end_date && !label) updates.label = `${fmtLabel(start_date)} – ${fmtLabel(end_date)}`;
    const { data, error } = await supabase
      .from('pay_periods').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('pay_periods').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

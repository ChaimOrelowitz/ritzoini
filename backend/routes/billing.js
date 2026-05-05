const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const supabase = require('../db/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function parseStubEntries(text) {
  const markerIdx = text.search(/information\s*&\s*announcements/i);
  const block = markerIdx !== -1 ? text.slice(markerIdx) : text;
  const entries = [];

  for (const raw of block.split('\n')) {
    const line = raw.trim();
    const dateMatch = line.match(/(\d{1,2}\/\d{1,2}\/\d{4})$/);
    if (!dateMatch) continue;

    const dateStr = dateMatch[1];
    const billingName = line.slice(0, line.lastIndexOf(dateStr)).trim();
    if (!billingName) continue;

    const [m, d, y] = dateStr.split('/');
    const date = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    entries.push({ billingName, date });
  }

  return entries;
}

async function matchEntries(entries) {
  const { data: groups } = await supabase
    .from('groups')
    .select('id, billing_name, internal_name, group_name')
    .not('billing_name', 'is', null)
    .neq('billing_name', '');

  const byBillingName = {};
  (groups || []).forEach(g => { byBillingName[g.billing_name] = g; });

  const matched = [];
  const unmatchedMap = {};

  for (const entry of entries) {
    const group = byBillingName[entry.billingName];
    if (!group) {
      if (!unmatchedMap[entry.billingName]) unmatchedMap[entry.billingName] = [];
      unmatchedMap[entry.billingName].push(entry.date);
      continue;
    }

    const { data: session } = await supabase
      .from('sessions')
      .select('id, session_date, ecw_time, paid, status')
      .eq('group_id', group.id)
      .eq('session_date', entry.date)
      .maybeSingle();

    matched.push({ billingName: entry.billingName, date: entry.date, group, session: session || null });
  }

  const unmatched = Object.entries(unmatchedMap).map(([billingName, dates]) => ({ billingName, dates }));
  return { matched, unmatched };
}

// POST /api/billing/parse-stub
router.post('/parse-stub', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const data = await pdfParse(req.file.buffer);
    const entries = parseStubEntries(data.text);
    if (!entries.length) return res.status(400).json({ error: 'No session lines found in PDF. Make sure the PDF has an "Information & Announcements" section.' });
    const { matched, unmatched } = await matchEntries(entries);
    res.json({ matched, unmatched });
  } catch (err) {
    console.error('[billing parse-stub]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/save-mappings  — saves billing_name to groups, then re-matches the pending entries
router.post('/save-mappings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { mappings, entries } = req.body;
    if (!mappings?.length) return res.status(400).json({ error: 'No mappings provided' });

    for (const { group_id, billing_name } of mappings) {
      await supabase.from('groups').update({ billing_name }).eq('id', group_id);
    }

    const { matched, unmatched } = await matchEntries(entries || []);
    res.json({ matched, unmatched });
  } catch (err) {
    console.error('[billing save-mappings]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

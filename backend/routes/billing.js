const express = require('express');
const router = express.Router();
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const XLSX = require('xlsx');
const supabase = require('../db/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function parseExcelEntries(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // Find the header row (contains "Group Name")
  let startRow = 0;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0] || '').toLowerCase().includes('group name')) { startRow = i + 1; break; }
  }

  const entries = [];
  for (let i = startRow; i < rows.length; i++) {
    const billingName = String(rows[i][0] || '').trim();
    const dateRaw     = rows[i][1];
    if (!billingName || !dateRaw) continue;

    let date = null;
    if (typeof dateRaw === 'number') {
      // Excel serial date
      const d = XLSX.SSF.parse_date_code(dateRaw);
      if (d) date = `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
    } else {
      const s = String(dateRaw).trim();
      const parts = s.split('/');
      if (parts.length === 3) {
        let [m, d, y] = parts.map(Number);
        if (y < 100) y += 2000;
        date = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      }
    }

    if (date) entries.push({ billingName, date });
  }
  return entries;
}

async function extractEntriesFromPDF(buffer) {
  const base64 = buffer.toString('base64');

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        },
        {
          type: 'text',
          text: `Extract every session entry from the "Information & Announcements" section of this pay stub.

Each line in that section looks like: <Group Name> <Date>
The date is at the end in M/D/YYYY format, sometimes run together with the last digits of the time (e.g. "Sensory Thursday 5:004/16/2026").

Return ONLY a JSON array, no explanation. Each element: { "billingName": "<everything before the date>", "date": "YYYY-MM-DD" }

Example output:
[{"billingName":"Sensory Gym Sunday 3:15 PM","date":"2026-03-29"},{"billingName":"Art Sunday 4:30pm","date":"2026-04-12"}]`,
        },
      ],
    }],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Could not parse session list from PDF');
  return JSON.parse(jsonMatch[0]);
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

// POST /api/billing/parse-stub  — accepts PDF or Excel
router.post('/parse-stub', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const name = req.file.originalname.toLowerCase();
    const isExcel = name.endsWith('.xlsx') || name.endsWith('.xls');
    const entries = isExcel
      ? parseExcelEntries(req.file.buffer)
      : await extractEntriesFromPDF(req.file.buffer);

    if (!entries.length) return res.status(400).json({ error: 'No session entries found in file.' });
    const { matched, unmatched } = await matchEntries(entries);
    res.json({ matched, unmatched });
  } catch (err) {
    console.error('[billing parse-stub]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/save-mappings
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

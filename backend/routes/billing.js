const express = require('express');
const router = express.Router();
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../db/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

// POST /api/billing/parse-stub
router.post('/parse-stub', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const entries = await extractEntriesFromPDF(req.file.buffer);
    if (!entries.length) return res.status(400).json({ error: 'No session entries found in PDF.' });
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

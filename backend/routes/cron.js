const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { autoCompleteSessions } = require('./sessions');

function requireCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers['x-cron-secret'] || req.query.secret;
  if (!secret || provided !== secret) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// POST /api/cron/process-sessions
router.post('/process-sessions', requireCronSecret, async (req, res) => {
  const log = [];
  let processed = 0, skipped = 0, failed = 0;

  try {
    const { data: groups, error } = await supabase
      .from('groups')
      .select('id')
      .eq('status', 'active');

    if (error) throw error;

    for (const group of (groups || [])) {
      try {
        await autoCompleteSessions(group.id);
        processed++;
        log.push({ id: group.id, status: 'ok' });
      } catch (err) {
        failed++;
        log.push({ id: group.id, status: 'error', error: err.message });
        console.error(`[cron] Failed group ${group.id}:`, err.message);
      }
    }

    console.log(`[cron] process-sessions: groups=${groups?.length || 0} processed=${processed} failed=${failed}`);
    res.json({ processed, skipped, failed, log });
  } catch (err) {
    console.error('[cron] Fatal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

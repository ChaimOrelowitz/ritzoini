const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');

router.get('/:key', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', req.params.key)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ value: data?.value || null });
});

router.post('/:key', requireAuth, async (req, res) => {
  const { value } = req.body;
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key: req.params.key, value, updated_at: new Date().toISOString() });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;

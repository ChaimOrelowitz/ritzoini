const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');
const { generateOrRefreshDigest } = require('../utils/peerDigestGenerator');

function isoToday() { return new Date().toISOString().slice(0, 10); }
function isoMinus6() {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return d.toISOString().slice(0, 10);
}

// POST /api/oo/peer-digest/generate
// Manual client-triggered digest: trailing 7 days ending today.
router.post('/generate', requireAuth, async (req, res) => {
  try {
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });

    const { data: client, error: clientErr } = await supabase
      .from('oo_clients')
      .select('id, first_name, last_name')
      .eq('id', client_id)
      .single();
    if (clientErr || !client) return res.status(404).json({ error: 'Client not found' });

    const result = await generateOrRefreshDigest({
      clientId:          client_id,
      clientName:        `${client.first_name || ''} ${client.last_name || ''}`.trim(),
      generationMode:    'ManualClientTriggered',
      digestWindowStart: isoMinus6(),
      digestWindowEnd:   isoToday(),
    });

    res.json(result);
  } catch (err) {
    console.error('[peer-digest/generate]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/oo/peer-digest/client/:clientId
// Returns the best available digest for this client:
// most recent by digest_window_end, then created_at.
router.get('/client/:clientId', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('peer_weekly_digests')
      .select('*')
      .eq('client_id', req.params.clientId)
      .order('digest_window_end', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    res.json(data || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

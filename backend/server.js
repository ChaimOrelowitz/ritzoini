const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { getEmailEnabled, setEmailEnabled, loadEmailEnabled } = require('./utils/mailer');
const { getDeliveryMode, setDeliveryMode, loadDeliveryMode } = require('./utils/soapNoteDelivery');
const { zohoDiagnostic } = require('./utils/zohoCrm');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://localhost:3001',
    'https://ritzoini.vercel.app',
    'https://ritzoini.corsolutions.io',
  ],
  credentials: true,
}));

// Scoped ahead of the global parser so the raw bytes are available for Zoom's
// webhook signature verification (body-parser no-ops on the second json() call).
app.use('/api/zoom/webhook', express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.json());

// Routes
app.use('/api/groups',      require('./routes/groups'));
app.use('/api/sessions',    require('./routes/sessions'));
app.use('/api/users',       require('./routes/users'));
app.use('/api/instructors', require('./routes/instructors'));
app.use('/api/pay-periods',  require('./routes/payPeriods'));
app.use('/api/payments',     require('./routes/payments'));
app.use('/api/bulk-import',  require('./routes/bulkImport'));
app.use('/api/billing',      require('./routes/billing'));
app.use('/api/cron',         require('./routes/cron'));
app.use('/api/email',        require('./routes/email'));
app.use('/api/oo/clients',       require('./routes/ooClients'));
app.use('/api/oo/appointments',  require('./routes/ooAppointments'));
app.use('/api/oo/insync-notes',  require('./routes/ooInsyncNotes'));
app.use('/api/oo/peer-digest',   require('./routes/ooPeerDigest'));
app.use('/api/settings',         require('./routes/settings'));
app.use('/api/zoom',             require('./routes/zoomWebhooks'));
app.use('/api/ps',               require('./routes/peerSupervision'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'Ritzoini API' });
});

app.get('/api/config/email', requireAuth, (req, res) => {
  res.json({ email_enabled: getEmailEnabled() });
});

app.post('/api/config/email', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  const { enabled } = req.body;
  await setEmailEnabled(enabled);
  res.json({ email_enabled: getEmailEnabled() });
});

// SOAP note delivery mode: 'zoho' | 'email' | 'both'
app.get('/api/config/soap-note-delivery', requireAuth, (req, res) => {
  res.json({ mode: getDeliveryMode() });
});

app.post('/api/config/soap-note-delivery', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  try {
    await setDeliveryMode(req.body.mode);
    res.json({ mode: getDeliveryMode() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Read-only Zoho connectivity/scope/match check (admin). ?session_id=… also
// tests whether that session's occurrence resolves. Writes nothing.
app.get('/api/config/zoho-test', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  try {
    res.json(await zohoDiagnostic(req.query.session_id || null));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  await loadEmailEnabled();
  await loadDeliveryMode();
  console.log(`Ritzoini API running on port ${PORT} (email_enabled: ${getEmailEnabled()}, soap_note_delivery: ${getDeliveryMode()})`);
});

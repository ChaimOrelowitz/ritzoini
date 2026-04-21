const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { getEmailEnabled, setEmailEnabled, loadEmailEnabled } = require('./utils/mailer');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://localhost:3001',
    'https://ritzoini.vercel.app',
  ],
  credentials: true,
}));

app.use(express.json());

// Routes
app.use('/api/groups',      require('./routes/groups'));
app.use('/api/sessions',    require('./routes/sessions'));
app.use('/api/users',       require('./routes/users'));
app.use('/api/instructors', require('./routes/instructors'));
app.use('/api/pay-periods',  require('./routes/payPeriods'));
app.use('/api/payments',     require('./routes/payments'));
app.use('/api/bulk-import',  require('./routes/bulkImport'));
app.use('/api/cron',         require('./routes/cron'));

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

app.listen(PORT, async () => {
  await loadEmailEnabled();
  console.log(`Ritzoini API running on port ${PORT} (email_enabled: ${getEmailEnabled()})`);
});

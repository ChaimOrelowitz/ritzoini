const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { getEmailEnabled, setEmailEnabled, loadEmailEnabled } = require('./utils/mailer');
const { getDeliveryMode, setDeliveryMode, loadDeliveryMode } = require('./utils/soapNoteDelivery');
const { zohoDiagnostic, zohoWriteTest, exchangeGrantCode, loadZohoRefreshToken, getOccurrenceRaw, syncZohoGroups, zohoLockBackfill, getRoster } = require('./utils/zohoCrm');
const { requireAuth } = require('./middleware/auth');
const supabase = require('./db/supabase');
const { reflectZohoCancellations } = require('./routes/sessions');

const app = express();
const PORT = process.env.PORT || 4000;

// Render terminates TLS in front of this process; without this req.ip is the
// proxy and req.protocol is always http, which would defeat both the private
// contact routes' rate limiting and their HTTPS check.
app.set('trust proxy', 1);

// ── TEMPORARY DIAGNOSTIC — DELETE AFTER THE PROPFIND REACHABILITY TEST ───────
// Answers one question: does a PROPFIND/REPORT from the public internet reach
// this Node process at all, or does Render's edge answer 405 on its own?
//
// First middleware in the stack, so it sees every request before any router,
// parser or auth check. It records the METHOD ONLY — never a path (card URLs
// embed a peer's record id), never a header, body, credential or contact field.
// The counter endpoint returns method tallies and nothing else.
const __davProbe = Object.create(null);
app.use((req, res, next) => {
  const method = String(req.method).toUpperCase().replace(/[^A-Z-]/g, '').slice(0, 20);
  __davProbe[method] = (__davProbe[method] || 0) + 1;
  console.log(`[dav-probe] DAVPROBE1 method=${method}`);
  next();
});
app.get('/api/__dav-probe', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ marker: 'DAVPROBE1', methods_since_boot: __davProbe });
});
// ── END TEMPORARY DIAGNOSTIC ────────────────────────────────────────────────

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
// Private, read-only CardDAV address books for iPhone Contacts. Mounted ahead
// of the JSON parser because PROPFIND/REPORT bodies are XML, and the router
// brings its own text parser plus Basic-auth, HTTPS and rate-limit guards.
const carddav = require('./routes/carddav');
app.use('/.well-known/carddav', carddav.wellKnown);
app.use('/carddav', carddav);
app.propfind('/', carddav.rootDiscovery);

app.use(express.json({ limit: '5mb' }));

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
app.use('/api/ps/payroll',       require('./routes/psPayroll'));
app.use('/api/dsc',              require('./routes/dscRecipients'));

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

// Safe write probe (admin): rewrites one occurrence's note to its own value to
// prove write scope. Changes no data.
app.post('/api/config/zoho-write-test', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  try {
    res.json(await zohoWriteTest());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Exchange a Self Client grant code for a refresh token (admin). Returns the
// refresh_token to paste into ZOHO_REFRESH_TOKEN. Does not persist anything.
app.post('/api/config/zoho-exchange', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  try {
    res.json(await exchangeGrantCode(req.body.code));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Read-only: dump one occurrence's full raw Zoho record (admin). For diagnosing
// field values/formats (Session_Name, Session_Date, parent Session lookup, …).
app.get('/api/config/zoho-inspect', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  try {
    res.json(await getOccurrenceRaw(req.query.occurrence_id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Link a Zoho instructor to a Ritzoini instructor (Roster reconciliation).
app.post('/api/config/zoho-instructor-link', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  const { zoho_instructor_id, ritzoini_instructor_id } = req.body;
  if (!zoho_instructor_id) return res.status(400).json({ error: 'zoho_instructor_id required' });
  try {
    const { error } = await supabase.from('zoho_instructors')
      .update({ ritzoini_instructor_id: ritzoini_instructor_id || null }).eq('id', zoho_instructor_id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Roster: the configured therapist's Zoho groups (from the cache) for the Roster page.
app.get('/api/config/zoho-roster', requireAuth, async (req, res) => {
  try {
    res.json(await getRoster());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Everything the Zoho alignment page needs: all Ritzoini groups + cached Zoho groups.
app.get('/api/config/zoho-alignment', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  try {
    const [g, z] = await Promise.all([
      supabase.from('groups').select('id, group_name, internal_name, status, zoho_session_id').order('group_name'),
      supabase.from('zoho_groups').select('id, session_name, session_code, group_activity, class_day').order('session_name'),
    ]);
    if (g.error) throw g.error;
    if (z.error) throw z.error;
    res.json({ groups: g.data || [], zohoGroups: z.data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-time lock reconciliation for sessions with a Zoho note (dry-run unless
// { apply: true }). Ritzoini-writes only.
app.post('/api/config/zoho-lock-backfill', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  try {
    res.json(await zohoLockBackfill({ apply: req.body.apply === true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List the cached Zoho groups (for the manual link picker dropdown).
app.get('/api/config/zoho-groups', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('zoho_groups')
      .select('id, session_name, session_code, group_activity, class_day, status')
      .order('session_name');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pull Zoho groups + auto-align to Ritzoini groups by name (admin button).
// Also reflects Zoho cancellations onto Ritzoini sessions (locked ones skipped).
app.post('/api/config/zoho-sync-groups', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  try {
    const result = await syncZohoGroups();
    try { result.cancellations = await reflectZohoCancellations(); }
    catch (e) { console.error('[zoho] reflect-cancellations failed:', e.message); result.cancellations = { error: e.message }; }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  await loadEmailEnabled();
  await loadDeliveryMode();
  await loadZohoRefreshToken();
  console.log(`Ritzoini API running on port ${PORT} (email_enabled: ${getEmailEnabled()}, soap_note_delivery: ${getDeliveryMode()})`);
});

const supabase = require('../db/supabase');

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Fetch profile to get role
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  req.user = { ...user, ...profile };

  // Payroll-only accounts can reach exactly one thing: reading their payroll
  // reports. Every protected route funnels through here, so this is the single
  // chokepoint that keeps them out of the rest of the API (read-only — the
  // finalize/edit/delete payroll routes are POST/PATCH/DELETE and blocked too).
  if (profile?.ps_payroll_only) {
    const path = req.originalUrl.split('?')[0];
    // The trailing-slash form matters: a bare startsWith would also let through
    // any future route whose name merely begins with these letters.
    const allowed =
      (req.method === 'GET' && (path === '/api/ps/payroll' || path.startsWith('/api/ps/payroll/'))) ||
      (req.method === 'GET' && path === '/api/users/me');
    if (!allowed) {
      return res.status(403).json({ error: 'This account can only view payroll reports.' });
    }
  }

  // Portal POC accounts (Bella) reach exactly one screen's API and nothing
  // else. Same chokepoint as ps_payroll_only above — every protected route
  // funnels through requireAuth, so this one check fences the whole API.
  // Unlike the payroll fence this one allows writes, because transcribing a
  // note IS the job; it is the SURFACE that is restricted, not the verbs.
  if (profile?.portal_only) {
    const path = req.originalUrl.split('?')[0];
    const allowed =
      path === '/api/portal' || path.startsWith('/api/portal/') ||
      (req.method === 'GET' && path === '/api/users/me');
    if (!allowed) {
      return res.status(403).json({ error: 'This account can only use the Portal POC screen.' });
    }
  }

  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Co-Sign Review queue: admins, plus non-admin accounts flagged `ps_cosign`
// (assistants who work the queue). Grants the queue only — the Settings tab's
// routes stay behind requireAdmin.
function requireCoSign(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.ps_cosign !== true) {
    return res.status(403).json({ error: 'Co-Sign Review access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireCoSign };

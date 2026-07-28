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
    const allowed =
      (req.method === 'GET' && path.startsWith('/api/ps/payroll')) ||
      (req.method === 'GET' && path === '/api/users/me');
    if (!allowed) {
      return res.status(403).json({ error: 'This account can only view payroll reports.' });
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

module.exports = { requireAuth, requireAdmin };

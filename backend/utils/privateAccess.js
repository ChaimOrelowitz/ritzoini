// Shared guards for the two *private* contact surfaces — the read-only CardDAV
// address books and the DSC recipient API for the Apple Shortcut.
//
// Both serve peer/instructor names, mobile numbers and emails to a phone, so
// everything here is written to fail CLOSED: if a secret or Supabase is not
// configured the route answers 503 and never touches the database. Nothing in
// this file logs a credential, an Authorization header, a phone number, an
// email address or a vCard body.

const crypto = require('crypto');

// ── constant-time comparison ─────────────────────────────────────────────────

// timingSafeEqual throws on length mismatch, which would itself leak length.
// Hashing both sides first makes every comparison fixed-width.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ── configuration ────────────────────────────────────────────────────────────

function supabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

function carddavConfig() {
  const username = process.env.CARDDAV_USERNAME;
  const salt     = process.env.CARDDAV_PASSWORD_SALT;
  const hash     = process.env.CARDDAV_PASSWORD_HASH;
  if (!username || !salt || !hash) return null;
  if (!/^[0-9a-f]+$/i.test(salt) || !/^[0-9a-f]+$/i.test(hash)) return null;
  return { username, salt, hash };
}

function shortcutToken() {
  const t = process.env.DSC_SHORTCUT_TOKEN;
  // A short token would be brute-forceable over the open internet.
  return t && t.length >= 24 ? t : null;
}

// ── password verification ────────────────────────────────────────────────────

const SCRYPT_KEYLEN = 32;

function scryptHex(password, saltHex) {
  return crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN).toString('hex');
}

// iOS re-authenticates on every request in a sync burst, and scrypt is
// deliberately slow. Cache the *verdict* for a short window, keyed by a hash of
// the credentials so the password itself is never held in memory as plaintext.
const verifyCache = new Map();
const VERIFY_TTL_MS = 60_000;

function verifyPassword(password, cfg) {
  const key = crypto.createHash('sha256')
    .update(`${cfg.salt}:${password}`, 'utf8').digest('hex');

  const hit = verifyCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.ok;

  const ok = safeEqual(scryptHex(password, cfg.salt), cfg.hash);
  verifyCache.set(key, { ok, expires: Date.now() + VERIFY_TTL_MS });
  if (verifyCache.size > 64) {
    for (const [k, v] of verifyCache) if (v.expires <= Date.now()) verifyCache.delete(k);
  }
  return ok;
}

function parseBasic(header) {
  if (!header || !/^Basic /i.test(header)) return null;
  let decoded;
  try { decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8'); }
  catch { return null; }
  const i = decoded.indexOf(':');
  if (i === -1) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

// ── transport ────────────────────────────────────────────────────────────────

// Render terminates TLS and forwards the original scheme. Credentials must
// never cross the wire in the clear, so refuse plain HTTP in production.
function requireHttps(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  if (String(proto).split(',')[0].trim() !== 'https') {
    return res.status(403).type('text/plain').send('HTTPS required');
  }
  next();
}

// Private contact data must not sit in any intermediary or client cache.
function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

// ── rate limiting ────────────────────────────────────────────────────────────

// Fixed window, in-memory. The backend runs as a single Render web service, so
// a shared store would be more machinery than the threat warrants.
function rateLimiter({ windowMs, max, name }) {
  const hits = new Map();

  return function limit(req, res, next) {
    const now = Date.now();
    const key = `${name}:${req.ip || 'unknown'}`;
    const rec = hits.get(key);

    if (!rec || rec.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs });
    } else if (++rec.count > max) {
      const retry = Math.ceil((rec.reset - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      console.warn(`[${name}] rate limit exceeded`);
      return res.status(429).type('text/plain').send('Too many requests');
    }

    if (hits.size > 500) {
      for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    }
    next();
  };
}

// ── auth middleware ──────────────────────────────────────────────────────────

// CardDAV on iOS can only offer HTTP Basic, so it gets its own credential pair
// rather than a Supabase JWT (which the Contacts app cannot obtain or refresh).
function requireCarddavAuth(req, res, next) {
  if (!supabaseConfigured()) {
    console.error('[carddav] refusing request: Supabase is not configured');
    return res.status(503).type('text/plain').send('Service not configured');
  }
  const cfg = carddavConfig();
  if (!cfg) {
    console.error('[carddav] refusing request: CardDAV credentials are not configured');
    return res.status(503).type('text/plain').send('Service not configured');
  }

  const creds = parseBasic(req.headers.authorization);
  const ok = creds
    && safeEqual(creds.user, cfg.username)
    && verifyPassword(creds.pass, cfg);

  if (!ok) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Ritzoini Contacts", charset="UTF-8"');
    return res.status(401).type('text/plain').send('Unauthorized');
  }
  next();
}

// The Shortcut can set headers, so it gets a scoped bearer token. Never a query
// parameter: URLs land in logs, screenshots and the Shortcuts share sheet.
function requireShortcutAuth(req, res, next) {
  if (!supabaseConfigured()) {
    console.error('[dsc] refusing request: Supabase is not configured');
    return res.status(503).json({ error: 'Service not configured' });
  }
  const token = shortcutToken();
  if (!token) {
    console.error('[dsc] refusing request: DSC_SHORTCUT_TOKEN is not configured');
    return res.status(503).json({ error: 'Service not configured' });
  }

  const header = req.headers.authorization || '';
  if (!/^Bearer /i.test(header) || !safeEqual(header.slice(7).trim(), token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = {
  safeEqual, scryptHex, parseBasic, verifyPassword,
  supabaseConfigured, carddavConfig, shortcutToken,
  requireHttps, noStore, rateLimiter,
  requireCarddavAuth, requireShortcutAuth,
  SCRYPT_KEYLEN,
};

// The signed envelope that carries a DAV request from the Cloudflare Worker to
// this backend, because Render's edge answers 405 to PROPFIND/REPORT before
// Node sees them.
//
// The Worker keeps a byte-identical copy of canonicalString() in
// carddav-worker/src/envelope.js. If one side changes, both must — a mismatch
// shows up immediately as a signature failure, which is the intended failure
// mode rather than a silent divergence.
//
// The signature binds every part of the request that could change its meaning:
// method, exact path, exact query, timestamp, nonce, a hash of the raw body,
// the DAV headers that alter the response, and a HASH of the Authorization
// header. The credential itself is never signed over in the clear, never
// logged, and never stored — only its digest travels inside the envelope, so a
// captured envelope cannot be replayed with different credentials attached.

const crypto = require('crypto');

const VERSION = 'v1';

// Headers that change what the handler returns. Anything outside this list is
// dropped rather than forwarded, so the envelope carries no cookies, no
// forwarding headers and no client fingerprinting.
const SIGNED_DAV_HEADERS = ['depth', 'content-type', 'if-none-match', 'if-match', 'brief', 'prefer'];

const MAX_BODY_BYTES = 256 * 1024;
const MAX_SKEW_SECONDS = 300;

const sha256 = value =>
  crypto.createHash('sha256').update(value ?? '', typeof value === 'string' ? 'utf8' : undefined).digest('hex');

// Deterministic and unambiguous: a JSON array of strings cannot be confused by
// a delimiter appearing inside a value, which a newline-joined string could.
function canonicalString({ method, path, query, timestamp, nonce, bodyHash, authHash, davHeaders }) {
  const pairs = Object.entries(davHeaders || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [String(k).toLowerCase(), String(v)])
    .filter(([k]) => SIGNED_DAV_HEADERS.includes(k))
    .sort((a, b) => a[0].localeCompare(b[0]));

  return JSON.stringify([
    VERSION,
    String(method).toUpperCase(),
    String(path),
    String(query || ''),
    String(timestamp),
    String(nonce),
    String(bodyHash),
    String(authHash),
    JSON.stringify(pairs),
  ]);
}

const sign = (canonical, secret) =>
  crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');

// Both sides are hex of a fixed length, but hashing again keeps the comparison
// fixed-width even if a caller passes something malformed.
function signaturesMatch(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Only the DAV headers, lowercased — used by both sides to build the same map.
function pickDavHeaders(headers) {
  const out = {};
  for (const name of SIGNED_DAV_HEADERS) {
    const v = headers?.[name] ?? headers?.[name.toLowerCase()];
    if (v !== undefined && v !== null && v !== '') out[name] = String(v);
  }
  return out;
}

// ── replay protection ────────────────────────────────────────────────────────

// A nonce may be used once inside the freshness window. In-memory, which holds
// because the backend runs as a single Render web service; if it is ever scaled
// out, each instance would keep its own view and the window would reopen.
class NonceCache {
  constructor(ttlSeconds = MAX_SKEW_SECONDS * 2) {
    this.ttl = ttlSeconds * 1000;
    this.seen = new Map();
  }

  // True if this nonce is fresh (and records it); false if already used.
  claim(nonce) {
    const now = Date.now();
    if (this.seen.size > 5000) {
      for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
    }
    const existing = this.seen.get(nonce);
    if (existing && existing > now) return false;
    this.seen.set(nonce, now + this.ttl);
    return true;
  }
}

// ── verification ─────────────────────────────────────────────────────────────

// Returns { ok: true, envelope } or { ok: false, status, reason }. `reason` is
// a fixed label safe to log — it never contains request content.
function verifyEnvelope({ envelope, signature, authorization, secret, nonceCache, now = Date.now() }) {
  if (!secret) return { ok: false, status: 503, reason: 'bridge secret not configured' };
  if (!envelope || typeof envelope !== 'object') return { ok: false, status: 400, reason: 'malformed envelope' };
  if (!signature) return { ok: false, status: 401, reason: 'missing signature' };

  const { v, method, path, query, timestamp, nonce, body_sha256: bodyHash, dav_headers: davHeaders } = envelope;

  if (v !== VERSION) return { ok: false, status: 400, reason: 'unsupported envelope version' };
  if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 128) {
    return { ok: false, status: 400, reason: 'malformed nonce' };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, status: 400, reason: 'malformed timestamp' };
  if (Math.abs(now / 1000 - ts) > MAX_SKEW_SECONDS) {
    return { ok: false, status: 401, reason: 'stale timestamp' };
  }

  // The body arrives base64 in the envelope; its digest is what was signed.
  const raw = typeof envelope.body_b64 === 'string' ? Buffer.from(envelope.body_b64, 'base64') : Buffer.alloc(0);
  if (raw.byteLength > MAX_BODY_BYTES) return { ok: false, status: 413, reason: 'body too large' };
  if (sha256(raw) !== String(bodyHash)) return { ok: false, status: 401, reason: 'body hash mismatch' };

  // Binds the credential to the signature without ever signing or storing it.
  const authHash = sha256(authorization || '');
  if (authHash !== String(envelope.authorization_sha256)) {
    return { ok: false, status: 401, reason: 'authorization hash mismatch' };
  }

  const canonical = canonicalString({
    method, path, query, timestamp, nonce, bodyHash, authHash, davHeaders,
  });
  if (!signaturesMatch(sign(canonical, secret), signature)) {
    return { ok: false, status: 401, reason: 'signature mismatch' };
  }

  // Claimed only after the signature verifies, so an unsigned request cannot
  // burn a nonce and lock out the real one.
  if (nonceCache && !nonceCache.claim(nonce)) {
    return { ok: false, status: 401, reason: 'nonce replayed' };
  }

  return { ok: true, envelope: { method, path, query, davHeaders: davHeaders || {}, body: raw.toString('utf8') } };
}

module.exports = {
  VERSION, SIGNED_DAV_HEADERS, MAX_BODY_BYTES, MAX_SKEW_SECONDS,
  sha256, canonicalString, sign, signaturesMatch, pickDavHeaders,
  NonceCache, verifyEnvelope,
};

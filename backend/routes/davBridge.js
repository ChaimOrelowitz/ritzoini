// POST /internal/dav-bridge — the landing point for DAV requests relayed by the
// Cloudflare Worker, since Render's edge answers 405 to PROPFIND and REPORT
// before Node sees them.
//
// This is a TRANSPORT, not an authorisation. A perfectly signed envelope with
// no CardDAV credentials still gets a 401, because handleDav performs the Basic
// auth check itself. Two independent secrets therefore stand between the public
// internet and a contact: the bridge HMAC key and the CardDAV password.
//
// The read-only allowlist is enforced here as well as at the Worker edge, so
// neither layer is the only thing preventing a write.

const express = require('express');
const router  = express.Router();

const { handleDav, isCarddavPath, READ_METHODS, WRITE_METHODS } = require('../utils/carddavCore');
const {
  verifyEnvelope, NonceCache, MAX_BODY_BYTES,
} = require('../utils/davEnvelope');
const { rateLimiter, requireHttps } = require('../utils/privateAccess');

const nonceCache = new NonceCache();

const secret = () => process.env.DAV_BRIDGE_SECRET || null;

router.use(requireHttps);
router.use(express.json({ limit: '512kb' }));
router.use(rateLimiter({ name: 'dav-bridge', windowMs: 5 * 60000, max: 600 }));

// Every rejection logs a fixed reason label and nothing else — no path, no
// header, no credential, no body, no response content.
const refuse = (res, status, reason) => {
  console.warn(`[dav-bridge] refused: ${reason}`);
  return res.status(status).type('text/plain').send('Bridge rejected');
};

router.post('/', async (req, res) => {
  const key = secret();
  if (!key) {
    console.error('[dav-bridge] refusing request: DAV_BRIDGE_SECRET is not configured');
    return res.status(503).type('text/plain').send('Service not configured');
  }

  const signature     = req.headers['x-dav-signature'];
  const authorization = req.headers['x-dav-authorization'] || '';
  const envelope      = req.body;

  const verified = verifyEnvelope({
    envelope, signature, authorization, secret: key, nonceCache,
  });
  if (!verified.ok) return refuse(res, verified.status, verified.reason);

  const { method, path, query, davHeaders, body } = verified.envelope;
  const upper = String(method).toUpperCase();

  // Independent of the Worker's own allowlist, and checked after the signature
  // so an unsigned caller learns nothing about what is permitted.
  if (WRITE_METHODS.includes(upper)) return refuse(res, 403, `write method ${upper}`);
  if (!READ_METHODS.includes(upper)) return refuse(res, 405, `unsupported method ${upper}`);

  // The bridge may only ever address the CardDAV tree.
  if (!isCarddavPath(path)) return refuse(res, 403, 'path outside CardDAV prefix');
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return refuse(res, 413, 'body too large');

  // Authorization is reassembled in memory for the handler's own auth check and
  // goes no further. It is not stored, echoed, or logged.
  const out = await handleDav({
    method: upper,
    path,
    query,
    headers: { ...davHeaders, authorization },
    body,
  });

  console.log(`[dav-bridge] ${upper} -> ${out.status}`);

  // The Worker rebuilds the client's response from exactly this, so status,
  // WWW-Authenticate, DAV, Allow, ETag and Content-Type all survive the hop.
  res.status(200).json({
    status:  out.status,
    headers: out.headers,
    body_b64: Buffer.from(out.body ?? '', 'utf8').toString('base64'),
  });
});

// Nothing else exists here. In particular there is no GET, so the bridge can
// never be poked at from a browser.
router.all('*', (req, res) => refuse(res, 405, 'non-POST on bridge'));

module.exports = router;

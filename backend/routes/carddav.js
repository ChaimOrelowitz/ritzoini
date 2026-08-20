// Express adapter for the CardDAV handler.
//
// All behaviour lives in utils/carddavCore.js; this file only translates
// between Express and the normalised {method,path,query,headers,body} contract,
// and applies the two transport concerns that do not belong in the handler:
// HTTPS enforcement and rate limiting.
//
// On Render this path is currently unreachable for PROPFIND and REPORT — the
// edge answers 405 before Node sees them (measured with an in-process method
// counter). Those methods arrive through routes/davBridge.js instead. GET and
// HEAD are unaffected and still come through here.

const express = require('express');
const router  = express.Router();

const { handleDav } = require('../utils/carddavCore');
const { requireHttps, rateLimiter } = require('../utils/privateAccess');

// Turns an Express request into the handler's normalised input. originalUrl is
// used rather than req.path so the handler always sees the full public path,
// whichever prefix the router happens to be mounted under.
function normalize(req) {
  const [path, query = ''] = String(req.originalUrl || '/').split('?');
  return {
    method:  req.method,
    path,
    query,
    headers: req.headers,
    body:    typeof req.body === 'string' ? req.body : '',
  };
}

function send(res, out) {
  res.status(out.status);
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.send(out.body);
}

// PROPFIND/REPORT bodies are XML; the app-level express.json() ignores them,
// but this router is mounted ahead of it in any case.
const parseBody = express.text({ type: () => true, limit: '256kb' });

// A sync burst is many small requests; the ceiling absorbs a full two-book
// refresh without ever looking like a usable enumeration channel.
const limit = rateLimiter({ name: 'carddav', windowMs: 5 * 60000, max: 600 });

const chain = [parseBody, requireHttps, limit, async (req, res) => {
  send(res, await handleDav(normalize(req)));
}];

router.use(...chain);

module.exports = router;

// Mounted at the app root by server.js for the discovery entry points iOS uses
// when it is given only a hostname: /.well-known/carddav and PROPFIND /.
// Both resolve inside handleDav, which routes on the full path — and neither
// redirects, because authenticated CardDAV clients handle redirects poorly.
module.exports.discovery = chain;

// Read-only CardDAV bridge.
//
// Render's edge answers 405 to PROPFIND and REPORT before the application sees
// them — measured with an in-process method counter, not inferred from a
// `server: cloudflare` header. Cloudflare Workers, by contrast, do receive
// those methods (also measured). So this Worker fronts the CardDAV hostname:
//
//   GET / HEAD          → proxied straight to the origin; those methods are
//                         not blocked and streaming the response back keeps
//                         ETag and 304 handling exactly as it was.
//   OPTIONS / PROPFIND  → wrapped in an HMAC-signed envelope and POSTed to the
//   REPORT                origin's private bridge route, which unwraps it and
//                         calls the same CardDAV handler.
//   everything else     → refused here, and refused again at the origin.
//
// The Worker is a transport. It never decides who may read a contact: the
// client's Authorization header is passed through for the origin's own Basic
// auth check, and a valid signature with no credentials still yields 401.

import {
  canonicalString, sign, sha256, pickDavHeaders, newNonce,
  MAX_BODY_BYTES, VERSION,
} from './envelope.js';

const READ_METHODS   = ['OPTIONS', 'PROPFIND', 'REPORT', 'GET', 'HEAD'];
const BRIDGE_METHODS = ['OPTIONS', 'PROPFIND', 'REPORT'];
const WRITE_METHODS  = [
  'PUT', 'POST', 'DELETE', 'PATCH', 'PROPPATCH', 'MKCOL', 'MKCALENDAR',
  'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'ACL', 'BIND', 'REBIND', 'UNBIND',
];
const ALLOW = 'OPTIONS, HEAD, GET, PROPFIND, REPORT';

const PRIVATE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// Only paths belonging to the CardDAV tree are carried at all.
const isCarddavPath = p =>
  p === '/' ||
  p === '/.well-known/carddav' || p === '/.well-known/carddav/' ||
  p === '/carddav' || p.startsWith('/carddav/');

// ── privacy-safe diagnostics ─────────────────────────────────────────────────
//
// Everything below emits labels and integers ONLY. No request or response body,
// no URL, no record id, no credential, no name, number or address ever reaches
// a log line. A card's filename is its record id, which is why routes are
// classified rather than printed.

function routeLabel(p) {
  if (p === '/' || p === '') return 'root';
  if (p.startsWith('/.well-known/carddav')) return 'well-known';
  if (p === '/carddav' || p === '/carddav/') return 'root-collection';
  if (/^\/carddav\/principals\//.test(p)) return 'principal';
  if (/^\/carddav\/addressbooks\/dsc\/?$/.test(p)) return 'home';
  const book = p.match(/^\/carddav\/addressbooks\/dsc\/([A-Za-z0-9_-]+)\/?$/);
  if (book) return `book:${book[1]}`;
  const card = p.match(/^\/carddav\/addressbooks\/dsc\/([A-Za-z0-9_-]+)\/[^/]+$/);
  if (card) return `card-in:${card[1]}`;   // the filename is a record id — never logged
  return 'other';
}

// Which REPORT this is. Reads the body but emits only the label.
function reportKind(text) {
  if (/<[\w-]*:?sync-collection[\s>]/i.test(text))       return 'sync-collection';
  if (/<[\w-]*:?addressbook-multiget[\s>]/i.test(text))  return 'multiget';
  if (/<[\w-]*:?addressbook-query[\s>]/i.test(text))     return 'query';
  return 'unknown';
}

const countOf = (text, re) => (text.match(re) || []).length;

// Which Apple daemon is asking — the version string is dropped.
function agentLabel(ua) {
  if (!ua) return 'none';
  if (/dataaccessd/i.test(ua)) return 'ios-dataaccessd';
  if (/accountsd/i.test(ua))   return 'ios-accountsd';
  if (/CardDAV|Contacts/i.test(ua)) return 'ios-contacts';
  return 'other';
}

const plain = (status, message, extra = {}) =>
  new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...PRIVATE_HEADERS, ...extra },
  });

export default {
  async fetch(request, env) {
    const method = request.method.toUpperCase();
    const url = new URL(request.url);

    // Fail closed: without both settings the Worker cannot reach the origin
    // safely, so it refuses rather than forwarding unsigned.
    if (!env.DAV_BRIDGE_SECRET || !env.ORIGIN_BASE_URL) {
      console.log('bridge refusing: worker not configured');
      return plain(503, 'Service not configured');
    }

    if (WRITE_METHODS.includes(method)) {
      console.log(`bridge refused write method=${method}`);
      return plain(403, 'Read-only', { Allow: ALLOW });
    }
    if (!READ_METHODS.includes(method)) {
      console.log(`bridge refused method=${method}`);
      return plain(405, 'Method not allowed', { Allow: ALLOW });
    }
    if (!isCarddavPath(url.pathname)) {
      console.log('bridge refused: path outside CardDAV prefix');
      return plain(404, 'Not found');
    }

    const origin = env.ORIGIN_BASE_URL.replace(/\/+$/, '');

    // GET/HEAD pass through untouched — the origin serves them today.
    if (method === 'GET' || method === 'HEAD') {
      const headers = new Headers();
      const auth = request.headers.get('authorization');
      if (auth) headers.set('authorization', auth);
      const inm = request.headers.get('if-none-match');
      if (inm) headers.set('if-none-match', inm);

      const upstream = await fetch(`${origin}${url.pathname}${url.search}`, { method, headers });
      console.log('bridge passthrough ' + [
        `method=${method}`,
        `route=${routeLabel(url.pathname)}`,
        `status=${upstream.status}`,
        `ua=${agentLabel(request.headers.get('user-agent'))}`,
      ].join(' '));

      const out = new Headers(upstream.headers);
      for (const [k, v] of Object.entries(PRIVATE_HEADERS)) out.set(k, v);
      return new Response(method === 'HEAD' ? null : upstream.body, {
        status: upstream.status,
        headers: out,
      });
    }

    // OPTIONS/PROPFIND/REPORT travel as a signed envelope.
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength > MAX_BODY_BYTES) {
      console.log('bridge refused: body too large');
      return plain(413, 'Request body too large');
    }

    const authorization = request.headers.get('authorization') || '';
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce     = newNonce();
    const bodyHash  = await sha256(raw);
    const authHash  = await sha256(authorization);
    const davHeaders = pickDavHeaders(request.headers);

    const signature = await sign(canonicalString({
      method, path: url.pathname, query: url.search.replace(/^\?/, ''),
      timestamp, nonce, bodyHash, authHash, davHeaders,
    }), env.DAV_BRIDGE_SECRET);

    const envelope = {
      v: VERSION,
      method,
      path: url.pathname,
      query: url.search.replace(/^\?/, ''),
      timestamp,
      nonce,
      body_sha256: bodyHash,
      authorization_sha256: authHash,
      dav_headers: davHeaders,
      body_b64: btoa(String.fromCharCode(...raw)),
    };

    let bridged;
    try {
      bridged = await fetch(`${origin}/internal/dav-bridge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dav-Signature': signature,
          // Carried separately so it is never confused with the bridge's own
          // credentials, and bound to the signature by its hash above.
          'X-Dav-Authorization': authorization,
        },
        body: JSON.stringify(envelope),
      });
    } catch {
      console.log('bridge origin unreachable');
      return plain(502, 'Upstream unavailable');
    }

    if (!bridged.ok) {
      console.log(`bridge origin rejected status=${bridged.status}`);
      return plain(bridged.status === 503 ? 503 : 502, 'Upstream error');
    }

    const payload = await bridged.json();
    const headers = new Headers();
    for (const [k, v] of Object.entries(payload.headers || {})) headers.set(k, v);
    for (const [k, v] of Object.entries(PRIVATE_HEADERS)) headers.set(k, v);

    const body = payload.body_b64
      ? Uint8Array.from(atob(payload.body_b64), c => c.charCodeAt(0))
      : null;

    // Diagnostics: labels and integers only. The bodies are read here to be
    // classified and counted, and neither is logged.
    {
      const reqText = new TextDecoder().decode(raw);
      const resText = body ? new TextDecoder().decode(body) : '';
      const parts = [
        `method=${method}`,
        `route=${routeLabel(url.pathname)}`,
        `depth=${request.headers.get('depth') ?? 'none'}`,
        `status=${payload.status}`,
        `ua=${agentLabel(request.headers.get('user-agent'))}`,
      ];
      if (method === 'REPORT') {
        parts.push(`report=${reportKind(reqText)}`);
        // How many cards the client named vs how many came back.
        parts.push(`hrefs_requested=${countOf(reqText, /<[\w-]*:?href[\s>]/gi)}`);
      }
      parts.push(`responses=${countOf(resText, /<[\w-]*:?response[\s>]/gi)}`);
      parts.push(`address_data=${countOf(resText, /<[\w-]*:?address-data[\s>]/gi)}`);
      parts.push(`sync_token=${/<[\w-]*:?sync-token[\s>]/i.test(resText) ? 1 : 0}`);
      parts.push(`bytes=${resText.length}`);
      console.log('bridge ' + parts.join(' '));
    }

    // The origin's exact status and DAV headers reach the phone — including
    // 401 with WWW-Authenticate, without which Contacts never prompts.
    return new Response(body, { status: payload.status, headers });
  },
};

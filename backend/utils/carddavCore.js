// The CardDAV implementation itself — deliberately free of Express.
//
// Two callers reach it, and they must behave identically:
//   • routes/carddav.js  — ordinary requests, when the host forwards DAV methods
//   • routes/davBridge.js — PROPFIND/REPORT relayed as a signed POST by the
//     Cloudflare Worker, because Render's edge answers 405 to DAV methods
//     before Node ever sees them (measured, not assumed).
//
// So the contract is a plain object in, a plain object out:
//   request  { method, path, query, headers (lowercased), body (string) }
//   response { status, headers, body }
//
// Everything security-relevant lives HERE rather than in middleware, so the
// bridge cannot become a way around it. In particular the Basic-auth check is
// part of this function: a validly-signed envelope with no CardDAV credentials
// still gets a 401. The bridge is a transport, never an authorisation.

const {
  carddavConfig, supabaseConfigured, safeEqual, verifyPassword, parseBasic,
} = require('./privateAccess');
const { fetchActiveCaseload, fetchInstructors } = require('./psCaseload');
const { renderBook } = require('./vcard');
const { MAX_BODY_BYTES } = require('./davEnvelope');

const ROOT       = '/carddav';
const PRINCIPAL  = `${ROOT}/principals/dsc/`;
const HOME       = `${ROOT}/addressbooks/dsc/`;
const VCARD_TYPE = 'text/vcard; charset=utf-8';
const XML_TYPE   = 'application/xml; charset=utf-8';

const BOOKS = {
  'dsc-peers': {
    displayName: 'DSC Peers',
    description: 'Peers currently on the DSC peer-supervision caseload',
    load: fetchActiveCaseload,
  },
  instructors: {
    displayName: 'Ritzoini Instructors',
    description: 'Ritzoini group-therapy instructors',
    load: fetchInstructors,
  },
};

// Read-only by construction. Enforced here AND independently at the Worker
// edge, so neither layer is the only thing standing between a phone and a write.
const READ_METHODS  = ['OPTIONS', 'PROPFIND', 'REPORT', 'GET', 'HEAD'];
const WRITE_METHODS = [
  'PUT', 'POST', 'DELETE', 'PATCH', 'PROPPATCH', 'MKCOL', 'MKCALENDAR',
  'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'ACL', 'BIND', 'REBIND', 'UNBIND',
];
const ALLOW_HEADER = 'OPTIONS, HEAD, GET, PROPFIND, REPORT';

const bookHref = slug => `${HOME}${slug}/`;
const cardHref = (slug, filename) => `${bookHref(slug)}${encodeURIComponent(filename)}`;

// ── XML helpers ──────────────────────────────────────────────────────────────

const NS =
  'xmlns:D="DAV:" ' +
  'xmlns:C="urn:ietf:params:xml:ns:carddav" ' +
  'xmlns:CS="http://calendarserver.org/ns/"';

const xmlEsc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const PREFIX = {
  'getctag':                 'CS',
  'addressbook-home-set':    'C',
  'address-data':            'C',
  'addressbook-description': 'C',
  'supported-address-data':  'C',
  'max-resource-size':       'C',
};
const tagFor = name => `${PREFIX[name] || 'D'}:${name}`;

function propStat(props, status) {
  const body = Object.entries(props)
    .map(([name, inner]) => {
      const tag = tagFor(name);
      return inner === '' || inner == null ? `<${tag}/>` : `<${tag}>${inner}</${tag}>`;
    })
    .join('');
  return `<D:propstat><D:prop>${body}</D:prop><D:status>HTTP/1.1 ${status}</D:status></D:propstat>`;
}

function responseXml(href, found, missing) {
  const parts = [`<D:href>${xmlEsc(href)}</D:href>`];
  if (Object.keys(found).length)   parts.push(propStat(found, '200 OK'));
  if (Object.keys(missing).length) parts.push(propStat(missing, '404 Not Found'));
  return `<D:response>${parts.join('')}</D:response>`;
}

// Names requested in <D:prop>. `null` means allprop — send everything we have.
function requestedProps(body) {
  const xml = typeof body === 'string' ? body : '';
  if (!xml.trim()) return null;
  if (/<[\w-]*:?allprop\s*\/?>/i.test(xml)) return null;

  const block = xml.match(/<[\w-]*:?prop[\s>][\s\S]*?<\/[\w-]*:?prop\s*>/i);
  if (!block) return null;

  const names = [];
  const re = /<([\w-]+:)?([\w-]+)(\s[^>]*)?\/?>/g;
  let m;
  while ((m = re.exec(block[0]))) {
    const name = m[2].toLowerCase();
    if (name !== 'prop') names.push(name);
  }
  return names.length ? [...new Set(names)] : null;
}

// Picks the requested subset out of the resource's full property map, reporting
// anything it does not have as 404 — clients rely on that to stop asking.
function splitProps(available, requested) {
  if (!requested) return { found: available, missing: {} };
  const found = {}, missing = {};
  for (const name of requested) {
    if (name in available) found[name] = available[name];
    else missing[name] = '';
  }
  return { found, missing };
}

// ── property maps ────────────────────────────────────────────────────────────

const PRIVILEGES = '<D:privilege><D:read/></D:privilege>' +
                   '<D:privilege><D:read-current-user-privilege-set/></D:privilege>';

const SUPPORTED_REPORTS =
  '<D:supported-report><D:report><C:addressbook-multiget/></D:report></D:supported-report>' +
  '<D:supported-report><D:report><C:addressbook-query/></D:report></D:supported-report>' +
  '<D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report>';

const syncToken = ctag => `http://ritzoini.corsolutions.io/ns/sync/${ctag}`;

const commonProps = () => ({
  'current-user-principal':     `<D:href>${PRINCIPAL}</D:href>`,
  'principal-url':              `<D:href>${PRINCIPAL}</D:href>`,
  'owner':                      `<D:href>${PRINCIPAL}</D:href>`,
  'current-user-privilege-set': PRIVILEGES,
});

const rootProps = () => ({
  ...commonProps(),
  resourcetype: '<D:collection/>',
  displayname:  'Ritzoini',
});

const principalProps = () => ({
  ...commonProps(),
  resourcetype:           '<D:collection/><D:principal/>',
  displayname:            'Ritzoini',
  'addressbook-home-set': `<D:href>${HOME}</D:href>`,
});

const homeProps = () => ({
  ...commonProps(),
  resourcetype: '<D:collection/>',
  displayname:  'Ritzoini Address Books',
});

// An address book is a COLLECTION. It has no content type of its own, and
// advertising one told clients this resource *is* a vCard file rather than a
// container of them — a coherent reason for a client to stop before
// enumerating members. quota-used-bytes was worse: it carried the card count,
// in a property defined in bytes, with no quota-available-bytes beside it.
// Neither belongs here; both are gone.
const bookProps = (slug, book, ctag) => ({
  ...commonProps(),
  resourcetype:              '<D:collection/><C:addressbook/>',
  displayname:               xmlEsc(book.displayName),
  'addressbook-description': xmlEsc(book.description),
  getctag:                   xmlEsc(ctag),
  // DAV:sync-token is deliberately NOT advertised as a collection property.
  //
  // RFC 6578 permits it, but handing a client the current token as plain
  // metadata lets it adopt that token as a sync baseline without ever having
  // received the members it stands for. iPhone Contacts does exactly that: it
  // read the token off a PROPFIND, then asked "anything new since this?", and
  // the honest answer — nothing — left it permanently synced to a checkpoint
  // whose contents it never fetched. Zero contacts, no errors, forever.
  //
  // A client now learns its baseline the only way that is safe: from the
  // sync-token returned INSIDE a sync-collection REPORT, alongside the members
  // that token accounts for. getctag stays — it signals "something changed"
  // and is not usable as a baseline.
  'supported-report-set':    SUPPORTED_REPORTS,
  'supported-address-data':  '<C:address-data-type content-type="text/vcard" version="3.0"/>',
  'max-resource-size':       '102400',
});

const cardProps = card => ({
  ...commonProps(),
  resourcetype:     '',
  getetag:          xmlEsc(card.etag),
  getcontenttype:   xmlEsc(VCARD_TYPE),
  getcontentlength: String(Buffer.byteLength(card.body, 'utf8')),
  displayname:      xmlEsc(card.contact.display),
  'address-data':   xmlEsc(card.body),
});

// ── responses ────────────────────────────────────────────────────────────────

// Set on every response, so the guarantees survive the Worker hop rather than
// depending on Express middleware the bridge path never runs.
const baseHeaders = () => ({
  'Cache-Control':          'no-store, no-cache, must-revalidate, private',
  'Pragma':                 'no-cache',
  'Expires':                '0',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy':        'no-referrer',
  'DAV':                    '1, 3, addressbook',
  'MS-Author-Via':          'DAV',
});

const reply = (status, headers, body = '') =>
  ({ status, headers: { ...baseHeaders(), ...headers }, body });

const text  = (status, body) => reply(status, { 'Content-Type': 'text/plain; charset=utf-8' }, body);

const multistatus = (responses, extra = '') => reply(207, { 'Content-Type': XML_TYPE },
  `<?xml version="1.0" encoding="utf-8"?><D:multistatus ${NS}>${responses.join('')}${extra}</D:multistatus>`);

const davError = (status, inner, extra = {}) => reply(status, { 'Content-Type': XML_TYPE, ...extra },
  `<?xml version="1.0" encoding="utf-8"?><D:error ${NS}>${inner}</D:error>`);

const unauthorized = () => reply(401, {
  'WWW-Authenticate': 'Basic realm="Ritzoini Contacts", charset="UTF-8"',
  'Content-Type':     'text/plain; charset=utf-8',
}, 'Unauthorized');

// ── routing ──────────────────────────────────────────────────────────────────

// Explicit table rather than a framework router, so both callers resolve paths
// the same way and nothing depends on Express's mounting behaviour.
function matchRoute(rawPath) {
  const path = String(rawPath || '');

  // Reject traversal and doubled separators before any matching. The regexes
  // below would not match them anyway; refusing outright keeps it obvious.
  if (path.includes('..') || path.includes('//') || path.includes('\\')) return null;
  if (!/^[A-Za-z0-9/._~%-]*$/.test(path)) return null;

  if (path === '/' || path === '') return { kind: 'root' };
  if (path === '/.well-known/carddav' || path === '/.well-known/carddav/') return { kind: 'root' };
  if (path === ROOT || path === `${ROOT}/`) return { kind: 'root' };
  if (path === `${ROOT}/principals/dsc` || path === `${ROOT}/principals/dsc/`) return { kind: 'principal' };
  if (path === `${ROOT}/addressbooks/dsc` || path === `${ROOT}/addressbooks/dsc/`) return { kind: 'home' };

  let m = path.match(/^\/carddav\/addressbooks\/dsc\/([A-Za-z0-9_-]+)\/?$/);
  if (m) return { kind: 'book', book: m[1] };

  m = path.match(/^\/carddav\/addressbooks\/dsc\/([A-Za-z0-9_-]+)\/([A-Za-z0-9._%-]+)$/);
  if (m) return { kind: 'card', book: m[1], file: decodeURIComponent(m[2]) };

  return null;
}

// The only paths the bridge may carry.
//
// Traversal is rejected HERE as well as in matchRoute. "/carddav/../api/health"
// starts with the CardDAV prefix, so a naive prefix test admits it and leaves
// matchRoute as the only thing standing between the bridge and the rest of the
// app. That is one layer where the design calls for two.
const isCarddavPath = path => {
  const p = String(path || '');
  if (p.includes('..') || p.includes('//') || p.includes('\\')) return false;
  if (!/^[A-Za-z0-9/._~%-]*$/.test(p)) return false;
  return p === '/' ||
    p === '/.well-known/carddav' || p === '/.well-known/carddav/' ||
    p === ROOT || p.startsWith(`${ROOT}/`);
};

// ── loading ──────────────────────────────────────────────────────────────────

async function loadBook(slug) {
  const book = BOOKS[slug];
  if (!book) return null;
  const contacts = await book.load();
  const { cards, ctag } = renderBook(contacts);
  return { slug, book, cards, ctag };
}

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;
const MAX_MULTIGET_HREFS = 1000;
const MAX_HREF_CHARS = 2048;

class MultigetXmlError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function xmlEntityDecode(value) {
  let out = '';
  for (let i = 0; i < value.length;) {
    if (value[i] !== '&') {
      out += value[i++];
      continue;
    }

    const end = value.indexOf(';', i + 1);
    if (end < 0) throw new MultigetXmlError('unterminated entity');
    const entity = value.slice(i + 1, end);
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    let decoded = named[entity];
    let numeric = null;

    if (decoded === undefined && /^#\d+$/.test(entity)) {
      numeric = Number(entity.slice(1));
    } else if (decoded === undefined && /^#x[0-9a-f]+$/i.test(entity)) {
      numeric = parseInt(entity.slice(2), 16);
    } else if (decoded === undefined) {
      throw new MultigetXmlError('unsupported entity');
    }

    const cp = numeric === null ? decoded.codePointAt(0) : numeric;
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ||
        (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d)) {
      throw new MultigetXmlError('invalid XML character');
    }
    if (numeric !== null) decoded = String.fromCodePoint(numeric);
    out += decoded;
    i = end + 1;
  }
  return out;
}

function splitQName(name) {
  if (!XML_NAME.test(name)) throw new MultigetXmlError('invalid XML name');
  const colon = name.indexOf(':');
  return colon < 0
    ? { prefix: '', local: name }
    : { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
}

function parseStartTag(source) {
  let text = source.trim();
  const selfClosing = text.endsWith('/');
  if (selfClosing) text = text.slice(0, -1).trimEnd();

  const nameMatch = text.match(/^([^\s]+)([\s\S]*)$/);
  if (!nameMatch) throw new MultigetXmlError('missing XML name');
  const name = nameMatch[1];
  splitQName(name);

  const attrs = [];
  const seen = new Set();
  let rest = nameMatch[2];
  while (rest.length) {
    const ws = rest.match(/^\s+/);
    if (!ws) throw new MultigetXmlError('malformed attributes');
    rest = rest.slice(ws[0].length);
    if (!rest.length) break;

    const attr = rest.match(/^([^\s=]+)\s*=\s*(["'])([\s\S]*?)\2/);
    if (!attr) throw new MultigetXmlError('malformed attribute');
    splitQName(attr[1]);
    if (seen.has(attr[1])) throw new MultigetXmlError('duplicate attribute');
    seen.add(attr[1]);
    attrs.push([attr[1], xmlEntityDecode(attr[3])]);
    rest = rest.slice(attr[0].length);
  }
  return { name, attrs, selfClosing };
}

function tagEnd(xml, start) {
  let quote = null;
  for (let i = start; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  throw new MultigetXmlError('unterminated tag');
}

// A deliberately narrow XML parser for CardDAV multiget. There is no XML
// dependency in this service. This accepts Apple's namespace declarations on
// each href, but only collects DAV:href elements that are direct children of a
// CardDAV addressbook-multiget root. Nested/unrelated href elements cannot be
// mistaken for requested cards. DTDs and custom entities are never interpreted.
function multigetHrefs(xml) {
  const body = typeof xml === 'string' ? xml : '';
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    throw new MultigetXmlError('body too large', 413);
  }

  const stack = [];
  const hrefs = [];
  let rootSeen = false;
  let rootClosed = false;
  let hrefText = null;

  for (let i = 0; i < body.length;) {
    if (body[i] !== '<') {
      const next = body.indexOf('<', i);
      const end = next < 0 ? body.length : next;
      const chunk = body.slice(i, end);
      if (hrefText !== null) hrefText += chunk;
      else if (!stack.length && chunk.trim()) throw new MultigetXmlError('text outside root');
      i = end;
      continue;
    }

    if (body.startsWith('<!--', i)) {
      const end = body.indexOf('-->', i + 4);
      if (end < 0) throw new MultigetXmlError('unterminated comment');
      if (hrefText !== null) throw new MultigetXmlError('markup inside href');
      i = end + 3;
      continue;
    }
    if (body.startsWith('<?', i)) {
      const end = body.indexOf('?>', i + 2);
      if (end < 0) throw new MultigetXmlError('unterminated processing instruction');
      if (hrefText !== null) throw new MultigetXmlError('markup inside href');
      i = end + 2;
      continue;
    }
    if (body.startsWith('<!', i)) throw new MultigetXmlError('declarations are not allowed');

    const end = tagEnd(body, i + 1);
    const raw = body.slice(i + 1, end);
    if (raw.startsWith('/')) {
      const closeName = raw.slice(1).trim();
      splitQName(closeName);
      const current = stack[stack.length - 1];
      if (!current || current.name !== closeName) throw new MultigetXmlError('mismatched closing tag');

      if (current.isHref) {
        const href = xmlEntityDecode(hrefText).trim();
        if (!href || href.length > MAX_HREF_CHARS) throw new MultigetXmlError('invalid href');
        hrefs.push(href);
        if (hrefs.length > MAX_MULTIGET_HREFS) throw new MultigetXmlError('too many hrefs', 413);
        hrefText = null;
      }
      stack.pop();
      if (!stack.length) rootClosed = true;
      i = end + 1;
      continue;
    }

    if (rootClosed) throw new MultigetXmlError('multiple root elements');
    if (hrefText !== null) throw new MultigetXmlError('markup inside href');

    const tag = parseStartTag(raw);
    const parentNs = stack.length ? stack[stack.length - 1].nsMap : new Map();
    const nsMap = new Map(parentNs);
    for (const [name, value] of tag.attrs) {
      if (name === 'xmlns') nsMap.set('', value);
      else if (name.startsWith('xmlns:')) nsMap.set(name.slice(6), value);
    }
    const qname = splitQName(tag.name);
    const ns = nsMap.get(qname.prefix);
    if (ns === undefined) throw new MultigetXmlError('undeclared namespace prefix');

    if (!rootSeen) {
      if (qname.local !== 'addressbook-multiget' ||
          ns !== 'urn:ietf:params:xml:ns:carddav') {
        throw new MultigetXmlError('wrong root element');
      }
      rootSeen = true;
    }

    const isHref = stack.length === 1 && qname.local === 'href' && ns === 'DAV:';
    const entry = { name: tag.name, nsMap, isHref };
    if (tag.selfClosing) {
      if (isHref) throw new MultigetXmlError('empty href');
      if (!stack.length) rootClosed = true;
    } else {
      stack.push(entry);
      if (isHref) hrefText = '';
    }
    i = end + 1;
  }

  if (!rootSeen || !rootClosed || stack.length) throw new MultigetXmlError('incomplete XML');
  return hrefs;
}

function filenameFromMultigetHref(href, slug) {
  let url;
  try {
    url = new URL(href, `https://carddav.invalid${bookHref(slug)}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) return null;

  const prefix = bookHref(slug);
  if (!url.pathname.startsWith(prefix)) return null;
  const encoded = url.pathname.slice(prefix.length);
  if (!encoded || encoded.includes('/')) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

const tokenIn = xml => {
  const m = String(xml || '').match(/<[\w-]*:?sync-token\s*>([\s\S]*?)<\/[\w-]*:?sync-token\s*>/i);
  return m ? m[1].trim() : null;
};

// ── auth ─────────────────────────────────────────────────────────────────────

function checkCredentials(authorization) {
  const cfg = carddavConfig();
  if (!cfg) return { ok: false, configured: false };

  const creds = parseBasic(authorization);
  const ok = Boolean(creds)
    && safeEqual(creds.user, cfg.username)
    && verifyPassword(creds.pass, cfg);
  return { ok, configured: true };
}

// ── the handler ──────────────────────────────────────────────────────────────

async function handleDav(nreq) {
  const method  = String(nreq?.method || '').toUpperCase();
  const path    = String(nreq?.path || '');
  const headers = nreq?.headers || {};
  const body    = typeof nreq?.body === 'string' ? nreq.body : '';
  const depth   = String(headers.depth ?? '0').trim();

  // 1. Configuration — fail closed, before any database work.
  if (!supabaseConfigured()) {
    console.error('[carddav] refusing request: Supabase is not configured');
    return text(503, 'Service not configured');
  }

  // 2. Method allowlist. Writes are named explicitly so the refusal is a
  //    deliberate 403 rather than an incidental 405.
  if (WRITE_METHODS.includes(method)) {
    console.warn(`[carddav] refused write method ${method}`);
    return davError(403, '<D:need-privileges/>', { Allow: ALLOW_HEADER });
  }
  if (!READ_METHODS.includes(method)) {
    return reply(405, { Allow: ALLOW_HEADER, 'Content-Type': 'text/plain; charset=utf-8' },
      'Method not allowed');
  }

  // 3. Authentication — inside the handler, so the bridge cannot bypass it.
  const auth = checkCredentials(headers.authorization);
  if (!auth.configured) {
    console.error('[carddav] refusing request: CardDAV credentials are not configured');
    return text(503, 'Service not configured');
  }
  if (!auth.ok) return unauthorized();

  // 4. Route.
  const route = matchRoute(path);
  if (!route) return text(404, 'Not found');

  if (method === 'OPTIONS') {
    return reply(200, { Allow: ALLOW_HEADER });
  }

  try {
    return await dispatch({ route, method, headers, body, depth });
  } catch (err) {
    console.error(`[carddav] ${method} ${route.kind} failed: ${err.message}`);
    return text(500, 'Server error');
  }
}

async function dispatch({ route, method, headers, body, depth }) {
  const requested = requestedProps(body);

  // ── PROPFIND ──
  if (method === 'PROPFIND') {
    if (route.kind === 'root') {
      const p = splitProps(rootProps(), requested);
      return multistatus([responseXml(`${ROOT}/`, p.found, p.missing)]);
    }

    if (route.kind === 'principal') {
      const p = splitProps(principalProps(), requested);
      return multistatus([responseXml(PRINCIPAL, p.found, p.missing)]);
    }

    if (route.kind === 'home') {
      const responses = [];
      const home = splitProps(homeProps(), requested);
      responses.push(responseXml(HOME, home.found, home.missing));

      if (depth !== '0') {
        for (const slug of Object.keys(BOOKS)) {
          const loaded = await loadBook(slug);
          const p = splitProps(
            bookProps(slug, loaded.book, loaded.ctag), requested);
          responses.push(responseXml(bookHref(slug), p.found, p.missing));
        }
      }
      console.log(`[carddav] PROPFIND home depth=${depth} 207`);
      return multistatus(responses);
    }

    if (route.kind === 'book') {
      const loaded = await loadBook(route.book);
      if (!loaded) return text(404, 'Not found');

      const responses = [];
      const self = splitProps(
        bookProps(loaded.slug, loaded.book, loaded.ctag), requested);
      responses.push(responseXml(bookHref(loaded.slug), self.found, self.missing));

      if (depth !== '0') {
        for (const card of loaded.cards) {
          const p = splitProps(cardProps(card), requested);
          responses.push(responseXml(cardHref(loaded.slug, card.filename), p.found, p.missing));
        }
      }
      console.log(`[carddav] PROPFIND book:${loaded.slug} depth=${depth} members=${loaded.cards.length} 207`);
      return multistatus(responses);
    }

    if (route.kind === 'card') {
      const loaded = await loadBook(route.book);
      if (!loaded) return text(404, 'Not found');
      const card = loaded.cards.find(c => c.filename === route.file);
      if (!card) return text(404, 'Not found');

      const p = splitProps(cardProps(card), requested);
      return multistatus([responseXml(cardHref(loaded.slug, card.filename), p.found, p.missing)]);
    }

    return text(404, 'Not found');
  }

  // ── REPORT ──
  if (method === 'REPORT') {
    if (route.kind !== 'book') return text(404, 'Not found');
    const loaded = await loadBook(route.book);
    if (!loaded) return text(404, 'Not found');

    const emit = card => {
      const p = splitProps(cardProps(card), requested);
      return responseXml(cardHref(loaded.slug, card.filename), p.found, p.missing);
    };

    // sync-collection — RFC 6578
    if (/<[\w-]*:?sync-collection[\s>]/i.test(body)) {
      const current = syncToken(loaded.ctag);
      const given   = tokenIn(body);

      if (given && given === current) {
        console.log(`[carddav] REPORT sync book:${loaded.slug} unchanged 207`);
        return multistatus([], `<D:sync-token>${xmlEsc(current)}</D:sync-token>`);
      }

      // No change history is kept, so a stale token cannot be turned into a
      // delta. Rejecting it makes the client fall back to a full PROPFIND,
      // which is the only way deletions are seen reliably.
      if (given && given !== current) {
        console.warn(`[carddav] REPORT sync book:${loaded.slug} stale token 403`);
        return davError(403, '<D:valid-sync-token/>');
      }

      console.log(`[carddav] REPORT sync book:${loaded.slug} initial members=${loaded.cards.length} 207`);
      return multistatus(loaded.cards.map(emit),
        `<D:sync-token>${xmlEsc(current)}</D:sync-token>`);
    }

    // addressbook-multiget — only the hrefs the client names
    if (/<[\w-]*:?addressbook-multiget[\s>]/i.test(body)) {
      let hrefs;
      try {
        hrefs = multigetHrefs(body);
      } catch (err) {
        const status = err instanceof MultigetXmlError ? err.status : 400;
        console.warn(`[carddav] REPORT multiget book:${loaded.slug} invalid XML ${status}`);
        return davError(status, '<D:valid-request/>');
      }
      const wanted = new Set(hrefs
        .map(h => filenameFromMultigetHref(h, loaded.slug))
        .filter(Boolean));
      const hit = loaded.cards.filter(c => wanted.has(c.filename));
      console.log(`[carddav] REPORT multiget book:${loaded.slug} asked=${wanted.size} sent=${hit.length} 207`);
      return multistatus(hit.map(emit));
    }

    // addressbook-query — the books are small enough that returning every card
    // is cheaper than interpreting the filter grammar, and always a valid
    // superset of what any filter would select.
    console.log(`[carddav] REPORT query book:${loaded.slug} members=${loaded.cards.length} 207`);
    return multistatus(loaded.cards.map(emit));
  }

  // ── GET / HEAD ──
  if (method === 'GET' || method === 'HEAD') {
    if (route.kind !== 'card') {
      // A bare GET on a collection is not part of CardDAV; answering with
      // anything resembling a contact list would create a second, unintended
      // export path.
      return text(405, 'Use PROPFIND or REPORT');
    }

    const loaded = await loadBook(route.book);
    if (!loaded) return text(404, 'Not found');
    const card = loaded.cards.find(c => c.filename === route.file);
    if (!card) return text(404, 'Not found');

    // Cards are byte-stable, so an unchanged ETag means the phone already has
    // this contact — saying so is most of what keeps routine syncs cheap.
    if (headers['if-none-match'] === card.etag) return reply(304, { ETag: card.etag });

    return reply(200, { 'Content-Type': VCARD_TYPE, ETag: card.etag },
      method === 'HEAD' ? '' : card.body);
  }

  return text(405, 'Method not allowed');
}

module.exports = {
  handleDav, matchRoute, isCarddavPath, checkCredentials,
  READ_METHODS, WRITE_METHODS, ALLOW_HEADER,
  BOOKS, ROOT, PRINCIPAL, HOME, VCARD_TYPE,
};

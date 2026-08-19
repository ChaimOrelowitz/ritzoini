// Read-only CardDAV server: publishes two private address books to iPhone
// Contacts over HTTP Basic.
//
//   /carddav/addressbooks/dsc/dsc-peers/    → "DSC Peers"            (live caseload)
//   /carddav/addressbooks/dsc/instructors/  → "Ritzoini Instructors" (instructors table)
//
// STRICTLY read-only. Every mutating method is refused with 403 and there is no
// code path from here back into Supabase or Airtable — an edit made on the
// phone stays on the phone and is overwritten at the next sync.
//
// Discovery chain iOS walks:
//   PROPFIND /.well-known/carddav (301) → / → current-user-principal
//     → /carddav/principals/dsc/       → addressbook-home-set
//       → /carddav/addressbooks/dsc/   → Depth:1 lists the two books
//         → each book                  → Depth:1 lists hrefs + ETags
//           → GET or addressbook-multiget for the cards

const express = require('express');
const router  = express.Router();

const { fetchActiveCaseload, fetchInstructors } = require('../utils/psCaseload');
const { renderBook } = require('../utils/vcard');
const {
  requireHttps, noStore, rateLimiter, requireCarddavAuth,
} = require('../utils/privateAccess');

const ROOT       = '/carddav';
const PRINCIPAL  = `${ROOT}/principals/dsc/`;
const HOME       = `${ROOT}/addressbooks/dsc/`;
const VCARD_TYPE = 'text/vcard; charset=utf-8';

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

// DAV: is the default namespace for these names; the handful that live
// elsewhere are prefixed here so the resolver can stay a flat map.
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

function multistatus(res, responses, extra = '') {
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:multistatus ${NS}>${responses.join('')}${extra}</D:multistatus>`;
  res.status(207).type('application/xml; charset=utf-8').send(xml);
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

const depthOf = req => String(req.headers.depth ?? '0').trim();

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

const bookProps = (slug, book, ctag, count) => ({
  ...commonProps(),
  resourcetype:              '<D:collection/><C:addressbook/>',
  displayname:               xmlEsc(book.displayName),
  'addressbook-description': xmlEsc(book.description),
  getctag:                   xmlEsc(ctag),
  'sync-token':              xmlEsc(syncToken(ctag)),
  'supported-report-set':    SUPPORTED_REPORTS,
  'supported-address-data':  '<C:address-data-type content-type="text/vcard" version="3.0"/>',
  'max-resource-size':       '102400',
  getcontenttype:            'text/vcard',
  'quota-used-bytes':        String(count),
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

// ── loading ──────────────────────────────────────────────────────────────────

async function loadBook(slug) {
  const book = BOOKS[slug];
  if (!book) return null;
  const contacts = await book.load();
  const { cards, ctag } = renderBook(contacts);
  return { slug, book, cards, ctag };
}

// Route label rather than req.path: a card URL embeds a peer's record id, and
// these logs are not the place for it.
const label = (slug, kind) => `${kind}${slug ? `:${slug}` : ''}`;

function fail(res, err, where) {
  console.error(`[carddav] ${where} failed: ${err.message}`);
  res.status(500).type('text/plain').send('Server error');
}

// ── middleware ───────────────────────────────────────────────────────────────

// Scoped body parser: PROPFIND/REPORT carry XML, which the app-level
// express.json() would ignore anyway — but this router is mounted ahead of it.
router.use(express.text({ type: () => true, limit: '256kb' }));
router.use(requireHttps);
router.use(noStore);
// A sync burst is many small requests; the ceiling absorbs a full two-book
// refresh without ever looking like a usable enumeration channel.
router.use(rateLimiter({ name: 'carddav', windowMs: 5 * 60000, max: 600 }));
router.use(requireCarddavAuth);

router.use((req, res, next) => {
  res.setHeader('DAV', '1, 3, addressbook');
  res.setHeader('MS-Author-Via', 'DAV');
  next();
});

// ── write methods: refused ───────────────────────────────────────────────────

const WRITE_METHODS = [
  'PUT', 'POST', 'DELETE', 'PATCH', 'PROPPATCH', 'MKCOL', 'MKCALENDAR',
  'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'ACL', 'BIND', 'REBIND', 'UNBIND',
];

router.use((req, res, next) => {
  if (!WRITE_METHODS.includes(req.method.toUpperCase())) return next();
  console.warn(`[carddav] refused write method ${req.method}`);
  res.setHeader('Allow', 'OPTIONS, HEAD, GET, PROPFIND, REPORT');
  res.status(403)
    .type('application/xml; charset=utf-8')
    .send(`<?xml version="1.0" encoding="utf-8"?><D:error ${NS}><D:need-privileges/></D:error>`);
});

// ── OPTIONS ──────────────────────────────────────────────────────────────────

router.options('*', (req, res) => {
  res.setHeader('Allow', 'OPTIONS, HEAD, GET, PROPFIND, REPORT');
  res.status(200).end();
});

// ── PROPFIND ─────────────────────────────────────────────────────────────────

router.propfind('/', (req, res) => {
  const { found, missing } = splitProps(rootProps(), requestedProps(req.body));
  multistatus(res, [responseXml(`${ROOT}/`, found, missing)]);
});

router.propfind('/principals/dsc/', (req, res) => {
  const { found, missing } = splitProps(principalProps(), requestedProps(req.body));
  multistatus(res, [responseXml(PRINCIPAL, found, missing)]);
});

// Depth:1 here is how iOS discovers that there are two books at all.
router.propfind('/addressbooks/dsc/', async (req, res) => {
  try {
    const requested = requestedProps(req.body);
    const responses = [];

    const home = splitProps(homeProps(), requested);
    responses.push(responseXml(HOME, home.found, home.missing));

    if (depthOf(req) !== '0') {
      for (const slug of Object.keys(BOOKS)) {
        const loaded = await loadBook(slug);
        const p = splitProps(
          bookProps(slug, loaded.book, loaded.ctag, loaded.cards.length), requested);
        responses.push(responseXml(bookHref(slug), p.found, p.missing));
      }
    }

    console.log(`[carddav] PROPFIND home depth=${depthOf(req)} 207`);
    multistatus(res, responses);
  } catch (err) { fail(res, err, 'PROPFIND home'); }
});

router.propfind('/addressbooks/dsc/:book/', async (req, res) => {
  try {
    const loaded = await loadBook(req.params.book);
    if (!loaded) return res.status(404).type('text/plain').send('Not found');

    const requested = requestedProps(req.body);
    const responses = [];

    const self = splitProps(
      bookProps(loaded.slug, loaded.book, loaded.ctag, loaded.cards.length), requested);
    responses.push(responseXml(bookHref(loaded.slug), self.found, self.missing));

    if (depthOf(req) !== '0') {
      for (const card of loaded.cards) {
        const p = splitProps(cardProps(card), requested);
        responses.push(responseXml(cardHref(loaded.slug, card.filename), p.found, p.missing));
      }
    }

    console.log(`[carddav] PROPFIND ${label(loaded.slug, 'book')} ` +
                `depth=${depthOf(req)} members=${loaded.cards.length} 207`);
    multistatus(res, responses);
  } catch (err) { fail(res, err, 'PROPFIND book'); }
});

router.propfind('/addressbooks/dsc/:book/:file', async (req, res) => {
  try {
    const loaded = await loadBook(req.params.book);
    if (!loaded) return res.status(404).type('text/plain').send('Not found');

    const card = loaded.cards.find(c => c.filename === req.params.file);
    if (!card) return res.status(404).type('text/plain').send('Not found');

    const { found, missing } = splitProps(cardProps(card), requestedProps(req.body));
    multistatus(res, [responseXml(cardHref(loaded.slug, card.filename), found, missing)]);
  } catch (err) { fail(res, err, 'PROPFIND card'); }
});

// ── REPORT ───────────────────────────────────────────────────────────────────

const hrefsIn = xml => [...String(xml || '')
  .matchAll(/<[\w-]*:?href\s*>([\s\S]*?)<\/[\w-]*:?href\s*>/gi)]
  .map(m => m[1].trim())
  .filter(Boolean);

const tokenIn = xml => {
  const m = String(xml || '').match(/<[\w-]*:?sync-token\s*>([\s\S]*?)<\/[\w-]*:?sync-token\s*>/i);
  return m ? m[1].trim() : null;
};

router.report('/addressbooks/dsc/:book/', async (req, res) => {
  try {
    const loaded = await loadBook(req.params.book);
    if (!loaded) return res.status(404).type('text/plain').send('Not found');

    const xml       = typeof req.body === 'string' ? req.body : '';
    const requested = requestedProps(xml);
    const emit = card => {
      const p = splitProps(cardProps(card), requested);
      return responseXml(cardHref(loaded.slug, card.filename), p.found, p.missing);
    };

    // sync-collection — RFC 6578
    if (/<[\w-]*:?sync-collection[\s>]/i.test(xml)) {
      const current = syncToken(loaded.ctag);
      const given   = tokenIn(xml);

      if (given && given === current) {
        console.log(`[carddav] REPORT sync ${label(loaded.slug, 'book')} unchanged 207`);
        return multistatus(res, [], `<D:sync-token>${xmlEsc(current)}</D:sync-token>`);
      }

      // No change history is kept, so a stale token cannot be turned into a
      // delta. Rejecting it makes the client fall back to a full PROPFIND,
      // which is the only way deletions are seen reliably.
      if (given && given !== current) {
        console.warn(`[carddav] REPORT sync ${label(loaded.slug, 'book')} stale token 403`);
        return res.status(403).type('application/xml; charset=utf-8').send(
          `<?xml version="1.0" encoding="utf-8"?><D:error ${NS}><D:valid-sync-token/></D:error>`);
      }

      console.log(`[carddav] REPORT sync ${label(loaded.slug, 'book')} ` +
                  `initial members=${loaded.cards.length} 207`);
      return multistatus(res, loaded.cards.map(emit),
        `<D:sync-token>${xmlEsc(current)}</D:sync-token>`);
    }

    // addressbook-multiget — only the hrefs the client names
    if (/<[\w-]*:?addressbook-multiget[\s>]/i.test(xml)) {
      const wanted = new Set(hrefsIn(xml).map(h => decodeURIComponent(h.split('/').pop())));
      const hit = loaded.cards.filter(c => wanted.has(c.filename));
      console.log(`[carddav] REPORT multiget ${label(loaded.slug, 'book')} ` +
                  `asked=${wanted.size} sent=${hit.length} 207`);
      return multistatus(res, hit.map(emit));
    }

    // addressbook-query — the books are small enough that returning every card
    // is cheaper than interpreting the filter grammar, and always a valid
    // superset of what any filter would select.
    console.log(`[carddav] REPORT query ${label(loaded.slug, 'book')} ` +
                `members=${loaded.cards.length} 207`);
    multistatus(res, loaded.cards.map(emit));
  } catch (err) { fail(res, err, 'REPORT'); }
});

// ── GET a card ───────────────────────────────────────────────────────────────

router.get('/addressbooks/dsc/:book/:file', async (req, res) => {
  try {
    const loaded = await loadBook(req.params.book);
    if (!loaded) return res.status(404).type('text/plain').send('Not found');

    const card = loaded.cards.find(c => c.filename === req.params.file);
    if (!card) return res.status(404).type('text/plain').send('Not found');

    res.setHeader('ETag', card.etag);
    if (req.headers['if-none-match'] === card.etag) return res.status(304).end();

    res.status(200).type(VCARD_TYPE).send(card.body);
  } catch (err) { fail(res, err, 'GET card'); }
});

// A bare GET on a collection is not part of CardDAV; answering with anything
// resembling a contact list would create a second, unintended export path.
router.get('*', (req, res) => {
  res.status(405).type('text/plain').send('Use PROPFIND or REPORT');
});

module.exports = router;
module.exports.BOOKS = BOOKS;
module.exports.ROOT = ROOT;
module.exports.PRINCIPAL = PRINCIPAL;

// ── discovery entry points (mounted at the app root by server.js) ────────────

// iOS is given only a hostname, so it starts at /.well-known/carddav and, if
// that fails, PROPFINDs "/". Both are answered here.
const GUARDS = [
  express.text({ type: () => true, limit: '256kb' }),
  requireHttps,
  noStore,
  rateLimiter({ name: 'carddav-discovery', windowMs: 5 * 60000, max: 120 }),
  requireCarddavAuth,
];

const wellKnown = express.Router();
wellKnown.use(...GUARDS);
wellKnown.all('*', (req, res) => {
  // 301 rather than 308: iOS reissues the PROPFIND against the new path, which
  // is exactly what RFC 6764 well-known discovery expects.
  res.redirect(301, `${ROOT}/`);
});

// PROPFIND / — the fallback discovery step. Returns the principal href and
// nothing else; no contact data is reachable from this depth.
const rootDiscovery = [...GUARDS, (req, res) => {
  const { found, missing } = splitProps(rootProps(), requestedProps(req.body));
  multistatus(res, [responseXml('/', found, missing)]);
}];

module.exports.wellKnown = wellKnown;
module.exports.rootDiscovery = rootDiscovery;

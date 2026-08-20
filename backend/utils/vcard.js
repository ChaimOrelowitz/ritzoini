// vCard 3.0 serialisation for the read-only CardDAV books.
//
// iOS Contacts negotiates 3.0 by default and accepts it everywhere, so there is
// no reason to emit 4.0 and risk the older parser. Output must be BYTE STABLE
// for unchanged input: the ETag is a hash of the card, and an ETag that moved
// on its own would make the phone re-download every contact on every sync.

const crypto = require('crypto');

const CRLF   = '\r\n';
const PRODID = '-//Ritzoini//DSC Contacts//EN';

// ── escaping / folding ───────────────────────────────────────────────────────

// Escapes one component of a property value (RFC 6350 §3.4).
function esc(v) {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// Components joined by a separator are escaped individually so the separator
// itself survives — N and ORG are structured, CATEGORIES is a value list.
const joinEsc = (parts, sep) => parts.map(esc).join(sep);

// Long lines fold at 75 octets with a leading space on continuations. Folding
// is measured in bytes, not characters, so a multi-byte name cannot be split
// mid-codepoint and corrupt the card.
function fold(line) {
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= 75) return line;

  const out = [];
  let start = 0;
  let limit = 75;

  while (start < buf.length) {
    let end = Math.min(start + limit, buf.length);
    // Back off until `end` sits on a codepoint boundary.
    while (end > start && end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
    out.push((out.length ? ' ' : '') + buf.slice(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines spend one octet on the leading space
  }
  return out.join(CRLF);
}

// ── REV ──────────────────────────────────────────────────────────────────────

// REV must be derived from stored data, never from the clock: a fresh timestamp
// per request would change the ETag on every poll and put iOS in a resync loop.
function toRev(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

// ── build ────────────────────────────────────────────────────────────────────

function buildVCard(contact) {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `PRODID:${PRODID}`,
    `UID:${esc(contact.uid)}`,
    `N:${joinEsc([contact.last || '', contact.first || '', '', '', ''], ';')}`,
    `FN:${esc(contact.display)}`,
  ];

  if (contact.org?.length)        lines.push(`ORG:${joinEsc(contact.org, ';')}`);
  if (contact.categories?.length) lines.push(`CATEGORIES:${joinEsc(contact.categories, ',')}`);

  // CATEGORIES/ORG carry the cohort in a form other CardDAV clients understand;
  // X-RITZOINI-COHORT keeps the bare value machine-readable on the way back.
  if (contact.cohort) lines.push(`X-RITZOINI-COHORT:${esc(contact.cohort)}`);

  if (contact.phone) lines.push(`TEL;TYPE=CELL,VOICE:${esc(contact.phone)}`);
  if (contact.email) lines.push(`EMAIL;TYPE=INTERNET:${esc(contact.email)}`);

  const rev = toRev(contact.rev);
  if (rev) lines.push(`REV:${rev}`);

  lines.push('END:VCARD');

  return lines.map(fold).join(CRLF) + CRLF;
}

// ── etags ────────────────────────────────────────────────────────────────────

const hash = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// Weak-free, quoted, and a pure function of the card body.
const etagFor = body => `"${hash(body).slice(0, 32)}"`;

// Bumped whenever the SERVER'S REPRESENTATION of a collection changes, even
// though no card did — property maps, hrefs, vCard shape.
//
// A client that has synced and holds a matching ctag stops asking; it has no
// other way to learn the server now answers differently. Without this, a fix to
// how collections are advertised can never reach a client that already cached
// the broken version — it sits there believing it is up to date. Folding the
// version into the tag makes any such change invalidate every cached view.
//
//   1 — initial
//   2 — dropped getcontenttype and quota-used-bytes from address-book
//       collections; both were wrong for a collection and getcontenttype in
//       particular described the book as though it were itself a vCard file
//   3 — stopped advertising DAV:sync-token as a collection property. Clients
//       adopted it as a sync baseline without having received the members it
//       stood for, and then correctly concluded nothing had changed. Bumping
//       invalidates every token already handed out that way.
// Bump whenever a protocol change requires clients to discard a previously
// cached collection representation. Schema 4 forces iOS clients that cached
// the pre-fix empty multiget result to perform a fresh member sync.
const COLLECTION_SCHEMA = 4;

// One value that changes whenever any member changes — serves as both the
// collection CTag and the sync-token payload.
function collectionTag(cards) {
  const material = [
    `schema:${COLLECTION_SCHEMA}`,
    ...cards.map(c => `${c.uid}:${c.etag}`).sort(),
  ].join('\n');
  return hash(material).slice(0, 32);
}

// Renders a whole book once: every card, its ETag, its filename.
function renderBook(contacts) {
  const cards = contacts.map(contact => {
    const body = buildVCard(contact);
    return {
      uid:      contact.uid,
      filename: `${contact.uid}.vcf`,
      contact,
      body,
      etag:     etagFor(body),
    };
  });
  return { cards, ctag: collectionTag(cards) };
}

module.exports = { buildVCard, etagFor, collectionTag, renderBook, fold, esc, toRev, CRLF, COLLECTION_SCHEMA };

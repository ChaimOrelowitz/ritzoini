// Payments 2.0 — batch import. Accepts any mix of stub PDFs, .eml emails,
// .xlsx/.pdf lists and pasted text (one file or a whole backfill folder),
// works out what each one is and which payday it belongs to, and files it.
//
// • Parsing is text-first (PDF text, xlsx cells, line regex); Claude is only
//   a fallback for a PDF whose text yields nothing (see parse.readPdf).
// • Stubs are applied before lists, so a list in the same batch can be
//   placed on its payday by matching the stub's gross.
// • Files with no stub or list content (lock reminders, missing-note
//   notices, replies) are skipped quietly and only counted.
// • A list whose payday isn't certain is held for review, never guessed.

const P = require('./parse');
const S = require('./service');
const D = require('./data');

// Emails about something other than payment, even if they list sessions.
const NOT_PAYMENT_SUBJECT = /lock|missing|reminder|unsigned|not\s*signed|notes?\s*(needed|due|required)|overdue\s*notes?/i;

// One upload → the documents inside it.
async function expand(file, depth = 0, mailCtx = null) {
  const filename = file.originalname || file.filename;
  const contentType = file.mimetype || file.contentType;
  const kind = P.kindOf(filename, contentType);
  const buffer = file.buffer;
  if (kind === 'eml' && depth < 2) {
    const mail = await P.readEml(buffer);
    const ctx = { email_date: mail.email_date, subject_date: P.subjectDate(mail.subject), subject: mail.subject };
    if (NOT_PAYMENT_SUBJECT.test(mail.subject)) return [{ kind: 'ignored', filename, reason: `not a payment email ("${mail.subject}")` }];
    const docs = [];
    for (const a of mail.attachments) docs.push(...await expand({ filename: a.filename, buffer: a.buffer, contentType: a.contentType }, depth + 1, ctx));
    docs.push({ kind: 'text', filename, text: mail.body, emailBody: true, ...ctx, store: { buffer, contentType: 'message/rfc822' } });
    return docs;
  }
  const base = { filename, ...(mailCtx || {}) };
  if (kind === 'pdf' || kind === 'xlsx') return [{ ...base, kind, buffer, store: { buffer, contentType } }];
  if (kind === 'text') return [{ ...base, kind: 'text', text: buffer.toString('utf8'), store: file.pasted ? null : { buffer, contentType: 'text/plain' } }];
  return [{ ...base, kind: 'ignored', reason: 'not a PDF, .eml, .xlsx or text file' }];
}

// A document → { stub, list } (either may be null).
async function read(doc) {
  if (doc.kind === 'pdf') {
    const r = await P.readPdf(doc.buffer);
    const stub = r.stub && r.stub.pay_date ? r.stub : null;
    return {
      stub, via: r.via,
      // A stub that prints its own session list: that list is this payday's.
      list: r.listText ? { text: r.listText, check_date: r.check_date || stub?.pay_date || null } : null,
    };
  }
  if (doc.kind === 'xlsx') {
    const x = P.readXlsx(doc.buffer);
    if (x.ritzoiniExport) return { ignored: 'a spreadsheet exported from Ritzoini (your own claim), not an office pay list' };
    return { list: { text: x.text, check_date: P.findCheckDate(x.text) } };
  }
  // Email bodies and pasted text: prose lines are dropped when parsing.
  if (doc.kind === 'text') return { list: { text: doc.text, check_date: P.findCheckDate(doc.text), prose: true } };
  return {};
}

// files: multer files. opts: { text, pay_date } (pay_date: the person chose it)
async function importBatch(files, { text, pay_date } = {}) {
  const results = [];   // one per stub/list filed, held or failed
  const skipped = [];   // { file, reason } — no stub or list content
  const stubs = [], lists = [];

  const sources = [...(files || [])];
  if (text && text.trim()) sources.push({ originalname: 'pasted text', buffer: Buffer.from(text, 'utf8'), mimetype: 'text/plain', pasted: true });

  for (const f of sources) {
    const name = f.originalname;
    let docs;
    try { docs = await expand(f); }
    catch (e) { results.push({ file: name, outcome: 'error', message: `couldn't open: ${e.message}` }); continue; }

    const found = [];
    let gotStub = false, reason = null;
    for (const doc of docs) {
      if (doc.kind === 'ignored') { reason = doc.reason; continue; }
      try {
        const r = await read(doc);
        if (r.stub) { stubs.push({ file: name, doc, stub: r.stub, via: r.via }); gotStub = true; }
        if (r.ignored) reason = r.ignored;
        if (r.list) {
          const items = P.parseListText(r.list.text, { prose: r.list.prose });
          if (items.length) found.push({ file: name, doc, items, text: r.list.text, check_date: r.list.check_date, prose: !!r.list.prose });
        }
      } catch (e) {
        results.push({ file: doc.filename !== name ? `${name} → ${doc.filename}` : name, outcome: 'error', message: e.message });
      }
    }
    // An email's attachment beats its body (the body often restates it).
    // Repeats within or across emails are dropped later, line by line.
    const attached = found.filter(l => !l.doc.emailBody);
    const chosen = attached.length ? attached : found;
    lists.push(...chosen);
    if (!gotStub && !chosen.length && !results.some(r => r.file === name)) skipped.push({ file: name, reason: reason || 'no stub or session list found' });
  }

  for (const s of stubs) {
    try {
      const r = await S.attachStub(s.stub, { filename: s.doc.filename, buffer: s.doc.buffer, contentType: 'application/pdf' });
      if (r.skipped) { skipped.push({ file: s.file, reason: r.reason }); continue; }
      results.push({ file: s.file, kind: 'stub', outcome: r.ok ? 'stub' : 'error', message: r.reason || null,
        pay_date: r.pay_date, gross_cents: s.stub.gross_cents, status: r.status, read_by: s.via });
    } catch (e) { results.push({ file: s.file, kind: 'stub', outcome: 'error', message: e.message }); }
  }

  const rates = await D.loadRates();
  for (const l of lists) {
    try {
      // The same list again (a forward, a re-sent email, a second upload):
      // nothing new to file, so it never reaches the review screen.
      const dup = await S.alreadyImported(l.items);
      if (dup.already === dup.total) { skipped.push({ file: l.file, reason: `list already imported (payday ${dup.paydays.join(', ')})` }); continue; }
      const amount = l.items.reduce((t, i) => t + (D.rateFor(i.session_date, rates) || 0), 0);
      const resolved = pay_date ? { pay_date, how: 'date you picked' }
        : await S.resolveListPayday({ check_date: l.check_date, subject_date: l.doc.subject_date, email_date: l.doc.email_date, amount_cents: amount });
      const upload = l.doc.store ? { filename: l.doc.filename, buffer: l.doc.store.buffer, contentType: l.doc.store.contentType } : null;
      if (!resolved.pay_date) {
        const stored = upload ? { path: await S.storeFile('pending', upload.filename, upload.buffer, upload.contentType), filename: upload.filename } : null;
        results.push({ file: l.file, kind: 'list', outcome: 'needs_date', lines: l.items.length, list_cents: amount,
          suggested: resolved.suggested, how: resolved.how, text: l.text, stored, prose: l.prose,
          dates: { check_date: l.check_date || null, subject_date: l.doc.subject_date || null, email_date: l.doc.email_date || null },
          first_date: l.items.map(i => i.session_date).sort()[0], last_date: l.items.map(i => i.session_date).sort().pop(),
          preview: l.items.slice(0, 4).map(i => i.raw_line) });
        continue;
      }
      const r = await S.attachList({ pay_date: resolved.pay_date, text: l.text, items: l.items, file: upload });
      if (r.skipped) { skipped.push({ file: l.file, reason: r.reason }); continue; }
      results.push({ file: l.file, kind: 'list', outcome: r.ok ? 'list' : 'error', message: r.reason || null,
        pay_date: resolved.pay_date, how: resolved.how, lines: r.lines, already_imported: r.already_imported,
        auto_matched: r.auto_matched, needs_review: r.needs_review, list_cents: r.list_cents, gross_cents: r.gross_cents, status: r.status });
    } catch (e) { results.push({ file: l.file, kind: 'list', outcome: 'error', message: e.message }); }
  }

  return { results, skipped, files: sources.length };
}

// A list that was held for review: the person picked its payday.
async function resolveHeld({ pay_date, text, stored, prose }) {
  const items = P.parseListText(text, { prose });
  return S.attachList({ pay_date, text, items, stored });
}

// After a batch finishes, a held list may now be certain (its stub arrived in
// a later batch). Files it if so; otherwise reports it's still held.
async function recheckHeld({ text, stored, dates, prose }) {
  const items = P.parseListText(text, { prose });
  const rates = await D.loadRates();
  const amount = items.reduce((t, i) => t + (D.rateFor(i.session_date, rates) || 0), 0);
  const r = await S.resolveListPayday({ ...(dates || {}), amount_cents: amount });
  if (!r.pay_date) return { held: true, suggested: r.suggested, how: r.how };
  return { held: false, how: r.how, ...(await S.attachList({ pay_date: r.pay_date, text, items, stored })) };
}

module.exports = { importBatch, resolveHeld, recheckHeld };

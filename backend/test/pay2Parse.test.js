// Payments 2.0 parser regression tests — real formats seen in the office's
// stubs, emails and spreadsheets. Run: `npm test` (in backend/), or
// `node --test test/pay2Parse.test.js`. No network, no database.

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const P = require('../utils/pay2/parse');

const parsed = line => { const p = P.parseLine(line); return p && [p.billing_name_raw, p.session_date]; };
const hhmm = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

// ── list lines ─────────────────────────────────────────────────────────────
test('stub lines: time glued to the date is split after the two-digit minutes', () => {
  assert.deepEqual(parsed('Sensory Thursday 4:154/16/2026'), ['Sensory Thursday 4:15', '2026-04-16']);
  assert.deepEqual(parsed('Sensory Thursday 5:004/16/2026'), ['Sensory Thursday 5:00', '2026-04-16']);
  assert.deepEqual(parsed('Phone crafts 5:50 (group time 5:45 PM) 7:454/13/2026'),
    ['Phone crafts 5:50 (group time 5:45 PM) 7:45', '2026-04-13']);
  assert.deepEqual(parsed('Sensory Gym 12:3011/2/2026'), ['Sensory Gym 12:30', '2026-11-02']);
});

test('stub lines: a name glued to the date', () => {
  assert.deepEqual(parsed('Awareness Skills Group10/25/2026'), ['Awareness Skills Group', '2026-10-25']);
});

test('"group time" is the first time read from a line', () => {
  const p = P.parseLine('Phone crafts 5:50 (group time 5:45 PM) 7:454/13/2026');
  assert.equal(hhmm(P.lineTimes(p.billing_name_raw)[0]), '17:45');
});

test('ordinary list lines', () => {
  assert.deepEqual(parsed('Sensory Gym 5:45 PM 4/16/2026'), ['Sensory Gym 5:45 PM', '2026-04-16']);
  assert.deepEqual(parsed('Problem-Solving Skills Group\t10/2/2026'), ['Problem-Solving Skills Group', '2026-10-02']);
  assert.deepEqual(parsed('Phone crafts 7:20 PM (group time 5:00 PM) 4/2/26'), ['Phone crafts 7:20 PM (group time 5:00 PM)', '2026-04-02']);
});

test('not sessions: footer voucher rows, headers, dates of other kinds, quotes', () => {
  assert.equal(P.parseLine('491 04/30/2026 (10447)'), null);
  assert.equal(P.parseLine('Group Name  Session Date'), null);
  assert.equal(P.parseLine('Check date: 11/20/2026'), null);
  assert.equal(P.parseLine('Pay Date 04/30/2026'), null);
  assert.equal(P.parseLine('> Sensory Gym 5:45 PM 4/16/2026'), null);
});

test('email bodies: prose lines are ignored, list rows kept', () => {
  const body = [
    'Hi Chaim,',
    'Payroll will be processed on Tuesday 4/28/2026.',
    'Did you get the list from 4/2/2026?',
    'We received your notes for 4/9/2026, thanks',
    'The payment for 4/16/2026 went out',
    'Sensory Gym 5:45 PM 4/16/2026',
    'Problem-Solving Skills Group 4/19/2026',
  ].join('\n');
  const items = P.parseListText(body, { prose: true });
  assert.deepEqual(items.map(i => i.raw_line), ['Sensory Gym 5:45 PM 4/16/2026', 'Problem-Solving Skills Group 4/19/2026']);
});

test('check date and subject date', () => {
  assert.equal(P.findCheckDate('Hello\nCheck date: 4/2/26\nSensory Gym 3/19/2026'), '2026-04-02');
  assert.equal(P.subjectDate('4.24.26 Payment report'), '2026-04-24');
});

// ── stubs ──────────────────────────────────────────────────────────────────
// Text shaped like a real RTG stub: list under "Information & Announcements",
// ending at the RTG ASSOCIATES footer with its account # / pay date / voucher.
const STUB_TEXT = [
  'RTG ASSOCIATES LLC',
  'Earnings Statement',
  'Pay Date 04/30/2026',
  'Period Beginning 04/14/2026 Period Ending 04/27/2026',
  'Hours Paid 10.00',
  'Gross Pay 500.00 7,250.00',
  'Net Pay 461.75',
  'Information & Announcements',
  'Sensory Thursday 4:154/16/2026',
  'Phone crafts 5:50 (group time 5:45 PM) 7:454/13/2026',
  'Awareness Skills Group10/25/2026',
  'Sensory Gym 5:45 PM 4/9/2026',
  'Art Sunday 4:30pm 4/12/2026',
  'Baking Monday 6:005/4/2026',
  'Aqua 9:45 AM4/14/2026',
  'Braingym Sunday 5:004/19/2026',
  'Painting Mon 4:204/20/2026',
  'Hairstyling Wed. 5:204/22/2026',
  'RTG ASSOCIATES',
  '491 04/30/2026 (10447)',
].join('\n');

test('stub: pay date, period, gross and hours paid', () => {
  const r = P.parseStubText(STUB_TEXT);
  assert.equal(r.stub.pay_date, '2026-04-30');
  assert.equal(r.stub.period_start, '2026-04-14');
  assert.equal(r.stub.period_end, '2026-04-27');
  assert.equal(r.stub.gross_cents, 50000);
  assert.equal(r.stub.stub_hours, 10);
});

test('stub: session list stops at the RTG ASSOCIATES footer (10 lines, no voucher row)', () => {
  const items = P.parseListText(P.parseStubText(STUB_TEXT).listText);
  assert.equal(items.length, 10);
  assert.ok(!items.some(i => /491|10447/.test(i.raw_line)));
  assert.equal(items.length * 50, P.parseStubText(STUB_TEXT).stub.gross_cents / 100); // 10 × $50 = gross
});

test('stub PDF is read from its text, without Claude', async () => {
  const buf = await new Promise(resolve => {
    const doc = new PDFDocument(); const chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks)));
    STUB_TEXT.split('\n').forEach(l => doc.text(l)); doc.end();
  });
  const r = await P.readPdf(buf);       // would throw on the Claude path (no key in tests)
  assert.equal(r.via, 'text');
  assert.equal(r.stub.pay_date, '2026-04-30');
  assert.equal(r.stub.stub_hours, 10);
  assert.equal(P.parseListText(r.listText).length, 10);
});

// ── spreadsheets ───────────────────────────────────────────────────────────
const xlsx = rows => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };

test('office spreadsheet: rows become list lines (Excel dates included)', () => {
  const x = P.readXlsx(xlsx([['Group Name', 'Session Date'], ['Problem-Solving Skills Group', new Date(2026, 9, 2)], ['Social Flexibility Skills Group', '10/7/2026']]));
  assert.equal(x.ritzoiniExport, false);
  assert.deepEqual(P.parseListText(x.text).map(i => [i.billing_name_raw, i.session_date]),
    [['Problem-Solving Skills Group', '2026-10-02'], ['Social Flexibility Skills Group', '2026-10-07']]);
});

test('Ritzoini’s own exports are not pay lists', () => {
  const old = P.readXlsx(xlsx([['Billing Name', 'Internal Name', 'Group Name', 'Date', 'ECW Time', 'Status'], ['Problem-Solving Skills Group', 'SenWed500', 'x', '2026-10-02', '17:00', 'Unpaid']]));
  assert.equal(old.ritzoiniExport, true);
  const owed = P.readXlsx(xlsx([['Session date', 'Group', 'Billing name', 'Time', 'Locked at', 'Zoho note id', 'Days waiting', 'Amount'], ['10/2/2026', 'SenWed500', 'x', '17:00', '', '', 9, 55]]));
  assert.equal(owed.ritzoiniExport, true);
});

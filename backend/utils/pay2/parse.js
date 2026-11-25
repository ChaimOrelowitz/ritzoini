// Payments 2.0 — turning uploaded documents into structured data.
//
// Two kinds of document exist per payday (see docs in README "Payments 2.0"):
//   • stub — RTG Associates pay stub PDF: Pay Date, Pay Period, Gross (older
//     stubs also show hours = session count).
//   • list — the billing office's session list: "<Group Name> <M/D/YYYY>"
//     lines, as an email body, .xlsx, .pdf or pasted text.
//
// Everything here is pure parsing — no database access.

const XLSX = require('xlsx');
const { simpleParser } = require('mailparser');
const Anthropic = require('@anthropic-ai/sdk');

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function toIsoDate(m, d, y) {
  m = Number(m); d = Number(d); y = Number(y);
  if (y < 100) y += 2000;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)) return null;
  return iso(y, m, d);
}

// ── Times ──────────────────────────────────────────────────────────────────
// Every time mentioned in a line, as minutes after midnight. "(group time X)"
// is the real ECW time and is listed first. A time with no AM/PM yields both
// readings (sessions run morning through night).
function lineTimes(text) {
  const out = [];
  const add = (h, m, mer) => {
    h = Number(h); m = Number(m);
    if (h > 23 || m > 59) return;
    mer = (mer || '').toLowerCase();
    if (mer.startsWith('p') && h < 12) out.push((h + 12) * 60 + m);
    else if (mer.startsWith('a')) out.push((h === 12 ? 0 : h) * 60 + m);
    else if (h >= 13) out.push(h * 60 + m);
    else { out.push(h * 60 + m); if (h < 12) out.push((h + 12) * 60 + m); }
  };
  const gt = /group\s*time\s*(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/i.exec(text);
  if (gt) add(gt[1], gt[2], gt[3]);
  const re = /(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/gi;
  let m;
  while ((m = re.exec(text))) add(m[1], m[2], m[3]);
  return [...new Set(out)];
}

// ── List lines ─────────────────────────────────────────────────────────────
const NOT_A_SESSION = /check\s*date|pay\s*date|pay\s*period|period\s*(start|end|begin)|invoice\s*date|hire\s*date|birth|statement|\bytd\b|year\s*to\s*date|^\s*(date|sent|from|to|subject|cc)\s*:/i;

// One "<name> <M/D/YYYY>" line → { raw_line, billing_name_raw, session_date }
// or null. The date is the LAST date on the line. Handles the run-together
// form "Sensory Thursday 5:004/16/2026" (time 5:00, date 4/16/2026).
function parseLine(rawLine) {
  const line = String(rawLine || '').replace(/\u00a0/g, ' ').trim();
  if (!line || NOT_A_SESSION.test(line) || /^>/.test(line)) return null;
  const all = [...line.matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/g)];
  if (!all.length) return null;
  const last = all[all.length - 1];
  let month = last[1];
  let before = line.slice(0, last.index);
  // "5:004/16/2026": the regex took "04" as the month; give the "0" back.
  if (/\d:\d$/.test(before) && month.length === 2 && month[0] === '0') {
    before += '0'; month = month.slice(1);
  }
  const session_date = toIsoDate(month, last[2], last[3]);
  if (!session_date) return null;
  const billing_name_raw = before.replace(/[\s,;|\t-]+$/, '').trim();
  if (!billing_name_raw || /^group\s*name/i.test(billing_name_raw)) return null;
  return { raw_line: line, billing_name_raw, session_date };
}

function parseListText(text) {
  const items = [];
  for (const l of String(text || '').split(/\r?\n/)) {
    const p = parseLine(l);
    if (p) items.push({ ...p, line_no: items.length + 1 });
  }
  return items;
}

// "Check date: 11/20/2026" anywhere in the text → ISO date.
function findCheckDate(text) {
  const m = /check\s*date\s*[:\-]?\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i.exec(String(text || ''));
  return m ? toIsoDate(m[1], m[2], m[3]) : null;
}

// ── .xlsx ──────────────────────────────────────────────────────────────────
// Every row becomes a text line ("cells joined", date cells as M/D/YYYY) and
// goes through the same line parser, so all list formats share one path.
function xlsxToText(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const lines = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true });
    for (const row of rows) {
      const cells = row.map(c => {
        if (typeof c === 'number' && c > 30000 && c < 80000) {   // Excel date serial
          const d = XLSX.SSF.parse_date_code(c);
          if (d) return `${d.m}/${d.d}/${d.y}`;
        }
        if (c instanceof Date) return `${c.getMonth() + 1}/${c.getDate()}/${c.getFullYear()}`;
        return String(c ?? '').trim();
      }).filter(Boolean);
      if (cells.length) lines.push(cells.join(' '));
    }
  }
  return lines.join('\n');
}

// ── PDF (Claude) ───────────────────────────────────────────────────────────
// A PDF can be a stub, a list, or a stub that also carries the list in its
// "Information & Announcements" section. One structured-output call reads it.
let anthropic = null; // created on first use so a missing key can't break server start
const PDF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_pay_stub', 'pay_date', 'period_start', 'period_end', 'gross', 'hours', 'check_date', 'session_lines'],
  properties: {
    is_pay_stub:   { type: 'boolean', description: 'true if this is an earnings statement / pay stub' },
    pay_date:      { type: 'string', description: 'Pay Date (or Check Date) as YYYY-MM-DD, "" if absent' },
    period_start:  { type: 'string', description: 'Pay period start YYYY-MM-DD, "" if absent' },
    period_end:    { type: 'string', description: 'Pay period end YYYY-MM-DD, "" if absent' },
    gross:         { type: 'string', description: 'Current-period gross pay as a plain number like "1650.00", "" if absent' },
    hours:         { type: 'string', description: 'Current-period hours as a plain number, "" if absent' },
    check_date:    { type: 'string', description: 'A "Check date" mentioned in a session list, YYYY-MM-DD, "" if absent' },
    session_lines: {
      type: 'array',
      description: 'Every session line, verbatim, each ending in its M/D/YYYY date',
      items: { type: 'string' },
    },
  },
};

async function readPdfWithClaude(buffer) {
  anthropic ||= new Anthropic();
  const res = await anthropic.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: PDF_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
        { type: 'text', text:
`This PDF is either a pay stub (earnings statement), a list of billed therapy group sessions, or a pay stub that also lists sessions (often under "Information & Announcements").

Read it and fill in the fields. Use the CURRENT period's gross and hours, not year-to-date.

For session_lines: copy every line that names a group and ends in a session date, exactly as printed, one string per line, e.g. "Sensory Gym 5:45 PM 4/16/2026" or "Problem-Solving Skills Group 10/2/2026". If the time and date are printed run together (e.g. "5:004/16/2026"), keep them as printed. Do not include headers, totals, pay/period/check dates, or anything that is not a session. Use [] if there are none.` },
      ],
    }],
  });
  if (res.stop_reason === 'refusal') throw new Error('the PDF reader declined this document');
  if (res.stop_reason === 'max_tokens') throw new Error('the PDF was too long to read in one pass');
  const text = res.content.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('the PDF reader returned nothing');
  const out = JSON.parse(text);
  const cents = v => { const n = parseFloat(String(v || '').replace(/[$,]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null; };
  const date = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
  return {
    stub: out.is_pay_stub ? {
      pay_date: date(out.pay_date),
      period_start: date(out.period_start),
      period_end: date(out.period_end),
      gross_cents: cents(out.gross),
      stub_hours: out.hours ? parseFloat(out.hours) || null : null,
    } : null,
    listText: (out.session_lines || []).join('\n'),
    check_date: date(out.check_date),
  };
}

// ── PDF without AI ─────────────────────────────────────────────────────────
// Text extraction + patterns. Returns the same shape as readPdfWithClaude.
const MDY = String.raw`(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})`;
const money = v => { const n = parseFloat(String(v || '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null; };

function parseStubText(text) {
  const t = String(text || '').replace(/ /g, ' ');
  const looksLikeStub = /\bRTG\b/i.test(t) || (/gross/i.test(t) && /(net\s*pay|earnings|deductions)/i.test(t));
  if (!looksLikeStub) return null;
  const pick = re => { const m = re.exec(t); return m ? toIsoDate(m[1], m[2], m[3]) : null; };
  const pay_date = pick(new RegExp(String.raw`(?:pay|check)\s*date\s*[:\-]?\s*` + MDY, 'i'));
  let period_start = pick(new RegExp(String.raw`period\s*(?:start|begin(?:ning)?)\s*(?:date)?\s*[:\-]?\s*` + MDY, 'i'));
  let period_end   = pick(new RegExp(String.raw`period\s*end(?:ing)?\s*(?:date)?\s*[:\-]?\s*` + MDY, 'i'));
  if (!period_start || !period_end) {
    const m = new RegExp(String.raw`pay\s*period\s*[:\-]?\s*` + MDY + String.raw`\s*(?:-|–|to|through)\s*` + MDY, 'i').exec(t);
    if (m) { period_start = toIsoDate(m[1], m[2], m[3]); period_end = toIsoDate(m[4], m[5], m[6]); }
  }
  // Current-period gross: the first amount after "Gross" (YTD comes later on the line).
  const g = /gross(?:\s*pay|\s*earnings|\s*wages)?\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})/i.exec(t);
  const h = /(?:total\s*)?hours\s*(?:worked)?\s*[:\-]?\s*([\d,]+(?:\.\d+)?)/i.exec(t);
  // Session lines a stub sometimes carries under "Information & Announcements".
  const info = /information\s*(?:&|and)?\s*announcements?/i.exec(t);
  return {
    stub: { pay_date, period_start, period_end, gross_cents: g ? money(g[1]) : null, stub_hours: h ? parseFloat(h[1].replace(/,/g, '')) || null : null },
    listText: info ? t.slice(info.index + info[0].length) : '',
  };
}

// Plain text of a PDF, one text line per visual line (pdf.js text items
// grouped by their y position). pdfjs-dist is ESM-only, so it's imported
// lazily.
let pdfjs = null;
async function pdfText(buffer) {
  pdfjs ||= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const { items } = await page.getTextContent();
    const rows = new Map();
    for (const it of items) {
      if (!it.str) continue;
      const y = Math.round(it.transform[5]);
      const key = [...rows.keys()].find(k => Math.abs(k - y) <= 2) ?? y;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push({ x: it.transform[4], s: it.str });
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      out.push(rows.get(y).sort((a, b) => a.x - b.x).map(i => i.s).join(' ').replace(/\s+/g, ' ').trim());
    }
  }
  await doc.destroy();
  return out.join('\n');
}

// Text first; Claude only when the text yields nothing usable (scans, odd
// layouts). Returns { stub, listText, check_date, via }.
async function readPdf(buffer) {
  let text = '';
  try { text = await pdfText(buffer); } catch { text = ''; }
  const stubRead = parseStubText(text);
  if (stubRead) {
    const ok = stubRead.stub.pay_date && stubRead.stub.gross_cents != null;
    if (ok) return { ...stubRead, check_date: findCheckDate(text), via: 'text' };
  } else if (parseListText(text).length) {
    return { stub: null, listText: text, check_date: findCheckDate(text), via: 'text' };
  }
  const r = await readPdfWithClaude(buffer);
  return { ...r, via: 'claude' };
}

// A date in an email subject: "4.24.26 Payment report", "Payroll 11/20/2026".
function subjectDate(subject) {
  const m = new RegExp(MDY).exec(String(subject || ''));
  return m ? toIsoDate(m[1], m[2], m[3]) : null;
}

// ── .eml ───────────────────────────────────────────────────────────────────
// Drop quoted history so a reply that only quotes the original list doesn't
// import it a second time.
function stripQuoted(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (/^\s*On .{5,200}wrote:\s*$/i.test(l)) break;
    if (/^\s*-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(l)) break;
    if (/^\s*From:\s.+/i.test(l) && out.length) break;        // Outlook-style quote header
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n');
}

async function readEml(buffer) {
  const mail = await simpleParser(buffer);
  const body = stripQuoted(mail.text || (mail.html ? String(mail.html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, ' ') : ''));
  const attachments = (mail.attachments || [])
    .filter(a => /\.(pdf|xlsx|xls|eml)$/i.test(a.filename || '') || /pdf|spreadsheet|excel/i.test(a.contentType || ''))
    .map(a => ({ filename: a.filename || 'attachment', buffer: a.content, contentType: a.contentType }));
  const d = mail.date instanceof Date && !isNaN(mail.date) ? mail.date : null;
  return {
    subject: mail.subject || '',
    from: mail.from?.text || '',
    email_date: d ? d.toISOString().slice(0, 10) : null,
    body,
    attachments,
  };
}

function kindOf(filename, contentType) {
  const n = String(filename || '').toLowerCase();
  if (n.endsWith('.eml') || /message\/rfc822/.test(contentType || '')) return 'eml';
  if (n.endsWith('.pdf') || /pdf/.test(contentType || '')) return 'pdf';
  if (/\.(xlsx|xls|csv)$/.test(n) || /spreadsheet|excel|csv/.test(contentType || '')) return 'xlsx';
  if (/\.(txt|text)$/.test(n) || /^text\//.test(contentType || '')) return 'text';
  return null;
}

module.exports = { parseLine, parseListText, lineTimes, findCheckDate, xlsxToText, readPdf, readPdfWithClaude, parseStubText, pdfText, subjectDate, readEml, stripQuoted, kindOf, toIsoDate };

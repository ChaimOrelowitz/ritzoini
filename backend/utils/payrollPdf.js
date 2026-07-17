// Renders a pay-period report as a PDF for billing.
//
// The layout leads with the inputs (assignment and removal dates) and shows the
// Calculation column verbatim, so billing can re-derive every amount by hand
// without access to Ritzoini.

const PDFDocument = require('pdfkit');

const NAVY = '#1e293b';
const GRAY = '#64748b';
const LINE = '#e2e8f0';

const fmt = iso => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
};

const long = iso => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
};

// x offset, width, and alignment per column.
const COLS = [
  { key: 'peer_name',       label: 'Peer',          x: 40,  w: 108, align: 'left'  },
  { key: 'entered_on',      label: 'Assigned',      x: 148, w: 58,  align: 'left',  fmt },
  { key: 'left_on',         label: 'Removed',       x: 206, w: 58,  align: 'left',  fmt },
  { key: 'counted_from',    label: 'From',          x: 264, w: 58,  align: 'left',  fmt },
  { key: 'counted_through', label: 'Through',       x: 322, w: 58,  align: 'left',  fmt },
  { key: 'days',            label: 'Days',          x: 380, w: 32,  align: 'right' },
  { key: 'calculation',     label: 'Calculation',   x: 418, w: 92,  align: 'left'  },
  { key: 'amount',          label: 'Amount',        x: 510, w: 62,  align: 'right' },
];

function header(doc, snapshot, supervisorName) {
  doc.fillColor(NAVY).fontSize(16).font('Helvetica-Bold')
     .text('Peer Caseload Payroll', 40, 40);

  doc.fontSize(10).font('Helvetica').fillColor(GRAY)
     .text(supervisorName || '', 40, 62);

  doc.fillColor(NAVY).fontSize(11).font('Helvetica-Bold')
     .text(`Pay period: ${long(snapshot.period_start)} – ${long(snapshot.period_end)}`, 40, 82);
  doc.fontSize(9).font('Helvetica').fillColor(GRAY)
     .text(`Pay date: ${long(snapshot.pay_date)}`, 40, 98);

  if (snapshot.finalized_at) {
    doc.text(`Finalized: ${new Date(snapshot.finalized_at).toLocaleString('en-US')}`, 40, 111);
  }
}

function tableHead(doc, y) {
  doc.fontSize(7.5).font('Helvetica-Bold').fillColor(GRAY);
  for (const c of COLS) {
    doc.text(c.label.toUpperCase(), c.x, y, { width: c.w, align: c.align });
  }
  doc.moveTo(40, y + 12).lineTo(572, y + 12).strokeColor(LINE).lineWidth(1).stroke();
  return y + 18;
}

function buildPayrollPdf({ snapshot, supervisorName }) {
  const doc = new PDFDocument({ size: 'letter', margin: 40 });

  header(doc, snapshot, supervisorName);
  let y = tableHead(doc, 132);

  doc.font('Helvetica').fontSize(8).fillColor(NAVY);

  for (const r of snapshot.rows) {
    // Leave room for the totals block; start a fresh page with headers if not.
    if (y > 690) {
      doc.addPage();
      y = tableHead(doc, 50);
      doc.font('Helvetica').fontSize(8).fillColor(NAVY);
    }

    for (const c of COLS) {
      const raw = r[c.key];
      const val = raw == null || raw === '' ? '—' : (c.fmt ? c.fmt(raw) : String(raw));
      doc.fillColor(c.key === 'peer_name' ? NAVY : GRAY)
         .font(c.key === 'peer_name' || c.key === 'amount' ? 'Helvetica-Bold' : 'Helvetica')
         .text(val, c.x, y, { width: c.w, align: c.align, lineBreak: false });
    }
    y += 15;
    doc.moveTo(40, y - 3).lineTo(572, y - 3).strokeColor('#f1f5f9').stroke();
  }

  y += 8;
  doc.moveTo(40, y).lineTo(572, y).strokeColor(NAVY).lineWidth(1).stroke();
  y += 10;

  const t = snapshot.totals;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY);
  doc.text(`Total peers: ${t.peers}`,        40,  y, { lineBreak: false });
  doc.text(`Total peer-days: ${t.peer_days}`, 160, y, { lineBreak: false });
  doc.text('Total amount due:',              380, y, { width: 130, align: 'right', lineBreak: false });
  doc.fontSize(11).text(t.total,             510, y - 2, { width: 62, align: 'right', lineBreak: false });

  y += 26;
  doc.font('Helvetica').fontSize(7).fillColor(GRAY)
     .text(
       'Amounts are based solely on caseload assignment dates. Both the assignment date and the removal date count as active days. ' +
       'Seven days pays a flat $60.00 and fourteen days a flat $120.00; other day counts bill at $8.57 per day.',
       40, y, { width: 532 }
     );

  doc.end();
  return doc;
}

module.exports = { buildPayrollPdf };

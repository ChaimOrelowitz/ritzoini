// Payments 2.0 — paydays-first payment tracking. Owner (admin) only.
// Lives alongside the original Payments routes; shares nothing with them
// except the sessions.paid flag, which it keeps in sync.
//
// Data model: backend/db/migrations/2026-11-25_payments2.sql
// Logic:      backend/utils/pay2/{parse,match,service,importer}.js

const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const S = require('../utils/pay2/service');
const { importBatch, resolveHeld, recheckHeld } = require('../utils/pay2/importer');
const { supabase } = require('../utils/pay2/data');
const ECW = require('../utils/pay2/ecw');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 400 } });
router.use(requireAuth, requireAdmin);

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (err) { console.error('[payments2]', err); res.status(500).json({ error: err.message }); }
};

const isoDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);

// ── Overview + ledger ──────────────────────────────────────────────────────
router.get('/summary', wrap(() => S.summary()));
router.get('/ledger', wrap(async () => { const { rows, today } = await S.buildLedger(); return { rows, today }; }));

// ── Import ─────────────────────────────────────────────────────────────────
router.post('/import', upload.array('files', 400), wrap(req =>
  importBatch(req.files || [], { text: req.body?.text, pay_date: isoDate(req.body?.pay_date) })));

router.post('/import/resolve', wrap(async req => {
  const pay_date = isoDate(req.body?.pay_date);
  if (!pay_date) throw new Error('pick a payday date');
  return resolveHeld({ pay_date, text: req.body?.text || '', stored: req.body?.stored || null, prose: !!req.body?.prose });
}));

router.post('/import/recheck', wrap(req => recheckHeld({ text: req.body?.text || '', stored: req.body?.stored || null, dates: req.body?.dates || {}, prose: !!req.body?.prose })));

// ── eCW encounter export ───────────────────────────────────────────────────
router.post('/ecw/import', upload.single('file'), wrap(req => {
  if (!req.file) throw new Error('choose the eCW export file');
  return ECW.importExport(req.file.buffer, req.file.originalname);
}));
router.get('/ecw/sessions', wrap(() => ECW.sessionView()));
router.get('/ecw/changes', wrap(() => ECW.openChanges()));
router.post('/ecw/changes/acknowledge', wrap(req => ECW.acknowledge({ ids: req.body?.ids, kind: req.body?.kind })));

// ── Paydays ────────────────────────────────────────────────────────────────
router.get('/paydays/:id', wrap(async req => {
  const [{ data: payday, error }, { data: items }] = await Promise.all([
    supabase.from('paydays').select('*').eq('id', req.params.id).single(),
    supabase.from('payday_items').select('*').eq('payday_id', req.params.id).order('line_no'),
  ]);
  if (error) throw new Error(error.message);
  const ids = (items || []).map(i => i.session_id).filter(Boolean);
  const sessions = ids.length
    ? (await supabase.from('sessions').select('id, session_date, ecw_time, start_time, locked, group:groups!group_id(internal_name, group_name, billing_name)').in('id', ids)).data || []
    : [];
  const byId = new Map(sessions.map(s => [s.id, s]));
  return {
    payday,
    items: (items || []).map(i => {
      const s = byId.get(i.session_id);
      return { ...i, session: s ? { id: s.id, group: s.group?.internal_name || s.group?.group_name, billing_name: s.group?.billing_name,
        time: (s.ecw_time || s.start_time || '').slice(0, 5), locked: s.locked } : null };
    }),
  };
}));

router.patch('/paydays/:id', wrap(async req => {
  const updates = {};
  if (req.body.notes !== undefined) updates.notes = req.body.notes || null;
  if (!Object.keys(updates).length) return { ok: true };
  const { error } = await supabase.from('paydays').update(updates).eq('id', req.params.id);
  if (error) throw new Error(error.message);
  return { ok: true };
}));

// Removes the payday and its lines (new tables only). Sessions already marked
// paid=true stay marked — the legacy flag is never cleared.
router.delete('/paydays/:id', wrap(async req => {
  const { error } = await supabase.from('paydays').delete().eq('id', req.params.id);
  if (error) throw new Error(error.message);
  return { ok: true };
}));

router.post('/paydays/:id/rematch', wrap(req => S.rematchPayday(req.params.id)));

router.get('/paydays/:id/file/:which', wrap(async req => {
  const { data: p } = await supabase.from('paydays').select('stub_file, list_file').eq('id', req.params.id).single();
  const path = req.params.which === 'stub' ? p?.stub_file : p?.list_file;
  if (!path) throw new Error('no file stored');
  return { url: await S.signedUrl(path) };
}));

// ── Review: lines that didn't match on their own ───────────────────────────
router.get('/items/:id/candidates', wrap(async req => {
  const { data: item } = await supabase.from('payday_items').select('*').eq('id', req.params.id).single();
  if (!item) throw new Error('line not found');
  return { item, candidates: await S.itemCandidates(item) };
}));
router.get('/review', wrap(() => S.reviewQueue()));
// Set a line aside with a reason ('paid_twice' | 'not_in_ritzoini'), or clear it (reason null).
router.post('/items/:id/set-aside', wrap(req => {
  const reason = req.body?.reason ?? null;
  if (reason !== null && !['paid_twice', 'not_in_ritzoini'].includes(reason)) throw new Error('unknown reason');
  return S.setAside(req.params.id, reason);
}));
router.post('/items/:id/link', wrap(async req => {
  if (!req.body?.session_id) throw new Error('session_id required');
  const r = await S.linkItem(req.params.id, req.body.session_id);
  const { data: item } = await supabase.from('payday_items').select('payday_id').eq('id', req.params.id).single();
  if (item) await S.recomputePayday(item.payday_id);
  return r;
}));

// ── Sessions ───────────────────────────────────────────────────────────────
router.post('/sessions/:id/cancel', wrap(req => S.markCancelled(req.params.id)));

// ── Rates ──────────────────────────────────────────────────────────────────
router.get('/rates', wrap(async () => (await supabase.from('pay_rates').select('*').order('effective_date', { ascending: false })).data || []));
router.post('/rates', wrap(async req => {
  const effective_date = isoDate(req.body?.effective_date);
  const amount_cents = Math.round(Number(req.body?.amount) * 100);
  if (!effective_date || !(amount_cents > 0)) throw new Error('effective date and a positive amount required');
  const { error } = await supabase.from('pay_rates').upsert({ effective_date, amount_cents }, { onConflict: 'effective_date' });
  if (error) throw new Error(error.message);
  return { ok: true };
}));
router.delete('/rates/:id', wrap(async req => {
  const { count } = await supabase.from('pay_rates').select('*', { count: 'exact', head: true });
  if (count <= 1) throw new Error('keep at least one rate');
  const { error } = await supabase.from('pay_rates').delete().eq('id', req.params.id);
  if (error) throw new Error(error.message);
  return { ok: true };
}));

// ── Claim exports (owed sessions) ──────────────────────────────────────────
const money = c => `$${((c || 0) / 100).toFixed(2)}`;
const us = iso => { if (!iso) return ''; const [y, m, d] = iso.slice(0, 10).split('-'); return `${Number(m)}/${Number(d)}/${y}`; };

router.get('/export/owed.xlsx', async (req, res) => {
  try {
    const { owed } = await S.summary();
    const rows = [['Session date', 'Group', 'Billing name', 'Time', 'Locked at', 'Zoho note id', 'Days waiting', 'Amount'],
      ...owed.map(r => [us(r.date), r.group || '', r.billing_name || '', r.time || '', us(r.locked_at), r.zoho_note_id || '', r.days_waiting, (r.amount_cents || 0) / 100])];
    rows.push([], ['Total', '', '', '', '', '', owed.length, owed.reduce((t, r) => t + (r.amount_cents || 0), 0) / 100]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [12, 22, 36, 8, 12, 22, 12, 10].map(wch => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Owed sessions');
    res.setHeader('Content-Disposition', 'attachment; filename="owed-sessions.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/export/owed.pdf', async (req, res) => {
  try {
    const { owed, today } = await S.summary();
    const total = owed.reduce((t, r) => t + (r.amount_cents || 0), 0);
    const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
    res.setHeader('Content-Disposition', 'attachment; filename="owed-sessions.pdf"');
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#1a2744').text('Unpaid sessions — claim');
    doc.moveDown(0.3).font('Helvetica').fontSize(10).fillColor('#64748b')
      .text(`Prepared ${us(today)}. Each session below was locked in eCW more than 7 days ago and has not appeared on any payday.`);
    doc.moveDown(0.4).font('Helvetica-Bold').fillColor('#1a2744').text(`${owed.length} sessions · ${money(total)}`);
    doc.moveDown(0.8);
    const cols = [['Date', 40, 58], ['Group', 98, 120], ['Billing name', 218, 170], ['Locked', 388, 58], ['Zoho note', 446, 84], ['Amount', 530, 42]];
    const head = () => {
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#64748b');
      cols.forEach(([l, x, w]) => doc.text(l, x, y, { width: w, align: l === 'Amount' ? 'right' : 'left' }));
      doc.moveTo(40, y + 12).lineTo(572, y + 12).strokeColor('#e2e8f0').stroke();
      doc.y = y + 16;
    };
    head();
    doc.font('Helvetica').fontSize(8).fillColor('#1a2744');
    for (const r of owed) {
      if (doc.y > 730) { doc.addPage(); head(); doc.font('Helvetica').fontSize(8).fillColor('#1a2744'); }
      const y = doc.y;
      const vals = [us(r.date), r.group || '', r.billing_name || '', us(r.locked_at), r.zoho_note_id || '', money(r.amount_cents)];
      cols.forEach(([l, x, w], i) => doc.text(vals[i], x, y, { width: w, align: l === 'Amount' ? 'right' : 'left', lineBreak: false, ellipsis: true }));
      doc.y = y + 13;
    }
    doc.moveDown(0.5).font('Helvetica-Bold').fontSize(9).text(`Total ${money(total)}`, 40, doc.y, { width: 532, align: 'right' });
    doc.end();
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

module.exports = router;

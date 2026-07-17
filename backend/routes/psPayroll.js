const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');
const P = require('../utils/payroll');
const { buildPayrollPdf } = require('../utils/payrollPdf');
const { todayET } = require('../utils/caseloadSync');

const SUPERVISOR = () => process.env.AIRTABLE_SUPERVISOR_RECORD_ID;

async function periodsFor(sup) {
  const { data, error } = await supabase
    .from('ps_caseload_periods')
    .select('*')
    .eq('supervisor_airtable_id', sup);
  if (error) throw new Error(error.message);
  return data || [];
}

async function snapshotFor(sup, periodStart) {
  const { data, error } = await supabase
    .from('ps_payroll_snapshots')
    .select('*')
    .eq('supervisor_airtable_id', sup)
    .eq('period_start', periodStart)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// Reports are served from the frozen snapshot when one exists, so a finalized
// period keeps showing what was actually submitted to billing.
async function reportFor(sup, periodStart) {
  const period = P.periodByStart(periodStart);
  const snap   = await snapshotFor(sup, periodStart);
  if (snap) {
    return {
      period, rows: snap.rows, totals: snap.totals,
      finalized: true, snapshot: snap,
    };
  }
  const live = P.buildReport(period, await periodsFor(sup));
  return { ...live, finalized: false, snapshot: null, open: todayET() <= period.end };
}

// GET /api/ps/payroll/periods — every period from first assignment to today
router.get('/periods', requireAuth, async (req, res) => {
  try {
    const sup     = req.query.supervisor_id || SUPERVISOR();
    const periods = await periodsFor(sup);

    if (!periods.length) return res.json([]);

    const earliest = periods.map(p => p.entered_on).sort()[0];
    const list     = P.listPeriods(earliest, todayET());

    const { data: snaps, error } = await supabase
      .from('ps_payroll_snapshots')
      .select('period_start, finalized_at, sent_to_billing_at, paid, paid_at, totals')
      .eq('supervisor_airtable_id', sup);
    if (error) throw new Error(error.message);

    const byStart = new Map((snaps || []).map(s => [s.period_start, s]));

    res.json(list.reverse().map(p => {
      const snap = byStart.get(p.start);
      const live = P.buildReport(p, periods).totals;
      return {
        ...p,
        finalized:  !!snap,
        paid:       snap?.paid || false,
        sent:       !!snap?.sent_to_billing_at,
        totals:     snap?.totals || live,
        // Still running: the totals assume everyone currently assigned stays
        // through the end date, so they are a projection, not an earned amount.
        open:       todayET() <= p.end,
        // A finalized report is frozen; if the underlying dates have since
        // changed, say so rather than quietly serving a stale total.
        drifted:    !!snap && snap.totals?.total_cents !== live.total_cents,
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ps/payroll/report?start=YYYY-MM-DD
router.get('/report', requireAuth, async (req, res) => {
  try {
    const sup = req.query.supervisor_id || SUPERVISOR();
    if (!req.query.start) return res.status(400).json({ error: 'start is required' });

    const out = await reportFor(sup, req.query.start);

    if (out.finalized) {
      const live = P.buildReport(out.period, await periodsFor(sup));
      out.live_totals = live.totals;
      out.drifted     = live.totals.total_cents !== out.totals.total_cents;
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ps/payroll/finalize { start, replace? } — freeze the period
router.post('/finalize', requireAuth, async (req, res) => {
  try {
    const sup   = SUPERVISOR();
    const start = req.body.start;
    if (!start) return res.status(400).json({ error: 'start is required' });

    const period = P.periodByStart(start);

    // Finalizing a period that hasn't finished yet would freeze a partial
    // count as though it were the final word to billing.
    if (todayET() <= period.end && !req.body.allow_incomplete) {
      return res.status(400).json({
        error: `Pay period runs through ${period.end} and is still open. ` +
               'Finalize it after it ends, or pass allow_incomplete to override.',
      });
    }

    const existing = await snapshotFor(sup, start);
    if (existing && !req.body.replace) {
      return res.status(409).json({ error: 'Period already finalized. Pass replace to overwrite.' });
    }

    const built = P.buildReport(period, await periodsFor(sup));
    const row = {
      supervisor_airtable_id: sup,
      period_index: period.index,
      period_start: period.start,
      period_end:   period.end,
      pay_date:     period.pay_date,
      rows:         built.rows,
      totals:       built.totals,
      finalized_at: new Date().toISOString(),
      finalized_by: req.user?.email || null,
      updated_at:   new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('ps_payroll_snapshots')
      .upsert(row, { onConflict: 'supervisor_airtable_id,period_start' })
      .select().single();
    if (error) throw new Error(error.message);

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/ps/payroll/snapshots/:id — mark sent / paid
router.patch('/snapshots/:id', requireAuth, async (req, res) => {
  try {
    const { paid, sent, paid_note } = req.body;
    const updates = { updated_at: new Date().toISOString() };

    if (paid !== undefined) {
      updates.paid    = !!paid;
      updates.paid_at = paid ? new Date().toISOString() : null;
    }
    if (sent !== undefined)      updates.sent_to_billing_at = sent ? new Date().toISOString() : null;
    if (paid_note !== undefined) updates.paid_note = paid_note;

    const { data, error } = await supabase
      .from('ps_payroll_snapshots').update(updates).eq('id', req.params.id).select().single();
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ps/payroll/snapshots/:id — un-finalize
router.delete('/snapshots/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('ps_payroll_snapshots').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ps/payroll/report.pdf?start=YYYY-MM-DD
router.get('/report.pdf', requireAuth, async (req, res) => {
  try {
    const sup = req.query.supervisor_id || SUPERVISOR();
    if (!req.query.start) return res.status(400).json({ error: 'start is required' });

    const out = await reportFor(sup, req.query.start);

    const { data: peer } = await supabase
      .from('ps_peers').select('supervisor_airtable_id').eq('supervisor_airtable_id', sup).limit(1);

    const snapshot = {
      period_start: out.period.start,
      period_end:   out.period.end,
      pay_date:     out.period.pay_date,
      rows:         out.rows,
      totals:       out.totals,
      finalized_at: out.snapshot?.finalized_at || null,
    };

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="peer-payroll-${out.period.start}.pdf"`);

    const doc = buildPayrollPdf({ snapshot, supervisorName: req.query.name || 'Orelowitz, Chaim (LMSW)' });
    doc.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ps/payroll/report.csv?start=YYYY-MM-DD
router.get('/report.csv', requireAuth, async (req, res) => {
  try {
    const sup = req.query.supervisor_id || SUPERVISOR();
    if (!req.query.start) return res.status(400).json({ error: 'start is required' });

    const out = await reportFor(sup, req.query.start);

    // Excel reads a bare leading field named "ID" as SYLK; quoting everything
    // also keeps the comma in "Last, First" from splitting the column.
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Peer', 'Assigned', 'Removed', 'Counted From', 'Counted Through', 'Days', 'Calculation', 'Amount'];

    const lines = [
      head.map(esc).join(','),
      ...out.rows.map(r => [
        r.peer_name, r.entered_on, r.left_on || '', r.counted_from, r.counted_through,
        r.days, r.calculation, (r.amount_cents / 100).toFixed(2),
      ].map(esc).join(',')),
      '',
      [esc('Total peers'), esc(out.totals.peers)].join(','),
      [esc('Total peer-days'), esc(out.totals.peer_days)].join(','),
      [esc('Total amount due'), esc((out.totals.total_cents / 100).toFixed(2))].join(','),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="peer-payroll-${out.period.start}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ps/payroll/email-text?start=YYYY-MM-DD — copyable text for billing
router.get('/email-text', requireAuth, async (req, res) => {
  try {
    const sup = req.query.supervisor_id || SUPERVISOR();
    if (!req.query.start) return res.status(400).json({ error: 'start is required' });

    const out = await reportFor(sup, req.query.start);
    const d   = iso => { const [y, m, dd] = iso.split('-'); return `${m}/${dd}/${y}`; };

    const width = Math.max(4, ...out.rows.map(r => (r.peer_name || '').length));
    const body = [
      `Peer caseload payroll for ${d(out.period.start)} – ${d(out.period.end)} (pay date ${d(out.period.pay_date)}).`,
      '',
      ...out.rows.map(r =>
        `${(r.peer_name || '').padEnd(width)}  ${d(r.counted_from)} – ${d(r.counted_through)}  ` +
        `${String(r.days).padStart(2)} days  ${r.calculation.padEnd(16)} ${r.amount}`),
      '',
      `Total peers: ${out.totals.peers}`,
      `Total peer-days: ${out.totals.peer_days}`,
      `Total amount due: ${out.totals.total}`,
      '',
      'Both the assignment date and the removal date count as active days.',
      'Seven days pays a flat $60.00; fourteen days a flat $120.00; other day counts bill at $8.57 per day.',
    ].join('\n');

    res.json({ subject: `Peer caseload payroll — ${d(out.period.start)} to ${d(out.period.end)}`, body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

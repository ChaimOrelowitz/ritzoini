// Peer caseload payroll.
//
// Money is handled in whole cents end-to-end. Amounts are read from a literal
// table rather than derived, because the schedule is deliberately NOT linear:
// 7 days pays $60.00 where 7 x $8.57 would give $59.99, and 14 days pays
// $120.00 where 7 x $8.57 + $60 would give $119.99. Multiplying a rounded
// daily rate produces those one-cent shortfalls, so the rate for every day
// count 0-14 is pinned exactly as billing specified.

const DAY_RATE_CENTS  = 857;   // $8.57, for the non-flat day counts
const WEEK_FLAT_CENTS = 6000;  // $60.00 at exactly 7 days

const RATE_CENTS = [
       0,   //  0 days
     857,   //  1
    1714,   //  2
    2571,   //  3
    3428,   //  4
    4285,   //  5
    5142,   //  6
    6000,   //  7  flat $60 -- not 7 x 857
    6857,   //  8
    7714,   //  9
    8571,   // 10
    9428,   // 11
   10285,   // 12
   11142,   // 13
   12000,   // 14  flat $120 -- not 6000 + 7 x 857
];

// Payroll anchor supplied by billing: this exact period pays on this date.
// 26 periods a year = 14 days each, so every other period is anchor +/- 14n.
const ANCHOR_START    = '2026-06-15';
const ANCHOR_PAY_DATE = '2026-07-10';
const PERIOD_DAYS     = 14;

const MS_DAY = 86400000;

// Dates here are payroll calendar days, never instants. Parsing at UTC noon
// keeps arithmetic clear of DST, which would otherwise shift a boundary date
// by a day twice a year and silently change someone's day count.
const parse  = d => new Date(d + 'T12:00:00Z');
const iso    = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => iso(new Date(parse(d).getTime() + n * MS_DAY));
const diffDays = (a, b) => Math.round((parse(a) - parse(b)) / MS_DAY);

function rateCents(days) {
  if (days < 0 || days > PERIOD_DAYS) throw new Error(`Day count out of range: ${days}`);
  return RATE_CENTS[days];
}

// Human-readable derivation for the report's Calculation column, so billing
// can check the arithmetic without knowing the table.
function explain(days) {
  if (days === 0)  return 'No active days';
  if (days === 7)  return 'Flat 7-day rate';
  if (days === 14) return 'Flat 14-day rate';
  if (days < 7)    return `${days} x $8.57`;
  return `$60 + ${days - 7} x $8.57`;
}

// Thousands separators: period totals run past $1,000 and billing reads these
// by eye. Raw cents stay on every row for anyone recomputing.
const money = cents =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Which period index contains a date; index 0 is the anchor period.
function periodIndexFor(date) {
  return Math.floor(diffDays(date, ANCHOR_START) / PERIOD_DAYS);
}

function periodByIndex(i) {
  const start = addDays(ANCHOR_START, i * PERIOD_DAYS);
  return {
    index:    i,
    start,
    end:      addDays(start, PERIOD_DAYS - 1),
    pay_date: addDays(ANCHOR_PAY_DATE, i * PERIOD_DAYS),
  };
}

function periodByStart(start) {
  const i = periodIndexFor(start);
  const p = periodByIndex(i);
  if (p.start !== start) throw new Error(`${start} is not a pay-period start date (nearest is ${p.start})`);
  return p;
}

// Periods from the earliest assignment through the one containing `today`.
function listPeriods(earliestDate, today) {
  const from = periodIndexFor(earliestDate);
  const to   = periodIndexFor(today);
  const out  = [];
  for (let i = from; i <= to; i++) out.push(periodByIndex(i));
  return out;
}

// Inclusive overlap: both the assignment date and the removal date count as
// active days, per billing's rule.
function overlapDays(period, enteredOn, leftOn) {
  const from = enteredOn > period.start ? enteredOn : period.start;
  const to   = (leftOn && leftOn < period.end) ? leftOn : period.end;
  if (from > to) return null;
  return { from, to, days: diffDays(to, from) + 1 };
}

// One row per peer with at least one active day in the period.
function buildReport(period, periods) {
  const rows = [];

  for (const p of periods) {
    const ov = overlapDays(period, p.entered_on, p.left_on);
    if (!ov || ov.days === 0) continue;

    const cents = rateCents(ov.days);
    rows.push({
      period_id:       p.id,
      peer_airtable_id: p.peer_airtable_id,
      peer_name:       p.peer_name,
      entered_on:      p.entered_on,
      left_on:         p.left_on,
      counted_from:    ov.from,
      counted_through: ov.to,
      days:            ov.days,
      calculation:     explain(ov.days),
      amount_cents:    cents,
      amount:          money(cents),
    });
  }

  rows.sort((a, b) => (a.peer_name || '').localeCompare(b.peer_name || ''));

  const total_cents = rows.reduce((s, r) => s + r.amount_cents, 0);

  return {
    period,
    rows,
    totals: {
      peers:       rows.length,
      peer_days:   rows.reduce((s, r) => s + r.days, 0),
      total_cents,
      total:       money(total_cents),
    },
  };
}

module.exports = {
  RATE_CENTS, DAY_RATE_CENTS, WEEK_FLAT_CENTS,
  ANCHOR_START, ANCHOR_PAY_DATE, PERIOD_DAYS,
  rateCents, explain, money,
  periodIndexFor, periodByIndex, periodByStart, listPeriods,
  overlapDays, buildReport,
  addDays, diffDays,
};

// Checks the payroll engine against the rules and worked example billing gave
// us. There's no test runner in this repo, so this is a plain script:
//
//   node scripts/check-payroll.js     (exits non-zero on any failure)
//
// The rate-table invariants are the point: 7 days must be exactly $60.00 and
// 14 days exactly $120.00, which multiplying $8.57 would miss by a cent.

const P = require('../utils/payroll');

let fail = 0;
const check = (label, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} got ${String(got).padEnd(12)} want ${want}`);
};

console.log('--- rate table invariants');
check('7 days is exactly $60',       P.money(P.rateCents(7)),  '$60.00');
check('14 days is exactly $120',     P.money(P.rateCents(14)), '$120.00');
check('7 x 8.57 would be wrong',     P.money(7 * 857),         '$59.99');
check('linear 14 would be wrong',    P.money(6000 + 7 * 857),  '$119.99');
check('0 days is $0',                P.money(P.rateCents(0)),  '$0.00');

console.log('\n--- monotonic + no float drift');
for (let d = 1; d <= 14; d++) {
  if (P.rateCents(d) <= P.rateCents(d - 1)) { console.log('FAIL non-monotonic at', d); fail++; }
  if (!Number.isInteger(P.rateCents(d)))    { console.log('FAIL non-integer cents at', d); fail++; }
}
console.log('PASS  rates strictly increasing, all integer cents');

console.log('\n--- pay period math from anchor');
const p0 = P.periodByStart('2026-06-15');
check('anchor period end',            p0.end,      '2026-06-28');
check('anchor pay date',              p0.pay_date, '2026-07-10');
const p1 = P.periodByIndex(1);
check('next period starts day after', p1.start,    '2026-06-29');
check('next period end',              p1.end,      '2026-07-12');
check('next pay date +14',            p1.pay_date, '2026-07-24');
check('26 periods spans a year',      P.addDays('2026-06-15', 26 * 14), '2027-06-14');

console.log('\n--- billing example (period Jun 15-28)');
const rep = P.buildReport(p0, [
  { id: '1', peer_name: 'Halpert, Avrum',       entered_on: '2026-06-15', left_on: null },
  { id: '2', peer_name: 'Steinmetz, Elimelech', entered_on: '2026-06-17', left_on: null },
  { id: '3', peer_name: 'Weiss, Joseph',        entered_on: '2026-06-18', left_on: null },
]);
const by = n => rep.rows.find(r => r.peer_name.startsWith(n));
check('Halpert days',    by('Halpert').days,          14);
check('Halpert amount',  by('Halpert').amount,        '$120.00');
check('Halpert calc',    by('Halpert').calculation,   'Flat 14-day rate');
check('Steinmetz days',  by('Steinmetz').days,        12);
check('Steinmetz amt',   by('Steinmetz').amount,      '$102.85');
check('Steinmetz calc',  by('Steinmetz').calculation, '$60 + 5 x $8.57');
check('Weiss days',      by('Weiss').days,            11);
check('Weiss amount',    by('Weiss').amount,          '$94.28');
check('Weiss calc',      by('Weiss').calculation,     '$60 + 4 x $8.57');
check('total peers',     rep.totals.peers,            3);
check('total peer-days', rep.totals.peer_days,        37);
check('total amount',    rep.totals.total,            '$317.13');

console.log('\n--- edge cases');
const days = (entered, left) => {
  const r = P.buildReport(p0, [{ id: 'x', peer_name: 'A', entered_on: entered, left_on: left }]);
  return r.rows.length ? r.rows[0].days : 0;
};
check('peer entirely before period',    days('2026-05-01', '2026-06-14'), 0);
check('peer entirely after period',     days('2026-07-01', null),         0);
check('enter+leave same day = 1 day',   days('2026-06-20', '2026-06-20'), 1);
check('spans whole period from before', days('2026-01-01', null),         14);
check('leaves on period end date',      days('2026-06-15', '2026-06-28'), 14);
check('leaves day before end',          days('2026-06-15', '2026-06-27'), 13);

console.log('\n--- re-entry produces two independent rows');
const reentry = P.buildReport(p0, [
  { id: 'a', peer_name: 'Back, Comes', entered_on: '2026-06-15', left_on: '2026-06-18' },
  { id: 'b', peer_name: 'Back, Comes', entered_on: '2026-06-25', left_on: null },
]);
check('two stints counted separately', reentry.rows.length, 2);
check('stint 1 days', reentry.rows.find(r => r.period_id === 'a').days, 4);
check('stint 2 days', reentry.rows.find(r => r.period_id === 'b').days, 4);

console.log(fail ? `\n${fail} FAILURE(S)` : '\nAll checks passed.');
process.exit(fail ? 1 : 0);

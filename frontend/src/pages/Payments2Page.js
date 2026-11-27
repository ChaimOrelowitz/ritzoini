// Payments 2.0 — what you're owed, and what needs you (owner only).
// Backend: backend/routes/payments2.js. Lives alongside the original Payments page.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';

// ── formatting ─────────────────────────────────────────────────────────────
const money = c => (c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`);
const toDate = iso => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const dayDate = iso => (iso ? toDate(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const longDay = iso => (iso ? toDate(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '—');
const shortDate = iso => (iso ? toDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');
const fmt12 = t => { if (!t) return ''; let [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')} ${ap}`; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const STATUS = {
  owed:         { label: 'Owed to you',        bg: '#fef2f2', fg: '#b91c1c' },
  needs_action: { label: 'Needs locking',      bg: '#fffbeb', fg: '#b45309' },
  not_run:      { label: 'No note, not locked', bg: '#f3f4f6', fg: '#4b5563' },
  pending:      { label: 'This week',          bg: '#eff6ff', fg: '#1d4ed8' },
  paid:         { label: 'Paid',               bg: '#ecfdf5', fg: '#047857' },
  upcoming:     { label: 'Upcoming',           bg: '#f9fafb', fg: '#6b7280' },
  cancelled:    { label: 'Cancelled',          bg: '#f9fafb', fg: '#9ca3af' },
  duplicate:    { label: 'Entered twice',      bg: '#f5f3ff', fg: '#6d28d9' },
  history:      { label: 'Before Apr 2026',    bg: '#f9fafb', fg: '#9ca3af' },
};

function Pill({ s }) {
  const m = STATUS[s] || { label: s, bg: '#f3f4f6', fg: '#374151' };
  return <span style={{ background: m.bg, color: m.fg, fontSize: '0.72rem', fontWeight: 700, padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap' }}>{m.label}</span>;
}

const th = { padding: '10px 14px', textAlign: 'left', fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap', borderBottom: '1px solid var(--gray-200)', background: 'var(--gray-50)' };
const td = { padding: '11px 14px', fontSize: '0.86rem', color: 'var(--gray-700)', borderBottom: '1px solid var(--gray-100)', verticalAlign: 'middle' };
const card = { background: 'var(--white)', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius-lg, 14px)', overflow: 'hidden' };
const h3 = { fontSize: '1.02rem', fontWeight: 700, color: 'var(--navy)', margin: '0 0 12px' };
const muted = { color: 'var(--gray-500)' };
const linkBtn = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--navy)', fontWeight: 600, textDecoration: 'underline', font: 'inherit' };

function Spinner() { return <div style={{ padding: 40, textAlign: 'center' }}><div className="spinner" style={{ margin: '0 auto' }} /></div>; }
function Empty({ children }) { return <div style={{ padding: '18px 16px', fontSize: '0.88rem', color: 'var(--gray-400)' }}>{children}</div>; }

// ── page ───────────────────────────────────────────────────────────────────
export default function Payments2Page() {
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [openPayday, setOpenPayday] = useState(null);
  const [ledgerFilter, setLedgerFilter] = useState('all');

  const load = useCallback(async () => {
    try { setData(await api.get('/payments2/summary')); setError(''); }
    catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const goPayday = id => { setOpenPayday(id); setTab('paydays'); };
  const goLedger = f => { setLedgerFilter(f); setTab('sessions'); };

  return (
    <div style={{ maxWidth: 1060 }}>
      <style>{'@media (max-width: 640px) { .p2-wide { display: none; } }'}</style>
      <div className="page-header" style={{ alignItems: 'center' }}>
        <div>
          <h2>Payments</h2>
          <p>What you've been paid, what you're still owed, and what needs you.</p>
        </div>
        <button className="btn btn-gold" onClick={() => setShowAdd(true)}>+ Add a pay stub or list</button>
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--gray-200)', marginBottom: 22, overflowX: 'auto' }}>
        {[['overview', 'Overview'], ['paydays', 'Paydays'], ['sessions', 'All sessions'], ['ecw', 'eCW check'], ['settings', 'Settings']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '9px 16px', fontSize: '0.9rem', fontWeight: 700, whiteSpace: 'nowrap',
            color: tab === k ? 'var(--navy)' : 'var(--gray-400)', marginBottom: -1,
            borderBottom: tab === k ? '2px solid var(--gold)' : '2px solid transparent',
          }}>{l}</button>
        ))}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {tab === 'overview' && (data ? <Overview data={data} reload={load} goPayday={goPayday} goLedger={goLedger} /> : !error && <Spinner />)}
      {tab === 'paydays' && (data ? <Paydays slots={data.slots} paydays={data.paydays} open={openPayday} setOpen={setOpenPayday} reload={load} /> : <Spinner />)}
      {tab === 'sessions' && <Ledger filter={ledgerFilter} setFilter={setLedgerFilter} onChanged={load} />}
      {tab === 'ecw' && <EcwCheck />}
      {tab === 'settings' && <Settings paydays={data?.paydays || []} onChanged={load} />}

      {showAdd && <AddModal onClose={() => { setShowAdd(false); load(); }} />}
    </div>
  );
}

// ── overview ───────────────────────────────────────────────────────────────
function Overview({ data, reload, goPayday, goLedger }) {
  const { cards: c, attention: a, owed, paydays } = data;
  const [exporting, setExporting] = useState('');
  const [open, setOpen] = useState(null);
  async function exp(kind) {
    setExporting(kind);
    try { await api.download(`/payments2/export/owed.${kind}`, `owed-sessions.${kind}`); }
    catch (e) { alert(e.message); } finally { setExporting(''); }
  }

  // Paydays with no list from before the office started sending lists are history, not a to-do.
  const firstListed = paydays.filter(p => p.has_list).map(p => p.pay_date).sort()[0];
  const missingList = a.waiting_for_list.filter(p => firstListed && p.pay_date > firstListed);
  const oldNoList = a.waiting_for_list.filter(p => !firstListed || p.pay_date <= firstListed);

  const tasks = [
    a.unmatched_total > 0 && {
      key: 'review', tone: 'amber',
      title: `Match ${plural(a.unmatched_total, 'line')} from the office's lists`,
      body: "These lines didn't clearly match one of your sessions. Pick the session, or tell me why there isn't one.",
      panel: <ReviewQueue onChanged={reload} />,
    },
    a.needs_action > 0 && {
      key: 'lock', tone: 'amber',
      title: `Lock ${plural(a.needs_action, 'session')} so you get paid`,
      body: "They're written up in Zoho but not locked. The office only pays locked sessions.",
      panel: <SessionList rows={a.needs_action_rows} />,
    },
    a.not_run > 0 && {
      key: 'notrun', tone: 'gray',
      title: `Check ${plural(a.not_run, 'session')} with no note`,
      body: 'No note was written and they were never locked. If one didn’t happen, cancel it so it stops counting.',
      panel: <SessionList rows={a.not_run_rows} canCancel onChanged={reload} />,
    },
    ...a.mismatches.map(p => {
      const diff = (p.gross_cents || 0) - (p.list_cents || 0);
      const n = Math.round(Math.abs(diff) / (c.current_rate_cents || 5500));
      return {
        key: `mm-${p.id}`, tone: 'red',
        title: `${longDay(p.pay_date)}: the stub and the list don't agree`,
        body: diff > 0
          ? `The office paid ${money(p.gross_cents)}, but its list only adds up to ${money(p.list_cents)} — about ${plural(n, 'session')} paid but not listed.`
          : `The list adds up to ${money(p.list_cents)}, but the office only paid ${money(p.gross_cents)} — about ${plural(n, 'session')} short.`,
        action: { label: 'See this payday', run: () => goPayday(p.id) },
      };
    }),
    ...missingList.map(p => ({
      key: `nl-${p.id}`, tone: 'gray',
      title: `${longDay(p.pay_date)}: no session list yet`,
      body: `You were paid ${money(p.gross_cents)}${p.gross_cents ? ` (about ${plural(Math.round(p.gross_cents / (c.current_rate_cents || 5500)), 'session')})` : ''}, but the office's list of which sessions it covered isn't here. Until it is, those sessions may show as owed. If you find the email, add it.`,
    })),
    ...a.waiting_for_stub.map(p => ({
      key: `ns-${p.id}`, tone: 'gray',
      title: `${longDay(p.pay_date)}: list is in, waiting for the pay stub`,
      body: 'Add the RTG stub when it arrives to check the amount.',
    })),
  ].filter(Boolean);

  const tone = { red: '#dc2626', amber: '#d97706', gray: '#9ca3af' };

  return (
    <div style={{ display: 'grid', gap: 28 }}>
      {/* The answer, in one sentence */}
      <div style={{ ...card, padding: '22px 24px', display: 'grid', gap: 18, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', alignItems: 'center', borderTop: `4px solid ${c.owed_count ? '#dc2626' : '#059669'}` }}>
        <div>
          <div style={{ fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', ...muted }}>Still owed to you</div>
          <div style={{ fontSize: '2.4rem', fontWeight: 800, color: c.owed_count ? '#b91c1c' : '#047857', lineHeight: 1.1, margin: '4px 0' }}>{money(c.owed_cents)}</div>
          <div style={{ fontSize: '0.9rem', ...muted }}>
            {c.owed_count
              ? <>{plural(c.owed_count, 'session')}, locked more than a week ago and not on any payday yet. Oldest: {dayDate(c.owed_oldest)}.</>
              : 'Every locked session from April 2026 on has been paid.'}
          </div>
          {c.owed_count > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" disabled={!!exporting} onClick={() => exp('pdf')}>{exporting === 'pdf' ? 'Preparing…' : 'Download claim (PDF)'}</button>
              <button className="btn btn-outline btn-sm" disabled={!!exporting} onClick={() => exp('xlsx')}>{exporting === 'xlsx' ? 'Preparing…' : 'Excel'}</button>
            </div>
          )}
        </div>
        <div style={{ display: 'grid', gap: 12 }}>
          <Fact label={`Paid so far in ${c.year}`} value={money(c.paid_this_year_cents)} />
          <Fact label="Next payday" value={c.next_payday ? dayDate(c.next_payday) : '—'}
            sub={c.next_payday ? `Up to ${money(c.next_expected_cents)} if the office pays everything locked by ${shortDate(c.next_cutoff)}` : null} />
          <Fact label="Your rate" value={`${money(c.current_rate_cents)} a session`} />
        </div>
      </div>

      {/* What needs you */}
      <section>
        <h3 style={h3}>{tasks.length ? 'What needs you' : 'What needs you'}</h3>
        <div style={card}>
          {tasks.length === 0 && <div style={{ padding: '20px 18px', fontSize: '0.95rem', color: '#047857', fontWeight: 600 }}>✓ Nothing needs you right now.</div>}
          {tasks.map((t, i) => (
            <div key={t.key} style={{ borderTop: i ? '1px solid var(--gray-100)' : 'none' }}>
              <div style={{ display: 'flex', gap: 14, padding: '15px 18px', alignItems: 'flex-start' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: tone[t.tone], flexShrink: 0, marginTop: 6 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '0.95rem' }}>{t.title}</div>
                  <div style={{ fontSize: '0.86rem', ...muted, marginTop: 3, lineHeight: 1.45 }}>{t.body}</div>
                </div>
                {t.panel && <button className={`btn btn-sm ${open === t.key ? 'btn-outline' : 'btn-gold'}`} onClick={() => setOpen(open === t.key ? null : t.key)}>{open === t.key ? 'Close' : 'Do it'}</button>}
                {t.action && <button className="btn btn-outline btn-sm" onClick={t.action.run}>{t.action.label}</button>}
              </div>
              {open === t.key && <div style={{ padding: '0 18px 18px 42px' }}>{t.panel}</div>}
            </div>
          ))}
          {oldNoList.length > 0 && (
            <div style={{ borderTop: tasks.length ? '1px solid var(--gray-100)' : 'none', padding: '11px 18px 11px 42px', fontSize: '0.8rem', color: 'var(--gray-400)' }}>
              {plural(oldNoList.length, 'older payday')} ({oldNoList.map(p => shortDate(p.pay_date)).join(', ')}) have a stub but no list — from before the office started sending lists. Nothing to do.
            </div>
          )}
          {a.duplicates > 0 && (
            <div style={{ borderTop: '1px solid var(--gray-100)', padding: '11px 18px 11px 42px', fontSize: '0.8rem', color: 'var(--gray-400)' }}>
              {plural(a.duplicates, 'session is', 'sessions are')} entered twice in Ritzoini under two groups. Each is counted once. <button style={{ ...linkBtn, fontWeight: 400, color: 'var(--gray-500)' }} onClick={() => goLedger('duplicate')}>See them</button>
            </div>
          )}
        </div>
      </section>

      {/* Owed */}
      {owed.length > 0 && (
        <section>
          <h3 style={h3}>The {plural(owed.length, 'session')} you're owed for</h3>
          <div style={{ ...card, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>Session</th><th style={th}>Group</th><th style={th} className="p2-wide">Locked</th>
                <th style={{ ...th, textAlign: 'right' }}>Waiting</th><th style={{ ...th, textAlign: 'right' }}>Amount</th>
              </tr></thead>
              <tbody>{owed.map(r => (
                <tr key={r.id}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <div style={{ fontWeight: 600, color: 'var(--navy)' }}>{dayDate(r.date)}</div>
                    {r.time && <div style={{ fontSize: '0.76rem', ...muted }}>{fmt12(r.time)}</div>}
                  </td>
                  <td style={td}>
                    <Link to={`/groups/${r.group_id}`} style={{ color: 'var(--navy)', fontWeight: 600 }}>{r.group}</Link>
                    {r.billing_name && <div style={{ fontSize: '0.76rem', ...muted }}>{r.billing_name}</div>}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }} className="p2-wide">{r.locked_at ? shortDate(r.locked_at) : 'Yes'}</td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', color: r.days_waiting > 45 ? '#b91c1c' : 'var(--gray-700)', fontWeight: r.days_waiting > 45 ? 700 : 400 }}>{r.days_waiting} days</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{money(r.amount_cents)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function Fact({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontSize: '0.74rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', ...muted }}>{label}</div>
      <div style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--navy)' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.78rem', ...muted }}>{sub}</div>}
    </div>
  );
}

// A plain list of sessions (for "needs locking" and "no note").
function SessionList({ rows, canCancel, onChanged }) {
  const [gone, setGone] = useState(new Set());
  const [busy, setBusy] = useState(null);
  async function cancel(r) {
    if (!window.confirm(`Cancel ${r.group} on ${longDay(r.date)}?\n\nIt will be marked cancelled in Ritzoini and stop counting as a session.`)) return;
    setBusy(r.id);
    try { await api.post(`/payments2/sessions/${r.id}/cancel`); setGone(g => new Set([...g, r.id])); onChanged?.(); }
    catch (e) { alert(e.message); } finally { setBusy(null); }
  }
  const shown = rows.filter(r => !gone.has(r.id));
  if (!shown.length) return <div style={{ fontSize: '0.86rem', color: '#047857', fontWeight: 600 }}>✓ All done.</div>;
  return (
    <div style={{ border: '1px solid var(--gray-200)', borderRadius: 10, overflow: 'hidden' }}>
      {shown.map((r, i) => (
        <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderTop: i ? '1px solid var(--gray-100)' : 'none', flexWrap: 'wrap' }}>
          <div style={{ width: 150, flexShrink: 0 }}>
            <div style={{ fontWeight: 600, color: 'var(--navy)', fontSize: '0.86rem' }}>{dayDate(r.date)}</div>
            {r.time && <div style={{ fontSize: '0.76rem', ...muted }}>{fmt12(r.time)}</div>}
          </div>
          <div style={{ flex: 1, minWidth: 160, fontSize: '0.86rem' }}>
            <Link to={`/groups/${r.group_id}`} style={{ color: 'var(--navy)', fontWeight: 600 }}>{r.group}</Link>
            {r.billing_name && <div style={{ fontSize: '0.76rem', ...muted }}>{r.billing_name}</div>}
          </div>
          {canCancel
            ? <button className="btn btn-outline btn-sm" disabled={busy === r.id} onClick={() => cancel(r)}>{busy === r.id ? '…' : "It didn't happen — cancel"}</button>
            : <Link to={`/groups/${r.group_id}`} className="btn btn-outline btn-sm">Open group to lock</Link>}
        </div>
      ))}
    </div>
  );
}

// ── review: lines that didn't match on their own ───────────────────────────
function ReviewQueue({ onChanged }) {
  const [q, setQ] = useState(null);
  const load = useCallback(() => api.get('/payments2/review').then(setQ).catch(e => alert(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const done = id => { setQ(list => list.filter(x => x.id !== id)); onChanged(); };
  if (!q) return <Spinner />;
  if (!q.length) return <div style={{ fontSize: '0.86rem', color: '#047857', fontWeight: 600 }}>✓ All matched.</div>;
  return <div style={{ display: 'grid', gap: 14 }}>{q.map(item => <ReviewItem key={item.id} item={item} onDone={() => done(item.id)} />)}</div>;
}

function ReviewItem({ item, onDone }) {
  const [busy, setBusy] = useState(false);
  const free = item.candidates.filter(c => !c.taken);
  const best = item.candidates[0];
  const bestTaken = best && best.taken && best.score >= 0.3;

  async function pick(sessionId) {
    setBusy(true);
    try { await api.post(`/payments2/items/${item.id}/link`, { session_id: sessionId }); onDone(); }
    catch (e) { alert(e.message); setBusy(false); }
  }
  async function aside(reason) {
    setBusy(true);
    try { await api.post(`/payments2/items/${item.id}/set-aside`, { reason }); onDone(); }
    catch (e) { alert(e.message); setBusy(false); }
  }

  return (
    <div style={{ border: '1px solid var(--gray-200)', borderRadius: 12, overflow: 'hidden', background: 'var(--white)' }}>
      <div style={{ padding: '12px 16px', background: 'var(--gray-50)', borderBottom: '1px solid var(--gray-200)' }}>
        <div style={{ fontWeight: 700, color: 'var(--navy)' }}>{longDay(item.session_date)}</div>
        <div style={{ fontSize: '0.86rem', color: 'var(--gray-600)', marginTop: 2 }}>
          The office wrote <strong>“{item.line}”</strong> — paid {money(item.amount_cents)} on the {shortDate(item.pay_date)} payday.
        </div>
      </div>

      {bestTaken && (
        <div style={{ padding: '10px 16px', background: '#fffbeb', fontSize: '0.84rem', color: '#92400e', borderBottom: '1px solid #fde68a' }}>
          The session that fits best — <strong>{best.group}</strong> at {fmt12(best.time)} — was <strong>already paid on the {shortDate(best.paid_on)} payday</strong>. The office probably paid it twice.
        </div>
      )}

      <div style={{ padding: '10px 16px 4px' }}>
        <div style={{ fontSize: '0.76rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', ...muted, marginBottom: 6 }}>
          Your sessions on {toDate(item.session_date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
        </div>
        {item.candidates.length === 0 && <div style={{ fontSize: '0.86rem', ...muted, padding: '6px 0 10px' }}>Ritzoini has no sessions on this day.</div>}
        {[...item.candidates].sort((a, b) => String(a.time).localeCompare(String(b.time))).map(c => (
          <div key={c.session_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: '1px solid var(--gray-100)', opacity: c.taken ? 0.6 : 1 }}>
            <div style={{ width: 78, flexShrink: 0, fontWeight: 700, color: 'var(--navy)', fontSize: '0.88rem' }}>{fmt12(c.time)}</div>
            <div style={{ flex: 1, minWidth: 0, fontSize: '0.86rem' }}>
              <div style={{ fontWeight: 600, color: 'var(--gray-700)' }}>{c.group}</div>
              <div style={{ fontSize: '0.76rem', ...muted }}>
                {[c.billing_name, c.locked ? 'locked' : 'not locked', c.status === 'cancelled' ? 'cancelled in Ritzoini' : null].filter(Boolean).join(' · ')}
              </div>
            </div>
            {c.taken
              ? <span style={{ fontSize: '0.76rem', ...muted, whiteSpace: 'nowrap' }}>Already paid {shortDate(c.paid_on)}</span>
              : <button className="btn btn-gold btn-sm" disabled={busy} onClick={() => pick(c.session_id)}>This one</button>}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '10px 16px 14px', borderTop: '1px solid var(--gray-100)' }}>
        <span style={{ fontSize: '0.8rem', ...muted, alignSelf: 'center', marginRight: 4 }}>{free.length ? 'None of these?' : 'No unpaid session fits.'}</span>
        <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => aside('paid_twice')}>It was already paid — office paid it twice</button>
        <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => aside('not_in_ritzoini')}>This session isn't in Ritzoini</button>
      </div>
    </div>
  );
}

// ── paydays ────────────────────────────────────────────────────────────────
// Every payday in order — including ones with nothing on file — each with a
// place for its pay stub and its session list.
function Paydays({ slots, paydays, open, setOpen, reload }) {
  const rows = slots?.length ? slots : paydays.map(p => ({ pay_date: p.pay_date, payday_id: p.id, card: p, has_stub: p.has_stub, has_list: p.has_list,
    period_start: p.period_start, period_end: p.period_end, missing: p.has_stub && p.has_list ? null : !p.has_stub ? 'pay stub' : 'session list' }));
  if (!rows.length) return <div style={card}><Empty>No paydays yet. Use <strong>+ Add a pay stub or list</strong> to bring them in.</Empty></div>;
  return (
    <div style={card}>
      {rows.map((sl, i) => {
        const p = sl.card;
        const adds = p && p.has_stub && p.has_list ? (p.list_cents || 0) - (p.gross_cents || 0) : null;
        const status = sl.future ? { t: 'Upcoming', c: 'var(--gray-400)' }
          : !sl.has_stub && !sl.has_list ? { t: 'Missing stub + list', c: '#b91c1c' }
          : !sl.has_list ? { t: 'Missing session list', c: '#b45309' }
          : !sl.has_stub ? { t: 'Missing pay stub', c: '#b45309' }
          : adds === 0 ? { t: '✓ Adds up', c: '#047857' }
          : { t: adds < 0 ? `Paid ${money(-adds)} more than listed` : `Paid ${money(adds)} less than listed`, c: '#b91c1c' };
        const key = sl.payday_id || sl.pay_date;
        const isOpen = open === key;
        return (
          <div key={key} style={{ borderTop: i ? '1px solid var(--gray-100)' : 'none' }}>
            <button onClick={() => setOpen(isOpen ? null : key)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 14, padding: '13px 18px', background: isOpen ? 'var(--gray-50)' : 'none', border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit', flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--gray-400)', fontSize: '0.7rem', width: 10 }}>{isOpen ? '▼' : '▶'}</span>
              <span style={{ fontWeight: 700, color: sl.payday_id ? 'var(--navy)' : 'var(--gray-500)', minWidth: 170 }}>{dayDate(sl.pay_date)}</span>
              <span style={{ minWidth: 90, fontWeight: 600 }}>{p ? money(p.gross_cents) : '—'}</span>
              <span style={{ flex: 1, minWidth: 120, ...muted, fontSize: '0.86rem' }}>
                {shortDate(sl.period_start)} – {shortDate(sl.period_end)}{p?.has_list ? ` · ${plural(p.sessions, 'session')}` : ''}{p?.unmatched ? ` · ${p.unmatched} to match` : ''}
              </span>
              <span style={{ display: 'flex', gap: 6 }}><DocDot ok={sl.has_stub} label="Stub" /><DocDot ok={sl.has_list} label="List" /></span>
              <span style={{ color: status.c, fontWeight: 600, fontSize: '0.84rem', minWidth: 150, textAlign: 'right' }}>{status.t}</span>
            </button>
            {isOpen && (
              <div style={{ padding: '4px 18px 6px 42px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
                <DocSlot kind="stub" sl={sl} reload={reload} />
                <DocSlot kind="list" sl={sl} reload={reload} />
              </div>
            )}
            {isOpen && sl.payday_id && <PaydayDetail id={sl.payday_id} reload={reload} />}
          </div>
        );
      })}
    </div>
  );
}

function DocDot({ ok, label }) {
  return <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: ok ? '#ecfdf5' : '#f3f4f6', color: ok ? '#047857' : '#9ca3af' }}>{ok ? '✓' : '○'} {label}</span>;
}

// One document box: what's on file, or a place to drop it. Lists are put on
// this payday; a stub goes to the Pay Date printed on it.
function DocSlot({ kind, sl, reload }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [over, setOver] = useState(false);
  const ref = useRef(null);
  const has = kind === 'stub' ? sl.has_stub : sl.has_list;
  const title = kind === 'stub' ? 'Pay stub' : 'Session list';
  async function openFile() {
    try {
      const { url, text } = await api.get(`/payments2/paydays/${sl.payday_id}/file/${kind}`);
      if (url) return window.open(url, '_blank', 'noopener');
      const w = window.open('', '_blank');
      if (!w) return alert(text);
      w.document.title = `Session list — ${sl.pay_date}`;
      const pre = w.document.createElement('pre');
      pre.style.cssText = 'font: 14px/1.5 ui-monospace, Menlo, monospace; white-space: pre-wrap; padding: 20px;';
      pre.textContent = text;
      w.document.body.appendChild(pre);
    }
    catch (e) { alert(e.message); }
  }
  async function send(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    setBusy(true); setMsg(null);
    try {
      const fd = new FormData();
      files.forEach(f => fd.append('files', f));
      fd.append('pay_date', sl.pay_date);
      const r = await api.postForm('/payments2/import', fd);
      const res = [...(r.results || []), ...(r.skipped || []).map(x => ({ outcome: 'skipped', message: x.reason, file: x.file }))];
      const lines = res.map(x => {
        if (x.outcome === 'stub') return x.pay_date && x.pay_date !== sl.pay_date
          ? { err: true, t: `Stub read: its Pay Date is ${dayDate(x.pay_date)}, so it went on that payday instead.` }
          : { t: `Stub added — ${money(x.gross_cents)}.` };
        if (x.outcome === 'list') return { t: `List added — ${plural(x.lines || 0, 'line')}${x.auto_matched != null ? `, ${x.auto_matched} matched` : ''}${x.needs_review ? `, ${x.needs_review} to match by hand` : ''}.` };
        if (x.outcome === 'skipped' || x.outcome === 'skipped_dup') return { t: `${x.file}: ${x.message || 'already on file'}` };
        return { err: true, t: `${x.file}: ${x.message || x.outcome}` };
      });
      setMsg(lines.length ? lines : [{ err: true, t: 'Nothing readable in that file.' }]);
      reload();
    } catch (e) { setMsg([{ err: true, t: e.message }]); }
    setBusy(false);
    if (ref.current) ref.current.value = '';
  }
  return (
    <div onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); send(e.dataTransfer.files); }}
      style={{ border: `1px ${has ? 'solid' : 'dashed'} ${over ? 'var(--gold)' : has ? '#a7f3d0' : 'var(--gray-300)'}`, background: has ? '#f0fdf4' : over ? '#fffbeb' : 'var(--white)', borderRadius: 10, padding: '10px 12px', fontSize: '0.84rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ flex: 1, color: 'var(--navy)' }}>{has ? '✓ ' : ''}{title}</strong>
        {has && sl.payday_id && <button style={linkBtn} onClick={openFile}>Open</button>}
        <input ref={ref} type="file" multiple style={{ display: 'none' }} accept=".pdf,.eml,.xlsx,.xls,.csv,.txt" onChange={e => send(e.target.files)} />
        <button className="btn btn-outline btn-xs" disabled={busy} onClick={() => ref.current?.click()}>{busy ? 'Reading…' : has ? 'Add another' : 'Upload'}</button>
      </div>
      {!has && !msg && <div style={{ ...muted, marginTop: 4 }}>Drop the {kind === 'stub' ? 'stub PDF' : 'list (email, Excel or PDF)'} here.</div>}
      {msg && msg.map((m, i) => <div key={i} style={{ marginTop: 4, color: m.err ? '#b45309' : '#047857' }}>{m.t}</div>)}
    </div>
  );
}

function PaydayDetail({ id, reload }) {
  const [d, setD] = useState(null);
  const load = useCallback(async () => { try { setD(await api.get(`/payments2/paydays/${id}`)); } catch (e) { alert(e.message); } }, [id]);
  useEffect(() => { load(); }, [load]);
  async function openFile(which) {
    try { const { url } = await api.get(`/payments2/paydays/${id}/file/${which}`); window.open(url, '_blank', 'noopener'); }
    catch (e) { alert(e.message); }
  }
  if (!d) return <div style={{ padding: '0 18px 16px' }}><Spinner /></div>;
  const p = d.payday;
  return (
    <div style={{ padding: '4px 18px 18px 42px', display: 'grid', gap: 12 }}>
      <div style={{ fontSize: '0.84rem', ...muted, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {p.period_start && <span>Stub's printed period: {shortDate(p.period_start)} – {shortDate(p.period_end)}</span>}
      </div>
      {d.items.length === 0 ? <div style={{ fontSize: '0.86rem', ...muted }}>No session list for this payday.</div> : (
        <div style={{ border: '1px solid var(--gray-200)', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Session date</th><th style={th}>Office wrote</th><th style={th}>Your session</th><th style={{ ...th, textAlign: 'right' }}>Paid</th></tr></thead>
            <tbody>{d.items.map(i => (
              <tr key={i.id}>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{dayDate(i.session_date)}</td>
                <td style={td}>{i.billing_name_raw}</td>
                <td style={td}>{i.session
                  ? <span>{i.session.group} <span style={muted}>{fmt12(i.session.time)}</span></span>
                  : <span style={{ color: '#b45309', fontWeight: 600 }}>Not matched</span>}</td>
                <td style={{ ...td, textAlign: 'right' }}>{money(i.amount_cents)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <PaydayNotes p={p} onSaved={reload} />
    </div>
  );
}

function PaydayNotes({ p, onSaved }) {
  const [notes, setNotes] = useState(p.notes || '');
  const [saved, setSaved] = useState(true);
  async function save() { try { await api.patch(`/payments2/paydays/${p.id}`, { notes }); setSaved(true); onSaved?.(); } catch (e) { alert(e.message); } }
  return (
    <div>
      <textarea className="form-textarea" placeholder="Notes for this payday (optional)" value={notes} onChange={e => { setNotes(e.target.value); setSaved(false); }} style={{ minHeight: 44 }} />
      {!saved && <button className="btn btn-outline btn-sm" style={{ marginTop: 6 }} onClick={save}>Save note</button>}
    </div>
  );
}

// ── add / import ───────────────────────────────────────────────────────────
const CHUNK = 3;   // small requests: big emails and PDFs are heavy on the server
const order = f => (/\.pdf$/i.test(f.name) ? 0 : /\.eml$/i.test(f.name) ? 1 : 2);   // stubs first

function AddModal({ onClose }) {
  const [files, setFiles] = useState([]);
  const [text, setText] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [out, setOut] = useState(null);
  const input = useRef(null);

  const addFiles = list => setFiles(prev => {
    const seen = new Set(prev.map(f => `${f.name}|${f.size}`));
    return [...prev, ...[...list].filter(f => !seen.has(`${f.name}|${f.size}`))];
  });

  async function post(fd, attempt = 0) {
    try { return await api.postForm('/payments2/import', fd); }
    catch (e) {
      // A dropped connection ("Failed to fetch") — the server may have restarted. Try once more.
      if (attempt === 0 && /fetch|network/i.test(e.message)) { await new Promise(r => setTimeout(r, 4000)); return post(fd, 1); }
      throw e;
    }
  }

  async function run() {
    setBusy(true);
    const results = [], skipped = [];
    const sorted = [...files].sort((a, b) => order(a) - order(b));
    const batches = [];
    for (let i = 0; i < sorted.length; i += CHUNK) batches.push(sorted.slice(i, i + CHUNK));
    if (text.trim() && !batches.length) batches.push([]);
    for (let b = 0; b < batches.length; b++) {
      setProgress(`Reading ${Math.min((b + 1) * CHUNK, sorted.length) || 1} of ${sorted.length || 1}…`);
      const fd = new FormData();
      batches[b].forEach(f => fd.append('files', f));
      if (b === batches.length - 1 && text.trim()) fd.append('text', text);
      try { const r = await post(fd); results.push(...r.results); skipped.push(...r.skipped); }
      catch (e) { batches[b].forEach(f => results.push({ file: f.name, outcome: 'error', message: `couldn't upload (${e.message})` })); }
    }
    const held = results.filter(r => r.outcome === 'needs_date');
    if (held.length) {
      setProgress('Double-checking…');
      for (const h of held) {
        try {
          const r = await api.post('/payments2/import/recheck', { text: h.text, stored: h.stored, dates: h.dates, prose: h.prose });
          if (!r.held) Object.assign(h, { outcome: r.skipped ? 'skipped_dup' : r.ok ? 'list' : 'error', pay_date: r.pay_date, auto_matched: r.auto_matched, needs_review: r.needs_review, lines: r.lines, message: r.reason });
          else Object.assign(h, { suggested: r.suggested || h.suggested, how: r.how || h.how });
        } catch { /* stays held */ }
      }
    }
    setOut({ results: results.filter(r => r.outcome !== 'skipped_dup'), skipped: [...skipped, ...results.filter(r => r.outcome === 'skipped_dup').map(r => ({ file: r.file, reason: r.message }))] });
    setBusy(false); setProgress(null);
  }

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" style={{ maxWidth: 720, width: '96vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ margin: 0, color: 'var(--navy)' }}>Add a pay stub or session list</h3>
          {!busy && <button className="modal-close" onClick={onClose}>×</button>}
        </div>
        <div className="modal-body" style={{ maxHeight: '74vh', overflowY: 'auto' }}>
          {!out ? (
            <>
              <div
                onDragOver={e => { e.preventDefault(); setOver(true); }}
                onDragLeave={() => setOver(false)}
                onDrop={e => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}
                onClick={() => input.current?.click()}
                style={{ border: `2px dashed ${over ? 'var(--gold)' : 'var(--gray-300)'}`, background: over ? '#fffbeb' : 'var(--gray-50)', borderRadius: 14, padding: '30px 16px', textAlign: 'center', cursor: 'pointer' }}>
                <div style={{ fontSize: '1.7rem' }}>📥</div>
                <div style={{ fontWeight: 700, color: 'var(--navy)', marginTop: 4 }}>Drop files here, or click to choose</div>
                <div style={{ fontSize: '0.84rem', ...muted, marginTop: 4 }}>The RTG pay stub (PDF) and the billing office's email or spreadsheet. Drop both — order doesn't matter.</div>
                <input ref={input} type="file" multiple accept=".pdf,.eml,.xlsx,.xls,.txt" style={{ display: 'none' }} onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
              </div>
              {files.length > 0 && (
                <div style={{ marginTop: 10, fontSize: '0.84rem', color: 'var(--gray-600)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <span><strong>{plural(files.length, 'file')}</strong> ready{files.length <= 4 ? `: ${files.map(f => f.name).join(', ')}` : ''}</span>
                  <button style={{ ...linkBtn, fontWeight: 400, color: 'var(--gray-400)' }} onClick={() => setFiles([])}>Clear</button>
                </div>
              )}
              <details style={{ marginTop: 16 }}>
                <summary style={{ cursor: 'pointer', fontSize: '0.86rem', color: 'var(--gray-600)', fontWeight: 600 }}>Or paste the session list instead</summary>
                <textarea className="form-textarea" value={text} onChange={e => setText(e.target.value)} placeholder={'Problem-Solving Skills Group 11/19/2026\nSelf-Monitoring Skills Group 11/17/2026'} style={{ minHeight: 100, fontFamily: 'monospace', fontSize: '0.82rem', marginTop: 8 }} />
              </details>
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginTop: 16 }}>
                {progress && <span style={{ fontSize: '0.84rem', ...muted }}>{progress}</span>}
                <button className="btn btn-gold" disabled={busy || (!files.length && !text.trim())} onClick={run}>{busy ? 'Working…' : 'Add'}</button>
              </div>
            </>
          ) : <ImportResults out={out} setOut={setOut} onDone={onClose} />}
        </div>
      </div>
    </div>
  );
}

function ImportResults({ out, setOut, onDone }) {
  const [showSkipped, setShowSkipped] = useState(false);
  const filed = out.results.filter(r => r.outcome === 'stub' || r.outcome === 'list');
  const held = out.results.filter(r => r.outcome === 'needs_date');
  const errors = out.results.filter(r => r.outcome === 'error');
  const review = filed.reduce((t, r) => t + (r.needs_review || 0), 0);

  async function confirm(h, date) {
    try {
      const r = await api.post('/payments2/import/resolve', { pay_date: date, text: h.text, stored: h.stored, prose: h.prose });
      setOut(o => ({ ...o, results: o.results.map(x => x === h ? { ...x, outcome: r.skipped ? 'error' : 'list', kind: 'list', pay_date: date, lines: r.lines, needs_review: r.needs_review, message: r.reason } : x) }));
    } catch (e) { alert(e.message); }
  }

  const sentence = [
    filed.filter(r => r.kind === 'stub').length && plural(filed.filter(r => r.kind === 'stub').length, 'pay stub'),
    filed.filter(r => r.kind === 'list').length && plural(filed.filter(r => r.kind === 'list').length, 'session list'),
  ].filter(Boolean).join(' and ');

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ fontSize: '1rem', color: 'var(--navy)', fontWeight: 700 }}>
        {sentence ? `Added ${sentence}.` : held.length ? 'Almost there.' : 'Nothing new was added.'}
        {review > 0 && <span style={{ fontWeight: 400, ...muted }}> {plural(review, 'line')} will need you to pick the session — it's on the Overview.</span>}
      </div>

      {held.length > 0 && (
        <section>
          <div style={{ fontWeight: 700, color: 'var(--navy)', marginBottom: 6 }}>Which payday is this list for?</div>
          <div style={{ fontSize: '0.84rem', ...muted, marginBottom: 8 }}>I couldn't tell for sure from the file. Check the date and press "Add to this payday".</div>
          <div style={card}>{held.map((h, i) => <HeldRow key={i} h={h} first={i === 0} onConfirm={d => confirm(h, d)} />)}</div>
        </section>
      )}

      {filed.length > 0 && (
        <div style={card}>
          {filed.map((r, i) => (
            <div key={i} style={{ padding: '10px 14px', borderTop: i ? '1px solid var(--gray-100)' : 'none', fontSize: '0.84rem', display: 'flex', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--gray-700)' }}>{r.file}</span>
              <span style={{ ...muted }}>
                {r.kind === 'stub' ? `Pay stub · ${dayDate(r.pay_date)} · ${money(r.gross_cents)}` : `List · ${dayDate(r.pay_date)} · ${plural(r.lines || 0, 'session')}`}
              </span>
            </div>
          ))}
        </div>
      )}

      {errors.length > 0 && (
        <div className="alert alert-error" style={{ margin: 0 }}>
          <strong>Couldn't add {plural(errors.length, 'file')}:</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{errors.map((r, i) => <li key={i}>{r.file || 'Upload'} — {r.message}</li>)}</ul>
        </div>
      )}

      {out.skipped.length > 0 && (
        <div style={{ fontSize: '0.82rem', ...muted }}>
          Skipped {plural(out.skipped.length, 'file')} with nothing new in them (reminders, replies, or lists already added).{' '}
          <button onClick={() => setShowSkipped(s => !s)} style={{ ...linkBtn, fontWeight: 400 }}>{showSkipped ? 'Hide' : 'Show which'}</button>
          {showSkipped && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{out.skipped.map((s, i) => <li key={i}>{s.file} — {s.reason}</li>)}</ul>}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="btn btn-gold" onClick={onDone}>Done</button></div>
    </div>
  );
}

function HeldRow({ h, first, onConfirm }) {
  const [date, setDate] = useState(h.suggested || '');
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ padding: '12px 14px', borderTop: first ? 'none' : '1px solid var(--gray-100)', display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '0.86rem', color: 'var(--navy)' }}>{h.file}</strong>
        <span style={{ fontSize: '0.8rem', ...muted }}>{plural(h.lines, 'session')} · {money(h.list_cents)} · sessions from {shortDate(h.first_date)} to {shortDate(h.last_date)}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input type="date" className="form-input" value={date} onChange={e => setDate(e.target.value)} style={{ width: 170, padding: '5px 8px' }} />
        <button className="btn btn-gold btn-sm" disabled={!date || busy} onClick={async () => { setBusy(true); await onConfirm(date); setBusy(false); }}>Add to this payday</button>
        {date && <span style={{ fontSize: '0.8rem', ...muted }}>{longDay(date)}</span>}
      </div>
    </div>
  );
}

// ── all sessions ───────────────────────────────────────────────────────────
const LEDGER_FILTERS = ['all', 'owed', 'needs_action', 'not_run', 'pending', 'paid', 'duplicate', 'cancelled', 'upcoming', 'history'];

function Ledger({ filter, setFilter, onChanged }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(async () => { try { setRows((await api.get('/payments2/ledger')).rows); } catch (e) { setErr(e.message); } }, []);
  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => { const c = { all: rows?.length || 0 }; (rows || []).forEach(r => { c[r.status] = (c[r.status] || 0) + 1; }); return c; }, [rows]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows || []).filter(r => (filter === 'all' || r.status === filter)
      && (!needle || [r.group, r.group_name, r.billing_name, dayDate(r.date), r.payday && dayDate(r.payday)].some(v => String(v || '').toLowerCase().includes(needle))));
  }, [rows, filter, q]);

  // Month headers make a long list scannable.
  const withMonths = useMemo(() => {
    const out = []; let last = null;
    for (const r of shown.slice(0, 600)) {
      const m = toDate(r.date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      if (m !== last) { out.push({ month: m }); last = m; }
      out.push(r);
    }
    return out;
  }, [shown]);

  if (err) return <div className="alert alert-error">{err}</div>;
  if (!rows) return <Spinner />;
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {LEDGER_FILTERS.filter(f => f === 'all' || counts[f]).map(f => (
          <button key={f} onClick={() => setFilter(f)} className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-outline'}`}>
            {f === 'all' ? 'All' : STATUS[f].label} <span style={{ opacity: 0.6, marginLeft: 4 }}>{counts[f] || 0}</span>
          </button>
        ))}
      </div>
      <input className="form-input" placeholder="Search by group, billing name or date (e.g. “Nov 9”)" value={q} onChange={e => setQ(e.target.value)} style={{ maxWidth: 420, marginBottom: 14 }} />
      <div style={{ ...card, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Session</th><th style={th}>Group</th><th style={th}>Status</th><th style={th}>Paid on</th><th style={{ ...th, textAlign: 'right' }}>Amount</th></tr></thead>
          <tbody>
            {withMonths.map((r, i) => r.month
              ? <tr key={`m${i}`}><td colSpan={5} style={{ ...td, background: 'var(--gray-50)', fontWeight: 700, color: 'var(--navy)', fontSize: '0.8rem', padding: '7px 14px' }}>{r.month}</td></tr>
              : (
                <tr key={r.id}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{dayDate(r.date)}{r.time && <span style={{ ...muted, marginLeft: 6 }}>{fmt12(r.time)}</span>}</td>
                  <td style={td}><Link to={`/groups/${r.group_id}`} style={{ color: 'var(--navy)', fontWeight: 600 }}>{r.group}</Link>{r.billing_name && <div style={{ fontSize: '0.74rem', ...muted }}>{r.billing_name}</div>}</td>
                  <td style={td}><Pill s={r.status} /></td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.payday ? dayDate(r.payday) : r.status === 'paid' ? <span style={muted}>Marked paid earlier</span> : '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{money(r.amount_cents)}</td>
                </tr>
              ))}
            {!shown.length && <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: 'var(--gray-400)', padding: 30 }}>Nothing here.</td></tr>}
          </tbody>
        </table>
        {shown.length > 600 && <div style={{ padding: 10, fontSize: '0.8rem', color: 'var(--gray-400)' }}>Showing the newest 600 of {shown.length}. Search or pick a filter to narrow it down.</div>}
      </div>
    </div>
  );
}

// ── settings ───────────────────────────────────────────────────────────────
function Settings({ paydays, onChanged }) {
  const [rates, setRates] = useState(null);
  const [form, setForm] = useState({ effective_date: '', amount: '' });
  const load = useCallback(async () => { try { setRates(await api.get('/payments2/rates')); } catch (e) { alert(e.message); } }, []);
  useEffect(() => { load(); }, [load]);

  async function addRate(e) {
    e.preventDefault();
    try { await api.post('/payments2/rates', form); setForm({ effective_date: '', amount: '' }); load(); onChanged(); } catch (ex) { alert(ex.message); }
  }
  async function delRate(r) {
    if (!window.confirm(`Remove the ${money(r.amount_cents)} rate that starts ${longDay(r.effective_date)}?`)) return;
    try { await api.delete(`/payments2/rates/${r.id}`); load(); onChanged(); } catch (ex) { alert(ex.message); }
  }
  async function delPayday(p) {
    if (!window.confirm(`Delete the ${longDay(p.pay_date)} payday and its ${plural(p.sessions, 'line')}?\n\nUse this only if it was added by mistake. Sessions already marked paid stay marked paid.`)) return;
    try { await api.delete(`/payments2/paydays/${p.id}`); onChanged(); } catch (ex) { alert(ex.message); }
  }

  return (
    <div style={{ display: 'grid', gap: 28, maxWidth: 720 }}>
      <section>
        <h3 style={h3}>Your rate</h3>
        <p style={{ fontSize: '0.86rem', ...muted, margin: '-6px 0 12px' }}>Each session is paid at the rate in effect on the day it happened.</p>
        <div style={card}>
          {(rates || []).map((r, i) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: i ? '1px solid var(--gray-100)' : 'none', fontSize: '0.9rem' }}>
              <span style={{ flex: 1 }}>{r.effective_date <= '2001-01-01' ? 'Originally' : `From ${longDay(r.effective_date)}`}</span>
              <strong style={{ color: 'var(--navy)' }}>{money(r.amount_cents)} a session</strong>
              <button className="btn btn-outline btn-xs" onClick={() => delRate(r)}>Remove</button>
            </div>
          ))}
          <form onSubmit={addRate} style={{ display: 'flex', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--gray-100)', background: 'var(--gray-50)', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '0.84rem', ...muted }}>New rate starting</span>
            <input type="date" className="form-input" required value={form.effective_date} onChange={e => setForm(f => ({ ...f, effective_date: e.target.value }))} style={{ width: 170 }} />
            <input type="number" step="0.01" min="0" className="form-input" required placeholder="$ a session" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} style={{ width: 130 }} />
            <button className="btn btn-gold btn-sm">Add</button>
          </form>
        </div>
      </section>

      <section>
        <h3 style={h3}>Remove a payday</h3>
        <p style={{ fontSize: '0.86rem', ...muted, margin: '-6px 0 12px' }}>Only for something added by mistake.</p>
        <div style={card}>
          {paydays.length === 0 && <Empty>None yet.</Empty>}
          {paydays.map((p, i) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderTop: i ? '1px solid var(--gray-100)' : 'none', fontSize: '0.86rem' }}>
              <span style={{ flex: 1, color: 'var(--navy)', fontWeight: 600 }}>{dayDate(p.pay_date)}</span>
              <span style={muted}>{money(p.gross_cents)}{p.has_list ? ` · ${plural(p.sessions, 'session')}` : ''}</span>
              <button className="btn btn-outline btn-xs" onClick={() => delPayday(p)}>Delete</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ── eCW check ──────────────────────────────────────────────────────────────
// Upload the eCW encounter export; see every locked session and whether it
// was paid. Same rows uploaded twice are counted once; rows that come back
// different are listed under "Changed in eCW" until you mark them seen.
const ECW_STATUS = {
  unpaid:        { label: 'Not paid yet',          bg: '#fef2f2', fg: '#b91c1c' },
  maybe_paid:    { label: 'Maybe paid as…',        bg: '#f5f3ff', fg: '#6d28d9' },
  unmatched:     { label: 'No Ritzoini session',   bg: '#fffbeb', fg: '#b45309' },
  to_lock:       { label: 'Lock in eCW',           bg: '#fef2f2', fg: '#b91c1c' },
  not_checked_in:{ label: 'In eCW, not checked in', bg: '#fffbeb', fg: '#b45309' },
  not_billed:    { label: 'Locked, not billed',    bg: '#fffbeb', fg: '#b45309' },
  not_locked:    { label: 'Not locked in eCW',     bg: '#f3f4f6', fg: '#4b5563' },
  paid:          { label: 'Paid',                  bg: '#ecfdf5', fg: '#047857' },
  cancelled:     { label: 'Cancelled',             bg: '#f9fafb', fg: '#9ca3af' },
  history:       { label: 'Before Apr 2026',       bg: '#f9fafb', fg: '#9ca3af' },
};
const ECW_FILTERS = ['all', 'to_lock', 'not_checked_in', 'unpaid', 'maybe_paid', 'unmatched', 'not_billed', 'not_locked', 'flagged', 'paid', 'cancelled', 'history'];
const FIELD_LABEL = { locked_at: 'Locked at', signed_at: 'Signed at', billed_at: 'Billed at', locked: 'Locked', signed: 'Signed', billed: 'Billed',
  visit_status: 'Visit status', claim_number: 'Claim #', claim_voided: 'Claim voided', cpt: 'CPT', start_time: 'Start', end_time: 'End',
  visit_date: 'Date', group_name: 'Group name', ecw_group_id: 'eCW group id', patient_id: 'Patient id', provider: 'Provider', visit_type: 'Visit type', present: 'In export' };

function EPill({ s }) {
  const m = ECW_STATUS[s] || { label: s, bg: '#f3f4f6', fg: '#374151' };
  return <span style={{ background: m.bg, color: m.fg, fontSize: '0.72rem', fontWeight: 700, padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap' }}>{m.label}</span>;
}
function Flag({ children, tone = '#6d28d9' }) {
  return <span style={{ display: 'inline-block', marginLeft: 6, fontSize: '0.68rem', fontWeight: 700, color: tone, border: `1px solid ${tone}55`, borderRadius: 6, padding: '1px 6px' }}>{children}</span>;
}
const isFlagged = s => s.double_billed || s.entered_twice || s.twin || s.am_typo || s.open_changes || s.missing_from_export;

function EcwCheck() {
  const [v, setV] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try { setV(await api.get('/payments2/ecw/sessions')); setErr(''); } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Files go up one at a time, oldest month first, so a later export's values win.
  async function upload(fileList) {
    const files = [...(fileList || [])].sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length) return;
    setBusy(true); setResult(null);
    const out = [];
    for (let i = 0; i < files.length; i++) {
      setBusy(`Reading ${i + 1} of ${files.length}…`);
      try { const fd = new FormData(); fd.append('file', files[i]); out.push(await api.postForm('/payments2/ecw/import', fd)); }
      catch (e) { out.push({ error: `${files[i].name}: ${e.message}` }); }
      setResult([...out]);
    }
    await load();
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  }

  const counts = useMemo(() => {
    const c = { all: v?.sessions.length || 0, flagged: 0 };
    (v?.sessions || []).forEach(s => { c[s.status] = (c[s.status] || 0) + 1; if (isFlagged(s)) c.flagged++; });
    return c;
  }, [v]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (v?.sessions || []).filter(s => (filter === 'all' || (filter === 'flagged' ? isFlagged(s) : s.status === filter))
      && (!needle || [s.group, s.ritzoini?.group, dayDate(s.date)].some(x => String(x || '').toLowerCase().includes(needle))));
  }, [v, filter, q]);
  const withMonths = useMemo(() => {
    const out = []; let last = null;
    for (const s of shown.slice(0, 600)) {
      const m = toDate(s.date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      if (m !== last) { out.push({ month: m }); last = m; }
      out.push(s);
    }
    return out;
  }, [shown]);

  const t = v?.totals || {};
  const waiting = (t.not_locked?.count || 0) + (t.not_billed?.count || 0);

  return (
    <div style={{ display: 'grid', gap: 22 }}>
      <section style={{ ...card, padding: 18 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontWeight: 700, color: 'var(--navy)' }}>Upload an eCW export</div>
            <div style={{ fontSize: '0.84rem', ...muted, marginTop: 2 }}>
              The encounter CSVs from the extension — pick several at once (one per month is fine). Rows already here are counted once, and anything that comes back different is listed below. With the extension connected, pulls arrive here on their own.
            </div>
          </div>
          <input ref={fileRef} type="file" multiple accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={e => upload(e.target.files)} />
          <button className="btn btn-gold" disabled={!!busy} onClick={() => fileRef.current?.click()}>{busy ? (busy === true ? 'Reading…' : busy) : 'Choose files'}</button>
        </div>
        {result && result.map((r, i) => <ImportSummary key={i} r={r} />)}
        {v?.imports?.length > 0 && (
          <div style={{ fontSize: '0.78rem', ...muted, marginTop: 12 }}>
            Last upload {new Date(v.imports[0].uploaded_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {v.imports[0].filename}
            {v.covered && <> · eCW data covers {shortDate(v.covered[0])} – {dayDate(v.covered[1])}</>}
          </div>
        )}
      </section>

      {err && <div className="alert alert-error">{err}</div>}
      {!v && !err && <Spinner />}

      {v && (
        <>
          <LockPanel sessions={v.sessions} />

          <EcwChanges flags={v.flags} onChanged={load} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
            <div style={{ ...card, padding: 14 }}><Fact label="Not paid yet" value={money(t.unpaid?.cents)} sub={`${plural(t.unpaid?.count || 0, 'session')} locked + billed, on no pay report`} /></div>
            <div style={{ ...card, padding: 14 }}><Fact label="Maybe paid under another entry" value={plural(t.maybe_paid?.count || 0, 'session')} sub="check and confirm" /></div>
            <div style={{ ...card, padding: 14 }}><Fact label="Waiting on eCW" value={plural(waiting, 'session')} sub="not locked or not billed yet" /></div>
            <div style={{ ...card, padding: 14 }}><Fact label="Paid" value={money(t.paid?.cents)} sub={plural(t.paid?.count || 0, 'session')} /></div>
          </div>

          {(v.flags.double_billed > 0 || v.flags.entered_twice > 0 || v.flags.am_typo > 0) && (
            <div style={{ ...card, padding: '12px 16px', fontSize: '0.86rem', display: 'grid', gap: 4 }}>
              <strong style={{ color: 'var(--navy)' }}>For the office</strong>
              {v.flags.double_billed > 0 && <span>{plural(v.flags.double_billed, 'session')} with the same patient billed twice — possible double billing.</span>}
              {v.flags.entered_twice > 0 && <span>{plural(v.flags.entered_twice, 'session')} entered twice in eCW (counted once here).</span>}
              {v.flags.am_typo > 0 && <span>{plural(v.flags.am_typo, 'session')} with an AM start time that should be PM.</span>}
              <button style={{ ...linkBtn, justifySelf: 'start', marginTop: 2 }} onClick={() => setFilter('flagged')}>Show them</button>
            </div>
          )}

          <MissingReports list={v.missing_reports} />

          {v.paid_no_ecw.length > 0 && (
            <details style={{ ...card, padding: '12px 16px' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 700, color: 'var(--navy)', fontSize: '0.9rem' }}>
                {plural(v.paid_no_ecw.length, 'payday line')} paid with no eCW session behind it
              </summary>
              <div style={{ fontSize: '0.84rem', marginTop: 8, display: 'grid', gap: 4 }}>
                {v.paid_no_ecw.map(r => (
                  <div key={r.id}>{dayDate(r.date)} {r.time && fmt12(r.time)} · <Link to={`/groups/${r.group_id}`} style={{ color: 'var(--navy)' }}>{r.group}</Link> · paid {shortDate(r.payday)}
                    {r.maybe_for && <span style={muted}> — probably eCW {shortDate(r.maybe_for.date)} {fmt12(r.maybe_for.time)} {r.maybe_for.group}</span>}</div>
                ))}
              </div>
            </details>
          )}

          <div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {ECW_FILTERS.filter(f => f === 'all' || counts[f]).map(f => (
                <button key={f} onClick={() => setFilter(f)} className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-outline'}`}>
                  {f === 'all' ? 'All' : f === 'flagged' ? 'Flagged' : ECW_STATUS[f].label} <span style={{ opacity: 0.6, marginLeft: 4 }}>{counts[f] || 0}</span>
                </button>
              ))}
            </div>
            <input className="form-input" placeholder="Search by group or date (e.g. “Nov 9”)" value={q} onChange={e => setQ(e.target.value)} style={{ maxWidth: 420, marginBottom: 14 }} />
            <div style={{ ...card, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={th}>Session</th><th style={th}>eCW group</th><th style={th}>Status</th><th style={th} className="p2-wide">Ritzoini</th><th style={{ ...th, textAlign: 'right' }}>Amount</th></tr></thead>
                <tbody>
                  {withMonths.map((s, i) => s.month
                    ? <tr key={`m${i}`}><td colSpan={5} style={{ ...td, background: 'var(--gray-50)', fontWeight: 700, color: 'var(--navy)', fontSize: '0.8rem', padding: '7px 14px' }}>{s.month}</td></tr>
                    : <EcwRow key={s.ecw_group_id} s={s} />)}
                  {!shown.length && <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: 'var(--gray-400)', padding: 30 }}>{v.sessions.length ? 'Nothing here.' : 'No eCW data yet — upload an export above.'}</td></tr>}
                </tbody>
              </table>
              {shown.length > 600 && <div style={{ padding: 10, fontSize: '0.8rem', color: 'var(--gray-400)' }}>Showing the newest 600 of {shown.length}. Search or pick a filter to narrow it down.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function EcwRow({ s }) {
  let detail = null;
  if (s.status === 'paid') detail = s.paid_on ? <>on {shortDate(s.paid_on)}</> : 'marked paid earlier (no pay report on file)';
  else if (s.status === 'unpaid') detail = <>locked {shortDate(s.ready_date)} · {plural(s.days_since_lock, 'day')} ago · on no pay report</>;
  else if (s.status === 'maybe_paid') detail = <>{s.maybe_paid_as.group} {s.maybe_paid_as.time && fmt12(s.maybe_paid_as.time)} on {shortDate(s.maybe_paid_as.date)}, paid {shortDate(s.maybe_paid_as.payday)}</>;
  else if (s.status === 'not_billed' || s.status === 'not_locked') detail = <>{s.locked}/{s.encounters} locked · {s.billed} billed</>;
  else if (s.status === 'to_lock') detail = <>{s.to_lock} visit{s.to_lock === 1 ? '' : 's'} to lock{s.office_flagged ? '' : <span style={{ color: '#b91c1c' }}> · office never flagged it in Zoho</span>}</>;
  else if (s.status === 'not_checked_in') detail = <>{s.ritzoini?.note_sent ? 'note sent · ' : ''}waiting on the office to check it in</>;
  return (
    <tr>
      <td style={{ ...td, whiteSpace: 'nowrap' }}>{dayDate(s.date)}{s.time && <span style={{ ...muted, marginLeft: 6 }}>{fmt12(s.time)}</span>}</td>
      <td style={td}>
        <span style={{ fontWeight: 600, color: 'var(--navy)' }}>{s.group || '—'}</span>
        <span style={{ fontSize: '0.74rem', ...muted, marginLeft: 6 }}>{plural(s.attended, 'patient')}</span>
        {s.double_billed > 0 && <Flag tone="#b91c1c">billed twice</Flag>}
        {(s.entered_twice > 0 || s.twin) && <Flag>entered twice</Flag>}
        {s.am_typo && <Flag tone="#b45309">{fmt12(s.time_raw)} in eCW</Flag>}
        {s.open_changes > 0 && <Flag tone="#b45309">changed in eCW</Flag>}
        {s.missing_from_export && <Flag tone="#b45309">rows gone from eCW</Flag>}
      </td>
      <td style={td}><EPill s={s.status} />{detail && <div style={{ fontSize: '0.74rem', ...muted, marginTop: 3 }}>{detail}</div>}</td>
      <td style={td} className="p2-wide">{s.ritzoini ? <Link to={`/groups/${s.ritzoini.group_id}`} style={{ color: 'var(--navy)' }}>{s.ritzoini.group}</Link> : <span style={muted}>—</span>}</td>
      <td style={{ ...td, textAlign: 'right' }}>{money(s.amount_cents)}</td>
    </tr>
  );
}

function ImportSummary({ r }) {
  if (r.error) return <div className="alert alert-error" style={{ marginTop: 12 }}>{r.error}</div>;
  const bits = [`${plural(r.new_count, 'new row')}`, `${r.unchanged_count} already here (not counted again)`];
  if (r.changed_count) bits.push(`${plural(r.changed_count, 'row')} came back different`);
  if (r.missing_count) bits.push(`${plural(r.missing_count, 'row')} no longer in eCW`);
  return (
    <div className="alert alert-success" style={{ marginTop: 12, fontSize: '0.86rem' }}>
      Read {plural(r.rows, 'encounter')} ({shortDate(r.date_from)} – {dayDate(r.date_to)}): {bits.join(' · ')}.
      {r.changed_encounters > 0 && <> {plural(r.changed_encounters, 'change')} to look at below.</>}
      {r.duplicate_rows_in_file > 0 && <> {plural(r.duplicate_rows_in_file, 'repeated row')} in the file counted once{r.in_file_conflicts ? ` (${r.in_file_conflicts} with different values — the first copy was kept)` : ''}.</>}
      {r.problems?.length > 0 && <div style={{ marginTop: 4 }}>Skipped: {r.problems.join('; ')}</div>}
    </div>
  );
}

function EcwChanges({ flags, onChanged }) {
  const [list, setList] = useState(null);
  const [showProgress, setShowProgress] = useState(false);
  const load = useCallback(async () => { try { setList(await api.get('/payments2/ecw/changes')); } catch { setList([]); } }, []);
  useEffect(() => { if (flags.open_changes || flags.open_progress) load(); else setList([]); }, [flags.open_changes, flags.open_progress, load]);
  if (!list || (!flags.open_changes && !flags.open_progress)) return null;

  async function ack(body) {
    try { await api.post('/payments2/ecw/changes/acknowledge', body); await load(); onChanged(); } catch (e) { alert(e.message); }
  }
  const important = list.filter(c => c.kind !== 'filled');
  // One block per group session (you're paid per group); its client lines underneath.
  const bySession = [];
  { const m = new Map(); for (const c of important) { const k = c.ecw_group_id || c.encounter_id; if (!m.has(k)) { m.set(k, []); bySession.push(m.get(k)); } m.get(k).push(c); } }
  const progress = list.filter(c => c.kind === 'filled');
  const val = (f, x) => (x == null ? <span style={muted}>blank</span> : f === 'start_time' || f === 'end_time' ? fmt12(x) : x);
  const Row = ({ c }) => (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 16px', borderTop: '1px solid var(--gray-100)', fontSize: '0.84rem', flexWrap: 'wrap' }}>
      <span style={{ minWidth: 190 }}>{dayDate(c.visit_date)} {c.start_time && fmt12(c.start_time)}<div style={{ fontSize: '0.74rem', ...muted }}>{c.group} · patient {c.patient_id}</div></span>
      <span style={{ flex: 1 }}><strong>{FIELD_LABEL[c.field] || c.field}:</strong> {val(c.field, c.old_value)} → {val(c.field, c.new_value)}</span>
      <button className="btn btn-outline btn-xs" onClick={() => ack({ ids: [c.id] })}>Seen</button>
    </div>
  );
  return (
    <section style={card}>
      {important.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 10 }}>
            <strong style={{ flex: 1, color: '#b45309' }}>Changed in eCW since an earlier upload · {plural(bySession.length, 'session')}</strong>
            <button className="btn btn-outline btn-xs" onClick={() => ack({ ids: important.map(c => c.id) })}>Mark all seen</button>
          </div>
          {bySession.slice(0, 100).map(cs => {
            const c0 = cs[0];
            const kinds = [...new Set(cs.map(c => `${FIELD_LABEL[c.field] || c.field}: ${c.old_value ?? 'blank'} → ${c.new_value ?? 'blank'}`))];
            const clients = new Set(cs.map(c => c.patient_id)).size;
            return (
              <details key={c0.ecw_group_id || c0.id} style={{ borderTop: '1px solid var(--gray-100)' }}>
                <summary style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '9px 16px', fontSize: '0.86rem', cursor: 'pointer', flexWrap: 'wrap' }}>
                  <span style={{ minWidth: 190, fontWeight: 600, color: 'var(--navy)' }}>{dayDate(c0.visit_date)} {c0.start_time && fmt12(c0.start_time)}<div style={{ fontSize: '0.74rem', fontWeight: 400, ...muted }}>{c0.group}</div></span>
                  <span style={{ flex: 1 }}>{kinds.length === 1 ? kinds[0] : plural(cs.length, 'change')}<span style={muted}> · {plural(clients, 'client')}</span></span>
                  <button className="btn btn-outline btn-xs" onClick={e => { e.preventDefault(); ack({ ids: cs.map(c => c.id) }); }}>Seen</button>
                </summary>
                {cs.map(c => <Row key={c.id} c={c} />)}
              </details>
            );
          })}
        </>
      )}
      {progress.length > 0 && (
        <div style={{ padding: '10px 16px', borderTop: important.length ? '1px solid var(--gray-200)' : 'none', fontSize: '0.84rem', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, ...muted }}>{plural(progress.length, 'normal update')} — blanks filled in, sessions locked or billed since the last upload.</span>
          <button style={linkBtn} onClick={() => setShowProgress(x => !x)}>{showProgress ? 'Hide' : 'Show'}</button>
          <button className="btn btn-outline btn-xs" onClick={() => ack({ kind: 'filled' })}>Mark seen</button>
        </div>
      )}
      {showProgress && progress.slice(0, 300).map(c => <Row key={c.id} c={c} />)}
    </section>
  );
}

// Pay periods with no stub and/or no session list on file — what to ask the office for.
function MissingReports({ list }) {
  const [copied, setCopied] = useState(false);
  if (!list?.length) return null;
  const range = m => `${shortDate(m.period_start)} – ${dayDate(m.period_end)}`;
  const text = 'Hi, could you please send me the payroll reports (pay stub and session list) for these pay periods:\n\n'
    + list.map(m => `• Payday ${dayDate(m.pay_date)} (pay period ${range(m)}): ${m.missing}`).join('\n') + '\n\nThank you!';
  async function copy() { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { window.prompt('Copy this:', text); } }
  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 10 }}>
        <strong style={{ flex: 1, color: 'var(--navy)' }}>Missing pay reports · {list.length}</strong>
        <button className="btn btn-outline btn-xs" onClick={copy}>{copied ? 'Copied ✓' : 'Copy request for the office'}</button>
      </div>
      <div style={{ padding: '0 16px 6px', fontSize: '0.8rem', ...muted }}>Sessions in these periods can't be confirmed paid until the report is uploaded.</div>
      {list.map(m => (
        <div key={m.pay_date} style={{ display: 'flex', gap: 12, padding: '8px 16px', borderTop: '1px solid var(--gray-100)', fontSize: '0.86rem', flexWrap: 'wrap' }}>
          <span style={{ minWidth: 170, fontWeight: 600, color: 'var(--navy)' }}>Payday {dayDate(m.pay_date)}</span>
          <span style={{ flex: 1 }}>Pay period {range(m)}</span>
          <span style={{ color: '#b45309' }}>Missing {m.missing}{m.gross_cents != null && <span style={muted}> · stub {money(m.gross_cents)}</span>}</span>
        </div>
      ))}
    </section>
  );
}

// Locking: what's waiting on you in eCW, what's waiting on the office, and
// where your Ritzoini "Locked" click (which tells Zoho) disagrees with eCW.
function LockPanel({ sessions }) {
  const [copied, setCopied] = useState(false);
  const toLock = sessions.filter(s => s.status === 'to_lock');
  const office = sessions.filter(s => s.status === 'not_checked_in');
  const notMarked = sessions.filter(s => s.lock_not_marked);
  const markedOpen = sessions.filter(s => s.lock_marked_not_done);
  if (!toLock.length && !office.length && !notMarked.length && !markedOpen.length) return null;
  const officeMiss = [...toLock.filter(s => !s.office_flagged), ...office];
  const when = s => `${dayDate(s.date)}${s.time ? ` ${fmt12(s.time)}` : ''}`;
  const text = 'Hi, these group sessions have notes sent but were not marked ready to lock in Zoho:\n\n'
    + officeMiss.map(s => `• ${when(s)} — ${s.group}${s.status === 'not_checked_in' ? ' (in eCW, visits not checked in yet)' : ' (in eCW, ready to lock)'}`).join('\n') + '\n\nThank you!';
  async function copy() { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { window.prompt('Copy this:', text); } }
  const Block = ({ title, tone, note, rows, right }) => rows.length ? (
    <div style={{ borderTop: '1px solid var(--gray-100)' }}>
      <div style={{ padding: '10px 16px 4px', fontWeight: 700, color: tone, fontSize: '0.88rem' }}>{title} · {rows.length}</div>
      {note && <div style={{ padding: '0 16px 6px', fontSize: '0.78rem', ...muted }}>{note}</div>}
      {rows.map(s => (
        <div key={s.ecw_group_id} style={{ display: 'flex', gap: 12, padding: '6px 16px', fontSize: '0.85rem', flexWrap: 'wrap' }}>
          <span style={{ minWidth: 200, color: 'var(--navy)', fontWeight: 600 }}>{when(s)}</span>
          <span style={{ flex: 1 }}>{s.group}{s.ritzoini && <> · <Link to={`/groups/${s.ritzoini.group_id}`} style={{ color: 'var(--navy)' }}>{s.ritzoini.group}</Link></>}</span>
          <span style={{ fontSize: '0.78rem' }}>{right(s)}</span>
        </div>
      ))}
    </div>
  ) : null;
  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 10 }}>
        <strong style={{ flex: 1, color: 'var(--navy)' }}>Locking</strong>
        {officeMiss.length > 0 && <button className="btn btn-outline btn-xs" onClick={copy}>{copied ? 'Copied ✓' : `Copy note for the office (${officeMiss.length})`}</button>}
      </div>
      <Block title="Lock these in eCW (you)" tone="#b91c1c" rows={toLock} note="Checked in to eCW with the note, not locked. After you lock, mark it locked in Ritzoini."
        right={s => s.office_flagged ? <span style={muted}>office flagged it ✓</span> : <span style={{ color: '#b91c1c', fontWeight: 600 }}>office never flagged it in Zoho</span>} />
      <Block title="Waiting on the office" tone="#b45309" rows={office} note="In eCW but not checked in yet, and not flagged ready to lock in Zoho."
        right={s => s.ritzoini?.note_sent ? <span style={muted}>your note was sent</span> : <span style={muted}>no note sent from Ritzoini</span>} />
      <Block title="Mark locked in Ritzoini (you)" tone="#b45309" rows={notMarked} note="Locked in eCW, but not marked locked in Ritzoini — so Zoho doesn't show it locked."
        right={() => <span style={muted}>locked in eCW ✓</span>} />
      <Block title="Marked locked, still open in eCW (you)" tone="#b91c1c" rows={markedOpen} note="Ritzoini (and Zoho) say locked, but eCW doesn't."
        right={s => <span style={{ color: '#b91c1c' }}>{s.to_lock + s.pending_checkin} open in eCW</span>} />
    </section>
  );
}

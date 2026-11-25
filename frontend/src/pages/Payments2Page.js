// Payments 2.0 — paydays-first payment tracking (owner only).
// Backend: backend/routes/payments2.js. Lives alongside the original Payments page.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../utils/api';

// ── formatting ─────────────────────────────────────────────────────────────
const money = c => (c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = iso => { if (!iso) return '—'; const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
const shortDate = iso => { if (!iso) return '—'; const [, m, d] = iso.slice(0, 10).split('-').map(Number); return `${MONTHS[m - 1]} ${d}`; };
const fmt12 = t => { if (!t) return ''; let [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')}${ap}`; };

const STATUS = {
  owed:         { label: 'Owed',               bg: '#fef2f2', fg: '#b91c1c' },
  needs_action: { label: 'Needs lock',         bg: '#fffbeb', fg: '#b45309' },
  not_run:      { label: "Probably didn't run", bg: '#f3f4f6', fg: '#4b5563' },
  pending:      { label: 'Within 7 days',      bg: '#eff6ff', fg: '#1d4ed8' },
  paid:         { label: 'Paid',               bg: '#ecfdf5', fg: '#047857' },
  upcoming:     { label: 'Upcoming',           bg: '#f9fafb', fg: '#6b7280' },
  cancelled:    { label: 'Cancelled',          bg: '#f9fafb', fg: '#9ca3af' },
  duplicate:    { label: 'Duplicate',          bg: '#f5f3ff', fg: '#6d28d9' },
  history:      { label: 'Before Apr 2026',    bg: '#f9fafb', fg: '#9ca3af' },
};
const PAYDAY_STATUS = {
  complete:  { label: 'Complete',          fg: '#047857', bg: '#ecfdf5' },
  mismatch:  { label: 'Mismatch',          fg: '#b91c1c', bg: '#fef2f2' },
  stub_only: { label: 'Waiting for list',  fg: '#b45309', bg: '#fffbeb' },
  list_only: { label: 'Waiting for stub',  fg: '#b45309', bg: '#fffbeb' },
};

function Pill({ s, map = STATUS }) {
  const m = map[s] || { label: s, bg: '#f3f4f6', fg: '#374151' };
  return <span style={{ background: m.bg, color: m.fg, fontSize: '0.7rem', fontWeight: 700, padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap' }}>{m.label}</span>;
}

const th = { padding: '9px 12px', textAlign: 'left', fontSize: '0.68rem', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap', borderBottom: '1px solid var(--gray-200)' };
const td = { padding: '9px 12px', fontSize: '0.83rem', color: 'var(--gray-700)', borderBottom: '1px solid var(--gray-100)', verticalAlign: 'top' };
const card = { background: 'var(--white)', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', overflow: 'hidden' };
const sectionTitle = { fontSize: '0.95rem', fontWeight: 700, color: 'var(--navy)', margin: '0 0 10px' };

// ── page ───────────────────────────────────────────────────────────────────
export default function Payments2Page() {
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [paydayId, setPaydayId] = useState(null);
  const [ledgerFilter, setLedgerFilter] = useState('all');

  const load = useCallback(async () => {
    try { setData(await api.get('/payments2/summary')); setError(''); }
    catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openLedger = f => { setLedgerFilter(f); setTab('ledger'); };

  return (
    <div>
      <div className="page-header" style={{ alignItems: 'center' }}>
        <div>
          <h2>Payments 2.0</h2>
          <p>What you're owed, payday by payday.</p>
        </div>
        <button className="btn btn-gold" onClick={() => setShowAdd(true)}>+ Add stubs or lists</button>
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--gray-200)', marginBottom: 20 }}>
        {[['overview', 'Overview'], ['ledger', 'Ledger'], ['settings', 'Settings']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '8px 14px', fontSize: '0.86rem', fontWeight: 700,
            color: tab === k ? 'var(--navy)' : 'var(--gray-400)', marginBottom: -1,
            borderBottom: tab === k ? '2px solid var(--gold)' : '2px solid transparent',
          }}>{l}</button>
        ))}
      </div>

      {error && <div className="alert alert-error">{error}{/relation|does not exist|schema cache/i.test(error) && ' — the Payments 2.0 migration hasn’t been run yet.'}</div>}

      {tab === 'overview' && (data ? <Overview data={data} openPayday={setPaydayId} openLedger={openLedger} /> : !error && <Spinner />)}
      {tab === 'ledger' && <Ledger filter={ledgerFilter} setFilter={setLedgerFilter} onChanged={load} />}
      {tab === 'settings' && <Settings paydays={data?.paydays || []} onChanged={load} openPayday={setPaydayId} />}

      {showAdd && <AddModal onClose={() => { setShowAdd(false); load(); }} />}
      {paydayId && <PaydayModal id={paydayId} onClose={() => { setPaydayId(null); load(); }} />}
    </div>
  );
}

function Spinner() { return <div style={{ padding: 40, textAlign: 'center' }}><div className="spinner" style={{ margin: '0 auto' }} /></div>; }

// ── overview ───────────────────────────────────────────────────────────────
function Overview({ data, openPayday, openLedger }) {
  const { cards: c, attention: a, owed, paydays } = data;
  const [exporting, setExporting] = useState('');
  async function exp(kind) {
    setExporting(kind);
    try { await api.download(`/payments2/export/owed.${kind}`, `owed-sessions.${kind}`); }
    catch (e) { alert(e.message); } finally { setExporting(''); }
  }

  const attention = [
    ...a.mismatches.map(p => ({ tone: 'red', text: `${fmtDate(p.pay_date)}: stub says ${money(p.gross_cents)}, list adds up to ${money(p.list_cents)}`, action: () => openPayday(p.id), cta: 'Open' })),
    ...a.unmatched_lines.map(p => ({ tone: 'amber', text: `${fmtDate(p.pay_date)}: ${p.unmatched} line${p.unmatched !== 1 ? 's' : ''} need you to pick the session`, action: () => openPayday(p.id), cta: 'Review' })),
    ...a.waiting_for_list.map(p => ({ tone: 'gray', text: `${fmtDate(p.pay_date)}: stub in (${money(p.gross_cents)}), waiting for the session list`, action: () => openPayday(p.id), cta: 'Open' })),
    ...a.waiting_for_stub.map(p => ({ tone: 'gray', text: `${fmtDate(p.pay_date)}: session list in (${money(p.list_cents)}), waiting for the stub`, action: () => openPayday(p.id), cta: 'Open' })),
    a.needs_action && { tone: 'amber', text: `${a.needs_action} session${a.needs_action !== 1 ? 's are' : ' is'} posted to Zoho but not locked — they won't be paid until locked`, action: () => openLedger('needs_action'), cta: 'See them' },
    a.not_run && { tone: 'gray', text: `${a.not_run} session${a.not_run !== 1 ? 's look' : ' looks'} like ${a.not_run !== 1 ? 'they' : 'it'} didn't run (no note, not locked)`, action: () => openLedger('not_run'), cta: 'Review' },
    a.duplicates && { tone: 'gray', text: `${a.duplicates} session${a.duplicates !== 1 ? 's are' : ' is'} entered twice under different groups — not counted twice`, action: () => openLedger('duplicate'), cta: 'See them' },
  ].filter(Boolean);
  const toneColor = { red: '#b91c1c', amber: '#b45309', gray: 'var(--gray-400)' };

  return (
    <div style={{ display: 'grid', gap: 26 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
        <Stat label="Owed to you" value={money(c.owed_cents)} sub={c.owed_count ? `${c.owed_count} session${c.owed_count !== 1 ? 's' : ''} · oldest ${fmtDate(c.owed_oldest)}` : 'Nothing overdue'} accent={c.owed_count ? '#b91c1c' : '#047857'} />
        <Stat label={`Paid in ${c.year}`} value={money(c.paid_this_year_cents)} sub="From paydays on file" />
        <Stat label="Next payday" value={c.next_payday ? fmtDate(c.next_payday) : '—'}
          sub={c.next_payday ? `Expect ~${money(c.next_expected_cents)} (${c.next_expected_count} locked by ${shortDate(c.next_cutoff)})` : 'Add a stub to start the calendar'} />
        <Stat label="Current rate" value={money(c.current_rate_cents)} sub="per session" />
      </div>

      <section>
        <h3 style={sectionTitle}>Needs attention</h3>
        <div style={card}>
          {attention.length === 0
            ? <div style={{ padding: 16, fontSize: '0.85rem', color: 'var(--gray-400)' }}>All clear.</div>
            : attention.map((x, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderTop: i ? '1px solid var(--gray-100)' : 'none' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: toneColor[x.tone], flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: '0.86rem', color: 'var(--gray-700)' }}>{x.text}</span>
                <button className="btn btn-outline btn-sm" onClick={x.action}>{x.cta}</button>
              </div>
            ))}
        </div>
      </section>

      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <h3 style={{ ...sectionTitle, margin: 0 }}>Owed ({owed.length})</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-outline btn-sm" disabled={!owed.length || !!exporting} onClick={() => exp('pdf')}>{exporting === 'pdf' ? 'Preparing…' : 'Claim report (PDF)'}</button>
            <button className="btn btn-outline btn-sm" disabled={!owed.length || !!exporting} onClick={() => exp('xlsx')}>{exporting === 'xlsx' ? 'Preparing…' : 'Excel'}</button>
          </div>
        </div>
        <div style={{ ...card, overflowX: 'auto' }}>
          {owed.length === 0 ? <div style={{ padding: 16, fontSize: '0.85rem', color: 'var(--gray-400)' }}>Every locked session from April 2026 on has been paid.</div> : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>Date</th><th style={th}>Group</th><th style={th}>Billing name</th><th style={th}>Locked</th>
                <th style={th}>Zoho note</th><th style={{ ...th, textAlign: 'right' }}>Waiting</th><th style={{ ...th, textAlign: 'right' }}>Amount</th>
              </tr></thead>
              <tbody>{owed.map(r => (
                <tr key={r.id}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(r.date)}{r.time && <div style={{ fontSize: '0.72rem', color: 'var(--gray-400)' }}>{fmt12(r.time)}</div>}</td>
                  <td style={{ ...td, fontWeight: 600, color: 'var(--navy)' }}>{r.group}</td>
                  <td style={td}>{r.billing_name || <span style={{ color: 'var(--gray-400)' }}>—</span>}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.locked_at ? shortDate(r.locked_at) : '—'}</td>
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: '0.74rem' }}>{r.zoho_note_id || '—'}</td>
                  <td style={{ ...td, textAlign: 'right', color: r.days_waiting > 30 ? '#b91c1c' : 'var(--gray-700)', fontWeight: r.days_waiting > 30 ? 700 : 400 }}>{r.days_waiting}d</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{money(r.amount_cents)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </section>

      <section>
        <h3 style={sectionTitle}>Paydays</h3>
        {paydays.length === 0
          ? <div style={{ ...card, padding: 16, fontSize: '0.85rem', color: 'var(--gray-400)' }}>No paydays yet. Use <strong>+ Add stubs or lists</strong> to import your stubs and billing emails — you can drop a whole folder at once.</div>
          : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 12 }}>
              {paydays.map(p => <PaydayCard key={p.id} p={p} onOpen={() => openPayday(p.id)} />)}
            </div>}
      </section>
    </div>
  );
}

function Stat({ label, value, sub, accent }) {
  return (
    <div style={{ ...card, padding: '14px 16px', borderTop: `3px solid ${accent || 'var(--gold)'}` }}>
      <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: '1.45rem', fontWeight: 800, color: accent || 'var(--navy)', margin: '4px 0 2px' }}>{value}</div>
      <div style={{ fontSize: '0.76rem', color: 'var(--gray-500)' }}>{sub}</div>
    </div>
  );
}

function PaydayCard({ p, onOpen }) {
  const diff = p.has_stub && p.has_list ? (p.list_cents || 0) - (p.gross_cents || 0) : null;
  return (
    <button onClick={onOpen} style={{ ...card, textAlign: 'left', cursor: 'pointer', padding: '12px 14px', display: 'grid', gap: 6, font: 'inherit' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <strong style={{ color: 'var(--navy)', fontSize: '0.92rem' }}>{fmtDate(p.pay_date)}</strong>
        <Pill s={p.status} map={PAYDAY_STATUS} />
      </div>
      <div style={{ fontSize: '0.78rem', color: 'var(--gray-500)' }}>
        {p.has_stub ? `Stub ${money(p.gross_cents)}` : 'No stub yet'} · {p.has_list ? `List ${money(p.list_cents)} (${p.sessions})` : 'No list yet'}
      </div>
      {diff != null && diff !== 0 && <div style={{ fontSize: '0.76rem', color: '#b91c1c', fontWeight: 600 }}>Off by {money(Math.abs(diff))}</div>}
      {p.unmatched > 0 && <div style={{ fontSize: '0.76rem', color: '#b45309', fontWeight: 600 }}>{p.unmatched} line{p.unmatched !== 1 ? 's' : ''} to review</div>}
    </button>
  );
}

// ── payday detail + review ─────────────────────────────────────────────────
function PaydayModal({ id, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [picking, setPicking] = useState(null);   // item id
  const load = useCallback(async () => { try { setD(await api.get(`/payments2/paydays/${id}`)); } catch (e) { setErr(e.message); } }, [id]);
  useEffect(() => { load(); }, [load]);

  async function openFile(which) {
    try { const { url } = await api.get(`/payments2/paydays/${id}/file/${which}`); window.open(url, '_blank', 'noopener'); }
    catch (e) { alert(e.message); }
  }
  async function rematch() { try { const r = await api.post(`/payments2/paydays/${id}/rematch`); alert(`${r.linked} more matched.`); load(); } catch (e) { alert(e.message); } }

  const p = d?.payday;
  const items = d?.items || [];
  const listCents = items.reduce((t, i) => t + (i.amount_cents || 0), 0);
  const unmatched = items.filter(i => !i.session_id);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 820, width: '96vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ margin: 0, color: 'var(--navy)' }}>Payday {p ? fmtDate(p.pay_date) : ''}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ maxHeight: '72vh', overflowY: 'auto' }}>
          {err && <div className="alert alert-error">{err}</div>}
          {!d ? <Spinner /> : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
                <MiniStat label="Status" value={<Pill s={p.status} map={PAYDAY_STATUS} />} />
                <MiniStat label="Stub gross" value={money(p.gross_cents)} sub={p.period_start ? `Printed period ${shortDate(p.period_start)} – ${shortDate(p.period_end)}` : null} />
                <MiniStat label="List total" value={items.length ? money(listCents) : '—'} sub={items.length ? `${items.length} sessions` : null} />
                <MiniStat label="Files" value={<span style={{ display: 'flex', gap: 6 }}>
                  {p.stub_file && <button className="btn btn-outline btn-xs" onClick={() => openFile('stub')}>Stub</button>}
                  {p.list_file && <button className="btn btn-outline btn-xs" onClick={() => openFile('list')}>List</button>}
                  {!p.stub_file && !p.list_file && '—'}
                </span>} />
              </div>
              {p.status === 'mismatch' && (
                <div className="alert alert-error" style={{ marginBottom: 14 }}>
                  The list adds up to {money(listCents)} but the stub paid {money(p.gross_cents)} — a difference of {money(Math.abs(listCents - p.gross_cents))}.
                </div>
              )}
              {unmatched.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10, padding: '10px 12px', background: '#fffbeb', borderRadius: 8, fontSize: '0.84rem', color: '#92400e' }}>
                  <span><strong>{unmatched.length}</strong> line{unmatched.length !== 1 ? 's' : ''} couldn't be matched with confidence. Pick the session for each — your pick is remembered for next time.</span>
                  <button className="btn btn-outline btn-sm" onClick={rematch}>Try again</button>
                </div>
              )}
              {items.length === 0 ? <div style={{ fontSize: '0.85rem', color: 'var(--gray-400)' }}>No session list for this payday yet.</div> : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={th}>Line on the list</th><th style={th}>Session in Ritzoini</th><th style={{ ...th, textAlign: 'right' }}>Amount</th></tr></thead>
                  <tbody>{items.map(i => (
                    <tr key={i.id} style={{ background: i.session_id ? 'transparent' : '#fffdf5' }}>
                      <td style={td}><div style={{ color: 'var(--navy)', fontWeight: 500 }}>{i.billing_name_raw}</div><div style={{ fontSize: '0.74rem', color: 'var(--gray-400)' }}>{fmtDate(i.session_date)}</div></td>
                      <td style={td}>
                        {i.session ? (
                          <span>{i.session.group} <span style={{ color: 'var(--gray-400)' }}>{fmt12(i.session.time)}</span>
                            <span style={{ marginLeft: 6, fontSize: '0.68rem', color: i.match_status === 'confirmed' ? '#047857' : 'var(--gray-400)' }}>{i.match_status === 'confirmed' ? '✓ you picked' : 'auto'}</span></span>
                        ) : picking === i.id ? (
                          <PickSession item={i} onDone={() => { setPicking(null); load(); }} onCancel={() => setPicking(null)} />
                        ) : (
                          <button className="btn btn-gold btn-xs" onClick={() => setPicking(i.id)}>Pick session</button>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>{money(i.amount_cents)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              <PaydayNotes p={p} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, sub }) {
  return (
    <div style={{ background: 'var(--gray-50)', borderRadius: 8, padding: '9px 11px' }}>
      <div style={{ fontSize: '0.66rem', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--navy)' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.7rem', color: 'var(--gray-400)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function PaydayNotes({ p }) {
  const [notes, setNotes] = useState(p.notes || '');
  const [saved, setSaved] = useState(true);
  async function save() { try { await api.patch(`/payments2/paydays/${p.id}`, { notes }); setSaved(true); } catch (e) { alert(e.message); } }
  return (
    <div style={{ marginTop: 16 }}>
      <label className="form-label">Notes</label>
      <textarea className="form-textarea" value={notes} onChange={e => { setNotes(e.target.value); setSaved(false); }} style={{ minHeight: 50 }} />
      {!saved && <button className="btn btn-outline btn-sm" style={{ marginTop: 6 }} onClick={save}>Save notes</button>}
    </div>
  );
}

function PickSession({ item, onDone, onCancel }) {
  const [c, setC] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/payments2/items/${item.id}/candidates`).then(r => setC(r.candidates)).catch(e => { alert(e.message); onCancel(); }); }, [item.id, onCancel]);
  async function pick(sessionId) {
    setBusy(true);
    try { await api.post(`/payments2/items/${item.id}/link`, { session_id: sessionId }); onDone(); }
    catch (e) { alert(e.message); setBusy(false); }
  }
  if (!c) return <span style={{ fontSize: '0.78rem', color: 'var(--gray-400)' }}>Loading sessions…</span>;
  const free = c.filter(x => !x.taken);
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {free.length === 0 && <span style={{ fontSize: '0.78rem', color: 'var(--gray-400)' }}>No unpaid Ritzoini session on {fmtDate(item.session_date)}.</span>}
      {free.slice(0, 8).map((x, n) => (
        <button key={x.session_id} disabled={busy} onClick={() => pick(x.session_id)} className="btn btn-outline btn-xs"
          style={{ justifyContent: 'flex-start', textAlign: 'left', borderColor: n === 0 && x.score > 0.2 ? 'var(--gold)' : undefined }}>
          {x.group} · {fmt12(x.time)}{x.billing_name ? ` · ${x.billing_name}` : ''}{x.locked ? '' : ' · not locked'}{x.status === 'cancelled' ? ' · cancelled' : ''}
        </button>
      ))}
      <button className="btn btn-xs" onClick={onCancel} style={{ background: 'none', border: 'none', color: 'var(--gray-400)', justifyContent: 'flex-start' }}>Cancel</button>
    </div>
  );
}

// ── add / import ───────────────────────────────────────────────────────────
const CHUNK = 10;
const order = f => (/\.pdf$/i.test(f.name) ? 0 : /\.eml$/i.test(f.name) ? 1 : 2);   // stubs first

function AddModal({ onClose }) {
  const [files, setFiles] = useState([]);
  const [text, setText] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [out, setOut] = useState(null);   // { results, skipped }
  const input = useRef(null);

  const addFiles = list => setFiles(prev => {
    const seen = new Set(prev.map(f => `${f.name}|${f.size}`));
    return [...prev, ...[...list].filter(f => !seen.has(`${f.name}|${f.size}`))];
  });

  async function run() {
    setBusy(true);
    const results = [], skipped = [];
    const sorted = [...files].sort((a, b) => order(a) - order(b));
    const batches = [];
    for (let i = 0; i < sorted.length; i += CHUNK) batches.push(sorted.slice(i, i + CHUNK));
    if (text.trim() && !batches.length) batches.push([]);
    try {
      for (let b = 0; b < batches.length; b++) {
        setProgress(`Importing ${Math.min((b + 1) * CHUNK, sorted.length) || 1} of ${sorted.length || 1}…`);
        const fd = new FormData();
        batches[b].forEach(f => fd.append('files', f));
        if (b === batches.length - 1 && text.trim()) fd.append('text', text);
        const r = await api.postForm('/payments2/import', fd);
        results.push(...r.results); skipped.push(...r.skipped);
      }
      // A list held in an early batch may be certain now that later stubs are in.
      const held = results.filter(r => r.outcome === 'needs_date');
      if (held.length) {
        setProgress('Re-checking held lists…');
        for (const h of held) {
          const r = await api.post('/payments2/import/recheck', { text: h.text, stored: h.stored, dates: h.dates, prose: h.prose });
          if (!r.held) Object.assign(h, { outcome: r.skipped ? 'skipped_dup' : r.ok ? 'list' : 'error', pay_date: r.pay_date, how: r.how,
            auto_matched: r.auto_matched, needs_review: r.needs_review, list_cents: r.list_cents, gross_cents: r.gross_cents, message: r.reason });
          else Object.assign(h, { suggested: r.suggested || h.suggested, how: r.how || h.how });
        }
      }
      setOut({ results: results.filter(r => r.outcome !== 'skipped_dup'), skipped: [...skipped, ...results.filter(r => r.outcome === 'skipped_dup').map(r => ({ file: r.file, reason: r.message }))] });
    } catch (e) { alert(e.message); }
    finally { setBusy(false); setProgress(null); }
  }

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" style={{ maxWidth: 760, width: '96vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ margin: 0, color: 'var(--navy)' }}>Add stubs or session lists</h3>
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
                style={{ border: `2px dashed ${over ? 'var(--gold)' : 'var(--gray-300)'}`, background: over ? '#fffbeb' : 'var(--gray-50)', borderRadius: 12, padding: '28px 16px', textAlign: 'center', cursor: 'pointer', transition: 'all 0.15s' }}>
                <div style={{ fontSize: '1.6rem' }}>📥</div>
                <div style={{ fontWeight: 700, color: 'var(--navy)', marginTop: 4 }}>Drop files here, or click to choose</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--gray-500)', marginTop: 4 }}>Pay stub PDFs · billing emails (.eml) · .xlsx or .pdf session lists. A whole folder at once is fine.</div>
                <input ref={input} type="file" multiple accept=".pdf,.eml,.xlsx,.xls,.txt" style={{ display: 'none' }} onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
              </div>
              {files.length > 0 && (
                <div style={{ marginTop: 10, fontSize: '0.8rem', color: 'var(--gray-600)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span><strong>{files.length}</strong> file{files.length !== 1 ? 's' : ''} ready{files.length <= 6 ? `: ${files.map(f => f.name).join(', ')}` : ''}</span>
                  <button className="btn btn-xs" style={{ background: 'none', border: 'none', color: 'var(--gray-400)' }} onClick={() => setFiles([])}>Clear</button>
                </div>
              )}
              <div style={{ marginTop: 16 }}>
                <label className="form-label">…or paste a session list</label>
                <textarea className="form-textarea" value={text} onChange={e => setText(e.target.value)} placeholder={'Sensory Gym 5:45 PM 4/16/2026\nProblem-Solving Skills Group 4/19/2026'} style={{ minHeight: 90, fontFamily: 'monospace', fontSize: '0.8rem' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginTop: 14 }}>
                {progress && <span style={{ fontSize: '0.8rem', color: 'var(--gray-500)' }}>{progress}</span>}
                <button className="btn btn-gold" disabled={busy || (!files.length && !text.trim())} onClick={run}>{busy ? 'Working…' : 'Import'}</button>
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
      setOut(o => ({ ...o, results: o.results.map(x => x === h ? { ...x, outcome: r.skipped ? 'error' : 'list', pay_date: date, how: 'date you picked',
        auto_matched: r.auto_matched, needs_review: r.needs_review, list_cents: r.list_cents, message: r.reason } : x) }));
    } catch (e) { alert(e.message); }
  }
  async function confirmAll() { for (const h of held.filter(x => x.suggested)) await confirm(h, h.suggested); }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <MiniStat label="Stubs filed" value={filed.filter(r => r.kind === 'stub').length} />
        <MiniStat label="Lists filed" value={filed.filter(r => r.kind === 'list').length} />
        <MiniStat label="Lines to review" value={review} />
        <MiniStat label="Need a payday" value={held.length} />
      </div>

      {held.length > 0 && (
        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h4 style={{ ...sectionTitle, margin: 0, fontSize: '0.88rem' }}>Which payday are these lists for?</h4>
            {held.some(h => h.suggested) && <button className="btn btn-outline btn-sm" onClick={confirmAll}>Use all suggestions</button>}
          </div>
          <div style={card}>
            {held.map((h, i) => <HeldRow key={i} h={h} first={i === 0} onConfirm={d => confirm(h, d)} />)}
          </div>
        </section>
      )}

      {filed.length > 0 && (
        <section>
          <h4 style={{ ...sectionTitle, fontSize: '0.88rem' }}>Filed</h4>
          <div style={card}>
            {filed.map((r, i) => (
              <div key={i} style={{ padding: '9px 14px', borderTop: i ? '1px solid var(--gray-100)' : 'none', fontSize: '0.82rem', display: 'flex', gap: 10, justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--gray-700)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.file}</span>
                <span style={{ color: 'var(--gray-500)', whiteSpace: 'nowrap' }}>
                  {r.kind === 'stub' ? `Stub · ${fmtDate(r.pay_date)} · ${money(r.gross_cents)}`
                    : `List · ${fmtDate(r.pay_date)} · ${r.lines} lines${r.already_imported ? ` (+${r.already_imported} already in)` : ''}${r.needs_review ? ` · ${r.needs_review} to review` : ''}`}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {errors.length > 0 && (
        <section>
          <h4 style={{ ...sectionTitle, fontSize: '0.88rem', color: '#b91c1c' }}>Couldn't import</h4>
          <div style={card}>{errors.map((r, i) => (
            <div key={i} style={{ padding: '9px 14px', borderTop: i ? '1px solid var(--gray-100)' : 'none', fontSize: '0.82rem' }}>
              <strong>{r.file || 'Upload'}</strong> — {r.message}
            </div>
          ))}</div>
        </section>
      )}

      {out.skipped.length > 0 && (
        <div style={{ fontSize: '0.8rem', color: 'var(--gray-500)' }}>
          Skipped {out.skipped.length} file{out.skipped.length !== 1 ? 's' : ''} with no new stub or list.{' '}
          <button onClick={() => setShowSkipped(s => !s)} style={{ background: 'none', border: 'none', color: 'var(--navy)', cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 'inherit' }}>{showSkipped ? 'Hide' : 'Show'}</button>
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
    <div style={{ padding: '11px 14px', borderTop: first ? 'none' : '1px solid var(--gray-100)', display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '0.84rem', color: 'var(--navy)' }}>{h.file}</strong>
        <span style={{ fontSize: '0.78rem', color: 'var(--gray-500)' }}>{h.lines} sessions · {money(h.list_cents)} · {shortDate(h.first_date)} – {shortDate(h.last_date)}</span>
      </div>
      <div style={{ fontSize: '0.74rem', color: 'var(--gray-400)', fontFamily: 'monospace' }}>{(h.preview || []).join(' · ')}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.78rem', color: 'var(--gray-500)' }}>Payday</span>
        <input type="date" className="form-input" value={date} onChange={e => setDate(e.target.value)} style={{ width: 170, padding: '5px 8px' }} />
        <button className="btn btn-gold btn-sm" disabled={!date || busy} onClick={async () => { setBusy(true); await onConfirm(date); setBusy(false); }}>File it</button>
        {h.how && <span style={{ fontSize: '0.72rem', color: 'var(--gray-400)' }}>{h.suggested ? `Suggested from ${h.how}` : h.how}</span>}
      </div>
    </div>
  );
}

// ── ledger ─────────────────────────────────────────────────────────────────
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
      && (!needle || [r.group, r.group_name, r.billing_name, r.date, r.payday, r.zoho_note_id].some(v => String(v || '').toLowerCase().includes(needle))));
  }, [rows, filter, q]);

  async function cancel(r) {
    if (!window.confirm(`Mark ${r.group} on ${fmtDate(r.date)} as cancelled? It will stop counting as a session.`)) return;
    try { await api.post(`/payments2/sessions/${r.id}/cancel`); await load(); onChanged(); } catch (e) { alert(e.message); }
  }

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
      <input className="form-input" placeholder="Search group, billing name, date, payday…" value={q} onChange={e => setQ(e.target.value)} style={{ maxWidth: 380, marginBottom: 12 }} />
      {filter === 'not_run' && <div className="alert alert-info" style={{ marginBottom: 12 }}>No Zoho note and never locked, more than 7 days ago. If a session really didn't happen, mark it cancelled so it stops counting.</div>}
      <div style={{ ...card, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={th}>Date</th><th style={th}>Group</th><th style={th}>Billing name</th><th style={th}>Status</th>
            <th style={th}>Paid on</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}></th>
          </tr></thead>
          <tbody>
            {shown.slice(0, 600).map(r => (
              <tr key={r.id}>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(r.date)}{r.time && <span style={{ color: 'var(--gray-400)', marginLeft: 6 }}>{fmt12(r.time)}</span>}</td>
                <td style={{ ...td, fontWeight: 600, color: 'var(--navy)' }}>{r.group}</td>
                <td style={td}>{r.billing_name || '—'}</td>
                <td style={td}><Pill s={r.status} />{r.status === 'paid' && r.paid_legacy_only && <span style={{ fontSize: '0.68rem', color: 'var(--gray-400)', marginLeft: 6 }}>(old Payments page)</span>}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.payday ? fmtDate(r.payday) : '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{money(r.amount_cents)}</td>
                <td style={td}>{r.status === 'not_run' && <button className="btn btn-outline btn-xs" onClick={() => cancel(r)}>Mark cancelled</button>}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: 'var(--gray-400)', padding: 30 }}>Nothing here.</td></tr>}
          </tbody>
        </table>
        {shown.length > 600 && <div style={{ padding: 10, fontSize: '0.78rem', color: 'var(--gray-400)' }}>Showing the newest 600 of {shown.length}. Search or filter to narrow it down.</div>}
      </div>
    </div>
  );
}

// ── settings ───────────────────────────────────────────────────────────────
function Settings({ paydays, onChanged, openPayday }) {
  const [rates, setRates] = useState(null);
  const [form, setForm] = useState({ effective_date: '', amount: '' });
  const load = useCallback(async () => { try { setRates(await api.get('/payments2/rates')); } catch (e) { alert(e.message); } }, []);
  useEffect(() => { load(); }, [load]);

  async function addRate(e) {
    e.preventDefault();
    try { await api.post('/payments2/rates', form); setForm({ effective_date: '', amount: '' }); load(); onChanged(); } catch (ex) { alert(ex.message); }
  }
  async function delRate(r) {
    if (!window.confirm(`Remove the ${money(r.amount_cents)} rate from ${fmtDate(r.effective_date)}?`)) return;
    try { await api.delete(`/payments2/rates/${r.id}`); load(); onChanged(); } catch (ex) { alert(ex.message); }
  }
  async function delPayday(p) {
    if (!window.confirm(`Delete payday ${fmtDate(p.pay_date)} and its ${p.sessions} lines? Sessions already marked paid stay marked paid.`)) return;
    try { await api.delete(`/payments2/paydays/${p.id}`); onChanged(); } catch (ex) { alert(ex.message); }
  }

  return (
    <div style={{ display: 'grid', gap: 26, maxWidth: 760 }}>
      <section>
        <h3 style={sectionTitle}>Pay rates</h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--gray-500)', margin: '-4px 0 10px' }}>A session is paid at the rate in effect on its session date.</p>
        <div style={card}>
          {(rates || []).map((r, i) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderTop: i ? '1px solid var(--gray-100)' : 'none', fontSize: '0.86rem' }}>
              <span style={{ flex: 1 }}>From <strong>{fmtDate(r.effective_date)}</strong></span>
              <strong style={{ color: 'var(--navy)' }}>{money(r.amount_cents)}</strong>
              <button className="btn btn-outline btn-xs" onClick={() => delRate(r)}>Remove</button>
            </div>
          ))}
          <form onSubmit={addRate} style={{ display: 'flex', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--gray-100)', background: 'var(--gray-50)', flexWrap: 'wrap' }}>
            <input type="date" className="form-input" required value={form.effective_date} onChange={e => setForm(f => ({ ...f, effective_date: e.target.value }))} style={{ width: 170 }} />
            <input type="number" step="0.01" min="0" className="form-input" required placeholder="Amount ($)" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} style={{ width: 130 }} />
            <button className="btn btn-gold btn-sm">Add rate</button>
          </form>
        </div>
      </section>

      <section>
        <h3 style={sectionTitle}>Paydays ({paydays.length})</h3>
        <div style={card}>
          {paydays.length === 0 && <div style={{ padding: 14, fontSize: '0.85rem', color: 'var(--gray-400)' }}>None yet.</div>}
          {paydays.map((p, i) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px', borderTop: i ? '1px solid var(--gray-100)' : 'none', fontSize: '0.84rem' }}>
              <button onClick={() => openPayday(p.id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--navy)', fontWeight: 700, font: 'inherit' }}>{fmtDate(p.pay_date)}</button>
              <Pill s={p.status} map={PAYDAY_STATUS} />
              <span style={{ flex: 1, color: 'var(--gray-500)' }}>{money(p.gross_cents)} · {p.sessions} lines</span>
              <button className="btn btn-outline btn-xs" onClick={() => delPayday(p)}>Delete</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

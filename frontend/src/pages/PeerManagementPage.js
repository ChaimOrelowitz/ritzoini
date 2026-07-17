import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';

const fmt = iso => {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
};

const fmtLong = iso => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
};

const daysSince = from => {
  const a = new Date(from + 'T12:00:00Z');
  return Math.max(0, Math.round((Date.now() - a) / 86400000));
};

const STATUS_COLORS = {
  'Active':            { bg: '#dcfce7', fg: '#166534' },
  'At-Risk':           { bg: '#fef9c3', fg: '#854d0e' },
  'Inactive':          { bg: '#fee2e2', fg: '#991b1b' },
  'No Longer Working': { bg: '#e5e7eb', fg: '#374151' },
};

function StatusPill({ status }) {
  const c = STATUS_COLORS[status] || { bg: '#e5e7eb', fg: '#374151' };
  return (
    <span style={{
      background: c.bg, color: c.fg, fontSize: '0.72rem', fontWeight: 700,
      padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
    }}>{status || '—'}</span>
  );
}

function Tag({ children, bg, fg }) {
  return (
    <span style={{
      background: bg, color: fg, fontSize: '0.68rem', fontWeight: 700,
      padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

export default function PeerManagementPage() {
  const [tab,        setTab]        = useState('peers');
  const [caseload,   setCaseload]   = useState([]);
  const [history,    setHistory]    = useState([]);
  const [knownPeers, setKnownPeers] = useState([]);
  const [periods,    setPeriods]    = useState([]);
  const [runs,       setRuns]       = useState([]);
  const [supervision,setSupervision]= useState({ schedule: [], sessions: [] });
  const [loading,    setLoading]    = useState(true);
  const [syncing,    setSyncing]    = useState(false);

  const load = useCallback(async () => {
    const [c, h, k, p, r, s] = await Promise.all([
      api.get('/ps/caseload').catch(() => []),
      api.get('/ps/caseload/history').catch(() => []),
      api.get('/ps/caseload/known-peers').catch(() => []),
      api.get('/ps/payroll/periods').catch(() => []),
      api.get('/ps/caseload/runs').catch(() => []),
      api.get('/ps/supervision').catch(() => ({ schedule: [], sessions: [] })),
    ]);
    setCaseload(Array.isArray(c) ? c : []);
    setHistory(Array.isArray(h) ? h : []);
    setKnownPeers(Array.isArray(k) ? k : []);
    setPeriods(Array.isArray(p) ? p : []);
    setRuns(Array.isArray(r) ? r : []);
    setSupervision(s && s.schedule ? s : { schedule: [], sessions: [] });
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function syncNow() {
    setSyncing(true);
    try {
      const r = await api.post('/ps/caseload/sync');
      const bits = [];
      if (r.entered?.length)  bits.push(`${r.entered.length} joined: ${r.entered.map(p => p.name).join(', ')}`);
      if (r.departed?.length) bits.push(`${r.departed.length} left: ${r.departed.map(p => p.name).join(', ')}`);
      alert(bits.length ? bits.join('\n') : `No changes. ${r.peers_seen} peers on caseload.`);
      await load();
    } catch (ex) { alert(ex.message); }
    finally { setSyncing(false); }
  }

  const lastRun = runs[0];

  if (loading) return <div style={{ padding: 32, color: 'var(--gray-400)' }}>Loading…</div>;

  const TABS = [
    ['peers',    `Peers (${caseload.length})`],
    ['dates',    `Start / End Dates (${history.length})`],
    ['payroll',  `Payroll Report (${periods.length})`],
    ['sessions', `Supervision Sessions`],
  ];

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: 'var(--navy)' }}>Peer Management</h2>
        <button className="btn btn-gold btn-sm" onClick={syncNow} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync from Airtable'}
        </button>
      </div>

      <p style={{ margin: '0 0 16px', fontSize: '0.76rem', color: 'var(--gray-400)' }}>
        {caseload.length} peers on caseload
        {lastRun && ` · last checked ${new Date(lastRun.ran_at).toLocaleString()}`}
        {lastRun && !lastRun.ok && (
          <span style={{ color: '#991b1b', fontWeight: 700 }}> · last sync failed: {lastRun.error}</span>
        )}
      </p>

      <div style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: '1px solid var(--gray-200)' }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '8px 14px', fontSize: '0.85rem', fontWeight: 700,
            color: tab === k ? 'var(--navy)' : 'var(--gray-400)',
            borderBottom: tab === k ? '2px solid var(--gold, #c9a227)' : '2px solid transparent',
            marginBottom: -1,
          }}>{label}</button>
        ))}
      </div>

      {tab === 'peers'    && <PeersTab rows={caseload} />}
      {tab === 'dates'    && <DatesTab history={history} knownPeers={knownPeers} reload={load} />}
      {tab === 'payroll'  && <PayrollTab periods={periods} reload={load} />}
      {tab === 'sessions' && <SessionsTab schedule={supervision.schedule} sessions={supervision.sessions} />}
    </div>
  );
}

// ── Supervision Sessions ──────────────────────────────────────────

function SessionsTab({ schedule, sessions }) {
  const slotLabel = s => {
    if (s.manual || !s.day) return 'Manual session';
    const freq = s.frequency ? ` · ${s.frequency}` : '';
    return `${s.day}s · ${s.start}–${s.end}${freq}`;
  };

  return (
    <>
      <h3 style={{ margin: '0 0 10px', fontSize: '0.95rem', fontWeight: 700, color: 'var(--navy)' }}>
        Recurring schedule
      </h3>
      {!schedule.length ? <Empty>No supervision schedule in Airtable yet.</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 28 }}>
          {schedule.map(s => (
            <div key={s.airtable_id} style={{
              background: 'white', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
              padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
              opacity: s.active ? 1 : 0.55,
            }}>
              <span style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '0.9rem' }}>{slotLabel(s)}</span>
              {s.cohort && <Tag bg="#eef2ff" fg="#3730a3">Cohort {s.cohort}</Tag>}
              {!s.active && <Tag bg="#f3f4f6" fg="#6b7280">inactive</Tag>}
              <div style={{ flex: 1 }} />
              {s.zoom  && <span style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>Zoom: {s.zoom}</span>}
              {s.phone && s.phone !== 'unknown' && <span style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>☎ {s.phone}</span>}
            </div>
          ))}
        </div>
      )}

      <h3 style={{ margin: '0 0 10px', fontSize: '0.95rem', fontWeight: 700, color: 'var(--navy)' }}>
        Sessions {sessions.length ? `(${sessions.length})` : ''}
      </h3>
      {!sessions.length ? (
        <Empty>
          No individual supervision sessions recorded in Airtable yet. As sessions are held and
          logged there, they’ll appear here automatically.
        </Empty>
      ) : (
        <table style={tbl}>
          <thead><tr style={hrow}>
            <th style={th}>Date</th><th style={th}>Day</th><th style={th}>Time</th>
            <th style={th}>Cohort</th><th style={th}>Status</th>
            <th style={{ ...th, textAlign: 'right' }}>Attended</th>
          </tr></thead>
          <tbody>
            {sessions.map(s => (
              <tr key={s.airtable_id} style={trow}>
                <td style={{ ...td, fontWeight: 600, color: 'var(--navy)', whiteSpace: 'nowrap' }}>{fmt(s.date)}</td>
                <td style={td}>{s.day || '—'}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{s.start ? `${s.start}–${s.end}` : '—'}</td>
                <td style={td}>{s.cohort || '—'}</td>
                <td style={td}>{s.status || '—'}</td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--gray-500)' }}>{s.attended ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ── Peers ─────────────────────────────────────────────────────────

function PeersTab({ rows }) {
  if (!rows.length) return <Empty>No peers on your caseload yet. Try “Sync from Airtable”.</Empty>;
  return (
    <table style={tbl}>
      <thead><tr style={hrow}>
        <th style={th}>Peer</th><th style={th}>Status</th><th style={th}>Cohort</th>
        <th style={th}>Phone</th><th style={th}>Email</th>
        <th style={th}>Last Superv.</th><th style={th}>Joined</th><th style={th}>Days</th>
      </tr></thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.period_id} style={trow}>
            <td style={{ ...td, fontWeight: 600, color: 'var(--navy)' }}>{r.peer_name}</td>
            <td style={td}><StatusPill status={r.status} /></td>
            <td style={td}>{r.cohort || '—'}</td>
            <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.phone || '—'}</td>
            <td style={{ ...td, color: 'var(--gray-500)' }}>{r.email || '—'}</td>
            <td style={td}>{fmt(r.last_supervision)}</td>
            <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmt(r.entered_on)}</td>
            <td style={{ ...td, color: 'var(--gray-500)' }}>{daysSince(r.entered_on)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Start / End dates ─────────────────────────────────────────────

const blankAssign = { peer_airtable_id: '', entered_on: '', left_on: '', note: '' };

function DatesTab({ history, knownPeers, reload }) {
  const [adding, setAdding] = useState(false);
  const [form,   setForm]   = useState(blankAssign);
  const [edit,   setEdit]   = useState(null);
  const [busy,   setBusy]   = useState(false);

  async function add() {
    if (!form.peer_airtable_id || !form.entered_on) return alert('Pick a peer and an assignment date.');
    setBusy(true);
    try {
      const peer = knownPeers.find(p => p.airtable_id === form.peer_airtable_id);
      await api.post('/ps/caseload/periods', { ...form, peer_name: peer?.peer_name, left_on: form.left_on || null });
      setForm(blankAssign); setAdding(false); await reload();
    } catch (ex) { alert(ex.message); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/ps/caseload/periods/${edit.id}`, {
        entered_on: edit.entered_on, left_on: edit.left_on || null, note: edit.note || null,
      });
      setEdit(null); await reload();
    } catch (ex) { alert(ex.message); }
    finally { setBusy(false); }
  }

  async function remove(p) {
    if (!window.confirm(`Delete this assignment row for ${p.peer_name}? This changes payroll.`)) return;
    try { await api.delete(`/ps/caseload/periods/${p.id}`); await reload(); }
    catch (ex) { alert(ex.message); }
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--gray-400)', maxWidth: 620 }}>
          Every stint on your caseload. A peer who leaves and returns gets a separate row, so repeat
          spells stay distinct. Both the start and end date count as active days.
        </p>
        <button className="btn btn-gold btn-sm" onClick={() => setAdding(a => !a)}>
          {adding ? 'Cancel' : '+ Add assignment'}
        </button>
      </div>

      {adding && (
        <div style={panel}>
          <div>
            <label style={lbl}>Peer</label>
            <select className="form-input" style={{ width: 210 }} value={form.peer_airtable_id}
              onChange={e => setForm(f => ({ ...f, peer_airtable_id: e.target.value }))}>
              <option value="">Select…</option>
              {knownPeers.map(p => <option key={p.airtable_id} value={p.airtable_id}>{p.peer_name}</option>)}
            </select>
          </div>
          <div>
            <label style={lbl}>Start date</label>
            <input type="date" className="form-input" style={{ width: 150 }} value={form.entered_on}
              onChange={e => setForm(f => ({ ...f, entered_on: e.target.value }))} />
          </div>
          <div>
            <label style={lbl}>End date (optional)</label>
            <input type="date" className="form-input" style={{ width: 150 }} value={form.left_on}
              onChange={e => setForm(f => ({ ...f, left_on: e.target.value }))} />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={lbl}>Note</label>
            <input className="form-input" style={{ width: '100%' }} value={form.note}
              onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
          </div>
          <button className="btn btn-gold btn-sm" onClick={add} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {!history.length ? <Empty>No assignments recorded yet.</Empty> : (
        <table style={tbl}>
          <thead><tr style={hrow}>
            <th style={th}>Peer</th><th style={th}>Start</th><th style={th}>End</th>
            <th style={th}>Days</th><th style={th}>Source</th><th style={th}>Note</th><th style={th}></th>
          </tr></thead>
          <tbody>
            {history.map(p => (
              <tr key={p.id} style={trow}>
                <td style={{ ...td, fontWeight: 600, color: 'var(--navy)' }}>{p.peer_name}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmt(p.entered_on)}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  {p.left_on ? fmt(p.left_on) : <Tag bg="#dcfce7" fg="#166534">current</Tag>}
                </td>
                <td style={{ ...td, color: 'var(--gray-500)' }}>
                  {p.left_on
                    ? Math.round((new Date(p.left_on + 'T12:00:00Z') - new Date(p.entered_on + 'T12:00:00Z')) / 86400000) + 1
                    : daysSince(p.entered_on) + 1}
                </td>
                <td style={{ ...td, color: 'var(--gray-400)', fontSize: '0.74rem' }}>{p.source}</td>
                <td style={{ ...td, color: 'var(--gray-400)', fontSize: '0.74rem' }}>{p.note || ''}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  <button className="btn btn-outline btn-xs" onClick={() => setEdit({ ...p })}>Edit</button>{' '}
                  <button className="btn btn-danger btn-xs" onClick={() => remove(p)}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {edit && (
        <Modal onClose={() => setEdit(null)} title={edit.peer_name}
          subtitle="Editing these changes payroll. Leave the end date empty if the peer is still on your caseload.">
          <label style={lbl}>Start date</label>
          <input type="date" className="form-input" style={full} value={edit.entered_on || ''}
            onChange={e => setEdit(v => ({ ...v, entered_on: e.target.value }))} />
          <label style={lbl}>End date</label>
          <input type="date" className="form-input" style={full} value={edit.left_on || ''}
            onChange={e => setEdit(v => ({ ...v, left_on: e.target.value }))} />
          <label style={lbl}>Note</label>
          <input className="form-input" style={full} value={edit.note || ''}
            onChange={e => setEdit(v => ({ ...v, note: e.target.value }))} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-gold btn-sm" onClick={save} disabled={busy}>Save</button>
            <button className="btn btn-outline btn-sm" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ── Payroll ───────────────────────────────────────────────────────

function PayrollTab({ periods, reload }) {
  const [open, setOpen] = useState(periods.find(p => !p.open)?.start || periods[0]?.start || null);

  if (!periods.length) return <Empty>No pay periods yet — add an assignment first.</Empty>;

  return (
    <>
      <p style={{ margin: '0 0 12px', fontSize: '0.78rem', color: 'var(--gray-400)' }}>
        26 pay periods a year, 14 days each. Finalizing freezes the numbers so later date edits
        can’t change a report you already sent.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {periods.map(p => (
          <PeriodCard key={p.start} p={p} expanded={open === p.start}
            onToggle={() => setOpen(open === p.start ? null : p.start)} reload={reload} />
        ))}
      </div>
    </>
  );
}

function PeriodCard({ p, expanded, onToggle, reload }) {
  const [rep,  setRep]  = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    api.get(`/ps/payroll/report?start=${p.start}`).then(setRep).catch(ex => alert(ex.message));
  }, [expanded, p.start]);

  async function finalize(replace) {
    if (p.open && !window.confirm(
      `This pay period runs through ${fmtLong(p.end)} and hasn’t ended yet. ` +
      `Finalizing now freezes a partial count. Continue?`)) return;
    setBusy(true);
    try {
      await api.post('/ps/payroll/finalize', { start: p.start, replace, allow_incomplete: p.open });
      setRep(await api.get(`/ps/payroll/report?start=${p.start}`));
      await reload();
    } catch (ex) { alert(ex.message); }
    finally { setBusy(false); }
  }

  async function setFlag(patch) {
    if (!rep?.snapshot) return;
    setBusy(true);
    try {
      await api.patch(`/ps/payroll/snapshots/${rep.snapshot.id}`, patch);
      setRep(await api.get(`/ps/payroll/report?start=${p.start}`));
      await reload();
    } catch (ex) { alert(ex.message); }
    finally { setBusy(false); }
  }

  async function unfinalize() {
    if (!window.confirm('Un-finalize this period? The frozen snapshot sent to billing will be deleted.')) return;
    setBusy(true);
    try {
      await api.delete(`/ps/payroll/snapshots/${rep.snapshot.id}`);
      setRep(await api.get(`/ps/payroll/report?start=${p.start}`));
      await reload();
    } catch (ex) { alert(ex.message); }
    finally { setBusy(false); }
  }

  // A bare <a href> would 401 -- these routes need the JWT attached.
  async function download(kind) {
    try {
      await api.download(`/ps/payroll/report.${kind}?start=${p.start}`, `peer-payroll-${p.start}.${kind}`);
    } catch (ex) { alert(ex.message); }
  }

  async function copyEmail() {
    try {
      const { subject, body } = await api.get(`/ps/payroll/email-text?start=${p.start}`);
      await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
      alert('Email text copied to clipboard.');
    } catch (ex) { alert(ex.message); }
  }

  return (
    <div style={{ background: 'white', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)' }}>
      <div onClick={onToggle} style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer', flexWrap: 'wrap',
      }}>
        <span style={{ color: 'var(--gray-400)', fontSize: '0.8rem' }}>{expanded ? '▾' : '▸'}</span>
        <span style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '0.9rem', minWidth: 210 }}>
          {fmtLong(p.start)} – {fmtLong(p.end)}
        </span>
        <span style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>pay {fmtLong(p.pay_date)}</span>
        <div style={{ flex: 1 }} />
        {p.open       && <Tag bg="#e0f2fe" fg="#075985">projected</Tag>}
        {p.drifted    && <Tag bg="#fef9c3" fg="#854d0e">dates changed since finalized</Tag>}
        {p.finalized  && <Tag bg="#e5e7eb" fg="#374151">finalized</Tag>}
        {p.sent       && <Tag bg="#dbeafe" fg="#1e40af">sent</Tag>}
        {p.paid       && <Tag bg="#dcfce7" fg="#166534">paid</Tag>}
        <span style={{ fontSize: '0.8rem', color: 'var(--gray-500)' }}>{p.totals?.peers} peers</span>
        <span style={{ fontWeight: 700, color: 'var(--navy)', minWidth: 74, textAlign: 'right' }}>
          {p.totals?.total}
        </span>
      </div>

      {expanded && (
        <div style={{ borderTop: '1px solid var(--gray-100)', padding: '12px 16px' }}>
          {p.open && (
            <Callout bg="#f0f9ff" fg="#075985">
              This period runs through {fmtLong(p.end)}. These totals assume everyone currently
              assigned stays to the end — they’re a projection, not an earned amount.
            </Callout>
          )}
          {rep?.drifted && (
            <Callout bg="#fefce8" fg="#854d0e">
              Assignment dates have changed since this was finalized. The frozen report shows{' '}
              {rep.totals.total}; today’s dates would give {rep.live_totals?.total}. Re-finalize to
              update it, or leave it as the record of what you sent.
            </Callout>
          )}

          {!rep ? <p style={{ color: 'var(--gray-400)', fontSize: '0.82rem' }}>Loading…</p> : (
            <>
              <table style={{ ...tbl, marginBottom: 12 }}>
                <thead><tr style={hrow}>
                  <th style={th}>Peer</th><th style={th}>Assigned</th><th style={th}>Removed</th>
                  <th style={th}>From</th><th style={th}>Through</th>
                  <th style={{ ...th, textAlign: 'right' }}>Days</th>
                  <th style={th}>Calculation</th>
                  <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                </tr></thead>
                <tbody>
                  {rep.rows.map(r => (
                    <tr key={r.period_id} style={trow}>
                      <td style={{ ...td, fontWeight: 600, color: 'var(--navy)' }}>{r.peer_name}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmt(r.entered_on)}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.left_on ? fmt(r.left_on) : '—'}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmt(r.counted_from)}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmt(r.counted_through)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{r.days}</td>
                      <td style={{ ...td, color: 'var(--gray-500)', fontSize: '0.78rem' }}>{r.calculation}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{r.amount}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--navy)' }}>
                    <td style={{ ...td, fontWeight: 700 }} colSpan={5}>
                      {rep.totals.peers} peers · {rep.totals.peer_days} peer-days
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{rep.totals.peer_days}</td>
                    <td style={td} />
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, fontSize: '0.95rem' }}>
                      {rep.totals.total}
                    </td>
                  </tr>
                </tfoot>
              </table>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn btn-outline btn-xs" onClick={() => download('pdf')}>Download PDF</button>
                <button className="btn btn-outline btn-xs" onClick={() => download('csv')}>Download CSV</button>
                <button className="btn btn-outline btn-xs" onClick={copyEmail}>Copy email text</button>

                {!rep.finalized
                  ? <button className="btn btn-gold btn-xs" onClick={() => finalize(false)} disabled={busy}>
                      Finalize period
                    </button>
                  : <>
                      <button className="btn btn-outline btn-xs" onClick={() => finalize(true)} disabled={busy}>
                        Re-finalize
                      </button>
                      <button className="btn btn-danger btn-xs" onClick={unfinalize} disabled={busy}>
                        Un-finalize
                      </button>
                    </>}

                {rep.finalized && (
                  <>
                    <div style={{ width: 1, height: 20, background: 'var(--gray-200)' }} />
                    <label style={chk}>
                      <input type="checkbox" checked={!!rep.snapshot?.sent_to_billing_at} disabled={busy}
                        onChange={e => setFlag({ sent: e.target.checked })} style={box} />
                      Sent to billing
                    </label>
                    <label style={chk}>
                      <input type="checkbox" checked={!!rep.snapshot?.paid} disabled={busy}
                        onChange={e => setFlag({ paid: e.target.checked })} style={box} />
                      Paid
                    </label>
                    {rep.snapshot?.paid_at && (
                      <span style={{ fontSize: '0.72rem', color: 'var(--gray-400)' }}>
                        paid {new Date(rep.snapshot.paid_at).toLocaleDateString()}
                      </span>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── bits ──────────────────────────────────────────────────────────

const Empty = ({ children }) => (
  <p style={{ color: 'var(--gray-400)', fontSize: '0.88rem' }}>{children}</p>
);

const Callout = ({ bg, fg, children }) => (
  <div style={{
    background: bg, color: fg, fontSize: '0.78rem', padding: '8px 12px',
    borderRadius: 6, marginBottom: 12, lineHeight: 1.5,
  }}>{children}</div>
);

function Modal({ title, subtitle, children, onClose }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'white', borderRadius: 'var(--radius)', padding: 24, width: 380,
      }}>
        <h3 style={{ margin: '0 0 4px', fontSize: '1rem', color: 'var(--navy)' }}>{title}</h3>
        {subtitle && <p style={{ margin: '0 0 16px', fontSize: '0.75rem', color: 'var(--gray-400)', lineHeight: 1.5 }}>{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

const tbl   = { width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' };
const hrow  = { textAlign: 'left', color: 'var(--gray-400)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' };
const trow  = { borderTop: '1px solid var(--gray-100)' };
const th    = { padding: '6px 8px', fontWeight: 700 };
const td    = { padding: '7px 8px' };
const lbl   = { display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 };
const full  = { width: '100%', marginBottom: 12 };
const chk   = { display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.78rem', color: 'var(--gray-700)', cursor: 'pointer' };
const box   = { width: 14, height: 14, accentColor: 'var(--navy)' };
const panel = {
  background: '#f8fafc', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
  padding: '14px 18px', marginBottom: 14, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end',
};

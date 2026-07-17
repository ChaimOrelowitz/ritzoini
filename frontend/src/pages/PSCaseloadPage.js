import { useState, useEffect } from 'react';
import { api } from '../utils/api';

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, mo, d] = iso.split('-');
  return `${mo}/${d}/${y}`;
}

function daysBetween(from, to) {
  const a = new Date(from + 'T12:00:00');
  const b = to ? new Date(to + 'T12:00:00') : new Date();
  return Math.max(0, Math.round((b - a) / 86400000));
}

const STATUS_COLORS = {
  'Active':             { bg: '#dcfce7', fg: '#166534' },
  'At-Risk':            { bg: '#fef9c3', fg: '#854d0e' },
  'Inactive':           { bg: '#fee2e2', fg: '#991b1b' },
  'No Longer Working':  { bg: '#e5e7eb', fg: '#374151' },
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

export default function PSCaseloadPage() {
  const [tab,     setTab]     = useState('caseload');
  const [rows,    setRows]    = useState([]);
  const [history, setHistory] = useState([]);
  const [runs,    setRuns]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [edit,    setEdit]    = useState(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const [c, h, r] = await Promise.all([
      api.get('/ps/caseload').catch(() => []),
      api.get('/ps/caseload/history').catch(() => []),
      api.get('/ps/caseload/runs').catch(() => []),
    ]);
    setRows(Array.isArray(c) ? c : []);
    setHistory(Array.isArray(h) ? h : []);
    setRuns(Array.isArray(r) ? r : []);
    setLoading(false);
  }

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

  async function savePeriod() {
    try {
      await api.patch(`/ps/caseload/periods/${edit.id}`, {
        entered_on: edit.entered_on,
        left_on:    edit.left_on || null,
        note:       edit.note || null,
      });
      setEdit(null);
      await load();
    } catch (ex) { alert(ex.message); }
  }

  const lastRun = runs[0];

  if (loading) return <div style={{ padding: 32, color: 'var(--gray-400)' }}>Loading…</div>;

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1000, margin: '0 auto' }}>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: 'var(--navy)' }}>My Caseload</h2>
        <button className="btn btn-gold btn-sm" onClick={syncNow} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      <p style={{ margin: '0 0 18px', fontSize: '0.78rem', color: 'var(--gray-400)' }}>
        {rows.length} peers · pulled from Airtable
        {lastRun && ` · last checked ${new Date(lastRun.ran_at).toLocaleString()}`}
        {lastRun && !lastRun.ok && <span style={{ color: '#991b1b', fontWeight: 700 }}> · last sync failed: {lastRun.error}</span>}
      </p>

      <div style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: '1px solid var(--gray-200)' }}>
        {[['caseload', `Caseload (${rows.length})`], ['history', `History (${history.length})`]].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '8px 14px', fontSize: '0.85rem', fontWeight: 700,
            color: tab === k ? 'var(--navy)' : 'var(--gray-400)',
            borderBottom: tab === k ? '2px solid var(--gold, #c9a227)' : '2px solid transparent',
            marginBottom: -1,
          }}>{label}</button>
        ))}
      </div>

      {tab === 'caseload' && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--gray-400)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              <th style={th}>Peer</th><th style={th}>Status</th><th style={th}>Cohort</th>
              <th style={th}>Phone</th><th style={th}>Email</th>
              <th style={th}>Last Superv.</th><th style={th}>Joined</th><th style={th}>Days</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.period_id} style={{ borderTop: '1px solid var(--gray-100)' }}>
                <td style={{ ...td, fontWeight: 600, color: 'var(--navy)' }}>{r.peer_name}</td>
                <td style={td}><StatusPill status={r.status} /></td>
                <td style={td}>{r.cohort || '—'}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.phone || '—'}</td>
                <td style={{ ...td, color: 'var(--gray-500)' }}>{r.email || '—'}</td>
                <td style={td}>{fmtDate(r.last_supervision)}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(r.entered_on)}</td>
                <td style={{ ...td, color: 'var(--gray-500)' }}>{daysBetween(r.entered_on)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === 'history' && (
        <>
          <p style={{ fontSize: '0.78rem', color: 'var(--gray-400)', marginTop: 0 }}>
            Every stint on your caseload, for payroll. A peer who leaves and returns gets a separate row.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--gray-400)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <th style={th}>Peer</th><th style={th}>Entered</th><th style={th}>Left</th>
                <th style={th}>Days</th><th style={th}>Source</th><th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {history.map(p => (
                <tr key={p.id} style={{ borderTop: '1px solid var(--gray-100)' }}>
                  <td style={{ ...td, fontWeight: 600, color: 'var(--navy)' }}>{p.peer_name}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(p.entered_on)}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {p.left_on
                      ? fmtDate(p.left_on)
                      : <span style={{ color: '#166534', fontWeight: 700 }}>current</span>}
                  </td>
                  <td style={{ ...td, color: 'var(--gray-500)' }}>{daysBetween(p.entered_on, p.left_on)}</td>
                  <td style={{ ...td, color: 'var(--gray-400)', fontSize: '0.75rem' }}>{p.source}</td>
                  <td style={td}>
                    <button className="btn btn-outline btn-xs" onClick={() => setEdit({ ...p })}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {edit && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
        }} onClick={() => setEdit(null)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: 'white', borderRadius: 'var(--radius)', padding: 24, width: 360,
          }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '1rem', color: 'var(--navy)' }}>{edit.peer_name}</h3>
            <p style={{ margin: '0 0 16px', fontSize: '0.75rem', color: 'var(--gray-400)' }}>
              Correcting these changes payroll. Leave “Left” empty if still on the caseload.
            </p>
            <label style={lbl}>Entered</label>
            <input type="date" className="form-input" style={{ width: '100%', marginBottom: 12 }}
              value={edit.entered_on || ''} onChange={e => setEdit(v => ({ ...v, entered_on: e.target.value }))} />
            <label style={lbl}>Left</label>
            <input type="date" className="form-input" style={{ width: '100%', marginBottom: 12 }}
              value={edit.left_on || ''} onChange={e => setEdit(v => ({ ...v, left_on: e.target.value }))} />
            <label style={lbl}>Note</label>
            <input className="form-input" style={{ width: '100%', marginBottom: 16 }}
              value={edit.note || ''} onChange={e => setEdit(v => ({ ...v, note: e.target.value }))} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-gold btn-sm" onClick={savePeriod}>Save</button>
              <button className="btn btn-outline btn-sm" onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const th  = { padding: '6px 10px', fontWeight: 700 };
const td  = { padding: '8px 10px' };
const lbl = { display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 };

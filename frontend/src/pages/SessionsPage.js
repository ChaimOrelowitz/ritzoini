import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function dayAbbr(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return DAYS[new Date(y, m - 1, d).getDay()];
}

function fmt12(timeStr) {
  if (!timeStr) return '—';
  const [h, m] = timeStr.slice(0, 5).split(':').map(Number);
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

const STATUS_STYLE = {
  scheduled: { background: '#e0e7ff', color: '#3730a3' },
  completed: { background: '#dcfce7', color: '#166534' },
  skipped:   { background: '#f3f4f6', color: '#6b7280' },
};
const STATUS_LABEL = { scheduled: 'Scheduled', completed: 'Completed', skipped: 'Skipped' };

function fmtDateTime(ts) {
  if (!ts) return null;
  return new Date(ts).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

// Deep link to the Zoho occurrence record.
const ZOHO_ORG = '871314197';
const zohoOccurrenceUrl = (id) => `https://crm.zoho.com/crm/org${ZOHO_ORG}/tab/Session_Occurrences/${id}`;

// A checkbox that stays visually centered; its timestamp + "view" link live in a
// hover popover so the three columns line up cleanly.
function CheckCell({ checked, onChange, timestamp, messageId, zohoId, accent }) {
  const [hover, setHover] = useState(false);
  const hasInfo = timestamp || zohoId || messageId;
  return (
    <td
      style={{ textAlign: 'center', padding: '10px 14px', verticalAlign: 'middle', position: 'relative' }}
      onClick={e => e.stopPropagation()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <input
        type="checkbox"
        checked={!!checked}
        onChange={e => onChange(e.target.checked)}
        style={{ width: 17, height: 17, cursor: 'pointer', accentColor: accent || 'var(--gold)', verticalAlign: 'middle' }}
      />
      {hover && hasInfo && (
        <div style={{
          position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
          marginTop: 2, zIndex: 20, whiteSpace: 'nowrap',
          background: 'var(--navy)', color: '#fff', borderRadius: 6, padding: '4px 8px',
          fontSize: '0.68rem', boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
        }}>
          {timestamp ? fmtDateTime(timestamp) : 'set'}
          {zohoId && (
            <a href={zohoOccurrenceUrl(zohoId)} target="_blank" rel="noreferrer"
              style={{ marginLeft: 6, color: '#c4b5fd', textDecoration: 'underline' }}>view in Zoho</a>
          )}
          {!zohoId && messageId && (
            <a href={`https://resend.com/emails/${messageId}`} target="_blank" rel="noreferrer"
              style={{ marginLeft: 6, color: '#93c5fd', textDecoration: 'underline' }}>view</a>
          )}
        </div>
      )}
    </td>
  );
}

function SessionRow({ session, onToggle }) {
  const navigate = useNavigate();
  const dateStr = session.session_date || session.scheduled_date || '';
  const tint = session.locked ? '#f0fdf4' : (session.ready_to_lock ? '#fffbeb' : undefined);
  const edge = session.locked ? '#12855C' : (session.ready_to_lock ? '#E0A50E' : 'transparent');

  return (
    <tr
      onClick={() => navigate(`/groups/${session.group_id}`)}
      style={{ cursor: 'pointer', background: tint, borderLeft: `3px solid ${edge}`, transition: 'background 0.15s' }}
      onMouseEnter={e => { e.currentTarget.style.background = tint || 'var(--gray-50)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = tint || ''; }}
    >
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: 'var(--navy)', fontWeight: 500 }}>
        {fmtDate(dateStr)} <span style={{ color: 'var(--gray-400)', fontWeight: 400 }}>({dayAbbr(dateStr)})</span>
      </td>
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: 'var(--gray-600)' }}>{fmt12(session.ecw_time || session.start_time || session.scheduled_time)}</td>
      <td style={{ padding: '10px 12px', color: 'var(--navy)', fontWeight: 500, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {session.group?.group_name || session.group?.internal_name || '—'}
      </td>
      <td style={{ padding: '10px 12px' }}>
        <span style={{ ...(STATUS_STYLE[session.status] || {}), borderRadius: 12, padding: '2px 10px', fontSize: '0.72rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
          {STATUS_LABEL[session.status] || session.status}
        </span>
      </td>
      <CheckCell checked={session.email_sent}    onChange={v => onToggle(session.id, 'email_sent', v)}    timestamp={session.email_sent_at}    messageId={session.email_message_id} zohoId={session.zoho_note_id} accent="#2563eb" />
      <CheckCell checked={session.ready_to_lock} onChange={v => onToggle(session.id, 'ready_to_lock', v)} timestamp={session.ready_to_lock_at} accent="#E0A50E" />
      <CheckCell checked={session.locked}        onChange={v => onToggle(session.id, 'locked', v)}        timestamp={session.locked_at} accent="#12855C" />
    </tr>
  );
}

const TILES = [
  { key: 'ready',     label: 'Ready to Lock', sub: 'lock these', accent: '#B4820E', bg: '#FFF8E1', border: '#F2D998' },
  { key: 'awaiting',  label: 'Sent · Awaiting', sub: "waiting on Zoho", accent: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
  { key: 'needsNote', label: 'Needs Note', sub: 'no note yet', accent: '#b45309', bg: '#fff7ed', border: '#fed7aa' },
  { key: 'locked',    label: 'Locked', sub: 'done', accent: '#12855C', bg: '#ecfdf3', border: '#a7f3d0' },
  { key: 'upcoming',  label: 'Upcoming', sub: 'scheduled', accent: 'var(--navy)', bg: '#eef2ff', border: '#c7d2fe' },
  { key: 'all',       label: 'All', sub: '', accent: '#6b7280', bg: '#f3f4f6', border: '#e5e7eb' },
];

const COLUMNS = [
  { key: 'date',          label: 'Date',          align: 'left'   },
  { key: 'time',          label: 'Time (ECW)',    align: 'left'   },
  { key: 'group',         label: 'Group Name',    align: 'left'   },
  { key: 'status',        label: 'Status',        align: 'left'   },
  { key: 'email_sent',    label: 'Note Sent',     align: 'center' },
  { key: 'ready_to_lock', label: 'Ready to Lock', align: 'center' },
  { key: 'locked',        label: 'Locked',        align: 'center' },
];

function sortVal(s, key) {
  switch (key) {
    case 'date':   return s.session_date || s.scheduled_date || '';
    case 'time':   return (s.ecw_time || s.start_time || s.scheduled_time || '').slice(0, 5);
    case 'group':  return (s.group?.group_name || s.group?.internal_name || '').toLowerCase();
    case 'status': return s.status || '';
    case 'email_sent':    return s.email_sent ? 1 : 0;
    case 'ready_to_lock': return s.ready_to_lock ? 1 : 0;
    case 'locked':        return s.locked ? 1 : 0;
    default: return '';
  }
}

export default function SessionsPage() {
  const { isAdmin } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [supervisors, setSupervisors] = useState([]);
  const [supervisorFilter, setSupervisorFilter] = useState('');
  const [filter, setFilter] = useState('ready'); // her default queue
  const [zohoOnly, setZohoOnly] = useState(true); // hide pre-Zoho sessions by default
  const [sort, setSort] = useState({ key: 'date', dir: 'desc' }); // default newest first
  const [toast, setToast] = useState(null);
  const [syncing, setSyncing] = useState(false);

  async function syncReadyToLock() {
    setSyncing(true);
    try {
      const r = await api.zohoLockBackfill(true); // apply: pull ready-to-lock + locked from Zoho
      await load();
      flash(`Synced with Zoho — ${r.wouldReady} ready to lock, ${r.wouldLock} locked`, 'success');
    } catch (err) {
      flash('Sync failed: ' + err.message, 'error');
    } finally { setSyncing(false); }
  }

  function toggleSort(key) {
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'date' ? 'desc' : 'asc' });
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, users] = await Promise.all([
        api.getAllSessions(supervisorFilter || undefined),
        isAdmin ? api.getUsers() : Promise.resolve([]),
      ]);
      setSessions(data);
      if (isAdmin) setSupervisors(users.filter(u => u.role === 'supervisor'));
    } catch (err) {
      console.error('Failed to load sessions:', err.message);
    } finally { setLoading(false); }
  }, [supervisorFilter, isAdmin]);

  useEffect(() => { load(); }, [load]);

  function flash(msg, type = 'success') {
    setToast({ msg, type });
    setTimeout(() => setToast(t => (t && t.msg === msg ? null : t)), 3800);
  }

  async function handleToggle(sessionId, field, value) {
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, [field]: value } : s));
    try {
      const updated = await api.updateSession(sessionId, { [field]: value });
      if (field === 'locked' && value) {
        if (updated && updated.zoho_lock_warning) flash(updated.zoho_lock_warning, 'warn');
        else flash('Locked ✓ — synced to Zoho', 'success');
      }
    } catch (err) {
      console.error('Toggle failed:', err.message);
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, [field]: !value } : s));
      flash('Could not save: ' + err.message, 'error');
    }
  }

  // "Zoho Sessions Only" hides pre-Zoho orphans (never posted → no occurrence id).
  const base = zohoOnly ? sessions.filter(s => s.zoho_note_id) : sessions;
  const completed = base.filter(s => s.status === 'completed');
  const buckets = {
    ready:     completed.filter(s => s.ready_to_lock && !s.locked),
    awaiting:  completed.filter(s => s.email_sent && !s.ready_to_lock && !s.locked),
    needsNote: completed.filter(s => !s.email_sent),
    locked:    completed.filter(s => s.locked),
    upcoming:  base.filter(s => s.status === 'scheduled'),
    all:       base,
  };
  const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));

  const rows = [...buckets[filter]].sort((a, b) => {
    const va = sortVal(a, sort.key), vb = sortVal(b, sort.key);
    const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return sort.dir === 'asc' ? cmp : -cmp;
  });

  const activeTile = TILES.find(t => t.key === filter);

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1160, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0, color: 'var(--navy)', fontWeight: 700 }}>Sessions</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {isAdmin && (
            <button className="btn btn-outline btn-sm" onClick={syncReadyToLock} disabled={syncing}
              style={{ color: '#6941C6', whiteSpace: 'nowrap' }}
              title="Pull Ready-to-Lock and Locked status from Zoho now">
              {syncing ? 'Syncing…' : '↻ Sync Ready-to-Lock'}
            </button>
          )}
          {isAdmin && supervisors.length > 0 && (
            <select className="form-select" value={supervisorFilter} onChange={e => setSupervisorFilter(e.target.value)} style={{ width: 220 }}>
              <option value="">All supervisors</option>
              {supervisors.map(s => <option key={s.id} value={s.id}>{s.first_name} {s.last_name}</option>)}
            </select>
          )}
        </div>
      </div>

      {/* Filter tiles */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10, alignItems: 'stretch' }}>
        {TILES.map(t => {
          const on = filter === t.key;
          return (
            <button key={t.key} onClick={() => setFilter(t.key)}
              style={{
                cursor: 'pointer', textAlign: 'left', minWidth: 120,
                background: on ? t.bg : 'var(--white)',
                border: `1.5px solid ${on ? t.accent : 'var(--gray-200)'}`,
                borderRadius: 10, padding: '10px 14px', transition: 'all 0.12s',
                boxShadow: on ? `0 1px 6px ${t.accent}22` : 'none',
              }}>
              <div style={{ fontSize: '1.4rem', fontWeight: 700, lineHeight: 1, color: t.accent, fontVariantNumeric: 'tabular-nums' }}>{counts[t.key]}</div>
              <div style={{ fontSize: '0.78rem', fontWeight: 600, color: on ? t.accent : 'var(--gray-600)', marginTop: 3 }}>{t.label}</div>
              {t.sub && <div style={{ fontSize: '0.66rem', color: 'var(--gray-400)', marginTop: 1 }}>{t.sub}</div>}
            </button>
          );
        })}
      </div>

      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 18, fontSize: '0.82rem', color: 'var(--gray-600)', cursor: 'pointer', userSelect: 'none' }}>
        <input type="checkbox" checked={zohoOnly} onChange={e => setZohoOnly(e.target.checked)} style={{ width: 15, height: 15, accentColor: '#6941C6', cursor: 'pointer' }} />
        Zoho Sessions Only <span style={{ color: 'var(--gray-400)', fontSize: '0.76rem' }}>(hide old pre-Zoho sessions)</span>
      </label>

      {/* Table */}
      <div style={{ border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        {rows.length === 0 ? (
          <div style={{ padding: '32px', textAlign: 'center', color: 'var(--gray-400)', fontSize: '0.9rem' }}>
            {filter === 'ready' ? '🎉 Nothing waiting to be locked.' : 'No sessions here.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ background: 'var(--gray-50)', borderBottom: '1px solid var(--gray-200)' }}>
                  {COLUMNS.map(c => {
                    const active = sort.key === c.key;
                    return (
                      <th key={c.key} onClick={() => toggleSort(c.key)}
                        style={{ padding: '9px 12px', textAlign: c.align, fontWeight: 600, color: active ? 'var(--navy)' : 'var(--gray-500)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }}>
                        {c.label}<span style={{ opacity: active ? 1 : 0.25, marginLeft: 4 }}>{active ? (sort.dir === 'asc' ? '▲' : '▼') : '▾'}</span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map(s => <SessionRow key={s.id} session={s} onToggle={handleToggle} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {activeTile && rows.length > 0 && (
        <div style={{ marginTop: 10, fontSize: '0.78rem', color: 'var(--gray-500)' }}>
          Showing <strong>{rows.length}</strong> {activeTile.label.toLowerCase()} · {counts.locked} locked so far
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 1000,
          background: toast.type === 'success' ? '#12855C' : toast.type === 'warn' ? '#B4820E' : '#b42318',
          color: '#fff', borderRadius: 10, padding: '12px 18px', fontSize: '0.85rem', fontWeight: 500,
          boxShadow: '0 8px 24px rgba(0,0,0,0.22)', maxWidth: 360,
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

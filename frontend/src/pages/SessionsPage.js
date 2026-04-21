import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const [, m, d] = dateStr.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
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

const STATUS_LABEL = {
  scheduled: 'Scheduled',
  completed: 'Completed',
  skipped:   'Skipped',
};

function CheckCell({ checked, onChange }) {
  return (
    <td
      style={{ textAlign: 'center', padding: '8px 12px' }}
      onClick={e => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={!!checked}
        onChange={e => onChange(e.target.checked)}
        style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--gold)' }}
      />
    </td>
  );
}

function SessionRow({ session, onToggle }) {
  const navigate = useNavigate();
  const dateStr = session.session_date || session.scheduled_date || '';
  const needsAttention = session.status === 'completed' && !session.email_sent;

  return (
    <tr
      onClick={() => navigate(`/groups/${session.group_id}`)}
      style={{
        cursor: 'pointer',
        background: needsAttention ? '#fef9ec' : undefined,
        borderLeft: needsAttention ? '3px solid #f59e0b' : '3px solid transparent',
        transition: 'background 0.15s',
      }}
      onMouseEnter={e => { if (!needsAttention) e.currentTarget.style.background = 'var(--gray-50)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = needsAttention ? '#fef9ec' : ''; }}
    >
      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: 'var(--navy)', fontWeight: 500 }}>
        {fmtDate(dateStr)}
      </td>
      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: 'var(--gray-600)' }}>
        {fmt12(session.start_time || session.scheduled_time)}
      </td>
      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: 'var(--gray-600)' }}>
        {fmt12(session.ecw_time)}
      </td>
      <td style={{ padding: '8px 12px', color: 'var(--navy)', fontWeight: 500, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {session.group?.internal_name || '—'}
      </td>
      <td style={{ padding: '8px 12px', color: 'var(--gray-600)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {session.group?.group_name || '—'}
      </td>
      <td style={{ padding: '8px 12px' }}>
        <span style={{
          ...(STATUS_STYLE[session.status] || {}),
          borderRadius: 12, padding: '2px 10px',
          fontSize: '0.72rem', fontWeight: 600, whiteSpace: 'nowrap',
        }}>
          {STATUS_LABEL[session.status] || session.status}
        </span>
      </td>
      <CheckCell checked={session.email_sent}    onChange={v => onToggle(session.id, 'email_sent', v)} />
      <CheckCell checked={session.ready_to_lock} onChange={v => onToggle(session.id, 'ready_to_lock', v)} />
      <CheckCell checked={session.locked}        onChange={v => onToggle(session.id, 'locked', v)} />
    </tr>
  );
}

function Section({ title, sessions, open, onToggle: onToggleSection, onFieldToggle, accent }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <button
        onClick={onToggleSection}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '10px 0', width: '100%', textAlign: 'left',
        }}
      >
        <span style={{
          display: 'inline-block', width: 22, height: 22, lineHeight: '22px',
          textAlign: 'center', borderRadius: 6,
          background: accent, color: '#fff', fontSize: '0.7rem', fontWeight: 700,
        }}>
          {open ? '▾' : '▸'}
        </span>
        <span style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--navy)' }}>{title}</span>
        <span style={{
          background: 'var(--gray-100)', color: 'var(--gray-500)',
          borderRadius: 10, padding: '1px 8px', fontSize: '0.75rem', fontWeight: 600,
        }}>
          {sessions.length}
        </span>
      </button>

      {open && (
        <div style={{ border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {sessions.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--gray-400)', fontSize: '0.85rem' }}>
              No sessions
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ background: 'var(--gray-50)', borderBottom: '1px solid var(--gray-200)' }}>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--gray-500)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>Date</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--gray-500)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>Time</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--gray-500)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>ECW</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--gray-500)', fontSize: '0.75rem' }}>Internal Name</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--gray-500)', fontSize: '0.75rem' }}>Group Name</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--gray-500)', fontSize: '0.75rem' }}>Status</th>
                    <th style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600, color: 'var(--gray-500)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>Email Sent</th>
                    <th style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600, color: 'var(--gray-500)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>Ready to Lock</th>
                    <th style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600, color: 'var(--gray-500)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>Locked (ECW)</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map(s => (
                    <SessionRow key={s.id} session={s} onToggle={onFieldToggle} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SessionsPage() {
  const { isAdmin } = useAuth();
  const [sessions, setSessions]           = useState([]);
  const [loading, setLoading]             = useState(true);
  const [supervisors, setSupervisors]     = useState([]);
  const [supervisorFilter, setSupervisorFilter] = useState('');
  const [upcomingOpen, setUpcomingOpen]   = useState(false);
  const [completedOpen, setCompletedOpen] = useState(true);

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
    } finally {
      setLoading(false);
    }
  }, [supervisorFilter, isAdmin]);

  useEffect(() => { load(); }, [load]);

  async function handleToggle(sessionId, field, value) {
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, [field]: value } : s));
    try {
      await api.updateSession(sessionId, { [field]: value });
    } catch (err) {
      console.error('Toggle failed:', err.message);
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, [field]: !value } : s));
    }
  }

  // Upcoming: descending by date (furthest at top, soonest at bottom)
  const upcoming = [...sessions]
    .filter(s => s.status === 'scheduled')
    .sort((a, b) => (b.session_date || b.scheduled_date || '').localeCompare(a.session_date || a.scheduled_date || ''));

  // Completed: descending by date (most recent at top)
  const completed = [...sessions]
    .filter(s => s.status === 'completed')
    .sort((a, b) => (b.session_date || b.scheduled_date || '').localeCompare(a.session_date || a.scheduled_date || ''));

  const needsAttentionCount = completed.filter(s => !s.email_sent).length;

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, color: 'var(--navy)', fontWeight: 700 }}>Sessions</h2>
          {needsAttentionCount > 0 && (
            <div style={{ marginTop: 4, fontSize: '0.8rem', color: '#92400e' }}>
              ⚠ {needsAttentionCount} completed session{needsAttentionCount !== 1 ? 's' : ''} without email sent
            </div>
          )}
        </div>
        {isAdmin && supervisors.length > 0 && (
          <select
            className="form-select"
            value={supervisorFilter}
            onChange={e => setSupervisorFilter(e.target.value)}
            style={{ width: 220 }}
          >
            <option value="">All supervisors</option>
            {supervisors.map(s => (
              <option key={s.id} value={s.id}>{s.first_name} {s.last_name}</option>
            ))}
          </select>
        )}
      </div>

      <Section
        title="Upcoming"
        sessions={upcoming}
        open={upcomingOpen}
        onToggle={() => setUpcomingOpen(o => !o)}
        onFieldToggle={handleToggle}
        accent="var(--navy)"
      />

      <Section
        title="Completed"
        sessions={completed}
        open={completedOpen}
        onToggle={() => setCompletedOpen(o => !o)}
        onFieldToggle={handleToggle}
        accent="#166534"
      />
    </div>
  );
}

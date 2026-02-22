import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import EditGroupModal from '../components/admin/EditGroupModal';

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_COLORS = {
  scheduled: 'badge-scheduled',
  completed: 'badge-completed',
  cancelled: 'badge-cancelled',
};

// ── Single Session Row ─────────────────────────────────────────
function SessionRow({ session, onUpdate }) {
  const [saving, setSaving] = useState(false);
  const [soapNote, setSoapNote] = useState(session.soap_note || session.notes || '');
  const saveTimer = useRef(null);

  // Auto-save soap note with 1s debounce
  function handleNoteChange(val) {
    setSoapNote(val);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        const updated = await api.updateSession(session.id, { soap_note: val });
        onUpdate(updated);
      } finally {
        setSaving(false);
      }
    }, 1000);
  }

  async function handleStatusChange(newStatus) {
    const updated = await api.updateSession(session.id, { status: newStatus, status_manual_override: true });
    onUpdate(updated);
  }

  async function handleCheckbox(field, value) {
    const updated = await api.updateSession(session.id, { [field]: value });
    onUpdate(updated);
  }

  async function handleCancel() {
    if (!window.confirm('Cancel this session?')) return;
    const updated = await api.cancelSession(session.id);
    onUpdate(updated);
  }

  async function handleReturnToAuto() {
    const updated = await api.returnToAuto(session.id);
    onUpdate(updated);
  }

  const isCancelled = session.status === 'cancelled';

  return (
    <div style={{
      background: isCancelled ? 'var(--gray-50)' : 'white',
      border: '1px solid var(--gray-100)',
      borderRadius: 'var(--radius)',
      padding: '16px 20px',
      opacity: isCancelled ? 0.65 : 1,
      marginBottom: 12,
    }}>
      {/* Top row: session info + status */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>

        {/* Session number + date */}
        <div style={{ minWidth: 100 }}>
          <div style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '0.95rem' }}>
            Session #{session.session_number}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--gray-600)', marginTop: 2 }}>
            {fmtDate(session.session_date || session.scheduled_date)}
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--gray-400)' }}>
            {fmt12(session.start_time || session.scheduled_time)}
            {session.end_time && ` – ${fmt12(session.end_time)}`}
          </div>
        </div>

        {/* Status dropdown */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</label>
          <select
            className="form-select"
            style={{ padding: '5px 10px', fontSize: '0.82rem', width: 130 }}
            value={session.status}
            disabled={isCancelled}
            onChange={e => handleStatusChange(e.target.value)}
          >
            <option value="scheduled">Scheduled</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          {session.status_manual_override && !isCancelled && (
            <button
              onClick={handleReturnToAuto}
              style={{
                fontSize: '0.7rem', color: 'var(--gold)', background: 'none',
                border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left',
                fontWeight: 600,
              }}
            >
              ↺ Return to Auto
            </button>
          )}
        </div>

        {/* Checkboxes */}
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' }}>
          {[
            { field: 'email_sent',    label: 'Email Sent' },
            { field: 'ready_to_lock', label: 'Ready to Lock' },
            { field: 'locked',        label: 'Locked (ECW)' },
          ].map(({ field, label }) => (
            <label key={field} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: '0.8rem', color: 'var(--gray-700)', cursor: 'pointer',
              fontWeight: 500,
            }}>
              <input
                type="checkbox"
                checked={!!session[field]}
                onChange={e => handleCheckbox(field, e.target.checked)}
                style={{ width: 15, height: 15, cursor: 'pointer', accentColor: 'var(--navy)' }}
              />
              {label}
            </label>
          ))}
        </div>

        {/* Cancel button */}
        {!isCancelled && (
          <button
            className="btn btn-danger btn-xs"
            onClick={handleCancel}
            style={{ alignSelf: 'flex-start', marginLeft: 8 }}
          >
            Cancel
          </button>
        )}
      </div>

      {/* SOAP Note */}
      <div>
        <div style={{
          fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)',
          textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          SOAP Note
          {saving && <span style={{ color: 'var(--gold)', fontWeight: 500 }}>Saving…</span>}
          {!saving && soapNote && <span style={{ color: '#10b981', fontWeight: 500 }}>✓ Saved</span>}
        </div>
        <textarea
          className="form-textarea"
          value={soapNote}
          onChange={e => handleNoteChange(e.target.value)}
          placeholder="Subjective, Objective, Assessment, Plan…"
          disabled={isCancelled}
          style={{
            minHeight: 80,
            fontSize: '0.875rem',
            background: isCancelled ? 'var(--gray-50)' : 'white',
          }}
        />
      </div>
    </div>
  );
}

// ── Group Detail Page ──────────────────────────────────────────
export default function GroupDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [group, setGroup] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showEditGroup, setShowEditGroup] = useState(false);

  const load = useCallback(async () => {
    try {
      const [g, s] = await Promise.all([api.getGroup(id), api.getSessions(id)]);
      setGroup(g);
      setSessions(s);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  function handleSessionUpdate(updated) {
    setSessions(prev => prev.map(s => s.id === updated.id ? updated : s));
  }

  async function handleArchive() {
    if (!window.confirm('Archive this group? It will be hidden from the dashboard.')) return;
    try {
      await api.archiveGroup(id);
      navigate('/');
    } catch (err) { setError(err.message); }
  }

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (!group)  return <div className="alert alert-error" style={{ margin: 24 }}>Group not found.</div>;

  const supervisorName = group.supervisor
    ? `${group.supervisor.first_name} ${group.supervisor.last_name}`.trim()
    : 'Unassigned';

  const dow = group.day_of_week_int ?? DAY_NAMES.indexOf(group.day_of_week);
  const dayName = DAY_NAMES[dow] || group.day_of_week || '';

  const completedCount = sessions.filter(s => s.status === 'completed').length;
  const cancelledCount = sessions.filter(s => s.status === 'cancelled').length;
  const lockedCount    = sessions.filter(s => s.locked).length;

  return (
    <div>
      <button className="back-link" onClick={() => navigate('/')}>← Back to Dashboard</button>

      {/* Header */}
      <div className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <h2>{group.group_name || group.name}</h2>
            <span className={`badge badge-${group.status}`}>{group.status}</span>
            {group.archived && <span className="badge badge-cancelled">Archived</span>}
          </div>
          {group.internal_name && group.internal_name !== (group.group_name || group.name) && (
            <div style={{ fontSize: '0.82rem', color: 'var(--gray-400)', marginBottom: 4 }}>
              Internal: {group.internal_name}
            </div>
          )}
          <p style={{ color: 'var(--gray-600)', fontSize: '0.875rem' }}>
            {dayName}s · {fmt12(group.start_time || group.session_time)} – {fmt12(group.end_time)}
            {group.ecw_time && <> · ECW {fmt12(group.ecw_time)}</>}
            {' '}· {supervisorName} · {group.total_sessions} sessions
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-outline btn-sm" onClick={() => setShowEditGroup(true)}>Edit Group</button>
          {!group.archived && (
            <button className="btn btn-danger btn-sm" onClick={handleArchive}>Archive Group</button>
          )}
        </div>
      </div>

      {error   && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      {/* Stats */}
      <div className="stats-row" style={{ marginBottom: 28 }}>
        <div className="stat-card"><div className="stat-value">{sessions.length}</div><div className="stat-label">Total</div></div>
        <div className="stat-card"><div className="stat-value">{sessions.filter(s => s.status === 'scheduled').length}</div><div className="stat-label">Scheduled</div></div>
        <div className="stat-card"><div className="stat-value">{completedCount}</div><div className="stat-label">Completed</div></div>
        <div className="stat-card"><div className="stat-value">{lockedCount}</div><div className="stat-label">Locked (ECW)</div></div>
        <div className="stat-card"><div className="stat-value">{cancelledCount}</div><div className="stat-label">Cancelled</div></div>
      </div>

      {/* Sessions */}
      <div className="card">
        <div className="card-header">
          <h3 style={{ fontSize: '1.1rem', color: 'var(--navy)' }}>Sessions</h3>
          <span style={{ fontSize: '0.8rem', color: 'var(--gray-400)' }}>
            SOAP notes auto-save as you type
          </span>
        </div>
        <div style={{ padding: '16px 24px' }}>
          {sessions.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">📅</div><p>No sessions yet.</p></div>
          ) : (
            sessions.map(session => (
              <SessionRow
                key={session.id}
                session={session}
                onUpdate={handleSessionUpdate}
              />
            ))
          )}
        </div>
      </div>

      {showEditGroup && (
        <EditGroupModal
          group={group}
          onClose={() => setShowEditGroup(false)}
          onSaved={() => { setShowEditGroup(false); setSuccess('Group updated.'); load(); }}
        />
      )}
    </div>
  );
}

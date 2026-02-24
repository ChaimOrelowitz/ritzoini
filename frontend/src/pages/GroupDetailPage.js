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
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

const STATUS_OPTIONS = ['scheduled','completed','cancelled','group_ended'];
const STATUS_LABELS  = { scheduled: 'Scheduled', completed: 'Completed', cancelled: 'Cancelled', group_ended: 'Group Ended' };
const STATUS_BADGE   = { scheduled: 'badge-scheduled', completed: 'badge-completed', cancelled: 'badge-cancelled', group_ended: 'badge-cancelled' };

// ── Session Row ───────────────────────────────────────────────
function SessionRow({ session, groupDuration, onUpdate, onCancel }) {
  const [soapNote, setSoapNote] = useState(session.soap_note || session.notes || '');
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved
  const saveTimer = useRef(null);
  const [editingDate, setEditingDate] = useState(false);
  const [editingTime, setEditingTime] = useState(false);
  const [localDate, setLocalDate]     = useState(session.session_date || session.scheduled_date || '');
  const [localTime, setLocalTime]     = useState((session.start_time  || session.scheduled_time || '').slice(0,5));
  const [localDur,  setLocalDur]      = useState(String(session.duration || groupDuration || 45));

  const isCancelled  = session.status === 'cancelled';
  const isGroupEnded = session.status === 'group_ended';
  const isReadOnly   = isCancelled || isGroupEnded;

  function handleNoteChange(val) {
    setSoapNote(val);
    setSaveState('saving');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const updated = await api.updateSession(session.id, { soap_note: val });
        onUpdate(updated);
        setSaveState('saved');
        setTimeout(() => setSaveState('idle'), 2000);
      } catch { setSaveState('idle'); }
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

  async function handleReturnToAuto() {
    const updated = await api.returnToAuto(session.id);
    onUpdate(updated);
  }

  async function saveDate() {
    setEditingDate(false);
    if (localDate === (session.session_date || session.scheduled_date)) return;
    const updated = await api.updateSession(session.id, { session_date: localDate });
    onUpdate(updated);
  }

  async function saveTime() {
    setEditingTime(false);
    const dur = parseInt(localDur) || groupDuration || 45;
    const updated = await api.updateSession(session.id, { start_time: localTime, duration: dur });
    onUpdate(updated);
  }

  const displayDow = session.session_day_of_week != null
    ? DAY_NAMES[session.session_day_of_week]
    : fmtDate(session.session_date || session.scheduled_date).split(',')[0];

  return (
    <div style={{
      background: isReadOnly ? 'var(--gray-50)' : 'white',
      border: '1px solid var(--gray-100)',
      borderLeft: `4px solid ${isCancelled ? 'var(--gray-300)' : isGroupEnded ? '#f59e0b' : 'var(--navy)'}`,
      borderRadius: 'var(--radius)',
      padding: '14px 18px',
      opacity: isReadOnly ? 0.7 : 1,
      marginBottom: 10,
    }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* Session # + date + time */}
        <div style={{ minWidth: 120 }}>
          <div style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '0.9rem' }}>
            #{session.session_number}
            {session.session_day_of_week != null && (
              <span style={{ fontWeight: 400, color: 'var(--gray-400)', marginLeft: 6, fontSize: '0.8rem' }}>
                {DAY_NAMES[session.session_day_of_week]}
              </span>
            )}
          </div>

          {/* Date — click to edit */}
          {editingDate ? (
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              <input type="date" className="form-input" style={{ padding: '3px 6px', fontSize: '0.78rem', width: 130 }}
                value={localDate} onChange={e => setLocalDate(e.target.value)} />
              <button className="btn btn-gold btn-xs" onClick={saveDate}>✓</button>
              <button className="btn btn-outline btn-xs" onClick={() => setEditingDate(false)}>✕</button>
            </div>
          ) : (
            <div style={{ fontSize: '0.8rem', color: 'var(--gray-600)', marginTop: 2, cursor: isReadOnly ? 'default' : 'pointer' }}
              onClick={() => !isReadOnly && setEditingDate(true)}
              title={isReadOnly ? '' : 'Click to edit date'}>
              {fmtDate(session.session_date || session.scheduled_date)}
              {!isReadOnly && <span style={{ color: 'var(--gray-300)', marginLeft: 4 }}>✏</span>}
            </div>
          )}

          {/* Time + duration — click to edit */}
          {editingTime ? (
            <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
              <input type="time" className="form-input" style={{ padding: '3px 6px', fontSize: '0.78rem', width: 100 }}
                value={localTime} onChange={e => setLocalTime(e.target.value)} />
              <input type="number" className="form-input" style={{ padding: '3px 6px', fontSize: '0.78rem', width: 64 }}
                value={localDur} onChange={e => setLocalDur(e.target.value)} placeholder="min" />
              <button className="btn btn-gold btn-xs" onClick={saveTime}>✓</button>
              <button className="btn btn-outline btn-xs" onClick={() => setEditingTime(false)}>✕</button>
            </div>
          ) : (
            <div style={{ fontSize: '0.78rem', color: 'var(--gray-400)', cursor: isReadOnly ? 'default' : 'pointer' }}
              onClick={() => !isReadOnly && setEditingTime(true)}
              title={isReadOnly ? '' : 'Click to edit time/duration'}>
              {fmt12(session.start_time || session.scheduled_time)}
              {' · '}{session.duration || groupDuration || 45} min
              {!isReadOnly && <span style={{ color: 'var(--gray-300)', marginLeft: 4 }}>✏</span>}
            </div>
          )}
        </div>

        {/* Status */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase' }}>Status</label>
          <select className="form-select" style={{ padding: '4px 8px', fontSize: '0.8rem', width: 130 }}
            value={session.status} disabled={isReadOnly}
            onChange={e => handleStatusChange(e.target.value)}>
            {STATUS_OPTIONS.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
          {session.status_manual_override && !isReadOnly && (
            <button onClick={handleReturnToAuto}
              style={{ fontSize: '0.7rem', color: 'var(--gold)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600, textAlign: 'left' }}>
              ↺ Return to Auto
            </button>
          )}
        </div>

        {/* Checkboxes */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginLeft: 'auto' }}>
          {[
            { field: 'email_sent',    label: 'Email Sent' },
            { field: 'ready_to_lock', label: 'Ready to Lock' },
            { field: 'locked',        label: 'Locked (ECW)' },
          ].map(({ field, label }) => (
            <label key={field} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.8rem', color: 'var(--gray-700)', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!session[field]}
                onChange={e => handleCheckbox(field, e.target.checked)}
                style={{ width: 14, height: 14, accentColor: 'var(--navy)' }} />
              {label}
            </label>
          ))}
        </div>

        {/* Cancel button */}
        {!isReadOnly && (
          <button className="btn btn-danger btn-xs" onClick={() => onCancel(session.id)}
            style={{ alignSelf: 'flex-start' }}>
            Cancel
          </button>
        )}
      </div>

      {/* SOAP Note */}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5, display: 'flex', gap: 8 }}>
          SOAP Note
          {saveState === 'saving' && <span style={{ color: 'var(--gold)', fontWeight: 500 }}>Saving…</span>}
          {saveState === 'saved'  && <span style={{ color: '#10b981', fontWeight: 500 }}>✓ Saved</span>}
        </div>
        <textarea className="form-textarea"
          value={soapNote}
          onChange={e => handleNoteChange(e.target.value)}
          placeholder="Subjective · Objective · Assessment · Plan…"
          disabled={false} // always editable per spec
          style={{ minHeight: 72, fontSize: '0.875rem', background: isReadOnly ? '#fafafa' : 'white' }}
        />
      </div>
    </div>
  );
}

// ── Bulk Notes Modal ──────────────────────────────────────────
function BulkNotesModal({ groupId, sessionCount, onClose, onDone }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await api.bulkNotes(groupId, text);
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 600 }}>
        <div className="modal-header">
          <h3>Bulk Upload Notes</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        {result ? (
          <div className="modal-body">
            <div className="alert alert-success">
              ✅ Updated {result.updated} of {result.total_sessions} sessions
              {result.total_chunks !== result.updated && ` (${result.total_chunks} chunks parsed)`}
            </div>
            <button className="btn btn-gold" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
              onClick={onDone}>Done</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="modal-body">
              {error && <div className="alert alert-error">{error}</div>}
              <p style={{ fontSize: '0.85rem', color: 'var(--gray-600)', marginBottom: 12 }}>
                Paste notes for multiple sessions separated by <code style={{ background: 'var(--gray-100)', padding: '1px 5px', borderRadius: 3 }}>---</code> on its own line.
                Notes will be assigned to sessions in order (cancelled sessions are skipped).
                You have <strong>{sessionCount}</strong> active sessions.
              </p>
              <textarea className="form-textarea"
                value={text} onChange={e => setText(e.target.value)}
                placeholder={"Session 1 SOAP note here...\n---\nSession 2 SOAP note here...\n---\nSession 3 SOAP note here..."}
                style={{ minHeight: 280, fontFamily: 'monospace', fontSize: '0.85rem' }}
                required
              />
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-gold" disabled={loading}>
                {loading ? 'Uploading…' : 'Upload Notes'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ── Group Detail Page ─────────────────────────────────────────
export default function GroupDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [group, setGroup]     = useState(null);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');
  const [showEditGroup, setShowEditGroup]   = useState(false);
  const [showBulkNotes, setShowBulkNotes]   = useState(false);

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

  async function handleCancel(sessionId) {
    if (!window.confirm('Cancel this session? A replacement session will be added at the end.')) return;
    try {
      await api.cancelSession(sessionId);
      setSuccess('Session cancelled — replacement added at end.');
      load();
    } catch (err) { setError(err.message); }
  }

  async function handleEndGroup() {
    if (!window.confirm('End this group? All remaining scheduled sessions will be marked as Group Ended.')) return;
    try {
      await api.endGroup(id);
      setSuccess('Group ended. All remaining sessions marked as Group Ended.');
      load();
    } catch (err) { setError(err.message); }
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

  const dow     = group.day_of_week_int ?? DAY_NAMES.indexOf(group.day_of_week);
  const dayName = DAY_NAMES[dow] || group.day_of_week || '';

  const stats = {
    total:      sessions.length,
    scheduled:  sessions.filter(s => s.status === 'scheduled').length,
    completed:  sessions.filter(s => s.status === 'completed').length,
    cancelled:  sessions.filter(s => s.status === 'cancelled').length,
    groupEnded: sessions.filter(s => s.status === 'group_ended').length,
    locked:     sessions.filter(s => s.locked).length,
  };

  const activeSessions = sessions.filter(s => s.status !== 'cancelled').length;

  return (
    <div>
      <button className="back-link" onClick={() => navigate('/')}>← Back to Dashboard</button>

      <div className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
            <h2>{group.group_name || group.name}</h2>
            <span className={`badge badge-${group.status}`}>{group.status}</span>
            {group.archived && <span className="badge badge-cancelled">Archived</span>}
          </div>
          {group.internal_name && group.internal_name !== (group.group_name || group.name) && (
            <div style={{ fontSize: '0.8rem', color: 'var(--gray-400)', marginBottom: 4 }}>
              Internal: {group.internal_name}
            </div>
          )}
          <p style={{ fontSize: '0.875rem', color: 'var(--gray-600)' }}>
            {dayName}s · {fmt12(group.start_time || group.session_time)} – {fmt12(group.end_time)}
            {group.ecw_time && <> · ECW {fmt12(group.ecw_time)}</>}
            {' '}· {group.default_duration || 45} min · {supervisorName}
          </p>
          {group.start_date && (
            <p style={{ fontSize: '0.8rem', color: 'var(--gray-400)' }}>
              {new Date(group.start_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              {group.end_date && ` → ${new Date(group.end_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
              {' '}· {group.total_sessions} sessions
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <button className="btn btn-outline btn-sm" onClick={() => setShowBulkNotes(true)}>📋 Bulk Notes</button>
          <button className="btn btn-outline btn-sm" onClick={() => setShowEditGroup(true)}>Edit Group</button>
          {isAdmin && group.status !== 'completed' && (
            <button className="btn btn-danger btn-sm" onClick={handleEndGroup}>End Group</button>
          )}
          {!group.archived && (
            <button className="btn btn-outline btn-sm" onClick={handleArchive}
              style={{ color: 'var(--gray-500)' }}>Archive</button>
          )}
        </div>
      </div>

      {error   && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      {/* Group SOAP Notes */}
      {(group.group_soap_notes || true) && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-header">
            <h3 style={{ fontSize: '0.95rem', color: 'var(--navy)' }}>Group Notes</h3>
          </div>
          <div style={{ padding: '12px 24px' }}>
            <textarea className="form-textarea"
              defaultValue={group.group_soap_notes || ''}
              placeholder="Group-level clinical notes…"
              style={{ minHeight: 64, fontSize: '0.875rem' }}
              onBlur={async e => {
                if (e.target.value !== (group.group_soap_notes || '')) {
                  await api.updateGroup(id, { group_soap_notes: e.target.value });
                  setGroup(g => ({ ...g, group_soap_notes: e.target.value }));
                }
              }}
            />
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="stats-row" style={{ marginBottom: 24 }}>
        <div className="stat-card"><div className="stat-value">{stats.total}</div><div className="stat-label">Total</div></div>
        <div className="stat-card"><div className="stat-value">{stats.scheduled}</div><div className="stat-label">Scheduled</div></div>
        <div className="stat-card"><div className="stat-value">{stats.completed}</div><div className="stat-label">Completed</div></div>
        <div className="stat-card"><div className="stat-value">{stats.locked}</div><div className="stat-label">Locked</div></div>
        <div className="stat-card"><div className="stat-value">{stats.cancelled}</div><div className="stat-label">Cancelled</div></div>
        {stats.groupEnded > 0 && (
          <div className="stat-card"><div className="stat-value">{stats.groupEnded}</div><div className="stat-label">Group Ended</div></div>
        )}
      </div>

      {/* Sessions */}
      <div className="card">
        <div className="card-header">
          <h3 style={{ fontSize: '1rem', color: 'var(--navy)' }}>Sessions</h3>
          <span style={{ fontSize: '0.78rem', color: 'var(--gray-400)' }}>SOAP notes auto-save · Click dates/times to edit</span>
        </div>
        <div style={{ padding: '16px 20px' }}>
          {sessions.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">📅</div><p>No sessions yet.</p></div>
          ) : (
            sessions.map(session => (
              <SessionRow
                key={session.id}
                session={session}
                groupDuration={group.default_duration || 45}
                onUpdate={handleSessionUpdate}
                onCancel={handleCancel}
              />
            ))
          )}
        </div>
      </div>

      {showEditGroup && (
        <EditGroupModal group={group} onClose={() => setShowEditGroup(false)}
          onSaved={() => { setShowEditGroup(false); setSuccess('Group updated.'); load(); }} />
      )}

      {showBulkNotes && (
        <BulkNotesModal groupId={id} sessionCount={activeSessions}
          onClose={() => setShowBulkNotes(false)}
          onDone={() => { setShowBulkNotes(false); load(); }} />
      )}
    </div>
  );
}

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

// Status colors
const STATUS_STYLE = {
  scheduled:   { bg: '#dbeafe', color: '#1e40af', border: '#93c5fd' },
  completed:   { bg: '#dcfce7', color: '#166534', border: '#86efac' },
  cancelled:   { bg: '#f3f4f6', color: '#6b7280', border: '#d1d5db' },
  group_ended: { bg: '#fef3c7', color: '#92400e', border: '#fcd34d' },
};
const STATUS_LABELS = {
  scheduled: 'Scheduled', completed: 'Completed',
  cancelled: 'Cancelled', group_ended: 'Group Ended',
};

// ── Session Row ───────────────────────────────────────────────
function SessionRow({ session, groupDuration, onUpdate, onCancel }) {
  const [soapNote, setSoapNote]   = useState(session.soap_note || session.notes || '');
  const [saveState, setSaveState] = useState('idle');
  const saveTimer = useRef(null);
  const [editDate, setEditDate]   = useState(false);
  const [editTime, setEditTime]   = useState(false);
  const [localDate, setLocalDate] = useState(session.session_date || session.scheduled_date || '');
  const [localTime, setLocalTime] = useState((session.start_time || session.scheduled_time || '').slice(0,5));
  const [localDur,  setLocalDur]  = useState(String(session.duration || groupDuration || 45));

  // Keep soap note in sync if parent refreshes
  useEffect(() => {
    setSoapNote(session.soap_note || session.notes || '');
  }, [session.soap_note, session.notes]);

  const isCancelled  = session.status === 'cancelled';
  const isGroupEnded = session.status === 'group_ended';
  const isReadOnly   = isCancelled || isGroupEnded;
  const style        = STATUS_STYLE[session.status] || STATUS_STYLE.scheduled;

  function handleNoteChange(val) {
    setSoapNote(val);
    setSaveState('saving');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const updated = await api.updateSession(session.id, { soap_note: val });
        // Update parent in place — no reload needed
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
    setEditDate(false);
    if (localDate === (session.session_date || session.scheduled_date)) return;
    const updated = await api.updateSession(session.id, { session_date: localDate });
    onUpdate(updated);
  }

  async function saveTime() {
    setEditTime(false);
    const dur = parseInt(localDur) || groupDuration || 45;
    const updated = await api.updateSession(session.id, { start_time: localTime, duration: dur });
    onUpdate(updated);
  }

  return (
    <div style={{
      background: 'white',
      border: `1px solid ${style.border}`,
      borderLeft: `5px solid ${style.border}`,
      borderRadius: 'var(--radius)',
      padding: '14px 18px',
      marginBottom: 10,
      opacity: isReadOnly ? 0.75 : 1,
    }}>
      {/* Top row */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* # + date + time */}
        <div style={{ minWidth: 130 }}>
          <div style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '0.9rem', marginBottom: 3 }}>
            #{session.session_number}
            {session.session_day_of_week != null && (
              <span style={{ fontWeight: 400, color: 'var(--gray-400)', marginLeft: 6, fontSize: '0.78rem' }}>
                {DAY_NAMES[session.session_day_of_week]}
              </span>
            )}
          </div>

          {/* Date */}
          {editDate ? (
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              <input type="date" className="form-input" style={{ padding: '3px 6px', fontSize: '0.78rem', width: 130 }}
                value={localDate} onChange={e => setLocalDate(e.target.value)} autoFocus />
              <button className="btn btn-gold btn-xs" type="button" onClick={saveDate}>✓</button>
              <button className="btn btn-outline btn-xs" type="button" onClick={() => setEditDate(false)}>✕</button>
            </div>
          ) : (
            <div style={{ fontSize: '0.8rem', color: 'var(--gray-600)', cursor: isReadOnly ? 'default' : 'pointer' }}
              onClick={() => !isReadOnly && setEditDate(true)}
              title={isReadOnly ? '' : 'Click to change date'}>
              {fmtDate(session.session_date || session.scheduled_date)}
              {!isReadOnly && <span style={{ color: 'var(--gray-300)', marginLeft: 4, fontSize: '0.7rem' }}>✏</span>}
            </div>
          )}

          {/* Time + duration */}
          {editTime ? (
            <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
              <input type="time" className="form-input" style={{ padding: '3px 6px', fontSize: '0.78rem', width: 100 }}
                value={localTime} onChange={e => setLocalTime(e.target.value)} />
              <input type="number" className="form-input" style={{ padding: '3px 6px', fontSize: '0.78rem', width: 64 }}
                value={localDur} onChange={e => setLocalDur(e.target.value)} placeholder="min" />
              <button className="btn btn-gold btn-xs" type="button" onClick={saveTime}>✓</button>
              <button className="btn btn-outline btn-xs" type="button" onClick={() => setEditTime(false)}>✕</button>
            </div>
          ) : (
            <div style={{ fontSize: '0.78rem', color: 'var(--gray-400)', cursor: isReadOnly ? 'default' : 'pointer', marginTop: 2 }}
              onClick={() => !isReadOnly && setEditTime(true)}
              title={isReadOnly ? '' : 'Click to change time/duration'}>
              {fmt12(session.start_time || session.scheduled_time)}
              {' · '}{session.duration || groupDuration || 45} min
              {!isReadOnly && <span style={{ color: 'var(--gray-300)', marginLeft: 4, fontSize: '0.7rem' }}>✏</span>}
            </div>
          )}
        </div>

        {/* Status dropdown — colored */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase' }}>Status</label>
          <select
            value={session.status}
            disabled={isReadOnly}
            onChange={e => handleStatusChange(e.target.value)}
            style={{
              padding: '5px 10px', fontSize: '0.82rem', width: 138, borderRadius: 'var(--radius)',
              border: `1.5px solid ${style.border}`,
              background: style.bg, color: style.color,
              fontWeight: 600, cursor: isReadOnly ? 'default' : 'pointer',
              appearance: 'none', WebkitAppearance: 'none',
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='${encodeURIComponent(style.color)}' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center',
              paddingRight: 28,
            }}
          >
            {Object.entries(STATUS_LABELS).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
          {session.status_manual_override && !isReadOnly && (
            <button type="button" onClick={handleReturnToAuto}
              style={{ fontSize: '0.7rem', color: 'var(--gold)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600, textAlign: 'left' }}>
              ↺ Return to Auto
            </button>
          )}
        </div>

        {/* Checkboxes */}
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginLeft: 'auto' }}>
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

        {/* Cancel */}
        {!isReadOnly && (
          <button type="button" className="btn btn-danger btn-xs" onClick={() => onCancel(session.id)}
            style={{ alignSelf: 'flex-start' }}>
            Cancel
          </button>
        )}
      </div>

      {/* SOAP Note */}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5, display: 'flex', gap: 8, alignItems: 'center' }}>
          SOAP Note
          {saveState === 'saving' && <span style={{ color: 'var(--gold)', fontWeight: 500, fontSize: '0.72rem' }}>Saving…</span>}
          {saveState === 'saved'  && <span style={{ color: '#10b981', fontWeight: 500, fontSize: '0.72rem' }}>✓ Saved</span>}
        </div>
        <textarea className="form-textarea"
          value={soapNote}
          onChange={e => handleNoteChange(e.target.value)}
          placeholder="Subjective · Objective · Assessment · Plan…"
          style={{ minHeight: 72, fontSize: '0.875rem', background: isReadOnly ? '#fafafa' : 'white' }}
        />
      </div>
    </div>
  );
}

// ── Bulk Notes Modal ──────────────────────────────────────────
function BulkNotesModal({ groupId, sessionCount, onClose, onDone }) {
  const [text, setText]     = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await api.bulkNotes(groupId, text);
      setResult(res);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
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
            </div>
            <button className="btn btn-gold" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
              onClick={onDone}>Done</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="modal-body">
              {error && <div className="alert alert-error">{error}</div>}
              <p style={{ fontSize: '0.85rem', color: 'var(--gray-600)', marginBottom: 12 }}>
                Paste notes separated by <code style={{ background: 'var(--gray-100)', padding: '1px 6px', borderRadius: 3 }}>---</code> on its own line.
                Assigned in session order, cancelled sessions skipped. <strong>{sessionCount}</strong> active sessions.
              </p>
              <textarea className="form-textarea" value={text} onChange={e => setText(e.target.value)}
                placeholder={"Session 1 notes...\n---\nSession 2 notes...\n---\nSession 3 notes..."}
                style={{ minHeight: 260, fontFamily: 'monospace', fontSize: '0.85rem' }} required />
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

// ── Main Page ─────────────────────────────────────────────────
export default function GroupDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [group,    setGroup]    = useState(null);
  const [sessions, setSessions] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const [showBulk, setShowBulk] = useState(false);

  const load = useCallback(async () => {
    try {
      const [g, s] = await Promise.all([api.getGroup(id), api.getSessions(id)]);
      setGroup(g);
      setSessions(s);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Update a single session in state without reloading everything
  function handleSessionUpdate(updated) {
    setSessions(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s));
  }

  async function handleCancel(sessionId) {
    if (!window.confirm('Cancel this session? A replacement will be added at the end.')) return;
    try {
      await api.cancelSession(sessionId);
      setSuccess('Session cancelled — replacement added at end.');
      load(); // reload to get new session
    } catch (err) { setError(err.message); }
  }

  async function handleEndGroup() {
    if (!window.confirm('End this group? All remaining scheduled sessions will be marked Group Ended.')) return;
    try { await api.endGroup(id); setSuccess('Group ended.'); load(); }
    catch (err) { setError(err.message); }
  }

  async function handleUnendGroup() {
    if (!window.confirm('Re-open this group? Group Ended sessions will return to Scheduled.')) return;
    try { await api.unendGroup(id); setSuccess('Group re-opened.'); load(); }
    catch (err) { setError(err.message); }
  }

  async function handleArchive() {
    if (!window.confirm('Archive this group?')) return;
    try { await api.archiveGroup(id); navigate('/'); }
    catch (err) { setError(err.message); }
  }

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (!group)  return <div className="alert alert-error" style={{ margin: 24 }}>Group not found.</div>;

  const supervisorName  = group.supervisor
    ? `${group.supervisor.first_name} ${group.supervisor.last_name}`.trim() : 'Unassigned';
  const instructorName  = group.instructor
    ? `${group.instructor.first_name} ${group.instructor.last_name}`.trim() : null;
  const dow     = group.day_of_week_int ?? DAY_NAMES.indexOf(group.day_of_week);
  const dayName = DAY_NAMES[dow] || group.day_of_week || '';
  const isEnded = group.status === 'completed';

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

      {/* Header */}
      <div className="page-header">
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0 }}>{group.group_name || group.name}</h2>
            <span className={`badge badge-${group.status}`}>{group.status}</span>
            {group.archived && <span className="badge badge-cancelled">Archived</span>}
          </div>

          {/* Internal name */}
          {group.internal_name && group.internal_name !== (group.group_name || group.name) && (
            <div style={{ fontSize: '0.8rem', color: 'var(--gray-400)', marginBottom: 6 }}>
              Internal: <strong>{group.internal_name}</strong>
            </div>
          )}

          {/* Description */}
          {group.description && (
            <div style={{ fontSize: '0.875rem', color: 'var(--gray-600)', marginBottom: 8, maxWidth: 600 }}>
              {group.description}
            </div>
          )}

          {/* Schedule meta */}
          <div style={{ fontSize: '0.85rem', color: 'var(--gray-600)', display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
            <span>📅 {dayName}s</span>
            <span>🕐 {fmt12(group.start_time || group.session_time)} – {fmt12(group.end_time)}</span>
            {group.ecw_time && <span>ECW {fmt12(group.ecw_time)}</span>}
            <span>⏱ {group.default_duration || 45} min</span>
            {group.start_date && (
              <span>
                {new Date(group.start_date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
                {group.end_date && ` → ${new Date(group.end_date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`}
              </span>
            )}
            {group.total_sessions && <span>{group.total_sessions} sessions</span>}
          </div>

          {/* People */}
          <div style={{ fontSize: '0.82rem', color: 'var(--gray-500)', marginTop: 6, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>👤 Supervisor: {supervisorName}</span>
            {instructorName && <span>🎓 Instructor: {instructorName}</span>}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <button className="btn btn-outline btn-sm" onClick={() => setShowBulk(true)}>📋 Bulk Notes</button>
          <button className="btn btn-outline btn-sm" onClick={() => setShowEdit(true)}>Edit Group</button>
          {isAdmin && !isEnded && (
            <button className="btn btn-danger btn-sm" onClick={handleEndGroup}>End Group</button>
          )}
          {isAdmin && isEnded && (
            <button className="btn btn-outline btn-sm" onClick={handleUnendGroup}
              style={{ borderColor: '#10b981', color: '#10b981' }}>
              Re-open Group
            </button>
          )}
          {!group.archived && (
            <button className="btn btn-outline btn-sm" onClick={handleArchive}
              style={{ color: 'var(--gray-400)' }}>Archive</button>
          )}
        </div>
      </div>

      {error   && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      {/* Stats */}
      <div className="stats-row" style={{ marginBottom: 24 }}>
        <div className="stat-card"><div className="stat-value">{stats.total}</div><div className="stat-label">Total</div></div>
        <div className="stat-card"><div className="stat-value" style={{ color: STATUS_STYLE.scheduled.color }}>{stats.scheduled}</div><div className="stat-label">Scheduled</div></div>
        <div className="stat-card"><div className="stat-value" style={{ color: STATUS_STYLE.completed.color }}>{stats.completed}</div><div className="stat-label">Completed</div></div>
        <div className="stat-card"><div className="stat-value">{stats.locked}</div><div className="stat-label">Locked</div></div>
        <div className="stat-card"><div className="stat-value" style={{ color: STATUS_STYLE.cancelled.color }}>{stats.cancelled}</div><div className="stat-label">Cancelled</div></div>
        {stats.groupEnded > 0 && (
          <div className="stat-card"><div className="stat-value" style={{ color: STATUS_STYLE.group_ended.color }}>{stats.groupEnded}</div><div className="stat-label">Group Ended</div></div>
        )}
      </div>

      {/* Sessions */}
      <div className="card">
        <div className="card-header">
          <h3 style={{ fontSize: '1rem', color: 'var(--navy)' }}>Sessions</h3>
          <span style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>SOAP notes auto-save · Click date or time to edit</span>
        </div>
        <div style={{ padding: '16px 20px' }}>
          {sessions.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">📅</div><p>No sessions yet.</p></div>
          ) : sessions.map(session => (
            <SessionRow
              key={session.id}
              session={session}
              groupDuration={group.default_duration || 45}
              onUpdate={handleSessionUpdate}
              onCancel={handleCancel}
            />
          ))}
        </div>
      </div>

      {showEdit && (
        <EditGroupModal group={group} onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); setSuccess('Group updated.'); load(); }} />
      )}
      {showBulk && (
        <BulkNotesModal groupId={id} sessionCount={activeSessions}
          onClose={() => setShowBulk(false)}
          onDone={() => { setShowBulk(false); load(); }} />
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import SubmitNotesModal from '../components/supervisor/SubmitNotesModal';
import EditSessionModal from '../components/shared/EditSessionModal';
import EditGroupModal from '../components/admin/EditGroupModal';

function SessionStatusBadge({ session }) {
  if (session.locked_at) return <span className="badge badge-locked">🔒 Locked</span>;
  if (session.ready_to_lock_at) return <span className="badge badge-ready">⏳ Ready to Lock</span>;
  return <span className={`badge badge-${session.status}`}>{session.status}</span>;
}

export default function GroupDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [group, setGroup] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [notesSession, setNotesSession] = useState(null);
  const [editSession, setEditSession] = useState(null);
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

  async function handleLock(sessionId) {
    try {
      await api.lockSession(sessionId);
      setSuccess('Session locked successfully.');
      load();
    } catch (err) { setError(err.message); }
  }

  async function handleCancel(sessionId) {
    if (!window.confirm('Cancel this session?')) return;
    try {
      await api.cancelSession(sessionId);
      setSuccess('Session cancelled.');
      load();
    } catch (err) { setError(err.message); }
  }

  async function handleStopGroup() {
    if (!window.confirm('Stop this group? This cannot be undone easily.')) return;
    try {
      await api.updateGroup(id, { status: 'stopped' });
      setSuccess('Group has been stopped.');
      load();
    } catch (err) { setError(err.message); }
  }

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (!group) return <div className="alert alert-error">Group not found.</div>;

  const supervisorName = group.supervisor
    ? `${group.supervisor.first_name} ${group.supervisor.last_name}`.trim()
    : 'Unassigned';

  const completedCount = sessions.filter(s => s.status === 'completed').length;
  const lockedCount = sessions.filter(s => s.locked_at).length;

  return (
    <div>
      <button className="back-link" onClick={() => navigate('/')}>← Back to Dashboard</button>

      <div className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
            <h2>{group.name}</h2>
            <span className={`badge badge-${group.status}`}>{group.status}</span>
          </div>
          <p>
            {group.day_of_week}s at {group.session_time?.slice(0, 5)} ·
            Supervisor: {supervisorName} ·
            {group.total_sessions} sessions total
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          {isAdmin && group.status === 'active' && (
            <>
              <button className="btn btn-outline btn-sm" onClick={() => setShowEditGroup(true)}>Edit Group</button>
              <button className="btn btn-danger btn-sm" onClick={handleStopGroup}>Stop Group</button>
            </>
          )}
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      <div className="stats-row" style={{ marginBottom: '24px' }}>
        <div className="stat-card">
          <div className="stat-value">{sessions.length}</div>
          <div className="stat-label">Total Sessions</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{completedCount}</div>
          <div className="stat-label">Completed</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{lockedCount}</div>
          <div className="stat-label">Locked</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{sessions.filter(s => s.status === 'cancelled').length}</div>
          <div className="stat-label">Cancelled</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 style={{ fontSize: '1.1rem', color: 'var(--navy)' }}>Sessions</h3>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="sessions-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Date</th>
                <th>Time</th>
                <th>Status</th>
                <th>Notes</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map(session => (
                <tr key={session.id} className={session.locked_at ? 'session-row-locked' : ''}>
                  <td style={{ fontWeight: 600, color: 'var(--navy)' }}>#{session.session_number}</td>
                  <td>{new Date(session.scheduled_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  <td>{session.scheduled_time?.slice(0, 5)}</td>
                  <td><SessionStatusBadge session={session} /></td>
                  <td>
                    {session.notes
                      ? <span className="notes-preview" title={session.notes}>{session.notes}</span>
                      : <span style={{ color: 'var(--gray-400)', fontSize: '0.8rem' }}>—</span>
                    }
                  </td>
                  <td>
                    <div className="session-actions">
                      {!session.locked_at && session.status !== 'cancelled' && (
                        <button className="btn btn-outline btn-xs" onClick={() => setEditSession(session)}>
                          Edit Time
                        </button>
                      )}
                      {!session.locked_at && session.status !== 'cancelled' && (
                        <button className="btn btn-primary btn-xs" onClick={() => setNotesSession(session)}>
                          {session.notes ? 'Edit Notes' : 'Submit Notes'}
                        </button>
                      )}
                      {session.ready_to_lock_at && !session.locked_at && (
                        <button className="btn btn-gold btn-xs" onClick={() => handleLock(session.id)}>
                          🔒 Lock
                        </button>
                      )}
                      {!session.locked_at && session.status === 'scheduled' && (
                        <button className="btn btn-danger btn-xs" onClick={() => handleCancel(session.id)}>
                          Cancel
                        </button>
                      )}
                      {session.locked_at && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>
                          Locked {new Date(session.locked_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {notesSession && (
        <SubmitNotesModal
          session={notesSession}
          onClose={() => setNotesSession(null)}
          onSubmitted={() => { setNotesSession(null); setSuccess('Notes submitted and email sent!'); load(); }}
        />
      )}

      {editSession && (
        <EditSessionModal
          session={editSession}
          onClose={() => setEditSession(null)}
          onSaved={() => { setEditSession(null); setSuccess('Session updated.'); load(); }}
        />
      )}

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

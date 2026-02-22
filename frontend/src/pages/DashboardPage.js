import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import CreateGroupModal from '../components/admin/CreateGroupModal';

function getSessionStats(sessions = []) {
  return {
    total: sessions.length,
    completed: sessions.filter(s => s.status === 'completed').length,
    cancelled: sessions.filter(s => s.status === 'cancelled').length,
    locked: sessions.filter(s => s.locked_at).length,
  };
}

export default function DashboardPage() {
  const { profile, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [error, setError] = useState('');

  const loadGroups = useCallback(async () => {
    try {
      const data = await api.getGroups();
      setGroups(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadGroups(); }, [loadGroups]);

  const allStats = {
    groups: groups.length,
    active: groups.filter(g => g.status === 'active').length,
    sessions: groups.reduce((acc, g) => acc + (g.sessions?.length || 0), 0),
    completed: groups.reduce((acc, g) => acc + (g.sessions?.filter(s => s.status === 'completed').length || 0), 0),
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Welcome back, {profile?.first_name || profile?.email}</h2>
          <p>{isAdmin ? 'All groups across the platform' : 'Your assigned groups'}</p>
        </div>
        {isAdmin && (
          <button className="btn btn-gold" onClick={() => setShowCreateModal(true)}>
            + New Group
          </button>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {isAdmin && (
        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-value">{allStats.groups}</div>
            <div className="stat-label">Total Groups</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{allStats.active}</div>
            <div className="stat-label">Active</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{allStats.sessions}</div>
            <div className="stat-label">Total Sessions</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{allStats.completed}</div>
            <div className="stat-label">Completed</div>
          </div>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📋</div>
          <p>{isAdmin ? 'No groups yet. Create one to get started.' : 'You have no groups assigned to you.'}</p>
        </div>
      ) : (
        <div className="groups-grid">
          {groups.map(group => {
            const stats = getSessionStats(group.sessions);
            const progress = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;
            const supervisorName = group.supervisor
              ? `${group.supervisor.first_name} ${group.supervisor.last_name}`.trim()
              : null;

            return (
              <div key={group.id} className="group-card" onClick={() => navigate(`/groups/${group.id}`)}>
                <div className="group-card-header">
                  <div>
                    <h3>{group.name}</h3>
                    <div className="group-card-meta">
                      {group.day_of_week}s at {group.session_time?.slice(0, 5)} · {group.total_sessions} sessions
                    </div>
                  </div>
                  <span className={`badge badge-${group.status}`}>{group.status}</span>
                </div>

                {supervisorName && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--gray-600)', marginBottom: '8px' }}>
                    👤 {supervisorName}
                  </div>
                )}

                <div className="group-progress">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${progress}%` }} />
                  </div>
                  <div className="progress-labels">
                    <span>{stats.completed} of {stats.total} completed</span>
                    <span>{progress}%</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showCreateModal && (
        <CreateGroupModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => { setShowCreateModal(false); loadGroups(); }}
        />
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import CreateGroupModal from '../components/admin/CreateGroupModal';

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function fmt12(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2,'0')} ${ampm}`;
}

function getSessionStats(sessions = []) {
  return {
    total: sessions.length,
    completed: sessions.filter(s => s.status === 'completed').length,
    locked: sessions.filter(s => s.locked_at).length,
  };
}

function GroupCard({ group, onClick }) {
  const stats = getSessionStats(group.sessions);
  const progress = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;

  return (
    <div className="group-card" onClick={onClick}>
      <div className="group-card-header">
        <div>
          <h3>{group.group_name || group.name}</h3>
          <div className="group-card-meta" style={{ marginTop: 2 }}>
            {fmt12(group.start_time || group.session_time)} – {fmt12(group.end_time)}
            {group.ecw_time && group.ecw_time !== group.start_time && (
              <span style={{ marginLeft: 8, color: 'var(--gold)', fontWeight: 600 }}>
                ECW {fmt12(group.ecw_time)}
              </span>
            )}
          </div>
          {group.internal_name && group.internal_name !== (group.group_name || group.name) && (
            <div style={{ fontSize: '0.75rem', color: 'var(--gray-400)', marginTop: 2 }}>
              {group.internal_name}
            </div>
          )}
        </div>
        <span className={`badge badge-${group.status}`}>{group.status}</span>
      </div>

      <div className="group-progress" style={{ marginTop: 12 }}>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="progress-labels">
          <span>{stats.completed} of {stats.total} sessions</span>
          <span>{progress}%</span>
        </div>
      </div>
    </div>
  );
}

// Admin view: groups within a day subdivided by supervisor
function AdminDaySection({ dayName, groups, navigate }) {
  // Group by supervisor
  const bySupervisor = {};
  for (const g of groups) {
    const supId = g.supervisor_id || 'unassigned';
    if (!bySupervisor[supId]) {
      bySupervisor[supId] = { supervisor: g.supervisor, groups: [] };
    }
    bySupervisor[supId].groups.push(g);
  }

  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
      }}>
        <h3 style={{
          fontFamily: "'DM Serif Display', serif",
          fontSize: '1.3rem',
          color: 'var(--navy)',
        }}>{dayName}</h3>
        <div style={{ flex: 1, height: 1, background: 'var(--gray-200)' }} />
        <span style={{ fontSize: '0.78rem', color: 'var(--gray-400)', fontWeight: 600 }}>
          {groups.length} group{groups.length !== 1 ? 's' : ''}
        </span>
      </div>

      {Object.entries(bySupervisor).map(([supId, { supervisor, groups: supGroups }]) => {
        const supName = supervisor
          ? `${supervisor.first_name} ${supervisor.last_name}`.trim()
          : 'Unassigned';
        return (
          <div key={supId} style={{ marginBottom: 20 }}>
            <div style={{
              fontSize: '0.78rem',
              fontWeight: 700,
              color: 'var(--gray-600)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: 10,
              paddingLeft: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <span style={{
                width: 24, height: 24, borderRadius: '50%',
                background: 'var(--navy)', color: 'white',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.65rem', fontWeight: 700, flexShrink: 0,
              }}>
                {supName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0,2)}
              </span>
              {supName}
            </div>
            <div className="groups-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
              {supGroups.map(g => (
                <GroupCard key={g.id} group={g} onClick={() => navigate(`/groups/${g.id}`)} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Supervisor view: groups within a day, no supervisor subdivision
function SupervisorDaySection({ dayName, groups, navigate }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h3 style={{
          fontFamily: "'DM Serif Display', serif",
          fontSize: '1.3rem',
          color: 'var(--navy)',
        }}>{dayName}</h3>
        <div style={{ flex: 1, height: 1, background: 'var(--gray-200)' }} />
        <span style={{ fontSize: '0.78rem', color: 'var(--gray-400)', fontWeight: 600 }}>
          {groups.length} group{groups.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="groups-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {groups.map(g => (
          <GroupCard key={g.id} group={g} onClick={() => navigate(`/groups/${g.id}`)} />
        ))}
      </div>
    </div>
  );
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

  // Group by day_of_week_int, Sunday (0) → Saturday (6)
  const byDay = {};
  for (const g of groups) {
    const dow = g.day_of_week_int ?? DAY_NAMES.indexOf(g.day_of_week);
    if (!byDay[dow]) byDay[dow] = [];
    byDay[dow].push(g);
  }

  const allStats = {
    groups: groups.length,
    active: groups.filter(g => g.status === 'active').length,
    sessions: groups.reduce((a, g) => a + (g.sessions?.length || 0), 0),
    completed: groups.reduce((a, g) => a + (g.sessions?.filter(s => s.status === 'completed').length || 0), 0),
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Welcome back, {profile?.first_name || profile?.email}</h2>
          <p>{isAdmin ? 'All groups across the platform' : 'Your assigned groups'}</p>
        </div>
        <button className="btn btn-gold" onClick={() => setShowCreateModal(true)}>
          + New Group
        </button>
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
        // Render days in Sun(0) → Sat(6) order, skip empty days
        [0,1,2,3,4,5,6].filter(d => byDay[d]?.length > 0).map(dow => (
          isAdmin
            ? <AdminDaySection
                key={dow}
                dayName={DAY_NAMES[dow]}
                groups={byDay[dow]}
                navigate={navigate}
              />
            : <SupervisorDaySection
                key={dow}
                dayName={DAY_NAMES[dow]}
                groups={byDay[dow]}
                navigate={navigate}
              />
        ))
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

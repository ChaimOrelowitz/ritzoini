import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import CreateGroupModal from '../components/admin/CreateGroupModal';

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function GroupCard({ group, onClick }) {
  const sessions = group.sessions || [];
  const total     = sessions.length;
  const completed = sessions.filter(s => s.status === 'completed').length;
  const progress  = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="group-card" onClick={onClick}>
      <div className="group-card-header">
        <div>
          <h3>{group.group_name || group.name}</h3>
          <div className="group-card-meta" style={{ marginTop: 2 }}>
            {fmt12(group.start_time || group.session_time)} – {fmt12(group.end_time)}
            {group.ecw_time && group.ecw_time !== (group.start_time || group.session_time) && (
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
          {group.total_sessions && (
            <div style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>
              {group.total_sessions} sessions · {group.default_duration || 45} min
            </div>
          )}
        </div>
        <span className={`badge badge-${group.status}`}>{group.status}</span>
      </div>
      <div className="group-progress" style={{ marginTop: 10 }}>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="progress-labels">
          <span>{completed} of {total} sessions</span>
          <span>{progress}%</span>
        </div>
      </div>
    </div>
  );
}

function AdminDaySection({ dayName, groups, navigate }) {
  const bySupervisor = {};
  for (const g of groups) {
    const supId = g.supervisor_id || 'unassigned';
    if (!bySupervisor[supId]) bySupervisor[supId] = { supervisor: g.supervisor, groups: [] };
    bySupervisor[supId].groups.push(g);
  }
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h3 style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.25rem', color: 'var(--navy)' }}>{dayName}</h3>
        <div style={{ flex: 1, height: 1, background: 'var(--gray-200)' }} />
        <span style={{ fontSize: '0.75rem', color: 'var(--gray-400)', fontWeight: 600 }}>
          {groups.length} group{groups.length !== 1 ? 's' : ''}
        </span>
      </div>
      {Object.entries(bySupervisor).map(([supId, { supervisor, groups: sg }]) => {
        const name = supervisor ? `${supervisor.first_name} ${supervisor.last_name}`.trim() : 'Unassigned';
        return (
          <div key={supId} style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, paddingLeft: 4 }}>
              <span style={{
                width: 24, height: 24, borderRadius: '50%', background: 'var(--navy)', color: 'white',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.65rem', fontWeight: 700, flexShrink: 0,
              }}>
                {name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0,2)}
              </span>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--gray-600)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                {name}
              </span>
            </div>
            <div className="groups-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
              {sg.map(g => <GroupCard key={g.id} group={g} onClick={() => navigate(`/groups/${g.id}`)} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SupervisorDaySection({ dayName, groups, navigate }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h3 style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.25rem', color: 'var(--navy)' }}>{dayName}</h3>
        <div style={{ flex: 1, height: 1, background: 'var(--gray-200)' }} />
      </div>
      <div className="groups-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {groups.map(g => <GroupCard key={g.id} group={g} onClick={() => navigate(`/groups/${g.id}`)} />)}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { profile, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [groups, setGroups]           = useState([]);
  const [loading, setLoading]         = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [showCreate, setShowCreate]   = useState(false);
  const [error, setError]             = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getGroups(showArchived);
      setGroups(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [showArchived]);

  useEffect(() => { load(); }, [load]);

  const byDay = {};
  for (const g of groups) {
    const dow = g.day_of_week_int ?? DAY_NAMES.indexOf(g.day_of_week);
    if (!byDay[dow]) byDay[dow] = [];
    byDay[dow].push(g);
  }

  const stats = {
    groups:    groups.length,
    active:    groups.filter(g => !g.archived && g.status !== 'completed').length,
    sessions:  groups.reduce((a, g) => a + (g.sessions?.length || 0), 0),
    completed: groups.reduce((a, g) => a + (g.sessions?.filter(s => s.status === 'completed').length || 0), 0),
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Welcome back, {profile?.first_name || profile?.email}</h2>
          <p style={{ color: 'var(--gray-500)', fontSize: '0.875rem' }}>
            {showArchived ? 'Archived groups' : isAdmin ? 'All active groups' : 'Your assigned groups'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-outline btn-sm" onClick={() => setShowArchived(a => !a)}>
            {showArchived ? '← Active Groups' : 'View Archived'}
          </button>
          {isAdmin && (
            <button className="btn btn-gold" onClick={() => setShowCreate(true)}>+ New Group</button>
          )}
        </div>
      </div>

      {showArchived && (
        <div className="alert" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d', borderRadius: 'var(--radius)', padding: '10px 16px', marginBottom: 20, fontSize: '0.85rem' }}>
          📦 Showing archived groups
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {isAdmin && !showArchived && (
        <div className="stats-row">
          <div className="stat-card"><div className="stat-value">{stats.groups}</div><div className="stat-label">Groups</div></div>
          <div className="stat-card"><div className="stat-value">{stats.active}</div><div className="stat-label">Active</div></div>
          <div className="stat-card"><div className="stat-value">{stats.sessions}</div><div className="stat-label">Sessions</div></div>
          <div className="stat-card"><div className="stat-value">{stats.completed}</div><div className="stat-label">Completed</div></div>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">{showArchived ? '📦' : '📋'}</div>
          <p>{showArchived ? 'No archived groups.' : isAdmin ? 'No groups yet. Create one to get started.' : 'No groups assigned to you.'}</p>
        </div>
      ) : (
        [0,1,2,3,4,5,6]
          .filter(d => byDay[d]?.length > 0)
          .map(dow => isAdmin
            ? <AdminDaySection key={dow} dayName={DAY_NAMES[dow]} groups={byDay[dow]} navigate={navigate} />
            : <SupervisorDaySection key={dow} dayName={DAY_NAMES[dow]} groups={byDay[dow]} navigate={navigate} />
          )
      )}

      {showCreate && (
        <CreateGroupModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />
      )}
    </div>
  );
}

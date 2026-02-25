import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import CreateGroupModal from '../components/admin/CreateGroupModal';

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.slice(0,5).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function StatusDot({ status }) {
  const colors = {
    active:    '#10b981',
    completed: '#6b7280',
    stopped:   '#ef4444',
  };
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: colors[status] || '#d1d5db', marginRight: 6, flexShrink: 0,
    }} />
  );
}

function GroupCard({ group, onClick }) {
  const sessions   = group.sessions || [];
  const total      = sessions.filter(s => s.status !== 'cancelled').length;
  const completed  = sessions.filter(s => s.status === 'completed').length;
  const locked     = sessions.filter(s => s.locked).length;
  const progress   = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div onClick={onClick} style={{
      background: 'white', border: '1px solid var(--gray-200)',
      borderRadius: 'var(--radius)', padding: '12px 16px',
      cursor: 'pointer', transition: 'box-shadow 0.15s',
      display: 'flex', alignItems: 'center', gap: 14,
    }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)'}
      onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}
    >
      <StatusDot status={group.status} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: 'var(--navy)', fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {group.group_name || group.name}
        </div>
        <div style={{ fontSize: '0.78rem', color: 'var(--gray-500)', marginTop: 2 }}>
          {fmt12(group.ecw_time || group.start_time || group.session_time)}
          {group.ecw_end_time && ` – ${fmt12(group.ecw_end_time)}`}
          {group.instructor && ` · 🎓 ${group.instructor.first_name} ${group.instructor.last_name}`}
        </div>
        {total > 0 && (
          <div style={{ marginTop: 6 }}>
            <div style={{ background: 'var(--gray-100)', borderRadius: 4, height: 4, overflow: 'hidden' }}>
              <div style={{ width: `${progress}%`, background: 'var(--navy)', height: '100%', borderRadius: 4, transition: 'width 0.3s' }} />
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--gray-400)', marginTop: 2 }}>
              {completed}/{total} done · {locked} locked
            </div>
          </div>
        )}
      </div>
      <span className={`badge badge-${group.status}`} style={{ flexShrink: 0 }}>{group.status}</span>
    </div>
  );
}

// Collapsible supervisor section within a day
function SupervisorSection({ supervisorName, groups, navigate }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom: 10 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', textAlign: 'left', background: 'var(--gray-50)',
          border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
          padding: '7px 12px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: '0.82rem', color: 'var(--gray-600)', fontWeight: 600,
        }}
      >
        <span style={{ fontSize: '0.7rem', transition: 'transform 0.15s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
        👤 {supervisorName}
        <span style={{ marginLeft: 'auto', fontWeight: 400, color: 'var(--gray-400)' }}>
          {groups.length} group{groups.length !== 1 ? 's' : ''}
        </span>
      </button>
      {open && (
        <div style={{ paddingLeft: 12, paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {groups.map(g => (
            <GroupCard key={g.id} group={g} onClick={() => navigate(`/groups/${g.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

// Collapsible day section
function DaySection({ dayName, groups, isAdmin, navigate }) {
  const [open, setOpen] = useState(true);

  // Group by supervisor for admin view
  let content;
  if (isAdmin) {
    const bySupervisor = {};
    groups.forEach(g => {
      const name = g.supervisor
        ? `${g.supervisor.first_name} ${g.supervisor.last_name}`
        : 'Unassigned';
      if (!bySupervisor[name]) bySupervisor[name] = [];
      bySupervisor[name].push(g);
    });
    content = Object.entries(bySupervisor).sort(([a],[b]) => a.localeCompare(b)).map(([name, supGroups]) => (
      <SupervisorSection key={name} supervisorName={name} groups={supGroups} navigate={navigate} />
    ));
  } else {
    content = groups.map(g => (
      <GroupCard key={g.id} group={g} onClick={() => navigate(`/groups/${g.id}`)} />
    ));
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', textAlign: 'left',
          background: 'var(--navy)', color: 'white',
          border: 'none', borderRadius: 'var(--radius)',
          padding: '10px 16px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 10,
          fontSize: '0.95rem', fontWeight: 700, marginBottom: 8,
        }}
      >
        <span style={{ fontSize: '0.75rem', transition: 'transform 0.15s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
        {dayName}
        <span style={{ marginLeft: 'auto', fontSize: '0.8rem', fontWeight: 400, opacity: 0.8 }}>
          {groups.length} group{groups.length !== 1 ? 's' : ''}
        </span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: isAdmin ? 0 : 6, paddingLeft: 4 }}>
          {content}
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const { profile, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [groups, setGroups]           = useState([]);
  const [loading, setLoading]         = useState(true);
  const [showCreateModal, setShowCreate] = useState(false);
  const [showArchived, setShowArchived]  = useState(false);
  const [error, setError]             = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.getGroups(showArchived);
      setGroups(data);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [showArchived]);

  useEffect(() => { load(); }, [load]);

  // Group by day_of_week_int
  const byDay = {};
  groups.forEach(g => {
    const dow = g.day_of_week_int ?? DAY_NAMES.indexOf(g.day_of_week);
    const key = dow >= 0 ? dow : 7;
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push(g);
  });
  const sortedDays = Object.keys(byDay).map(Number).sort((a, b) => a - b);

  const stats = {
    total:     groups.length,
    active:    groups.filter(g => g.status === 'active').length,
    completed: groups.filter(g => g.status === 'completed').length,
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Welcome back, {profile?.first_name || profile?.email}</h2>
          <p>{isAdmin ? 'All groups' : 'Your groups'}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button
            className="btn btn-outline btn-sm"
            onClick={() => setShowArchived(a => !a)}
            style={{ color: showArchived ? 'var(--navy)' : 'var(--gray-400)' }}
          >
            {showArchived ? '← Active Groups' : 'View Archived'}
          </button>
          {isAdmin && !showArchived && (
            <button className="btn btn-gold" onClick={() => setShowCreate(true)}>+ New Group</button>
          )}
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {isAdmin && (
        <div className="stats-row" style={{ marginBottom: 24 }}>
          <div className="stat-card"><div className="stat-value">{stats.total}</div><div className="stat-label">Total Groups</div></div>
          <div className="stat-card"><div className="stat-value" style={{ color: '#10b981' }}>{stats.active}</div><div className="stat-label">Active</div></div>
          <div className="stat-card"><div className="stat-value" style={{ color: '#6b7280' }}>{stats.completed}</div><div className="stat-label">Completed</div></div>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📋</div>
          <p>{showArchived ? 'No archived groups.' : isAdmin ? 'No groups yet. Create one to get started.' : 'No groups assigned to you.'}</p>
        </div>
      ) : (
        <div>
          {sortedDays.map(dow => (
            <DaySection
              key={dow}
              dayName={DAY_NAMES[dow] || 'Unknown Day'}
              groups={byDay[dow]}
              isAdmin={isAdmin}
              navigate={navigate}
            />
          ))}
        </div>
      )}

      {showCreateModal && (
        <CreateGroupModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}

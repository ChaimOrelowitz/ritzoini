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
    archived:  '#d1d5db',
  };
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: colors[status] || '#d1d5db', marginRight: 6, flexShrink: 0,
    }} />
  );
}

function GroupCard({ group, onClick, onEndGroup, onToggleAi }) {
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
      position: 'relative',
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
      <div style={{ position: 'absolute', top: 6, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: '2px 10px' }}>
        {['Manual', 'AI'].map(mode => {
          const active = mode === 'AI' ? !!group.ai_notes : !group.ai_notes;
          return (
            <span
              key={mode}
              onClick={e => { e.stopPropagation(); if (!active) onToggleAi && onToggleAi(group.id, mode === 'AI'); }}
              style={{
                fontSize: '0.75rem', cursor: active ? 'default' : 'pointer',
                color: active ? 'var(--navy)' : 'var(--gray-400)',
                fontWeight: active ? 700 : 400,
              }}
            >{mode}</span>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
        {group.status === 'active' && onEndGroup && (
          <button
            onClick={e => { e.stopPropagation(); onEndGroup(group.id); }}
            style={{
              fontSize: '0.7rem', fontWeight: 600, padding: '3px 8px',
              background: 'transparent', border: '1px solid #ef4444',
              color: '#ef4444', borderRadius: 4, cursor: 'pointer',
              lineHeight: 1.4,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#fef2f2'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            End Group
          </button>
        )}
        <span className={`badge badge-${group.status}`}>{group.status}</span>
      </div>
    </div>
  );
}

// Collapsible supervisor section within a day
function SupervisorSection({ supervisorName, groups, navigate, onEndGroup, onToggleAi }) {
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
            <GroupCard key={g.id} group={g} onClick={() => navigate(`/groups/${g.id}`)} onEndGroup={onEndGroup} onToggleAi={onToggleAi} />
          ))}
        </div>
      )}
    </div>
  );
}

// Collapsible day section
function DaySection({ dayName, groups, isAdmin, navigate, onEndGroup, onToggleAi }) {
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
      <SupervisorSection key={name} supervisorName={name} groups={supGroups} navigate={navigate} onEndGroup={onEndGroup} onToggleAi={onToggleAi} />
    ));
  } else {
    content = groups.map(g => (
      <GroupCard key={g.id} group={g} onClick={() => navigate(`/groups/${g.id}`)} onEndGroup={onEndGroup} onToggleAi={onToggleAi} />
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

function BulkAssignModal({ groups, onClose, onDone }) {
  const [supervisors, setSupervisors] = useState([]);
  const [supervisorId, setSupervisorId] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getUsers().then(u => setSupervisors(u.filter(x => x.role === 'supervisor')));
  }, []);

  function toggleGroup(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(prev => prev.size === groups.length ? new Set() : new Set(groups.map(g => g.id)));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!supervisorId) { setError('Please select a supervisor.'); return; }
    if (selected.size === 0) { setError('Please select at least one group.'); return; }
    setLoading(true); setError('');
    try {
      await Promise.all([...selected].map(id => api.updateGroup(id, { supervisor_id: supervisorId })));
      onDone();
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 540 }}>
        <div className="modal-header">
          <h3>Bulk Assign Supervisor</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="alert alert-error">{error}</div>}
            <div className="form-group">
              <label className="form-label">Assign to Supervisor</label>
              <select className="form-select" value={supervisorId} onChange={e => setSupervisorId(e.target.value)}>
                <option value="">— Select supervisor —</option>
                {supervisors.map(s => (
                  <option key={s.id} value={s.id}>{s.first_name} {s.last_name}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label className="form-label" style={{ margin: 0 }}>Groups ({selected.size} selected)</label>
              <button type="button" className="btn btn-outline btn-xs" onClick={toggleAll}>
                {selected.size === groups.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>
            <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)' }}>
              {groups.map(g => (
                <label key={g.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px',
                  cursor: 'pointer', borderBottom: '1px solid var(--gray-100)',
                  background: selected.has(g.id) ? 'var(--gray-50)' : 'white',
                }}>
                  <input type="checkbox" checked={selected.has(g.id)} onChange={() => toggleGroup(g.id)}
                    style={{ width: 15, height: 15, accentColor: 'var(--navy)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--navy)' }}>
                      {g.group_name || g.name}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>
                      {g.internal_name}
                      {g.supervisor ? ` · currently: ${g.supervisor.first_name} ${g.supervisor.last_name}` : ' · unassigned'}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-gold" disabled={loading}>
              {loading ? 'Assigning…' : `Assign ${selected.size > 0 ? selected.size : ''} Group${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        </form>
      </div>
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
  const [showBulkAssign, setShowBulkAssign] = useState(false);
  const [filter, setFilter]           = useState('active');
  const [emailEnabled, setEmailEnabledState] = useState(null);
  const [myEmailEnabled, setMyEmailEnabled] = useState(null);
  const [error, setError]             = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.getGroups(showArchived);
      setGroups(data);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [showArchived]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.getEmailEnabled().then(r => setEmailEnabledState(r.email_enabled)).catch(() => {});
    api.getMyProfile().then(p => setMyEmailEnabled(p.email_enabled !== false)).catch(() => {});
  }, []);

  async function toggleEmail() {
    const res = await api.setEmailEnabled(!emailEnabled);
    setEmailEnabledState(res.email_enabled);
  }

  async function toggleMyEmail() {
    const next = !myEmailEnabled;
    setMyEmailEnabled(next);
    try {
      await api.updateMyProfile({ email_enabled: next });
    } catch (err) {
      setMyEmailEnabled(!next);
      alert('Failed to update email setting: ' + err.message);
    }
  }

  async function handleEndGroup(groupId) {
    if (!window.confirm('Mark this group as completed?')) return;
    try {
      await api.updateGroup(groupId, { status: 'completed' });
      load();
    } catch (err) { setError(err.message); }
  }

  async function handleToggleAi(groupId, aiNotes) {
    try {
      const updated = await api.updateGroup(groupId, { ai_notes: aiNotes });
      setGroups(prev => prev.map(g => g.id === groupId ? { ...g, ai_notes: updated.ai_notes } : g));
    } catch (err) { setError(err.message); }
  }

  const stats = {
    total:     groups.length,
    active:    groups.filter(g => g.status === 'active').length,
    completed: groups.filter(g => g.status === 'completed').length,
  };

  const visibleGroups = showArchived ? groups : groups.filter(g => {
    if (filter === 'active')    return g.status === 'active';
    if (filter === 'completed') return g.status === 'completed';
    return true; // 'total'
  });

  // Group by day_of_week_int
  const byDay = {};
  visibleGroups.forEach(g => {
    const dow = g.day_of_week_int ?? DAY_NAMES.indexOf(g.day_of_week);
    const key = dow >= 0 ? dow : 7;
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push(g);
  });
  const sortedDays = Object.keys(byDay).map(Number).sort((a, b) => a - b);

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
            onClick={() => { setShowArchived(a => !a); setFilter('active'); }}
            style={{ color: showArchived ? 'var(--navy)' : 'var(--gray-400)' }}
          >
            {showArchived ? '← Active Groups' : 'View Archived'}
          </button>
          {myEmailEnabled !== null && (
            <button
              className="btn btn-outline btn-sm"
              onClick={toggleMyEmail}
              style={{ color: myEmailEnabled ? '#10b981' : 'var(--gray-400)' }}
              title={myEmailEnabled ? 'My emails on — click to disable' : 'My emails off — click to enable'}
            >
              ✉ {myEmailEnabled ? 'My Emails On' : 'My Emails Off'}
            </button>
          )}
          {isAdmin && emailEnabled !== null && (
            <button
              className="btn btn-outline btn-sm"
              onClick={toggleEmail}
              style={{ color: emailEnabled ? '#10b981' : 'var(--gray-400)', fontSize: '0.75rem' }}
              title={emailEnabled ? 'Global emails on — click to disable all' : 'Global emails off — click to enable all'}
            >
              {emailEnabled ? 'Global On' : 'Global Off'}
            </button>
          )}
          {!showArchived && (
            <>
              {isAdmin && <button className="btn btn-outline btn-sm" onClick={() => setShowBulkAssign(true)}>Assign Supervisor</button>}
              <button className="btn btn-gold" onClick={() => setShowCreate(true)}>+ New Group</button>
            </>
          )}
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {!showArchived && (
        <div className="stats-row" style={{ marginBottom: 24 }}>
          {[
            { key: 'total',     label: 'Total Groups', value: stats.total,     color: 'var(--navy)' },
            { key: 'active',    label: 'Active',        value: stats.active,    color: '#10b981'     },
            { key: 'completed', label: 'Completed',     value: stats.completed, color: '#6b7280'     },
          ].map(({ key, label, value, color }) => (
            <div
              key={key}
              className="stat-card"
              onClick={() => setFilter(key)}
              style={{
                cursor: 'pointer',
                outline: filter === key ? `2px solid ${color}` : '2px solid transparent',
                transition: 'outline 0.15s, box-shadow 0.15s',
                boxShadow: filter === key ? `0 0 0 1px ${color}20` : undefined,
              }}
            >
              <div className="stat-value" style={{ color }}>{value}</div>
              <div className="stat-label">{label}</div>
            </div>
          ))}
        </div>
      )}

      {visibleGroups.length === 0 ? (
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
              onEndGroup={handleEndGroup}
              onToggleAi={handleToggleAi}
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
      {showBulkAssign && (
        <BulkAssignModal
          groups={visibleGroups}
          onClose={() => setShowBulkAssign(false)}
          onDone={() => { setShowBulkAssign(false); load(); }}
        />
      )}
    </div>
  );
}

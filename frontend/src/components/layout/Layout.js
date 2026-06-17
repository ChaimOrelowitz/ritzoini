import { useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

const SECTIONS = [
  { key: 'ritzoini',   label: 'Ritzoini' },
  { key: 'one-on-one', label: 'One-On-One' },
  { key: 'peer-sup',   label: 'Peer Supervision' },
];

function getInitialSection() {
  return localStorage.getItem('app_section') || 'ritzoini';
}

export default function Layout() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [section, setSection] = useState(getInitialSection);

  async function handleSignOut() {
    await signOut();
    navigate('/login');
  }

  function closeNav() { setSidebarOpen(false); }

  function switchSection(key) {
    setSection(key);
    localStorage.setItem('app_section', key);
    setSidebarOpen(false);
    if (key === 'ritzoini')   navigate('/');
    if (key === 'one-on-one') navigate('/oo');
    if (key === 'peer-sup')   navigate('/ps');
  }

  const fullName = `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim();
  const initials = [profile?.first_name?.[0], profile?.last_name?.[0]]
    .filter(Boolean).join('').toUpperCase() || '?';
  const isAdmin = profile?.role === 'admin';

  const navLinks = {
    ritzoini: (
      <>
        <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-icon">⊞</span> Groups
        </NavLink>
        <NavLink to="/sessions" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-icon">☑</span> Sessions
        </NavLink>
        <NavLink to="/calendar" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-icon">📅</span> Calendar
        </NavLink>
        <NavLink to="/instructors" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-icon">🎓</span> Instructors
        </NavLink>
        {isAdmin && (
          <NavLink to="/supervisors" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <span className="nav-icon">👤</span> Users
          </NavLink>
        )}
        {isAdmin && (
          <NavLink to="/payments" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <span className="nav-icon">💰</span> Payments
          </NavLink>
        )}
      </>
    ),
    'one-on-one': (
      <>
        <NavLink to="/oo/clients" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-icon">👤</span> Clients
        </NavLink>
        <NavLink to="/oo/call-list" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-icon">📞</span> Calls
        </NavLink>
        <NavLink to="/oo/calls" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-icon">☑</span> Sessions
        </NavLink>
        <NavLink to="/oo/transcripts" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-icon">📝</span> Transcripts
        </NavLink>
        <NavLink to="/oo/referral-sources" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-icon">🔗</span> Sources / EHR
        </NavLink>
        <NavLink to="/oo/peer-notes" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-icon">📋</span> Peer Notes
        </NavLink>
        <NavLink to="/calendar" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-icon">📅</span> Calendar
        </NavLink>
        {isAdmin && (
          <NavLink to="/oo/payments" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <span className="nav-icon">💰</span> Payments
          </NavLink>
        )}
      </>
    ),
    'peer-sup': (
      <>
        <NavLink to="/ps/sessions" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-icon">☑</span> Sessions
        </NavLink>
        <NavLink to="/calendar" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-icon">📅</span> Calendar
        </NavLink>
      </>
    ),
  };

  return (
    <div className="layout">
      <button className="hamburger" onClick={() => setSidebarOpen(o => !o)} aria-label="Menu">☰</button>
      <div className={`sidebar-overlay${sidebarOpen ? ' open' : ''}`} onClick={closeNav} />
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>

        <div className="sidebar-logo">
          <h1>Ritzoini</h1>
          <span>Practice Management</span>
        </div>

        <nav className="sidebar-nav" onClick={closeNav}>
          {navLinks[section]}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="avatar">{initials}</div>
            <div className="sidebar-user-info">
              <p>{fullName || profile?.email}</p>
              <span>{profile?.role}</span>
            </div>
          </div>
          <button className="btn-signout" onClick={handleSignOut}>Sign Out</button>
        </div>
      </aside>

      <main className="main-content">
        {/* Section switcher */}
        <div style={{
          display: 'flex', justifyContent: 'center', gap: 28,
          padding: '12px 0 10px',
          borderBottom: '1px solid var(--gray-100)',
          marginBottom: 0,
        }}>
          {SECTIONS.map(s => (
            <button
              key={s.key}
              onClick={() => switchSection(s.key)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0',
                fontSize: '0.8rem', fontWeight: section === s.key ? 700 : 400,
                color: section === s.key ? 'var(--navy)' : 'var(--gray-400)',
                borderBottom: section === s.key ? '2px solid var(--navy)' : '2px solid transparent',
                transition: 'color 0.15s, border-color 0.15s',
                letterSpacing: '0.01em',
              }}
              onMouseEnter={e => { if (section !== s.key) e.currentTarget.style.color = 'var(--gray-600)'; }}
              onMouseLeave={e => { if (section !== s.key) e.currentTarget.style.color = 'var(--gray-400)'; }}
            >
              {s.label}
            </button>
          ))}
        </div>

        <Outlet />
      </main>
    </div>
  );
}

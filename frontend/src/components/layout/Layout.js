import { useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export default function Layout() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  async function handleSignOut() {
    await signOut();
    navigate('/login');
  }

  function closeNav() { setSidebarOpen(false); }

  const fullName = `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim();
  const initials = [profile?.first_name?.[0], profile?.last_name?.[0]]
    .filter(Boolean).join('').toUpperCase() || '?';

  const isAdmin = profile?.role === 'admin';

  return (
    <div className="layout">
      <button className="hamburger" onClick={() => setSidebarOpen(o => !o)} aria-label="Menu">☰</button>
      <div className={`sidebar-overlay${sidebarOpen ? ' open' : ''}`} onClick={closeNav} />
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-logo">
          <h1>Ritzoini</h1>
          <span>Group Management</span>
        </div>

        <nav className="sidebar-nav" onClick={closeNav}>
          <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <span className="nav-icon">⊞</span> Groups
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
        <Outlet />
      </main>
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';

function EditUserModal({ user, onClose, onSaved }) {
  const [form, setForm] = useState({
    first_name: user.first_name || '',
    last_name: user.last_name || '',
    phone: user.phone || '',
    role: user.role || 'supervisor',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api.updateUser(user.id, form);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h3>Edit User</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="alert alert-error">{error}</div>}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">First Name</label>
                <input className="form-input" type="text" value={form.first_name} onChange={e => set('first_name', e.target.value)} placeholder="Jane" />
              </div>
              <div className="form-group">
                <label className="form-label">Last Name</label>
                <input className="form-input" type="text" value={form.last_name} onChange={e => set('last_name', e.target.value)} placeholder="Smith" />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Phone</label>
              <input className="form-input" type="tel" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="(555) 000-0000" />
            </div>
            <div className="form-group">
              <label className="form-label">Role</label>
              <select className="form-select" value={form.role} onChange={e => set('role', e.target.value)}>
                <option value="supervisor">Supervisor</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div style={{ background: '#fef3c7', borderRadius: 'var(--radius)', padding: '10px 14px', fontSize: '0.8rem', color: '#92400e' }}>
              ⚠️ Admins can see all groups, invite users, and manage the entire platform.
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-gold" disabled={loading}>
              {loading ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '' });
  const [status, setStatus] = useState({ type: '', message: '' });
  const [inviting, setInviting] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [togglingEmail, setTogglingEmail] = useState(null);

  const loadUsers = useCallback(async () => {
    try {
      const data = await api.getUsers();
      setUsers(data);
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  async function handleResetPassword(userId) {
    try {
      const res = await api.resetPassword(userId);
      setStatus({ type: 'success', message: res.message });
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    }
  }

  async function toggleUserEmail(user) {
    const next = user.email_enabled === false ? true : false;
    setTogglingEmail(user.id);
    try {
      await api.updateUser(user.id, { email_enabled: next });
      setUsers(us => us.map(u => u.id === user.id ? { ...u, email_enabled: next } : u));
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setTogglingEmail(null);
    }
  }

  async function handleInvite(e) {
    e.preventDefault();
    setInviting(true);
    setStatus({ type: '', message: '' });
    try {
      const res = await api.inviteUser(form.email, form.first_name, form.last_name, form.phone);
      setStatus({ type: 'success', message: res.message });
      setForm({ first_name: '', last_name: '', email: '', phone: '' });
      loadUsers();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setInviting(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Users</h2>
          <p>Manage admins and supervisors</p>
        </div>
      </div>

      {status.message && (
        <div className={`alert alert-${status.type}`}>{status.message}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: '24px', alignItems: 'start' }}>

        {/* Invite Form */}
        <div className="card">
          <div className="card-header">
            <h3 style={{ fontSize: '1rem', color: 'var(--navy)' }}>Invite Supervisor</h3>
          </div>
          <div className="card-body">
            <form onSubmit={handleInvite}>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">First Name *</label>
                  <input className="form-input" type="text" value={form.first_name} onChange={e => set('first_name', e.target.value)} placeholder="Jane" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Last Name *</label>
                  <input className="form-input" type="text" value={form.last_name} onChange={e => set('last_name', e.target.value)} placeholder="Smith" required />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Email *</label>
                <input className="form-input" type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="jane@example.com" required />
              </div>
              <div className="form-group">
                <label className="form-label">Phone</label>
                <input className="form-input" type="tel" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="(555) 000-0000" />
              </div>
              <button type="submit" className="btn btn-gold" style={{ width: '100%', justifyContent: 'center' }} disabled={inviting}>
                {inviting ? 'Sending…' : '✉️ Send Invitation'}
              </button>
            </form>
            <p style={{ fontSize: '0.78rem', color: 'var(--gray-400)', marginTop: '12px', lineHeight: 1.5 }}>
              They'll receive an email with a link to set their password and access the platform as a supervisor.
            </p>
          </div>
        </div>

        {/* Users Table */}
        <div className="card">
          <div className="card-header">
            <h3 style={{ fontSize: '1rem', color: 'var(--navy)' }}>All Users ({users.length})</h3>
          </div>
          {loading ? (
            <div style={{ padding: '40px', textAlign: 'center' }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
          ) : users.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">👥</div>
              <p>No users yet. Invite a supervisor to get started.</p>
            </div>
          ) : (
            <table className="sessions-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Role</th>
                  <th>Emails</th>
                  <th>Joined</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map(user => (
                  <tr key={user.id}>
                    <td style={{ fontWeight: 500 }}>
                      {user.first_name || user.last_name
                        ? `${user.first_name} ${user.last_name}`.trim()
                        : <span style={{ color: 'var(--gray-400)' }}>No name set</span>
                      }
                    </td>
                    <td style={{ color: 'var(--gray-600)', fontSize: '0.85rem' }}>{user.email}</td>
                    <td style={{ color: 'var(--gray-600)', fontSize: '0.85rem' }}>
                      {user.phone || <span style={{ color: 'var(--gray-300)' }}>—</span>}
                    </td>
                    <td>
                      <span className={`badge badge-${user.role === 'admin' ? 'locked' : 'active'}`}>
                        {user.role}
                      </span>
                    </td>
                    <td>
                      <button
                        className="btn btn-outline btn-xs"
                        onClick={() => toggleUserEmail(user)}
                        disabled={togglingEmail === user.id}
                        style={{ color: user.email_enabled === false ? 'var(--gray-400)' : '#10b981', minWidth: 56 }}
                        title={user.email_enabled === false ? 'Emails off — click to enable' : 'Emails on — click to disable'}
                      >
                        {user.email_enabled === false ? 'Off' : 'On'}
                      </button>
                    </td>
                    <td style={{ color: 'var(--gray-400)', fontSize: '0.8rem' }}>
                      {new Date(user.created_at).toLocaleDateString()}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-outline btn-xs" onClick={() => setEditingUser(user)}>Edit</button>
                        <button className="btn btn-outline btn-xs" onClick={() => handleResetPassword(user.id)}>Reset Password</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {editingUser && (
        <EditUserModal
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onSaved={() => {
            setEditingUser(null);
            setStatus({ type: 'success', message: 'User updated successfully.' });
            loadUsers();
          }}
        />
      )}
    </div>
  );
}

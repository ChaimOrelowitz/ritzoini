import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';

export default function SupervisorsPage() {
  const [users, setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm]     = useState({ first_name: '', last_name: '', email: '', phone: '' });
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm]   = useState({});
  const [status, setStatus] = useState({ type: '', message: '' });
  const [inviting, setInviting]   = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getUsers();
      setUsers(data);
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function set(field, value) { setForm(f => ({ ...f, [field]: value })); }

  async function handleInvite(e) {
    e.preventDefault();
    setInviting(true);
    setStatus({ type: '', message: '' });
    try {
      const res = await api.inviteUser(form.email, form.first_name, form.last_name, form.phone);
      setStatus({ type: 'success', message: res.message });
      setForm({ first_name: '', last_name: '', email: '', phone: '' });
      load();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setInviting(false);
    }
  }

  function startEdit(user) {
    setEditingId(user.id);
    setEditForm({ first_name: user.first_name, last_name: user.last_name, phone: user.phone || '', role: user.role });
  }

  async function saveEdit(userId) {
    try {
      await api.updateUser(userId, editForm);
      setEditingId(null);
      load();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    }
  }

  const supervisors = users.filter(u => u.role === 'supervisor');
  const admins      = users.filter(u => u.role === 'admin');

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Supervisors</h2>
          <p>Manage supervisor accounts and access</p>
        </div>
      </div>

      {status.message && (
        <div className={`alert alert-${status.type}`} style={{ marginBottom: 20 }}>
          {status.message}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 24, alignItems: 'start' }}>

        {/* Invite form */}
        <div className="card">
          <div className="card-header">
            <h3 style={{ fontSize: '1rem', color: 'var(--navy)' }}>Invite Supervisor</h3>
          </div>
          <div className="card-body">
            <form onSubmit={handleInvite}>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">First Name *</label>
                  <input className="form-input" value={form.first_name} onChange={e => set('first_name', e.target.value)} placeholder="Jane" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Last Name *</label>
                  <input className="form-input" value={form.last_name} onChange={e => set('last_name', e.target.value)} placeholder="Smith" required />
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
            <p style={{ fontSize: '0.78rem', color: 'var(--gray-400)', marginTop: 12, lineHeight: 1.5 }}>
              They'll receive an email with a link to set their password and log in as a supervisor.
            </p>
          </div>
        </div>

        {/* User tables */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Supervisors */}
          <div className="card">
            <div className="card-header">
              <h3 style={{ fontSize: '1rem', color: 'var(--navy)' }}>Supervisors ({supervisors.length})</h3>
            </div>
            {loading ? (
              <div style={{ padding: 40, textAlign: 'center' }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
            ) : supervisors.length === 0 ? (
              <div className="empty-state"><div className="empty-icon">👤</div><p>No supervisors yet. Invite one above.</p></div>
            ) : (
              <table className="sessions-table">
                <thead>
                  <tr><th>Name</th><th>Email</th><th>Phone</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {supervisors.map(user => (
                    <tr key={user.id}>
                      {editingId === user.id ? (
                        <>
                          <td>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <input className="form-input" style={{ padding: '4px 8px', fontSize: '0.82rem' }}
                                value={editForm.first_name} onChange={e => setEditForm(f => ({ ...f, first_name: e.target.value }))} />
                              <input className="form-input" style={{ padding: '4px 8px', fontSize: '0.82rem' }}
                                value={editForm.last_name} onChange={e => setEditForm(f => ({ ...f, last_name: e.target.value }))} />
                            </div>
                          </td>
                          <td style={{ color: 'var(--gray-500)', fontSize: '0.85rem' }}>{user.email}</td>
                          <td>
                            <input className="form-input" style={{ padding: '4px 8px', fontSize: '0.82rem' }}
                              value={editForm.phone} onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))} />
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button className="btn btn-gold btn-xs" onClick={() => saveEdit(user.id)}>Save</button>
                              <button className="btn btn-outline btn-xs" onClick={() => setEditingId(null)}>Cancel</button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td style={{ fontWeight: 500 }}>{user.first_name} {user.last_name}</td>
                          <td style={{ color: 'var(--gray-600)', fontSize: '0.85rem' }}>{user.email}</td>
                          <td style={{ color: 'var(--gray-600)', fontSize: '0.85rem' }}>{user.phone || <span style={{ color: 'var(--gray-300)' }}>—</span>}</td>
                          <td>
                            <button className="btn btn-outline btn-xs" onClick={() => startEdit(user)}>Edit</button>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Admins (read-only view) */}
          {admins.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h3 style={{ fontSize: '1rem', color: 'var(--navy)' }}>Admins ({admins.length})</h3>
              </div>
              <table className="sessions-table">
                <thead>
                  <tr><th>Name</th><th>Email</th><th>Phone</th></tr>
                </thead>
                <tbody>
                  {admins.map(user => (
                    <tr key={user.id}>
                      <td style={{ fontWeight: 500 }}>{user.first_name} {user.last_name}</td>
                      <td style={{ color: 'var(--gray-600)', fontSize: '0.85rem' }}>{user.email}</td>
                      <td style={{ color: 'var(--gray-600)', fontSize: '0.85rem' }}>{user.phone || <span style={{ color: 'var(--gray-300)' }}>—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

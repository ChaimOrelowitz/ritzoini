import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';

function fmtPhone(raw) {
  if (!raw) return '';
  const d = raw.replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3)  return d.length ? `(${d}` : '';
  if (d.length <= 6)  return `(${d.slice(0,3)}) ${d.slice(3)}`;
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}
function displayPhone(raw) {
  if (!raw) return null;
  return fmtPhone(raw.replace(/\D/g, ''));
}

function PhoneInput({ value, onChange, placeholder = '(555) 000-0000', ...rest }) {
  return (
    <input
      type="tel"
      value={fmtPhone(value)}
      onChange={e => onChange(e.target.value.replace(/\D/g, '').slice(0, 10))}
      placeholder={placeholder}
      {...rest}
    />
  );
}

function UserTable({ title, users, editingId, editForm, setEditForm, onStartEdit, onSaveEdit, onCancelEdit, onChangeRole, onResetPassword }) {
  return (
    <div className="card">
      <div className="card-header">
        <h3 style={{ fontSize: '1rem', color: 'var(--navy)' }}>{title} ({users.length})</h3>
      </div>
      {users.length === 0 ? (
        <div className="empty-state"><div className="empty-icon">👤</div><p>None yet.</p></div>
      ) : (
        <table className="sessions-table">
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Actions</th></tr></thead>
          <tbody>
            {users.map(user => (
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
                      <PhoneInput className="form-input" style={{ padding: '4px 8px', fontSize: '0.82rem' }}
                        value={editForm.phone} onChange={v => setEditForm(f => ({ ...f, phone: v }))} />
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-gold btn-xs" onClick={() => onSaveEdit(user.id)}>Save</button>
                        <button className="btn btn-outline btn-xs" onClick={onCancelEdit}>Cancel</button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td style={{ fontWeight: 500 }}>{user.first_name} {user.last_name}</td>
                    <td style={{ color: 'var(--gray-600)', fontSize: '0.85rem' }}>{user.email}</td>
                    <td style={{ color: 'var(--gray-600)', fontSize: '0.85rem' }}>
                      {displayPhone(user.phone) || <span style={{ color: 'var(--gray-300)' }}>—</span>}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button className="btn btn-outline btn-xs" onClick={() => onStartEdit(user)}>Edit</button>
                        <button className="btn btn-outline btn-xs"
                          onClick={() => onChangeRole(user.id, user.role === 'admin' ? 'supervisor' : 'admin')}>
                          Make {user.role === 'admin' ? 'Supervisor' : 'Admin'}
                        </button>
                        <button className="btn btn-outline btn-xs" onClick={() => onResetPassword(user.id)}
                          style={{ color: 'var(--gray-400)' }}>
                          Reset Password
                        </button>
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function SupervisorsPage() {
  const [users, setUsers]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [form, setForm]         = useState({ first_name: '', last_name: '', email: '', phone: '', role: 'supervisor' });
  const [editingId, setEditingId]   = useState(null);
  const [editForm, setEditForm]     = useState({});
  const [status, setStatus]     = useState({ type: '', message: '' });
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getUsers();
      setUsers(data);
    } catch (err) { setStatus({ type: 'error', message: err.message }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function set(field, value) { setForm(f => ({ ...f, [field]: value })); }

  async function handleInvite(e) {
    e.preventDefault();
    setInviting(true); setStatus({ type: '', message: '' });
    try {
      const res = await api.inviteUser(form.email, form.first_name, form.last_name, form.phone, form.role);
      setStatus({ type: 'success', message: res.message });
      setForm({ first_name: '', last_name: '', email: '', phone: '', role: 'supervisor' });
      load();
    } catch (err) { setStatus({ type: 'error', message: err.message }); }
    finally { setInviting(false); }
  }

  function startEdit(user) {
    setEditingId(user.id);
    setEditForm({ first_name: user.first_name, last_name: user.last_name, phone: user.phone || '' });
  }

  async function saveEdit(userId) {
    try {
      await api.updateUser(userId, editForm);
      setEditingId(null); load();
    } catch (err) { setStatus({ type: 'error', message: err.message }); }
  }

  async function handleChangeRole(userId, newRole) {
    try {
      await api.updateUser(userId, { role: newRole });
      load();
    } catch (err) { setStatus({ type: 'error', message: err.message }); }
  }

  async function handleResetPassword(userId) {
    try {
      const res = await api.resetPassword(userId);
      setStatus({ type: 'success', message: res.message });
    } catch (err) { setStatus({ type: 'error', message: err.message }); }
  }

  const supervisors = users.filter(u => u.role === 'supervisor');
  const admins      = users.filter(u => u.role === 'admin');

  const tableProps = {
    editingId, editForm, setEditForm,
    onStartEdit: startEdit,
    onSaveEdit: saveEdit,
    onCancelEdit: () => setEditingId(null),
    onChangeRole: handleChangeRole,
    onResetPassword: handleResetPassword,
  };

  return (
    <div>
      <div className="page-header">
        <div><h2>Users</h2><p>Manage user accounts and access</p></div>
      </div>

      {status.message && (
        <div className={`alert alert-${status.type}`} style={{ marginBottom: 20 }}>{status.message}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 24, alignItems: 'start' }}>

        {/* Invite form */}
        <div className="card">
          <div className="card-header">
            <h3 style={{ fontSize: '1rem', color: 'var(--navy)' }}>Invite User</h3>
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
                <PhoneInput className="form-input" value={form.phone} onChange={v => set('phone', v)} />
              </div>
              <div className="form-group">
                <label className="form-label">Role</label>
                <select className="form-select" value={form.role} onChange={e => set('role', e.target.value)}>
                  <option value="supervisor">Supervisor</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <button type="submit" className="btn btn-gold" style={{ width: '100%', justifyContent: 'center' }} disabled={inviting}>
                {inviting ? 'Sending…' : '✉️ Send Invitation'}
              </button>
            </form>
            <p style={{ fontSize: '0.78rem', color: 'var(--gray-400)', marginTop: 12, lineHeight: 1.5 }}>
              They'll receive an email with a link to set their password and log in.
            </p>
          </div>
        </div>

        {/* Tables */}
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center' }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <UserTable title="Supervisors" users={supervisors} {...tableProps} />
            <UserTable title="Admins" users={admins} {...tableProps} />
          </div>
        )}
      </div>
    </div>
  );
}

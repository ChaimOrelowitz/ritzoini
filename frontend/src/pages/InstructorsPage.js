import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';

export default function InstructorsPage() {
  const [instructors, setInstructors] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [form, setForm]         = useState({ first_name: '', last_name: '', phone: '' });
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm]   = useState({});
  const [status, setStatus]     = useState({ type: '', message: '' });
  const [saving, setSaving]     = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getInstructors();
      setInstructors(data);
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function setF(field, value) { setForm(f => ({ ...f, [field]: value })); }

  async function handleCreate(e) {
    e.preventDefault();
    setSaving(true);
    setStatus({ type: '', message: '' });
    try {
      await api.createInstructor(form);
      setStatus({ type: 'success', message: `${form.first_name} ${form.last_name} added.` });
      setForm({ first_name: '', last_name: '', phone: '' });
      load();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setSaving(false);
    }
  }

  function startEdit(inst) {
    setEditingId(inst.id);
    setEditForm({ first_name: inst.first_name, last_name: inst.last_name, phone: inst.phone || '' });
  }

  async function saveEdit(id) {
    try {
      await api.updateInstructor(id, editForm);
      setEditingId(null);
      load();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    }
  }

  async function handleDelete(inst) {
    if (!window.confirm(`Remove ${inst.first_name} ${inst.last_name}? Groups assigned to them will have no instructor.`)) return;
    try {
      await api.deleteInstructor(inst.id);
      load();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Instructors</h2>
          <p>Manage instructors assigned to groups</p>
        </div>
      </div>

      {status.message && (
        <div className={`alert alert-${status.type}`} style={{ marginBottom: 20 }}>{status.message}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 24, alignItems: 'start' }}>

        {/* Add form */}
        <div className="card">
          <div className="card-header">
            <h3 style={{ fontSize: '1rem', color: 'var(--navy)' }}>Add Instructor</h3>
          </div>
          <div className="card-body">
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label className="form-label">First Name *</label>
                <input className="form-input" value={form.first_name} onChange={e => setF('first_name', e.target.value)} placeholder="Jane" required />
              </div>
              <div className="form-group">
                <label className="form-label">Last Name *</label>
                <input className="form-input" value={form.last_name} onChange={e => setF('last_name', e.target.value)} placeholder="Smith" required />
              </div>
              <div className="form-group">
                <label className="form-label">Phone</label>
                <input className="form-input" type="tel" value={form.phone} onChange={e => setF('phone', e.target.value)} placeholder="(555) 000-0000" />
              </div>
              <button type="submit" className="btn btn-gold" style={{ width: '100%', justifyContent: 'center' }} disabled={saving}>
                {saving ? 'Adding…' : '+ Add Instructor'}
              </button>
            </form>
            <p style={{ fontSize: '0.78rem', color: 'var(--gray-400)', marginTop: 10, lineHeight: 1.5 }}>
              Instructors don't need a login. They appear in the group selector when creating or editing a group.
            </p>
          </div>
        </div>

        {/* Instructors table */}
        <div className="card">
          <div className="card-header">
            <h3 style={{ fontSize: '1rem', color: 'var(--navy)' }}>
              All Instructors ({instructors.length})
            </h3>
          </div>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center' }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
          ) : instructors.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🎓</div>
              <p>No instructors yet. Add one to get started.</p>
            </div>
          ) : (
            <table className="sessions-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {instructors.map(inst => (
                  <tr key={inst.id}>
                    {editingId === inst.id ? (
                      <>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <input className="form-input" style={{ padding: '4px 8px', fontSize: '0.82rem' }}
                              value={editForm.first_name} onChange={e => setEditForm(f => ({ ...f, first_name: e.target.value }))} />
                            <input className="form-input" style={{ padding: '4px 8px', fontSize: '0.82rem' }}
                              value={editForm.last_name} onChange={e => setEditForm(f => ({ ...f, last_name: e.target.value }))} />
                          </div>
                        </td>
                        <td>
                          <input className="form-input" style={{ padding: '4px 8px', fontSize: '0.82rem' }}
                            value={editForm.phone} onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))} />
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button className="btn btn-gold btn-xs" onClick={() => saveEdit(inst.id)}>Save</button>
                            <button className="btn btn-outline btn-xs" onClick={() => setEditingId(null)}>Cancel</button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{
                              width: 32, height: 32, borderRadius: '50%',
                              background: 'var(--navy)', color: 'white',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: '0.72rem', fontWeight: 700, flexShrink: 0,
                            }}>
                              {inst.first_name?.[0]}{inst.last_name?.[0]}
                            </div>
                            <span style={{ fontWeight: 500 }}>{inst.first_name} {inst.last_name}</span>
                          </div>
                        </td>
                        <td style={{ color: 'var(--gray-600)', fontSize: '0.85rem' }}>
                          {inst.phone || <span style={{ color: 'var(--gray-300)' }}>—</span>}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button className="btn btn-outline btn-xs" onClick={() => startEdit(inst)}>Edit</button>
                            <button className="btn btn-danger btn-xs" onClick={() => handleDelete(inst)}>Remove</button>
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
      </div>
    </div>
  );
}

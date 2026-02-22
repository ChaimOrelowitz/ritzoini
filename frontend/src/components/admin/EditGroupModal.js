import { useState, useEffect } from 'react';
import { api } from '../../utils/api';

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

export default function EditGroupModal({ group, onClose, onSaved }) {
  const [supervisors, setSupervisors] = useState([]);
  const [form, setForm] = useState({
    name: group.name,
    supervisor_id: group.supervisor_id || '',
    total_sessions: group.total_sessions,
    day_of_week: group.day_of_week,
    session_time: group.session_time?.slice(0, 5) || '10:00',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getUsers().then(users => setSupervisors(users.filter(u => u.role === 'supervisor')));
  }, []);

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api.updateGroup(group.id, {
        ...form,
        total_sessions: parseInt(form.total_sessions),
        supervisor_id: form.supervisor_id || null,
      });
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
          <h3>Edit Group</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="alert alert-error">{error}</div>}

            <div className="form-group">
              <label className="form-label">Group Name</label>
              <input className="form-input" value={form.name} onChange={e => set('name', e.target.value)} required />
            </div>

            <div className="form-group">
              <label className="form-label">Supervisor</label>
              <select className="form-select" value={form.supervisor_id} onChange={e => set('supervisor_id', e.target.value)}>
                <option value="">— Unassigned —</option>
                {supervisors.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.first_name} {s.last_name}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Total Sessions</label>
                <input className="form-input" type="number" min="1" max="52" value={form.total_sessions} onChange={e => set('total_sessions', e.target.value)} required />
              </div>
              <div className="form-group">
                <label className="form-label">Day of Week</label>
                <select className="form-select" value={form.day_of_week} onChange={e => set('day_of_week', e.target.value)}>
                  {DAYS.map(d => <option key={d}>{d}</option>)}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Session Time</label>
              <input className="form-input" type="time" value={form.session_time} onChange={e => set('session_time', e.target.value)} required />
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

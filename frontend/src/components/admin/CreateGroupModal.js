import { useState, useEffect } from 'react';
import { api } from '../../utils/api';
import { useAuth } from '../../context/AuthContext';

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function deriveDayName(dateStr) {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.split('-').map(Number);
  return DAY_NAMES[new Date(year, month - 1, day).getDay()];
}

export default function CreateGroupModal({ onClose, onCreated }) {
  const { profile, isAdmin } = useAuth();
  const [supervisors, setSupervisors] = useState([]);
  const [form, setForm] = useState({
    internal_name: '',
    group_name: '',
    supervisor_id: '',
    start_date: '',
    start_time: '09:00',
    end_time: '09:45',
    ecw_time: '',
    total_sessions: 8,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isAdmin) {
      api.getUsers().then(users => setSupervisors(users.filter(u => u.role === 'supervisor')));
    }
  }, [isAdmin]);

  // Pre-fill supervisor_id for supervisors — wait until profile is loaded
  useEffect(() => {
    if (profile?.role === 'supervisor' && profile?.id) {
      setForm(f => ({ ...f, supervisor_id: profile.id }));
    }
  }, [profile]);

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  const dayName = deriveDayName(form.start_date);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api.createGroup({
        ...form,
        total_sessions: parseInt(form.total_sessions),
        supervisor_id: form.supervisor_id || null,
        ecw_time: form.ecw_time || null,
      });
      onCreated();
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
          <h3>Create New Group</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="alert alert-error">{error}</div>}

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Group Name *</label>
                <input
                  className="form-input"
                  value={form.group_name}
                  onChange={e => set('group_name', e.target.value)}
                  placeholder="Public-facing name"
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Internal Name *</label>
                <input
                  className="form-input"
                  value={form.internal_name}
                  onChange={e => set('internal_name', e.target.value)}
                  placeholder="Staff-only label"
                  required
                />
              </div>
            </div>

            {isAdmin && (
              <div className="form-group">
                <label className="form-label">Supervisor</label>
                <select className="form-select" value={form.supervisor_id} onChange={e => set('supervisor_id', e.target.value)}>
                  <option value="">— Assign later —</option>
                  {supervisors.map(s => (
                    <option key={s.id} value={s.id}>{s.first_name} {s.last_name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Start Date *</label>
                <input
                  className="form-input"
                  type="date"
                  value={form.start_date}
                  onChange={e => set('start_date', e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Day of Week</label>
                <input
                  className="form-input"
                  value={dayName || '— pick a date —'}
                  readOnly
                  style={{ background: 'var(--gray-50)', color: 'var(--gray-600)', cursor: 'default' }}
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Start Time *</label>
                <input
                  className="form-input"
                  type="time"
                  value={form.start_time}
                  onChange={e => set('start_time', e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">End Time *</label>
                <input
                  className="form-input"
                  type="time"
                  value={form.end_time}
                  onChange={e => set('end_time', e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">
                  ECW Time <span style={{ fontWeight: 400, color: 'var(--gray-400)' }}>(defaults to start time)</span>
                </label>
                <input
                  className="form-input"
                  type="time"
                  value={form.ecw_time}
                  onChange={e => set('ecw_time', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Total Sessions</label>
                <input
                  className="form-input"
                  type="number"
                  min="1"
                  max="52"
                  value={form.total_sessions}
                  onChange={e => set('total_sessions', e.target.value)}
                  required
                />
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-gold" disabled={loading}>
              {loading ? 'Creating…' : 'Create Group'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

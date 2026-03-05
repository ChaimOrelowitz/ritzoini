import { useState, useEffect } from 'react';
import { api } from '../../utils/api';

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function deriveDayName(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return DAY_NAMES[new Date(y, m - 1, d).getDay()];
}

function addMinutesToTime(timeStr, mins) {
  if (!timeStr || !mins) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + parseInt(mins);
  return `${String(Math.floor(total / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
}

function computeEndDate(startDate, dowInt, numSessions) {
  if (!startDate || !numSessions) return '';
  const [y, m, d] = startDate.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const daysAhead = (dowInt - start.getDay() + 7) % 7;
  const first = new Date(start); first.setDate(first.getDate() + daysAhead);
  const last  = new Date(first); last.setDate(last.getDate() + (parseInt(numSessions) - 1) * 7);
  return last.toISOString().split('T')[0];
}

function computeNumSessions(startDate, endDate, dowInt) {
  if (!startDate || !endDate) return '';
  const [sy,sm,sd] = startDate.split('-').map(Number);
  const [ey,em,ed] = endDate.split('-').map(Number);
  const start = new Date(sy,sm-1,sd), end = new Date(ey,em-1,ed);
  const daysAhead = (dowInt - start.getDay() + 7) % 7;
  const first = new Date(start); first.setDate(first.getDate() + daysAhead);
  if (first > end) return 0;
  return Math.floor((end - first) / (7*24*60*60*1000)) + 1;
}

// ── Inline new instructor form ────────────────────────────────
function NewInstructorInline({ onCreated, onCancel }) {
  const [form, setForm] = useState({ first_name:'', last_name:'', phone:'' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    if (!form.first_name || !form.last_name) { setError('First and last name required'); return; }
    setLoading(true);
    try {
      const created = await api.createInstructor(form);
      onCreated(created);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  return (
    <div style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: '12px 14px', marginTop: 8 }}>
      <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--navy)', marginBottom: 10 }}>New Instructor</div>
      {error && <div style={{ color: 'red', fontSize: '0.78rem', marginBottom: 8 }}>{error}</div>}
      <div className="form-row">
        <div className="form-group" style={{ marginBottom: 8 }}>
          <input className="form-input" placeholder="First name *" value={form.first_name}
            onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))} />
        </div>
        <div className="form-group" style={{ marginBottom: 8 }}>
          <input className="form-input" placeholder="Last name *" value={form.last_name}
            onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))} />
        </div>
      </div>
      <input className="form-input" placeholder="Phone (optional)" value={form.phone}
        onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} style={{ marginBottom: 10 }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-gold btn-sm" onClick={handleSave} disabled={loading}>
          {loading ? 'Saving…' : 'Add Instructor'}
        </button>
        <button type="button" className="btn btn-outline btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export default function CreateGroupModal({ onClose, onCreated }) {
  const [supervisors, setSupervisors]   = useState([]);
  const [instructors, setInstructors]   = useState([]);
  const [showNewInstructor, setShowNewInstructor] = useState(false);
  const [lastEdited, setLastEdited] = useState('sessions');
  const [form, setForm] = useState({
    internal_name: '', group_name: '', description: '',
    supervisor_id: '', instructor_id: '',
    start_date: '', end_date: '',
    start_time: '09:00', ecw_time: '',
    total_sessions: '', default_duration: '45',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    api.getUsers().then(u => setSupervisors(u.filter(x => x.role === 'supervisor')));
    api.getInstructors().then(setInstructors);
  }, []);

  const dowInt = form.start_date
    ? (() => { const [y,m,d] = form.start_date.split('-').map(Number); return new Date(y,m-1,d).getDay(); })()
    : 0;
  const dayName  = deriveDayName(form.start_date);
  const end_time = addMinutesToTime(form.start_time, form.default_duration);

  function set(field, value) {
    setForm(f => {
      const next = { ...f, [field]: value };
      const dow = next.start_date
        ? (() => { const [y,m,d] = next.start_date.split('-').map(Number); return new Date(y,m-1,d).getDay(); })()
        : dowInt;

      if (field === 'total_sessions' && next.start_date && value) {
        setLastEdited('sessions');
        next.end_date = computeEndDate(next.start_date, dow, value);
      } else if (field === 'end_date' && next.start_date && value) {
        setLastEdited('end_date');
        next.total_sessions = String(computeNumSessions(next.start_date, value, dow));
      } else if (field === 'start_date' && value) {
        if (lastEdited === 'sessions' && next.total_sessions)
          next.end_date = computeEndDate(value, dow, next.total_sessions);
        else if (lastEdited === 'end_date' && next.end_date)
          next.total_sessions = String(computeNumSessions(value, next.end_date, dow));
      }
      return next;
    });
  }

  function handleInstructorCreated(instructor) {
    setInstructors(prev => [...prev, instructor].sort((a,b) => a.last_name.localeCompare(b.last_name)));
    setForm(f => ({ ...f, instructor_id: instructor.id }));
    setShowNewInstructor(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await api.createGroup({
        ...form,
        total_sessions:   form.total_sessions ? parseInt(form.total_sessions) : null,
        default_duration: parseInt(form.default_duration) || 45,
        ecw_time:       form.ecw_time || null,
        supervisor_id:  form.supervisor_id || null,
        instructor_id:  form.instructor_id || null,
        end_date:       form.end_date || null,
      });
      onCreated();
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 600 }}>
        <div className="modal-header">
          <h3>Create New Group</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="alert alert-error">{error}</div>}

            {/* Names */}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Internal Name * <span style={{ fontSize:'0.7rem', color:'var(--gray-400)' }}>(Admin only)</span></label>
                <input className="form-input" value={form.internal_name} onChange={e => set('internal_name', e.target.value)} placeholder="e.g. TUE-AM-2025" required />
              </div>
              <div className="form-group">
                <label className="form-label">Group Name <span style={{ fontSize:'0.7rem', color:'var(--gray-400)' }}>(optional)</span></label>
                <input className="form-input" value={form.group_name} onChange={e => set('group_name', e.target.value)} placeholder="Supervisor-facing label" />
              </div>
            </div>

            {/* Description */}
            <div className="form-group">
              <label className="form-label">Description</label>
              <textarea className="form-textarea" value={form.description} onChange={e => set('description', e.target.value)}
                placeholder="Brief description of the group…" style={{ minHeight: 60 }} />
            </div>

            {/* Supervisor */}
            <div className="form-group">
              <label className="form-label">Supervisor</label>
              <select className="form-select" value={form.supervisor_id} onChange={e => set('supervisor_id', e.target.value)}>
                <option value="">— Assign later —</option>
                {supervisors.map(s => <option key={s.id} value={s.id}>{s.first_name} {s.last_name}</option>)}
              </select>
            </div>

            {/* Instructor */}
            <div className="form-group">
              <label className="form-label">Instructor</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select className="form-select" value={form.instructor_id} onChange={e => set('instructor_id', e.target.value)} style={{ flex: 1 }}>
                  <option value="">— Select instructor —</option>
                  {instructors.map(i => <option key={i.id} value={i.id}>{i.first_name} {i.last_name}</option>)}
                </select>
                <button type="button" className="btn btn-outline btn-sm"
                  onClick={() => setShowNewInstructor(v => !v)}
                  style={{ whiteSpace: 'nowrap' }}>
                  + New
                </button>
              </div>
              {showNewInstructor && (
                <NewInstructorInline
                  onCreated={handleInstructorCreated}
                  onCancel={() => setShowNewInstructor(false)}
                />
              )}
            </div>

            {/* Dates */}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Start Date *</label>
                <input className="form-input" type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} required />
              </div>
              <div className="form-group">
                <label className="form-label">Day of Week</label>
                <input className="form-input" value={dayName || '— pick a date —'} readOnly
                  style={{ background: 'var(--gray-50)', color: 'var(--gray-600)', cursor: 'default' }} />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label"># of Sessions</label>
                <input
  className="form-input"
  type="text"
  inputMode="numeric"
  value={form.total_sessions}
  onChange={e => {
    const onlyDigits = e.target.value.replace(/\D/g, '');
    set('total_sessions', onlyDigits);
  }}
  onWheel={e => e.preventDefault()}
  placeholder="e.g. 12"
/>
              </div>
              <div className="form-group">
                <label className="form-label">End Date</label>
                <input className="form-input" type="date" value={form.end_date} onChange={e => set('end_date', e.target.value)} />
              </div>
            </div>
            <p style={{ fontSize: '0.74rem', color: 'var(--gray-400)', marginTop: -8, marginBottom: 12 }}>
              # Sessions and End Date are linked — editing one updates the other.
            </p>

            {/* Times */}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Start Time *</label>
                <input className="form-input" type="time" value={form.start_time} onChange={e => set('start_time', e.target.value)} required />
              </div>
              <div className="form-group">
                <label className="form-label">ECW Start Time <span style={{ fontWeight:400, color:'var(--gray-400)' }}>(defaults to start)</span></label>
                <input className="form-input" type="time" value={form.ecw_time} onChange={e => set('ecw_time', e.target.value)} />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Duration (minutes)</label>
               <input
  className="form-input no-spin"
  type="number"
  min="1"
  max="200"
  value={form.total_sessions}
  onChange={e => set('total_sessions', e.target.value)}
  onWheel={e => e.currentTarget.blur()}
  placeholder="e.g. 12"
/>
              </div>
              <div className="form-group">
                <label className="form-label">End Time (computed)</label>
                <input className="form-input" value={end_time || '—'} readOnly
                  style={{ background: 'var(--gray-50)', color: 'var(--gray-600)', cursor: 'default' }} />
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

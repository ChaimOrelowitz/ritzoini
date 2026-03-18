import { useState, useEffect } from 'react';
import { api } from '../../utils/api';
import { useAuth } from '../../context/AuthContext';

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
  const startMs = Date.UTC(sy,sm-1,sd), endMs = Date.UTC(ey,em-1,ed);
  const daysAhead = (dowInt - new Date(startMs).getUTCDay() + 7) % 7;
  const firstMs = startMs + daysAhead * 24*60*60*1000;
  if (firstMs > endMs) return 0;
  return Math.floor((endMs - firstMs) / (7*24*60*60*1000)) + 1;
}

function NewInstructorInline({ onCreated, onCancel }) {
  const [form, setForm] = useState({ first_name:'', last_name:'', phone:'' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function handleSave() {
    if (!form.phone) { setError('Phone is required'); return; }
    setLoading(true);
    try { const created = await api.createInstructor(form); onCreated(created); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  return (
    <div style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: '12px 14px', marginTop: 8 }}>
      <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--navy)', marginBottom: 10 }}>New Instructor</div>
      {error && <div style={{ color: 'red', fontSize: '0.78rem', marginBottom: 8 }}>{error}</div>}
      <input className="form-input" placeholder="Phone *" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} style={{ marginBottom: 8 }} />
      <div className="form-row">
        <div className="form-group" style={{ marginBottom: 8 }}>
          <input className="form-input" placeholder="First name (optional)" value={form.first_name} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))} />
        </div>
        <div className="form-group" style={{ marginBottom: 8 }}>
          <input className="form-input" placeholder="Last name (optional)" value={form.last_name} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-gold btn-sm" onClick={handleSave} disabled={loading}>{loading ? 'Saving…' : 'Add Instructor'}</button>
        <button type="button" className="btn btn-outline btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export default function EditGroupModal({ group, onClose, onSaved }) {
  const { isAdmin } = useAuth();
  const [supervisors, setSupervisors]   = useState([]);
  const [instructors, setInstructors]   = useState([]);
  const [showNewInstructor, setShowNewInstructor] = useState(false);
  const [form, setForm] = useState({
    internal_name:    group.internal_name  || group.name || '',
    group_name:       group.group_name     || group.name || '',
    description:      group.description   || '',
    supervisor_id:    group.supervisor_id  || '',
    instructor_id:    group.instructor_id  || '',
    start_date:       group.start_date     || '',
    end_date:         group.end_date       || '',
    start_time:       (group.start_time    || group.session_time || '09:00').slice(0,5),
    ecw_time:         (group.ecw_time      || '').slice(0,5),
    total_sessions:   String(group.total_sessions || ''),
    default_duration: String(group.default_duration || 45),
  });
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  useEffect(() => {
    if (isAdmin) api.getUsers().then(u => setSupervisors(u.filter(x => x.role === 'supervisor')));
    api.getInstructors().then(setInstructors);
  }, [isAdmin]);

  const dowInt = form.start_date
    ? (() => { const [y,m,d] = form.start_date.split('-').map(Number); return new Date(y,m-1,d).getDay(); })()
    : (group.day_of_week_int ?? 0);

  function set(field, value) {
    setForm(f => {
      const next = { ...f, [field]: value };
      const dow = next.start_date
        ? (() => { const [y,m,d] = next.start_date.split('-').map(Number); return new Date(y,m-1,d).getDay(); })()
        : dowInt;
      if (field === 'total_sessions' && next.start_date && value)
        next.end_date = computeEndDate(next.start_date, dow, value);
      else if (field === 'end_date' && next.start_date && value)
        next.total_sessions = String(computeNumSessions(next.start_date, value, dow));
      else if (field === 'start_date' && value && next.total_sessions)
        next.end_date = computeEndDate(value, dow, next.total_sessions);
      return next;
    });
  }

  function handleInstructorCreated(instructor) {
    setInstructors(prev => [...prev, instructor].sort((a,b) => a.last_name.localeCompare(b.last_name)));
    setForm(f => ({ ...f, instructor_id: instructor.id }));
    setShowNewInstructor(false);
  }

  const dayName  = deriveDayName(form.start_date);
  const end_time = addMinutesToTime(form.start_time, form.default_duration);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await api.updateGroup(group.id, {
        ...(isAdmin ? { internal_name: form.internal_name, supervisor_id: form.supervisor_id || null, instructor_id: form.instructor_id || null } : {}),
        group_name:       form.group_name,
        description:      form.description,
        start_date:       form.start_date,
        end_date:         form.end_date || null,
        start_time:       form.start_time,
        ecw_time:         form.ecw_time || null,
        total_sessions:   form.total_sessions ? parseInt(form.total_sessions) : null,
        default_duration: parseInt(form.default_duration) || 45,
      });
      onSaved();
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 580 }}>
        <div className="modal-header">
          <h3>Edit Group</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="alert alert-error">{error}</div>}

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Internal Name {!isAdmin && <span style={{ fontSize:'0.7rem', color:'var(--gray-400)' }}>(Admin only)</span>}</label>
                <input className="form-input" value={form.internal_name} onChange={e => set('internal_name', e.target.value)}
                  readOnly={!isAdmin} style={!isAdmin ? { background:'var(--gray-50)', color:'var(--gray-500)', cursor:'not-allowed' } : {}} />
              </div>
              <div className="form-group">
                <label className="form-label">Group Name</label>
                <input className="form-input" value={form.group_name} onChange={e => set('group_name', e.target.value)} />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Description</label>
              <textarea className="form-textarea" value={form.description} onChange={e => set('description', e.target.value)}
                placeholder="Brief description…" style={{ minHeight: 60 }} />
            </div>

            {isAdmin && (
              <div className="form-group">
                <label className="form-label">Supervisor</label>
                <select className="form-select" value={form.supervisor_id} onChange={e => set('supervisor_id', e.target.value)}>
                  <option value="">— Unassigned —</option>
                  {supervisors.map(s => <option key={s.id} value={s.id}>{s.first_name} {s.last_name}</option>)}
                </select>
              </div>
            )}

            <div className="form-group">
              <label className="form-label">Instructor {!isAdmin && <span style={{ fontSize:'0.7rem', color:'var(--gray-400)' }}>(Admin only)</span>}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select className="form-select" value={form.instructor_id} onChange={e => set('instructor_id', e.target.value)}
                  disabled={!isAdmin} style={{ flex:1, ...(isAdmin ? {} : { background:'var(--gray-50)', color:'var(--gray-500)' }) }}>
                  <option value="">— Select instructor —</option>
                  {instructors.map(i => <option key={i.id} value={i.id}>{i.first_name} {i.last_name}</option>)}
                </select>
                {isAdmin && (
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowNewInstructor(v => !v)}>+ New</button>
                )}
              </div>
              {showNewInstructor && (
                <NewInstructorInline onCreated={handleInstructorCreated} onCancel={() => setShowNewInstructor(false)} />
              )}
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Start Date</label>
                <input className="form-input" type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Day of Week</label>
                <input className="form-input" value={dayName || '—'} readOnly style={{ background:'var(--gray-50)', color:'var(--gray-600)', cursor:'default' }} />
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

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Start Time</label>
                <input className="form-input" type="time" value={form.start_time} onChange={e => set('start_time', e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">ECW Start Time</label>
                <input className="form-input" type="time" value={form.ecw_time} onChange={e => set('ecw_time', e.target.value)} />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Duration (minutes)</label>
                <input className="form-input" type="number" min="1" value={form.default_duration} onChange={e => set('default_duration', e.target.value)} onWheel={e => e.preventDefault()} />
              </div>
              <div className="form-group">
                <label className="form-label">End Time (computed)</label>
                <input className="form-input" value={end_time || '—'} readOnly style={{ background:'var(--gray-50)', color:'var(--gray-600)', cursor:'default' }} />
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-gold" disabled={loading}>{loading ? 'Saving…' : 'Save Changes'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

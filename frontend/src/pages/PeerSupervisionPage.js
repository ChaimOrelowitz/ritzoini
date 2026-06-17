import { useState, useEffect } from 'react';
import { api } from '../utils/api';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, mo, d] = iso.split('-');
  return `${mo}/${d}/${y}`;
}

const blankCohort = { name: '', day_of_week: '1', time: '10:00' };

export default function PeerSupervisionPage() {
  const [cohorts,  setCohorts]  = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading,  setLoading]  = useState(true);

  // add/edit cohort form
  const [showAdd,   setShowAdd]   = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form,      setForm]      = useState(blankCohort);
  const [saving,    setSaving]    = useState(false);

  // generate form per cohort
  const [genOpen,  setGenOpen]  = useState({});   // cohortId → bool
  const [genForm,  setGenForm]  = useState({});   // cohortId → { start_date, occurrences }
  const [genBusy,  setGenBusy]  = useState({});

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const [c, s] = await Promise.all([
      api.get('/ps/cohorts').catch(() => []),
      api.get('/ps/sessions').catch(() => []),
    ]);
    setCohorts(Array.isArray(c) ? c : []);
    setSessions(Array.isArray(s) ? s : []);
    setLoading(false);
  }

  function openAdd() { setForm(blankCohort); setEditingId(null); setShowAdd(true); }
  function openEdit(c) { setForm({ name: c.name, day_of_week: String(c.day_of_week), time: c.time.slice(0, 5) }); setEditingId(c.id); setShowAdd(true); }

  async function saveCohort() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      if (editingId) {
        const updated = await api.put(`/ps/cohorts/${editingId}`, form);
        setCohorts(cs => cs.map(c => c.id === editingId ? updated : c));
      } else {
        const created = await api.post('/ps/cohorts', form);
        setCohorts(cs => [...cs, created]);
      }
      setShowAdd(false);
    } catch (ex) { alert(ex.message); }
    finally { setSaving(false); }
  }

  async function deleteCohort(id) {
    if (!window.confirm('Delete this cohort and all its sessions?')) return;
    await api.delete(`/ps/cohorts/${id}`);
    setCohorts(cs => cs.filter(c => c.id !== id));
    setSessions(ss => ss.filter(s => s.cohort_id !== id));
  }

  function toggleGen(id) {
    setGenOpen(o => ({ ...o, [id]: !o[id] }));
    setGenForm(f => ({ ...f, [id]: f[id] || { start_date: '', occurrences: '10' } }));
  }

  async function generate(cohortId) {
    const { start_date, occurrences } = genForm[cohortId] || {};
    if (!start_date || !occurrences) return;
    setGenBusy(b => ({ ...b, [cohortId]: true }));
    try {
      await api.post(`/ps/cohorts/${cohortId}/generate`, { start_date, occurrences: parseInt(occurrences) });
      const s = await api.get('/ps/sessions').catch(() => []);
      setSessions(Array.isArray(s) ? s : []);
      setGenOpen(o => ({ ...o, [cohortId]: false }));
    } catch (ex) { alert(ex.message); }
    finally { setGenBusy(b => ({ ...b, [cohortId]: false })); }
  }

  async function toggleStatus(sess) {
    const next = sess.status === 'completed' ? 'scheduled' : 'completed';
    const updated = await api.patch(`/ps/sessions/${sess.id}`, { status: next });
    setSessions(ss => ss.map(s => s.id === sess.id ? updated : s));
  }

  async function deleteSession(id) {
    await api.delete(`/ps/sessions/${id}`);
    setSessions(ss => ss.filter(s => s.id !== id));
  }

  const upcoming = sessions.filter(s => s.date >= new Date().toISOString().split('T')[0]);
  const past     = sessions.filter(s => s.date <  new Date().toISOString().split('T')[0]);

  if (loading) return <div style={{ padding: 32, color: 'var(--gray-400)' }}>Loading…</div>;

  return (
    <div style={{ padding: '24px 32px', maxWidth: 860, margin: '0 auto' }}>

      {/* ── Cohorts ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: 'var(--navy)' }}>Peer Supervision Cohorts</h2>
        <button className="btn btn-gold btn-sm" onClick={openAdd}>+ Add Cohort</button>
      </div>

      {/* Add / Edit form */}
      {showAdd && (
        <div style={{ background: '#f8fafc', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: '16px 20px', marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={lbl}>Name</label>
            <input className="form-input" style={{ width: 140 }} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Cohort A" autoFocus />
          </div>
          <div>
            <label style={lbl}>Day</label>
            <select className="form-input" style={{ width: 130 }} value={form.day_of_week} onChange={e => setForm(f => ({ ...f, day_of_week: e.target.value }))}>
              {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </div>
          <div>
            <label style={lbl}>Time</label>
            <input type="time" className="form-input" style={{ width: 120 }} value={form.time} onChange={e => setForm(f => ({ ...f, time: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-gold btn-sm" onClick={saveCohort} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            <button className="btn btn-outline btn-sm" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Cohort list */}
      {cohorts.length === 0 && !showAdd && (
        <p style={{ color: 'var(--gray-400)', fontSize: '0.88rem' }}>No cohorts yet. Add one above.</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 32 }}>
        {cohorts.map(c => (
          <div key={c.id} style={{ background: 'white', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: '14px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '0.95rem' }}>{c.name}</span>
                <span style={{ marginLeft: 12, fontSize: '0.82rem', color: 'var(--gray-500)' }}>
                  {DAYS[c.day_of_week]}s · {fmt12(c.time)} · 30 min · every other week
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-outline btn-xs" onClick={() => toggleGen(c.id)}>
                  {genOpen[c.id] ? 'Cancel' : 'Generate Sessions'}
                </button>
                <button className="btn btn-outline btn-xs" onClick={() => openEdit(c)}>Edit</button>
                <button className="btn btn-danger btn-xs" onClick={() => deleteCohort(c.id)}>Delete</button>
              </div>
            </div>

            {/* Generate panel */}
            {genOpen[c.id] && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--gray-100)', display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div>
                  <label style={lbl}>Start date</label>
                  <input type="date" className="form-input" style={{ width: 150 }}
                    value={genForm[c.id]?.start_date || ''}
                    onChange={e => setGenForm(f => ({ ...f, [c.id]: { ...f[c.id], start_date: e.target.value } }))} />
                </div>
                <div>
                  <label style={lbl}>Occurrences</label>
                  <input type="number" className="form-input" style={{ width: 80 }} min={1} max={52}
                    value={genForm[c.id]?.occurrences || '10'}
                    onChange={e => setGenForm(f => ({ ...f, [c.id]: { ...f[c.id], occurrences: e.target.value } }))} />
                </div>
                <button className="btn btn-gold btn-sm" onClick={() => generate(c.id)} disabled={genBusy[c.id]}>
                  {genBusy[c.id] ? 'Generating…' : 'Generate'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── Sessions ── */}
      <h2 style={{ margin: '0 0 14px', fontSize: '1.15rem', fontWeight: 700, color: 'var(--navy)' }}>Schedule</h2>

      {sessions.length === 0 && (
        <p style={{ color: 'var(--gray-400)', fontSize: '0.88rem' }}>No sessions yet. Generate sessions from a cohort above.</p>
      )}

      {upcoming.length > 0 && (
        <SessionTable label="Upcoming" rows={upcoming} onToggle={toggleStatus} onDelete={deleteSession} />
      )}
      {past.length > 0 && (
        <SessionTable label="Past" rows={past} onToggle={toggleStatus} onDelete={deleteSession} dimmed />
      )}
    </div>
  );
}

function SessionTable({ label, rows, onToggle, onDelete, dimmed }) {
  const [open, setOpen] = useState(label === 'Upcoming');
  return (
    <div style={{ marginBottom: 24 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 8,
        fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
        color: 'var(--gray-400)', display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {open ? '▾' : '▸'} {label} ({rows.length})
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map(s => {
            const done = s.status === 'completed';
            return (
              <div key={s.id} style={{
                background: 'white', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
                padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 14,
                opacity: dimmed && !done ? 0.6 : 1,
              }}>
                <div style={{ minWidth: 90, fontWeight: 600, fontSize: '0.85rem', color: done ? 'var(--gray-400)' : 'var(--navy)', textDecoration: done ? 'line-through' : 'none' }}>
                  {fmtDate(s.date)}
                </div>
                <div style={{ flex: 1, fontSize: '0.82rem', color: 'var(--gray-600)' }}>
                  {s.cohort?.name} · {DAYS[s.cohort?.day_of_week]} · {fmt12(s.cohort?.time)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.8rem', color: 'var(--gray-700)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={done} onChange={() => onToggle(s)}
                      style={{ width: 15, height: 15, accentColor: 'var(--navy)' }} />
                    Done
                  </label>
                  <button className="btn btn-danger btn-xs" onClick={() => onDelete(s.id)}>✕</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const lbl = { display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 };

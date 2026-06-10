import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y.slice(2)}`;
}

function formatTime12(t) {
  if (!t) return '';
  let [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')}${ampm}`;
}

function formatWeekRange(ws, we) {
  if (!ws) return '';
  return `${formatDate(ws)} – ${formatDate(we)}`;
}

function apptDayLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00Z');
  return DAY_NAMES[d.getUTCDay()];
}

// ── Appointment creation modal ─────────────────────────────────────────────
function NewApptModal({ client, onClose, onCreated }) {
  const today = new Date().toISOString().split('T')[0];
  const [date, setDate] = useState(today);
  const [time, setTime] = useState('10:00');
  const [duration, setDuration] = useState(45);
  const [repeatWeeks, setRepeatWeeks] = useState(12);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      await api.post('/oo/appointments', { client_id: client.id, date, time, duration, repeat_weeks: repeatWeeks });
      onCreated();
    } catch (ex) {
      setErr(ex.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ margin: 0, fontSize: '1rem' }}>Schedule — {client.first_name} {client.last_name}</h2>
          <button className="btn-ghost" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px' }}>
          <div>
            <label style={labelSt}>Start date</label>
            <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} required />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={labelSt}>Time</label>
              <input type="time" className="input" value={time} onChange={e => setTime(e.target.value)} required />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelSt}>Duration (min)</label>
              <input type="number" className="input" value={duration} min={15} max={120} onChange={e => setDuration(Number(e.target.value))} />
            </div>
          </div>
          <div>
            <label style={labelSt}>Repeat (weeks)</label>
            <input type="number" className="input" value={repeatWeeks} min={1} max={52} onChange={e => setRepeatWeeks(Number(e.target.value))} />
          </div>
          {err && <p style={{ color: 'var(--danger)', margin: 0, fontSize: '0.82rem' }}>{err}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Create'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Notes modal ────────────────────────────────────────────────────────────
function NotesModal({ client, appt, onClose, onSaved }) {
  const [notes, setNotes] = useState(appt.raw_notes || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      await api.patch(`/oo/appointments/${appt.id}`, { raw_notes: notes });
      onSaved();
    } catch (ex) {
      setErr(ex.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 500 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ margin: 0, fontSize: '1rem' }}>
            Notes — {client.first_name} {client.last_name}
            <span style={{ fontWeight: 400, marginLeft: 8, color: 'var(--gray-400)' }}>
              {apptDayLabel(appt.date)} {formatDate(appt.date)} {formatTime12(appt.time)}
            </span>
          </h2>
          <button className="btn-ghost" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px' }}>
          <textarea
            className="input"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={7}
            placeholder="Session notes…"
            style={{ resize: 'vertical', fontFamily: 'inherit' }}
            autoFocus
          />
          {err && <p style={{ color: 'var(--danger)', margin: 0, fontSize: '0.82rem' }}>{err}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Notes'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

const labelSt = { display: 'block', fontSize: '0.75rem', color: 'var(--gray-400)', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' };

// ── Bucket card ─────────────────────────────────────────────────────────────
function ClientCard({ c, onSchedule, onNotes, onGoToClient }) {
  const appt = c.next_appointment;
  const bucket = !appt ? 'none' : c.called ? 'called' : 'pending';

  const borderColor = bucket === 'none' ? 'var(--warning, #f59e0b)' : bucket === 'called' ? 'var(--success, #22c55e)' : 'var(--navy)';
  const bg = bucket === 'none' ? '#fffbeb' : bucket === 'called' ? '#f0fdf4' : '#fff';

  return (
    <div style={{
      background: bg,
      border: `1.5px solid ${borderColor}`,
      borderRadius: 10,
      padding: '12px 16px',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      cursor: 'pointer',
    }} onClick={() => onGoToClient(c.id)}>
      {/* Name + referral */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>{c.first_name} {c.last_name}</div>
        {c.oo_referral_sources?.name && (
          <div style={{ fontSize: '0.75rem', color: 'var(--gray-400)', marginTop: 1 }}>{c.oo_referral_sources.name}</div>
        )}
      </div>

      {/* Appointment info */}
      <div style={{ textAlign: 'right', minWidth: 90 }}>
        {appt ? (
          <>
            <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{apptDayLabel(appt.date)} {formatTime12(appt.time)}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>{formatDate(appt.date)}</div>
          </>
        ) : (
          <span style={{ fontSize: '0.75rem', color: 'var(--warning, #f59e0b)', fontWeight: 600 }}>No appt</span>
        )}
      </div>

      {/* Action button */}
      <div onClick={e => e.stopPropagation()}>
        {bucket === 'none' && (
          <button className="btn-primary" style={{ fontSize: '0.78rem', padding: '5px 12px' }} onClick={() => onSchedule(c)}>
            Schedule
          </button>
        )}
        {bucket === 'pending' && (
          <button className="btn-primary" style={{ fontSize: '0.78rem', padding: '5px 12px' }} onClick={() => onNotes(c, appt)}>
            Add Notes
          </button>
        )}
        {bucket === 'called' && (
          <button className="btn-ghost" style={{ fontSize: '0.78rem', padding: '5px 12px' }} onClick={() => onNotes(c, appt)}>
            Edit Notes
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function OOCallsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [scheduleClient, setScheduleClient] = useState(null);
  const [notesTarget, setNotesTarget] = useState(null); // { client, appt }

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const d = await api.get('/oo/appointments/calls');
      setData(d);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function handleCreated() { setScheduleClient(null); load(); }
  function handleSaved()   { setNotesTarget(null);    load(); }

  if (loading) return <div style={{ padding: 32, textAlign: 'center' }}>Loading…</div>;
  if (err) return <div style={{ padding: 32, color: 'var(--danger)' }}>{err}</div>;
  if (!data) return null;

  const { clients, week_start, week_end } = data;

  const noAppt   = clients.filter(c => !c.next_appointment);
  const pending  = clients.filter(c =>  c.next_appointment && !c.called)
                          .sort((a, b) => {
                            const da = a.next_appointment, db = b.next_appointment;
                            if (da.date !== db.date) return da.date.localeCompare(db.date);
                            return da.time.localeCompare(db.time);
                          });
  const called   = clients.filter(c =>  c.next_appointment &&  c.called);

  const totalDone = called.length;
  const totalLeft = noAppt.length + pending.length;

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '24px 16px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.2rem' }}>Calls</h2>
          <div style={{ fontSize: '0.8rem', color: 'var(--gray-400)', marginTop: 2 }}>
            Week of {formatWeekRange(week_start, week_end)}
          </div>
        </div>
        <div style={{ fontSize: '0.82rem', color: 'var(--gray-400)' }}>
          {totalDone} done · {totalLeft} remaining
        </div>
      </div>

      {/* No appointment bucket */}
      {noAppt.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <div style={bucketHeaderSt('#f59e0b')}>
            No Appointment This Week
            <span style={countBadgeSt('#f59e0b')}>{noAppt.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {noAppt.map(c => (
              <ClientCard
                key={c.id} c={c}
                onSchedule={setScheduleClient}
                onNotes={(cl, ap) => setNotesTarget({ client: cl, appt: ap })}
                onGoToClient={id => navigate(`/oo/clients/${id}`)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Pending bucket */}
      {pending.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <div style={bucketHeaderSt('var(--navy)')}>
            Pending — needs notes
            <span style={countBadgeSt('var(--navy)')}>{pending.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pending.map(c => (
              <ClientCard
                key={c.id} c={c}
                onSchedule={setScheduleClient}
                onNotes={(cl, ap) => setNotesTarget({ client: cl, appt: ap })}
                onGoToClient={id => navigate(`/oo/clients/${id}`)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Called / done bucket */}
      {called.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <div style={bucketHeaderSt('#22c55e')}>
            Done
            <span style={countBadgeSt('#22c55e')}>{called.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {called.map(c => (
              <ClientCard
                key={c.id} c={c}
                onSchedule={setScheduleClient}
                onNotes={(cl, ap) => setNotesTarget({ client: cl, appt: ap })}
                onGoToClient={id => navigate(`/oo/clients/${id}`)}
              />
            ))}
          </div>
        </section>
      )}

      {clients.length === 0 && (
        <p style={{ color: 'var(--gray-400)', textAlign: 'center', marginTop: 60 }}>No active clients.</p>
      )}

      {/* Modals */}
      {scheduleClient && (
        <NewApptModal client={scheduleClient} onClose={() => setScheduleClient(null)} onCreated={handleCreated} />
      )}
      {notesTarget && (
        <NotesModal
          client={notesTarget.client}
          appt={notesTarget.appt}
          onClose={() => setNotesTarget(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

const bucketHeaderSt = color => ({
  display: 'flex', alignItems: 'center', gap: 8,
  fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.06em', color, marginBottom: 10,
});

const countBadgeSt = color => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  minWidth: 20, height: 20, padding: '0 6px',
  background: color, color: '#fff',
  borderRadius: 10, fontSize: '0.7rem', fontWeight: 700,
});

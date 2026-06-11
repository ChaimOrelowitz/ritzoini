import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SCHED_DAYS = [0, 1, 2, 3, 4, 5]; // Sun–Fri (no Shabbos)

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

// ── Bulk schedule modal ────────────────────────────────────────────────────
function BulkScheduleModal({ clients, onClose, onDone }) {
  const today = new Date().toISOString().split('T')[0];
  const [weeks, setWeeks]         = useState(12);
  const [startDate, setStartDate] = useState(today);
  const [startTime, setStartTime] = useState('09:00');
  const [saving, setSaving]       = useState(false);
  const [result, setResult]       = useState(null);
  const [err, setErr]             = useState('');

  const [selections, setSelections] = useState(() => {
    const s = {};
    for (const c of clients) s[c.id] = { days: new Set(), duration: 45 };
    return s;
  });

  function toggleDay(clientId, day) {
    setSelections(prev => {
      const days = new Set(prev[clientId].days);
      days.has(day) ? days.delete(day) : days.add(day);
      return { ...prev, [clientId]: { ...prev[clientId], days } };
    });
  }

  function setDur(clientId, d) {
    setSelections(prev => ({ ...prev, [clientId]: { ...prev[clientId], duration: d } }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const assignments = clients
      .filter(c => selections[c.id]?.days.size > 0)
      .map(c => ({ client_id: c.id, days: [...selections[c.id].days], duration: selections[c.id].duration }));
    if (!assignments.length) { setErr('Select at least one day for at least one client.'); return; }
    setSaving(true); setErr('');
    try {
      const r = await api.post('/oo/appointments/bulk-schedule', { assignments, weeks, start_date: startDate, start_time: startTime });
      setResult(r);
    } catch (ex) { setErr(ex.message); setSaving(false); }
  }

  if (result) {
    return (
      <div className="modal-overlay" onClick={onDone}>
        <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h2 style={{ margin: 0, fontSize: '1rem' }}>Bulk Schedule — Done</h2>
            <button className="btn-ghost" onClick={onDone}>✕</button>
          </div>
          <div style={{ padding: '18px 20px' }}>
            <p style={{ margin: 0, fontSize: '0.95rem' }}>
              Created <strong>{result.created}</strong> appointments across <strong>{result.total_dates}</strong> dates.
            </p>
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn-primary" onClick={onDone}>Done</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 720, width: '96vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ margin: 0, fontSize: '1rem' }}>Bulk Schedule</h2>
          <button className="btn-ghost" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          {/* Options row */}
          <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--gray-200)', display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label style={labelSt}>Start date</label>
              <input type="date" className="input" style={{ width: 152 }} value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div>
              <label style={labelSt}>First appt at</label>
              <input type="time" className="input" style={{ width: 120 }} value={startTime} onChange={e => setStartTime(e.target.value)} />
            </div>
            <div>
              <label style={labelSt}>Weeks</label>
              <input type="number" className="input" style={{ width: 76 }} value={weeks} min={1} max={52} onChange={e => setWeeks(Number(e.target.value))} />
            </div>
          </div>

          {/* Client grid */}
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                <tr>
                  <th style={{ textAlign: 'left', padding: '10px 20px', fontSize: '0.72rem', color: 'var(--gray-400)', fontWeight: 700, textTransform: 'uppercase' }}>Client</th>
                  {SCHED_DAYS.map(d => (
                    <th key={d} style={{ textAlign: 'center', padding: '10px 6px', fontSize: '0.72rem', color: 'var(--gray-400)', fontWeight: 700, textTransform: 'uppercase' }}>
                      {DAY_NAMES[d]}
                    </th>
                  ))}
                  <th style={{ textAlign: 'center', padding: '10px 6px', fontSize: '0.72rem', color: 'var(--gray-400)', fontWeight: 700, textTransform: 'uppercase' }}>Min</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c, i) => {
                  const sel = selections[c.id];
                  return (
                    <tr key={c.id} style={{ borderTop: '1px solid var(--gray-100)' }}>
                      <td style={{ padding: '8px 20px', fontSize: '0.88rem', fontWeight: 500, whiteSpace: 'nowrap' }}>
                        {c.first_name} {c.last_name}
                      </td>
                      {SCHED_DAYS.map(day => {
                        const on = sel.days.has(day);
                        return (
                          <td key={day} style={{ textAlign: 'center', padding: '8px 4px' }}>
                            <button
                              type="button"
                              onClick={() => toggleDay(c.id, day)}
                              style={{
                                width: 34, height: 34, borderRadius: '50%', padding: 0,
                                border: `2px solid ${on ? 'var(--navy)' : 'var(--gray-300)'}`,
                                background: on ? 'var(--navy)' : 'transparent',
                                color: on ? '#fff' : 'var(--gray-400)',
                                fontSize: '0.68rem', fontWeight: 700, cursor: 'pointer',
                                transition: 'background 0.12s, border-color 0.12s',
                              }}
                            >{DAY_NAMES[day][0]}</button>
                          </td>
                        );
                      })}
                      <td style={{ textAlign: 'center', padding: '8px 8px' }}>
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                          {[30, 45].map(d => (
                            <button key={d} type="button" onClick={() => setDur(c.id, d)}
                              style={{
                                padding: '3px 7px', fontSize: '0.72rem', fontWeight: 700, borderRadius: 4, cursor: 'pointer',
                                border: `1.5px solid ${sel.duration === d ? 'var(--navy)' : 'var(--gray-300)'}`,
                                background: sel.duration === d ? 'var(--navy)' : 'transparent',
                                color: sel.duration === d ? '#fff' : 'var(--gray-400)',
                              }}
                            >{d}</button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {err && <p style={{ color: 'var(--danger)', margin: '0 20px 8px', fontSize: '0.82rem' }}>{err}</p>}
          <div style={{ padding: '12px 20px', borderTop: '1px solid var(--gray-200)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Scheduling…' : 'Schedule'}</button>
          </div>
        </form>
      </div>
    </div>
  );
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

  const [conflicts, setConflicts] = useState([]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setErr('');
    setConflicts([]);
    try {
      const r = await api.post('/oo/appointments', { client_id: client.id, date, time, duration, repeat_weeks: repeatWeeks });
      if (r.conflicts?.length) {
        setConflicts(r.conflicts);
        setSaving(false);
        // don't close — let user see the warning first
      } else {
        onCreated();
      }
    } catch (ex) {
      setErr(ex.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
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
              <label style={labelSt}>Duration</label>
              <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                {[30, 45].map(d => (
                  <label key={d} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.88rem', cursor: 'pointer' }}>
                    <input type="radio" name="duration" value={d} checked={duration === d} onChange={() => setDuration(d)} />
                    {d} min
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div>
            <label style={labelSt}>Repeat (weeks)</label>
            <input type="number" className="input" value={repeatWeeks} min={1} max={52} onChange={e => setRepeatWeeks(Number(e.target.value))} />
          </div>
          {conflicts.length > 0 && (
            <div style={{ background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 6, padding: '8px 12px', fontSize: '0.8rem', color: '#92400e' }}>
              <strong>⚠ Scheduling conflict</strong> — appointments were created but overlap with:
              <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                {conflicts.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}
          {err && <p style={{ color: 'var(--danger)', margin: 0, fontSize: '0.82rem' }}>{err}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            {conflicts.length > 0
              ? <button type="button" className="btn-primary" onClick={onCreated}>Got it — close</button>
              : <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Create'}</button>
            }
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
    <div className="modal-overlay" onClick={onClose}>
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
  const [notesTarget, setNotesTarget]     = useState(null); // { client, appt }
  const [showBulk, setShowBulk]           = useState(false);

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
            Next 7 days · {formatWeekRange(week_start, week_end)}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: '0.82rem', color: 'var(--gray-400)' }}>
            {totalDone} done · {totalLeft} remaining
          </div>
          <button className="btn-primary" style={{ fontSize: '0.78rem', padding: '5px 12px' }} onClick={() => setShowBulk(true)}>
            Bulk Schedule
          </button>
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
      {showBulk && (
        <BulkScheduleModal
          clients={clients}
          onClose={() => setShowBulk(false)}
          onDone={() => { setShowBulk(false); load(); }}
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

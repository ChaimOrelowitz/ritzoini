import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';
import ApptCard from '../components/shared/OOApptCard';

const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const SCHED_DAYS = [0,1,2,3,4,5];

function fmt12(t) {
  if (!t) return '';
  let [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2,'0')}${ap}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y,m,d] = iso.split('-');
  return `${m}/${d}/${y.slice(2)}`;
}

function getWeekBounds(anchor) {
  const d = new Date(anchor + 'T12:00:00Z');
  const sun = new Date(d);
  sun.setUTCDate(d.getUTCDate() - d.getUTCDay());
  const sat = new Date(sun);
  sat.setUTCDate(sun.getUTCDate() + 6);
  return { start: sun.toISOString().split('T')[0], end: sat.toISOString().split('T')[0] };
}

function fmtWeekLabel(start, end) {
  if (!start) return '';
  const fmt = (iso) => {
    const [, m, d] = iso.split('-');
    return `${parseInt(m)}/${parseInt(d)}`;
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

const labelSt = { display:'block', fontSize:'0.75rem', color:'var(--gray-400)', marginBottom:4, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em' };

// ── Pipeline definitions ─────────────────────────────────────────────────────
// A client linked to InSync gets the full EHR workflow; everyone else gets the
// lighter note → AI → email pipeline.
const PIPELINE_INSYNC = [
  { key: 'visit',  label: 'Visit',  test: a => !!a.insync_visit_id },
  { key: 'note',   label: 'Note',   test: a => !!a.raw_notes?.trim() },
  { key: 'ai',     label: 'AI',     test: a => !!a.ai_fields },
  { key: 'pushed', label: 'Pushed', test: a => !!a.insync_encounter_id },
  { key: 'closed', label: 'Closed', test: a => !!a.note_done_at },
];
const PIPELINE_EMAIL = [
  { key: 'note', label: 'Note', test: a => !!a.raw_notes?.trim() },
  { key: 'ai',   label: 'AI',   test: a => !!a.ai_fields },
  { key: 'sent', label: 'Sent', test: a => !!a.note_sent_at },
  { key: 'done', label: 'Done', test: a => !!a.note_done_at },
];

function getPipeline(appt) {
  return appt.oo_clients?.insync_patient_id ? PIPELINE_INSYNC : PIPELINE_EMAIL;
}

function isApptDone(appt) {
  const stages = getPipeline(appt);
  return stages[stages.length - 1].test(appt);
}

// ── Pipeline stepper — at-a-glance progress dots ────────────────────────────
function PipelineStepper({ appt }) {
  const stages = getPipeline(appt);
  let nextFound = false;

  return (
    <div style={{ display:'flex', alignItems:'center' }}>
      {stages.map((s, i) => {
        const done = s.test(appt);
        const prevDone = i === 0 || stages[i - 1].test(appt);
        const isNext = !done && !nextFound && prevDone;
        if (isNext) nextFound = true;
        return (
          <div key={s.key} style={{ display:'flex', alignItems:'center' }}>
            {i > 0 && (
              <div style={{ width:12, height:2, background: prevDone ? 'var(--navy)' : 'var(--gray-200)' }} />
            )}
            <div title={s.label} style={{
              width:22, height:22, borderRadius:'50%', flexShrink:0,
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:'0.6rem', fontWeight:700, boxSizing:'border-box',
              background: done ? 'var(--navy)' : isNext ? '#fef3c7' : 'var(--gray-100)',
              color: done ? '#fff' : isNext ? '#b45309' : 'var(--gray-400)',
              border: isNext ? '2px solid #f59e0b' : '2px solid transparent',
            }}>
              {done ? '✓' : i + 1}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Bulk Schedule Modal ──────────────────────────────────────────────────────
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
    for (const c of clients) {
      const mins = c.insync_data?.typical_session_minutes;
      s[c.id] = { days: new Set(), duration: mins === 30 ? 30 : 45 };
    }
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
        <div className="modal" style={{ maxWidth:420 }} onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h2 style={{ margin:0, fontSize:'1rem' }}>Bulk Schedule — Done</h2>
            <button className="modal-close" onClick={onDone}>×</button>
          </div>
          <div className="modal-body">
            <p style={{ margin:0, fontSize:'0.95rem' }}>
              Created <strong>{result.created}</strong> appointments across <strong>{result.total_dates}</strong> dates.
            </p>
            <div style={{ marginTop:16, display:'flex', justifyContent:'flex-end' }}>
              <button className="btn btn-gold" onClick={onDone}>Done</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth:720, width:'96vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Bulk Schedule</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ padding:'12px 28px', borderBottom:'1px solid var(--gray-100)', display:'flex', gap:14, flexWrap:'wrap', alignItems:'flex-end' }}>
            <div>
              <label style={labelSt}>Start date</label>
              <input type="date" className="form-input" style={{ width:152 }} value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div>
              <label style={labelSt}>First appt at</label>
              <input type="time" className="form-input" style={{ width:120 }} value={startTime} onChange={e => setStartTime(e.target.value)} />
            </div>
            <div>
              <label style={labelSt}>Weeks</label>
              <input type="number" className="form-input" style={{ width:76 }} value={weeks} min={1} max={52} onChange={e => setWeeks(Number(e.target.value))} />
            </div>
          </div>
          <div style={{ maxHeight:420, overflowY:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead style={{ position:'sticky', top:0, background:'#fff', zIndex:1 }}>
                <tr>
                  <th style={{ textAlign:'left', padding:'10px 28px', fontSize:'0.72rem', color:'var(--gray-400)', fontWeight:700, textTransform:'uppercase' }}>Client</th>
                  {SCHED_DAYS.map(d => (
                    <th key={d} style={{ textAlign:'center', padding:'10px 6px', fontSize:'0.72rem', color:'var(--gray-400)', fontWeight:700, textTransform:'uppercase' }}>
                      {DAY_NAMES[d]}
                    </th>
                  ))}
                  <th style={{ textAlign:'center', padding:'10px 6px', fontSize:'0.72rem', color:'var(--gray-400)', fontWeight:700, textTransform:'uppercase' }}>Min</th>
                  <th style={{ textAlign:'center', padding:'10px 6px', fontSize:'0.72rem', color:'var(--gray-400)', fontWeight:700, textTransform:'uppercase' }}>Last</th>
                </tr>
              </thead>
              <tbody>
                {clients.map(c => {
                  const sel = selections[c.id] || { days: new Set(), duration: 45 };
                  const lastMin = c.insync_data?.typical_session_minutes;
                  return (
                    <tr key={c.id} style={{ borderTop:'1px solid var(--gray-100)' }}>
                      <td style={{ padding:'8px 28px', fontSize:'0.88rem', fontWeight:500, whiteSpace:'nowrap' }}>
                        {c.first_name} {c.last_name}
                      </td>
                      {SCHED_DAYS.map(day => {
                        const on = sel.days.has(day);
                        return (
                          <td key={day} style={{ textAlign:'center', padding:'8px 4px' }}>
                            <button type="button" onClick={() => toggleDay(c.id, day)} style={{
                              width:34, height:34, borderRadius:'50%', padding:0,
                              border:`2px solid ${on ? 'var(--navy)' : 'var(--gray-200)'}`,
                              background: on ? 'var(--navy)' : 'transparent',
                              color: on ? '#fff' : 'var(--gray-400)',
                              fontSize:'0.68rem', fontWeight:700, cursor:'pointer',
                            }}>{DAY_NAMES[day][0]}</button>
                          </td>
                        );
                      })}
                      <td style={{ textAlign:'center', padding:'8px' }}>
                        <div style={{ display:'flex', gap:4, justifyContent:'center' }}>
                          {[30,45].map(d => (
                            <button key={d} type="button" onClick={() => setDur(c.id, d)} style={{
                              padding:'3px 7px', fontSize:'0.72rem', fontWeight:700, borderRadius:4, cursor:'pointer',
                              border:`1.5px solid ${sel.duration === d ? 'var(--navy)' : 'var(--gray-200)'}`,
                              background: sel.duration === d ? 'var(--navy)' : 'transparent',
                              color: sel.duration === d ? '#fff' : 'var(--gray-400)',
                            }}>{d}</button>
                          ))}
                        </div>
                      </td>
                      <td style={{ textAlign:'center', padding:'8px', fontSize:'0.8rem', color: lastMin ? 'var(--navy)' : 'var(--gray-300)', fontWeight: lastMin ? 600 : 400 }}>
                        {lastMin ? `${lastMin}m` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {err && <p style={{ color:'#dc2626', margin:'0 28px 8px', fontSize:'0.82rem' }}>{err}</p>}
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-gold" disabled={saving}>{saving ? 'Scheduling…' : 'Schedule'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Appointment row ──────────────────────────────────────────────────────────
function ApptRow({ appt, expanded, onToggle, onUpdate, onDelete, today }) {
  const c = appt.oo_clients;
  const name = c ? `${c.last_name}, ${c.first_name}` : '—';
  const dayIdx = new Date(appt.date + 'T12:00:00Z').getUTCDay();
  const done = isApptDone(appt);
  const dueNow = !done && appt.date <= today;

  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          cursor:'pointer',
          background: expanded ? 'var(--gray-50)' : dueNow ? '#fef9ec' : undefined,
          borderLeft: done ? '3px solid #86efac' : dueNow ? '3px solid #f59e0b' : '3px solid transparent',
        }}
        onMouseEnter={e => { if (!expanded) e.currentTarget.style.background = dueNow ? '#fdf2d8' : 'var(--gray-50)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = expanded ? 'var(--gray-50)' : (dueNow ? '#fef9ec' : ''); }}
      >
        <td style={{ padding:'10px 8px', color:'var(--gray-300)', fontSize:'0.7rem', width:18 }}>{expanded ? '▾' : '▸'}</td>
        <td style={{ padding:'10px 16px', fontWeight:600, color:'var(--navy)' }}>{name}</td>
        <td style={{ padding:'10px 12px', color:'var(--gray-600)' }}>{DAY_NAMES[dayIdx]}</td>
        <td style={{ padding:'10px 12px', whiteSpace:'nowrap', color:'var(--gray-600)' }}>{fmtDate(appt.date)}</td>
        <td style={{ padding:'10px 12px', whiteSpace:'nowrap', color:'var(--gray-600)' }}>{fmt12(appt.time)}</td>
        <td style={{ padding:'10px 12px', color:'var(--gray-400)' }}>{appt.duration || 45}m</td>
        <td style={{ padding:'10px 16px' }} onClick={e => e.stopPropagation()}>
          <PipelineStepper appt={appt} />
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} style={{ padding:'4px 16px 16px', background:'var(--gray-50)' }} onClick={e => e.stopPropagation()}>
            <ApptCard appt={appt} client={c} onUpdate={onUpdate} onDelete={onDelete} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function OOCallsPage() {
  const [anchor, setAnchor]         = useState(new Date().toISOString().split('T')[0]);
  const [appts, setAppts]           = useState([]);
  const [allClients, setAllClients] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [showBulk, setShowBulk]     = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  const { start: ws, end: we } = getWeekBounds(anchor);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get(`/oo/appointments?week_start=${ws}&week_end=${we}`);
      setAppts(Array.isArray(data) ? [...data].sort((a,b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.time.localeCompare(b.time);
      }) : []);
    } catch (ex) { console.error(ex); }
    finally { setLoading(false); }
  }, [ws, we]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/oo/appointments/calls')
      .then(d => setAllClients(d?.clients || []))
      .catch(() => {});
  }, []);

  function handleApptUpdate(updated) {
    setAppts(prev => prev.map(a => a.id === updated.id ? { ...a, ...updated } : a));
  }
  function handleApptDelete(apptId) {
    setAppts(prev => prev.filter(a => a.id !== apptId));
    setExpandedId(id => id === apptId ? null : id);
  }

  function shiftWeek(dir) {
    const d = new Date(ws + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + dir * 7);
    setAnchor(d.toISOString().split('T')[0]);
  }

  const today        = new Date().toISOString().split('T')[0];
  const isThisWeek    = ws <= today && today <= we;
  const doneCount      = appts.filter(a => isApptDone(a)).length;
  const dueNowCount    = appts.filter(a => !isApptDone(a) && a.date <= today).length;
  const upcomingCount  = appts.length - doneCount - dueNowCount;

  return (
    <div style={{ padding:'28px 32px', maxWidth:1100, margin:'0 auto' }}>
      {/* Header */}
      <div className="page-header">
        <div>
          <h2 style={{ margin:0 }}>Sessions</h2>
          <p style={{ marginTop:4, display:'flex', gap:14, alignItems:'center' }}>
            <span style={{ color:'#16a34a', fontWeight:600 }}>{doneCount} done</span>
            <span style={{ color: dueNowCount ? '#b45309' : 'var(--gray-400)', fontWeight: dueNowCount ? 600 : 400 }}>{dueNowCount} need action</span>
            <span style={{ color:'var(--gray-400)' }}>{upcomingCount} upcoming</span>
          </p>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <button className="btn btn-outline btn-sm" onClick={() => shiftWeek(-1)}>←</button>
          <button
            className="btn btn-outline btn-sm"
            onClick={() => setAnchor(today)}
            style={{ minWidth:140, fontWeight: isThisWeek ? 700 : 400 }}
          >
            {fmtWeekLabel(ws, we)}
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => shiftWeek(1)}>→</button>
          <button className="btn btn-gold btn-sm" onClick={() => setShowBulk(true)}>Bulk Schedule</button>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign:'center', padding:60, color:'var(--gray-400)' }}>Loading…</div>
      ) : (
        <div className="card" style={{ overflow:'hidden' }}>
          {appts.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📅</div>
              <p>No appointments this week.</p>
            </div>
          ) : (
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'0.85rem' }}>
                <thead>
                  <tr style={{ background:'var(--gray-50)', borderBottom:'1px solid var(--gray-100)' }}>
                    {[
                      { label:'',          w:18 },
                      { label:'Client' },
                      { label:'Day' },
                      { label:'Date' },
                      { label:'Time' },
                      { label:'Duration' },
                      { label:'Pipeline' },
                    ].map(({ label, w }) => (
                      <th key={label || 'expand'} style={{
                        padding:'10px 12px', width: w,
                        textAlign:'left',
                        fontWeight:600, color:'var(--gray-400)',
                        fontSize:'0.72rem', textTransform:'uppercase',
                        letterSpacing:'0.05em', whiteSpace:'nowrap',
                      }}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {appts.map(a => (
                    <ApptRow
                      key={a.id}
                      appt={a}
                      today={today}
                      expanded={expandedId === a.id}
                      onToggle={() => setExpandedId(id => id === a.id ? null : a.id)}
                      onUpdate={handleApptUpdate}
                      onDelete={handleApptDelete}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {showBulk && (
        <BulkScheduleModal
          clients={allClients}
          onClose={() => setShowBulk(false)}
          onDone={() => { setShowBulk(false); load(); }}
        />
      )}
    </div>
  );
}

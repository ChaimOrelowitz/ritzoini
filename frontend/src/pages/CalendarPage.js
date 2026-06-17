import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function fmtEndTime(dateObj) {
  if (!dateObj) return null;
  const h = dateObj.getHours(), m = dateObj.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
}

const STATUS_COLORS = {
  scheduled:  { bg: '#1e40af', border: '#1e40af' },
  completed:  { bg: '#166534', border: '#166534' },
  cancelled:  { bg: '#6b7280', border: '#6b7280' },
  group_ended:{ bg: '#92400e', border: '#92400e' },
};

export default function CalendarPage() {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const calendarRef = useRef(null);

  const [sessions,         setSessions]         = useState([]);
  const [ooAppts,          setOoAppts]          = useState([]);
  const [supervisors,      setSupervisors]      = useState([]);
  const [filterSup,        setFilterSup]        = useState('');
  const [includeArchived,  setIncludeArchived]  = useState(false);
  const [loading,          setLoading]          = useState(true);
  const [view,             setView]             = useState('dayGridMonth');

  useEffect(() => {
    if (isAdmin) api.getUsers().then(u => setSupervisors(u.filter(x => x.role === 'supervisor')));
  }, [isAdmin]);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getCalendarSessions(filterSup || null, includeArchived),
      api.get('/oo/appointments').catch(() => []),
    ]).then(([s, oo]) => {
      setSessions(s);
      setOoAppts(Array.isArray(oo) ? oo : []);
    }).catch(console.error).finally(() => setLoading(false));
  }, [filterSup, includeArchived]);

  const sessionEvents = sessions.map(s => {
    const date = s.session_date || s.scheduled_date;
    const time = s.ecw_time || s.start_time || s.scheduled_time;
    const colors = STATUS_COLORS[s.status] || STATUS_COLORS.scheduled;
    const g = s.groups;
    const title = [g?.internal_name, g?.group_name].filter(Boolean).join(' · ');

    // Compute end from start + duration so stale ecw_end_time never overrides actual length
    const computedEnd = (() => {
      if (!time || !s.duration) return null;
      const [h, m] = time.slice(0, 5).split(':').map(Number);
      const total = h * 60 + m + parseInt(s.duration, 10);
      return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`;
    })();

    return {
      id: s.id,
      title,
      start: time ? `${date}T${time}` : date,
      end: time && computedEnd ? `${date}T${computedEnd}` : undefined,
      allDay: !time,
      backgroundColor: colors.bg,
      borderColor: colors.border,
      extendedProps: {
        groupId: s.group_id,
        sessionId: s.id,
        internalName: g?.internal_name,
        groupName: g?.group_name,
        ecwTime: s.ecw_time,
        status: s.status,
        type: 'group',
      },
    };
  });

  const ooEvents = ooAppts.map(a => {
    const c = a.oo_clients;
    const name = c ? `${c.last_name}, ${c.first_name}` : 'OO';
    const endDate = new Date(`${a.date}T${a.time}`);
    endDate.setMinutes(endDate.getMinutes() + (a.duration || 45));
    const endTime = endDate.toTimeString().slice(0, 8);
    return {
      id: `oo-${a.id}`,
      title: `1:1 ${name}`,
      start: `${a.date}T${a.time}`,
      end: `${a.date}T${endTime}`,
      backgroundColor: '#0e7490',
      borderColor: '#0e7490',
      extendedProps: { type: 'oo', apptId: a.id, clientId: a.client_id },
    };
  });

  const events = [...sessionEvents, ...ooEvents];

  function handleEventClick({ event }) {
    const { type, groupId, sessionId, clientId } = event.extendedProps;
    if (type === 'oo') {
      navigate(`/oo/clients/${clientId}`);
    } else {
      navigate(`/groups/${groupId}?session=${sessionId}`);
    }
  }

  function handleDateClick({ date, view: v }) {
    if (v.type === 'dayGridMonth') {
      const cal = calendarRef.current?.getApi();
      if (cal) {
        cal.changeView('timeGridDay', date);
        setView('timeGridDay');
      }
    }
  }

  function switchView(v) {
    setView(v);
    calendarRef.current?.getApi()?.changeView(v);
  }

  function renderEventContent(info) {
    const { type, ecwTime, groupName, internalName } = info.event.extendedProps;
    const isTimeGrid = info.view.type !== 'dayGridMonth';
    const endLabel = isTimeGrid ? fmtEndTime(info.event.end) : null;
    const endLine = endLabel ? (
      <div style={{ fontSize: '0.65rem', opacity: 0.8, marginTop: 1, overflow: 'hidden', whiteSpace: 'nowrap' }}>
        Ends {endLabel}
      </div>
    ) : null;

    if (type === 'oo') {
      return (
        <div style={{ padding: '1px 3px', overflow: 'hidden', fontSize: '0.75rem', lineHeight: 1.3, cursor: 'pointer' }}>
          <span>{info.event.title}</span>
          {endLine}
        </div>
      );
    }
    return (
      <div style={{ padding: '1px 3px', overflow: 'hidden', fontSize: '0.75rem', lineHeight: 1.3, cursor: 'pointer' }}>
        {ecwTime && <span style={{ fontWeight: 700 }}>{fmt12(ecwTime)} </span>}
        <span>{internalName}</span>
        {groupName && internalName !== groupName && (
          <span style={{ opacity: 0.85 }}> · {groupName}</span>
        )}
        {endLine}
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, color: 'var(--navy)', fontSize: '1.4rem', fontWeight: 700 }}>Calendar</h2>

        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap', alignItems: 'center' }}>
          {isAdmin && (
            <select
              className="form-select"
              style={{ width: 'auto', minWidth: 160, fontSize: '0.85rem' }}
              value={filterSup}
              onChange={e => setFilterSup(e.target.value)}
            >
              <option value="">All Supervisors</option>
              {supervisors.map(s => (
                <option key={s.id} value={s.id}>{s.first_name} {s.last_name}</option>
              ))}
            </select>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', color: 'var(--gray-600)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={includeArchived} onChange={e => setIncludeArchived(e.target.checked)}
              style={{ width: 14, height: 14, accentColor: 'var(--navy)' }} />
            Show archived
          </label>

          <div style={{ display: 'flex', gap: 4 }}>
            <button
              className={`btn btn-sm ${view === 'dayGridMonth' ? 'btn-gold' : 'btn-outline'}`}
              onClick={() => switchView('dayGridMonth')}
            >Month</button>
            <button
              className={`btn btn-sm ${view === 'timeGridWeek' ? 'btn-gold' : 'btn-outline'}`}
              onClick={() => switchView('timeGridWeek')}
            >Week</button>
            <button
              className={`btn btn-sm ${view === 'timeGridDay' ? 'btn-gold' : 'btn-outline'}`}
              onClick={() => switchView('timeGridDay')}
            >Day</button>
          </div>
        </div>
      </div>

      {loading && <div style={{ textAlign: 'center', color: 'var(--gray-400)', padding: 40 }}>Loading sessions…</div>}

      <div style={{ background: 'white', borderRadius: 'var(--radius)', border: '1px solid var(--gray-200)', padding: '16px', display: loading ? 'none' : 'block' }}>
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          headerToolbar={{ left: 'prev,next today', center: 'title', right: '' }}
          events={events}
          eventClick={handleEventClick}
          dateClick={handleDateClick}
          eventContent={renderEventContent}
          height="auto"
          eventDisplay="block"
          dayMaxEvents={4}
          slotDuration="00:15:00"
          slotLabelInterval="00:15:00"
          slotMinTime="07:00:00"
          slotMaxTime="23:00:00"
          slotLabelContent={arg => {
            const mins = arg.date.getMinutes();
            if (mins === 0) return { html: `<span style="font-size:0.8rem;font-weight:600">${arg.text}</span>` };
            return { html: `<span style="font-size:0.65rem;color:#aaa">:${String(mins).padStart(2,'0')}</span>` };
          }}
        />
      </div>
    </div>
  );
}

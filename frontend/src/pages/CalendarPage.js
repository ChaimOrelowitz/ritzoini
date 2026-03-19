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
    api.getCalendarSessions(filterSup || null, includeArchived)
      .then(setSessions)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [filterSup, includeArchived]);

  const events = sessions.map(s => {
    const date = s.session_date || s.scheduled_date;
    const time = s.ecw_time || s.start_time || s.scheduled_time;
    const colors = STATUS_COLORS[s.status] || STATUS_COLORS.scheduled;
    const g = s.groups;
    const title = [g?.internal_name, g?.group_name].filter(Boolean).join(' · ');

    return {
      id: s.id,
      title,
      start: time ? `${date}T${time}` : date,
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
      },
    };
  });

  function handleEventClick({ event }) {
    const { groupId, sessionId } = event.extendedProps;
    navigate(`/groups/${groupId}?session=${sessionId}`);
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
    const { ecwTime, groupName, internalName } = info.event.extendedProps;
    return (
      <div style={{ padding: '1px 3px', overflow: 'hidden', fontSize: '0.75rem', lineHeight: 1.3, cursor: 'pointer' }}>
        {ecwTime && <span style={{ fontWeight: 700 }}>{fmt12(ecwTime)} </span>}
        <span>{internalName}</span>
        {groupName && internalName !== groupName && (
          <span style={{ opacity: 0.85 }}> · {groupName}</span>
        )}
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
          slotMinTime="07:00:00"
          slotMaxTime="23:00:00"
        />
      </div>
    </div>
  );
}

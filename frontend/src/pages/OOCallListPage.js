import { useState, useEffect } from 'react'; // v2
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtDayHeader(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function getRolling7() {
  const today = new Date();
  const start = today.toISOString().split('T')[0];
  const end   = new Date(today.getTime() + 6 * 86400000).toISOString().split('T')[0];
  return { start, end };
}

export default function OOCallListPage() {
  const navigate = useNavigate();
  const [appts,   setAppts]   = useState([]);
  const [loading, setLoading] = useState(true);

  const { start, end } = getRolling7();

  useEffect(() => {
    api.get(`/oo/appointments?week_start=${start}&week_end=${end}`)
      .then(d => {
        const sorted = (Array.isArray(d) ? d : [])
          .filter(a => a.status === 'scheduled')
          .sort((a, b) => a.date !== b.date ? a.date.localeCompare(b.date) : a.time.localeCompare(b.time));
        setAppts(sorted);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  async function toggle(apptId, field, currentVal) {
    const newVal = currentVal ? null : new Date().toISOString();
    setAppts(prev => prev.map(a => a.id === apptId ? { ...a, [field]: newVal } : a));
    try {
      await api.patch(`/oo/appointments/${apptId}`, { [field]: newVal });
    } catch {
      setAppts(prev => prev.map(a => a.id === apptId ? { ...a, [field]: currentVal } : a));
    }
  }

  const total = appts.length;
  const sent  = appts.filter(a => a.note_sent_at).length;
  const done  = appts.filter(a => a.note_done_at).length;

  // Group by date
  const byDate = [];
  let lastDate = null;
  for (const a of appts) {
    if (a.date !== lastDate) { byDate.push({ date: a.date, rows: [] }); lastDate = a.date; }
    byDate[byDate.length - 1].rows.push(a);
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>Calls</h2>
        <span style={{ fontSize: '0.78rem', color: 'var(--gray-400)' }}>Next 7 days</span>
        {!loading && (
          <span style={{ fontSize: '0.8rem', color: 'var(--gray-500)', marginLeft: 4 }}>
            {total} session{total !== 1 ? 's' : ''} · {sent} sent · {done} done
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--gray-400)' }}>Loading…</div>
      ) : appts.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📞</div>
          <p>No scheduled sessions in the next 7 days.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {byDate.map(({ date, rows }) => (
            <div key={date}>
              {/* Day header */}
              <div style={{
                fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)',
                textTransform: 'uppercase', letterSpacing: '0.08em',
                paddingBottom: 6, marginBottom: 2,
                borderBottom: '1px solid var(--gray-100)',
              }}>
                {fmtDayHeader(date)}
              </div>

              {/* Rows for this day */}
              {rows.map(a => {
                const c   = a.oo_clients;
                const rs  = c?.oo_referral_sources;
                const noteSent = !!a.note_sent_at;
                const noteDone = !!a.note_done_at;
                const hasNote  = !!a.raw_notes?.trim();

                return (
                  <div key={a.id}
                    onClick={() => navigate(`/oo/clients/${a.client_id}`)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 0,
                      padding: '11px 0', cursor: 'pointer',
                      borderBottom: '1px solid var(--gray-100)',
                      borderLeft: `3px solid ${noteDone ? '#86efac' : noteSent ? '#93c5fd' : hasNote ? '#fde68a' : 'transparent'}`,
                      paddingLeft: 12,
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--gray-50)'}
                    onMouseLeave={e => e.currentTarget.style.background = ''}
                  >
                    {/* Time */}
                    <div style={{ width: 80, fontSize: '0.82rem', fontWeight: 600, color: 'var(--navy)', flexShrink: 0 }}>
                      {fmt12(a.time)}
                    </div>

                    {/* Client name */}
                    <div style={{ flex: 1, fontSize: '0.9rem', fontWeight: 600, color: 'var(--gray-800)' }}>
                      {c ? `${c.last_name}, ${c.first_name}` : '—'}
                    </div>

                    {/* Referral source */}
                    <div style={{ width: 160, fontSize: '0.78rem', color: 'var(--gray-400)', flexShrink: 0 }}>
                      {rs?.name || ''}
                    </div>

                    {/* Duration */}
                    <div style={{ width: 44, fontSize: '0.75rem', color: 'var(--gray-400)', flexShrink: 0 }}>
                      {a.duration || 45}m
                    </div>

                    {/* Note Sent checkbox */}
                    <div style={{ width: 80, display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}
                      onClick={e => { e.stopPropagation(); toggle(a.id, 'note_sent_at', a.note_sent_at); }}>
                      <input type="checkbox" readOnly checked={noteSent}
                        style={{ width: 15, height: 15, cursor: 'pointer', accentColor: 'var(--navy)', pointerEvents: 'none' }} />
                      <span style={{ fontSize: '0.6rem', color: 'var(--gray-400)', marginTop: 2 }}>Note Sent</span>
                    </div>

                    {/* Done checkbox */}
                    <div style={{ width: 60, display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}
                      onClick={e => { e.stopPropagation(); toggle(a.id, 'note_done_at', a.note_done_at); }}>
                      <input type="checkbox" readOnly checked={noteDone}
                        style={{ width: 15, height: 15, cursor: 'pointer', accentColor: '#16a34a', pointerEvents: 'none' }} />
                      <span style={{ fontSize: '0.6rem', color: 'var(--gray-400)', marginTop: 2 }}>Done</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

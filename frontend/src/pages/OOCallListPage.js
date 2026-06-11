import { useState, useEffect, useRef } from 'react';
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

function fmtStamp(ts) {
  if (!ts) return null;
  return new Date(ts).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function getRolling7() {
  const today = new Date();
  const start = today.toISOString().split('T')[0];
  const end   = new Date(today.getTime() + 6 * 86400000).toISOString().split('T')[0];
  return { start, end };
}

// ── Phone with copy button ────────────────────────────────────────────────────

function PhoneNum({ number, small }) {
  const [copied, setCopied] = useState(false);

  function copy(e) {
    e.stopPropagation();
    navigator.clipboard.writeText(number).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{ fontSize: small ? '0.72rem' : '0.8rem', color: small ? 'var(--gray-400)' : 'var(--gray-700)', fontWeight: small ? 400 : 500 }}>
        {number}
      </span>
      <button
        type="button"
        onClick={copy}
        title="Copy"
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px',
          fontSize: '0.7rem', color: copied ? '#16a34a' : 'var(--gray-300)',
          lineHeight: 1, borderRadius: 3,
          transition: 'color 0.15s',
        }}
        onMouseEnter={e => { if (!copied) e.currentTarget.style.color = 'var(--gray-500)'; }}
        onMouseLeave={e => { if (!copied) e.currentTarget.style.color = 'var(--gray-300)'; }}
      >
        {copied ? '✓' : '⎘'}
      </button>
    </div>
  );
}

// ── Single call row ───────────────────────────────────────────────────────────

function CallRow({ appt: initialAppt, onUpdate }) {
  const navigate = useNavigate();
  const [appt,      setAppt]      = useState(initialAppt);
  const [expanded,  setExpanded]  = useState(false);
  const [notes,     setNotes]     = useState(initialAppt.raw_notes || '');
  const [saveState, setSaveState] = useState('idle');
  const timer = useRef(null);

  useEffect(() => {
    setAppt(initialAppt);
    setNotes(initialAppt.raw_notes || '');
  }, [initialAppt]);

  const c  = appt.oo_clients;
  const rs = c?.oo_referral_sources;

  async function patch(fields) {
    const updated = { ...appt, ...fields };
    setAppt(updated);
    onUpdate(updated);
    try {
      await api.patch(`/oo/appointments/${appt.id}`, fields);
    } catch {
      setAppt(appt);
      onUpdate(appt);
    }
  }

  function handleNotesChange(val) {
    setNotes(val);
    setSaveState('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await api.patch(`/oo/appointments/${appt.id}`, { raw_notes: val });
        setAppt(prev => ({ ...prev, raw_notes: val }));
        onUpdate({ ...appt, raw_notes: val });
        setSaveState('saved');
        setTimeout(() => setSaveState('idle'), 2000);
      } catch { setSaveState('idle'); }
    }, 1000);
  }

  function toggleCalled() {
    patch({ called_at: appt.called_at ? null : new Date().toISOString() });
  }
  function toggleNoteSent() {
    patch({ note_sent_at: appt.note_sent_at ? null : new Date().toISOString() });
  }
  function toggleDone() {
    patch({ note_done_at: appt.note_done_at ? null : new Date().toISOString() });
  }

  const phone = c?.mobile || c?.phone || null;
  const altPhone = c?.mobile && c?.phone && c.mobile !== c.phone ? c.phone : null;

  return (
    <div style={{ borderBottom: '1px solid var(--gray-100)' }}>
      {/* Main row */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '9px 0 9px 8px',
        borderLeft: `3px solid ${appt.note_done_at ? '#86efac' : appt.called_at ? '#93c5fd' : 'transparent'}`,
      }}>

        {/* Expand arrow — only this toggles expansion */}
        <div
          onClick={() => setExpanded(e => !e)}
          style={{ width: 20, fontSize: '0.65rem', color: 'var(--gray-300)', flexShrink: 0, cursor: 'pointer', userSelect: 'none', textAlign: 'center' }}
        >
          {expanded ? '▾' : '▸'}
        </div>

        {/* Time */}
        <div style={{ width: 70, fontSize: '0.8rem', fontWeight: 600, color: 'var(--navy)', flexShrink: 0 }}>
          {fmt12(appt.time)}
        </div>

        {/* Client name — navigates to client detail */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <span
            onClick={() => navigate(`/oo/clients/${appt.client_id}`)}
            style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--navy)', cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'transparent', transition: 'text-decoration-color 0.1s' }}
            onMouseEnter={e => e.currentTarget.style.textDecorationColor = 'var(--navy)'}
            onMouseLeave={e => e.currentTarget.style.textDecorationColor = 'transparent'}
          >
            {c ? `${c.last_name}, ${c.first_name}` : '—'}
          </span>
        </div>

        {/* Phone numbers */}
        <div style={{ width: 185, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {phone
            ? <>
                <PhoneNum number={phone} />
                {altPhone && <PhoneNum number={altPhone} small />}
              </>
            : <span style={{ fontSize: '0.72rem', color: 'var(--gray-300)' }}>no phone</span>
          }
        </div>

        {/* Referral source */}
        <div style={{ width: 120, fontSize: '0.72rem', color: 'var(--gray-400)', flexShrink: 0, paddingRight: 6 }}>
          {rs?.name || ''}
        </div>

        {/* Called */}
        <div style={{ width: 56, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}
          onClick={toggleCalled}>
          <input type="checkbox" readOnly checked={!!appt.called_at}
            style={{ width: 14, height: 14, accentColor: '#2563eb', pointerEvents: 'none' }} />
          <span style={{ fontSize: '0.56rem', color: 'var(--gray-400)', marginTop: 1, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Called</span>
          {appt.called_at && <span style={{ fontSize: '0.56rem', color: '#2563eb', textAlign: 'center', lineHeight: 1.2 }}>{fmtStamp(appt.called_at)}</span>}
        </div>

        {/* Note Sent */}
        <div style={{ width: 56, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}
          onClick={toggleNoteSent}>
          <input type="checkbox" readOnly checked={!!appt.note_sent_at}
            style={{ width: 14, height: 14, accentColor: 'var(--navy)', pointerEvents: 'none' }} />
          <span style={{ fontSize: '0.56rem', color: 'var(--gray-400)', marginTop: 1, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Sent</span>
          {appt.note_sent_at && <span style={{ fontSize: '0.56rem', color: 'var(--gray-500)', textAlign: 'center', lineHeight: 1.2 }}>{fmtStamp(appt.note_sent_at)}</span>}
        </div>

        {/* Done */}
        <div style={{ width: 48, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}
          onClick={toggleDone}>
          <input type="checkbox" readOnly checked={!!appt.note_done_at}
            style={{ width: 14, height: 14, accentColor: '#16a34a', pointerEvents: 'none' }} />
          <span style={{ fontSize: '0.56rem', color: 'var(--gray-400)', marginTop: 1, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Done</span>
          {appt.note_done_at && <span style={{ fontSize: '0.56rem', color: '#16a34a', textAlign: 'center', lineHeight: 1.2 }}>{fmtStamp(appt.note_done_at)}</span>}
        </div>
      </div>

      {/* Expanded notes area */}
      {expanded && (
        <div style={{ padding: '10px 16px 14px 34px', background: 'var(--gray-50)', borderTop: '1px solid var(--gray-100)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Session Notes
            </span>
            {saveState === 'saving' && <span style={{ fontSize: '0.72rem', color: 'var(--gold)' }}>Saving…</span>}
            {saveState === 'saved'  && <span style={{ fontSize: '0.72rem', color: '#16a34a' }}>✓ Saved</span>}
          </div>
          <textarea
            value={notes}
            onChange={e => handleNotesChange(e.target.value)}
            placeholder="Session notes…"
            autoFocus
            style={{
              width: '100%', boxSizing: 'border-box',
              minHeight: 80, fontSize: '0.875rem', lineHeight: 1.5,
              border: '1px solid var(--gray-200)', borderRadius: 6,
              padding: '8px 10px', resize: 'vertical', fontFamily: 'inherit',
              background: 'white', color: 'var(--gray-800)',
            }}
          />
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function OOCallListPage() {
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

  function handleUpdate(updated) {
    setAppts(prev => prev.map(a => a.id === updated.id ? updated : a));
  }

  const pending = appts.filter(a => !a.called_at);
  const done    = appts.filter(a => !!a.called_at);

  // Group by date
  function groupByDate(list) {
    const groups = [];
    let last = null;
    for (const a of list) {
      if (a.date !== last) { groups.push({ date: a.date, rows: [] }); last = a.date; }
      groups[groups.length - 1].rows.push(a);
    }
    return groups;
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: 980 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>Calls</h2>
        <span style={{ fontSize: '0.78rem', color: 'var(--gray-400)' }}>Next 7 days · click row to add notes</span>
        {!loading && (
          <span style={{ fontSize: '0.8rem', color: 'var(--gray-500)' }}>
            {pending.length} to call · {done.length} called
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
        <>
          {/* ── Pending calls ── */}
          {pending.length > 0 && (
            <div className="card" style={{ marginBottom: 24, overflow: 'hidden' }}>
              {groupByDate(pending).map(({ date, rows }) => (
                <div key={date}>
                  <div style={{
                    padding: '7px 12px 7px 15px',
                    background: 'var(--gray-50)',
                    borderBottom: '1px solid var(--gray-100)',
                    fontSize: '0.68rem', fontWeight: 700, color: 'var(--gray-500)',
                    textTransform: 'uppercase', letterSpacing: '0.07em',
                  }}>
                    {fmtDayHeader(date)}
                  </div>
                  {rows.map(a => <CallRow key={a.id} appt={a} onUpdate={handleUpdate} />)}
                </div>
              ))}
            </div>
          )}

          {/* ── Done calls ── */}
          {done.length > 0 && (
            <div>
              <div style={{
                fontSize: '0.68rem', fontWeight: 700, color: 'var(--gray-400)',
                textTransform: 'uppercase', letterSpacing: '0.08em',
                marginBottom: 8, paddingBottom: 5, borderBottom: '1px solid var(--gray-100)',
              }}>
                Done Calls ({done.length})
              </div>
              <div className="card" style={{ overflow: 'hidden', opacity: 0.75 }}>
                {groupByDate(done).map(({ date, rows }) => (
                  <div key={date}>
                    <div style={{
                      padding: '7px 12px 7px 15px',
                      background: 'var(--gray-50)',
                      borderBottom: '1px solid var(--gray-100)',
                      fontSize: '0.68rem', fontWeight: 700, color: 'var(--gray-500)',
                      textTransform: 'uppercase', letterSpacing: '0.07em',
                    }}>
                      {fmtDayHeader(date)}
                    </div>
                    {rows.map(a => <CallRow key={a.id} appt={a} onUpdate={handleUpdate} />)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import CreateGroupModal from '../components/admin/CreateGroupModal';

const DAY_ORDER = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ZOHO_ORG = '871314197';
const zohoSessionUrl = (id) => `https://crm.zoho.com/crm/org${ZOHO_ORG}/tab/Session/${id}`;

function fmtDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || '');
  return m ? `${m[2]}/${m[3]}/${m[1]}` : (ymd || '—');
}
function fmtTime(hm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(hm || '');
  if (!m) return '';
  const h = +m[1];
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}
// Zoho Status ("Active" / "Completed") → a css-safe key for badges + filtering.
function statusKey(s) {
  return String(s || '').trim().toLowerCase();
}
// Activity minus the numbers, e.g. "Surprise Crafts 5:20" → "Surprise Crafts".
function activityText(a) {
  return String(a || '').replace(/\d[\d:.]*/g, '').replace(/\s+/g, ' ').trim();
}

const th = { padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--gray-500)', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' };
const td = { padding: '8px 12px', fontSize: '0.82rem', color: 'var(--gray-700)', verticalAlign: 'top' };

export default function RosterPage() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState('');

  const [instructors, setInstructors] = useState([]);
  const [filter, setFilter] = useState('total');
  const load = useCallback(async () => {
    try {
      const [r, ins] = await Promise.all([api.getRoster(), api.getInstructors().catch(() => [])]);
      setRows(r);
      setInstructors((ins || []).slice().sort((a, b) => (a.last_name || '').localeCompare(b.last_name || '')));
      return r;
    } catch (err) { setError(err.message); return []; }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function linkInstructor(zohoInstructorId, ritzId) {
    try { await api.linkZohoInstructor(zohoInstructorId, ritzId || null); await load(); }
    catch (err) { setError('Link failed: ' + err.message); }
  }

  const [addPrefill, setAddPrefill] = useState(null); // { _zohoId, ...form fields }

  function startAdd(g) {
    const desc = [
      g.group_name,
      activityText(g.group_activity),
      g.group_type,
      g.age_range && `Ages ${g.age_range}`,
    ].filter(Boolean).join(' · ');
    setAddPrefill({
      _zohoId:         g.id,
      group_name:      g.group_name,
      internal_name:   g.session_code || g.group_name,
      description:     desc,
      supervisor_name: 'Chaim Orelowitz Supervisor',
      instructor_id:   g.ritzoini_instructor_id || '',
      start_date:      g.start_date || '',
      end_date:        g.end_date || '',
      start_time:      g.start_time || '',
      ecw_time:        g.start_time || '',
      total_sessions:  g.how_many_sessions || '',
    });
  }

  async function onGroupCreated(created) {
    const zid = addPrefill?._zohoId;
    if (created?.id && zid) {
      try { await api.updateGroup(created.id, { zoho_session_id: zid }); }
      catch (err) { setError('Group created, but linking to Zoho failed: ' + err.message); }
    }
    setAddPrefill(null);
    await load();
  }

  async function sync() {
    setSyncing(true); setMsg(''); setError('');
    try {
      const r = await api.syncZohoGroups();
      const mine = await load();
      const c = r.cancellations;
      const cancelMsg = c && c.cancelled ? ` Cancelled ${c.cancelled} session${c.cancelled !== 1 ? 's' : ''}${c.skippedLocked ? `, skipped ${c.skippedLocked} locked` : ''}.` : '';
      setMsg(`Synced ${r.fetched} Zoho groups (all therapists) — ${mine.length} are yours.${cancelMsg}`);
    }
    catch (err) { setError('Sync failed: ' + err.message); }
    finally { setSyncing(false); }
  }

  if (!rows && !error) return <div className="loading-screen"><div className="spinner" /></div>;

  const all = rows || [];
  const stats = {
    total:     all.length,
    active:    all.filter(g => statusKey(g.status) === 'active').length,
    completed: all.filter(g => statusKey(g.status) === 'completed').length,
  };
  const visible = filter === 'total' ? all : all.filter(g => statusKey(g.status) === filter);

  const byDay = {};
  visible.forEach(g => { (byDay[g.class_day || 'Unscheduled'] ||= []).push(g); });
  // Within each day, order groups by start time (early → late; blanks last).
  Object.values(byDay).forEach(list =>
    list.sort((a, b) => (a.start_time || '99:99').localeCompare(b.start_time || '99:99')));
  const days = Object.keys(byDay).sort((a, b) => {
    const ia = DAY_ORDER.indexOf(a), ib = DAY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const missingPhones = (rows || []).filter(g => g.phone_missing).length;

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1240, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0, color: 'var(--navy)', fontWeight: 700 }}>Roster</h2>
        <button className="btn btn-outline btn-sm" onClick={sync} disabled={syncing} style={{ color: '#6941C6' }}>
          {syncing ? 'Syncing…' : '↻ Sync from Zoho'}
        </button>
      </div>
      <p style={{ margin: '0 0 18px', fontSize: '0.85rem', color: 'var(--gray-500)' }}>
        Your groups, synced from Zoho. {visible.length} group{visible.length !== 1 ? 's' : ''}
        {missingPhones > 0 && (
          <span style={{ color: '#b45309', fontWeight: 600 }}> · ⚠ {missingPhones} missing an instructor phone</span>
        )}
      </p>

      {error && <div className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div>}
      {msg && <div className="alert alert-success" style={{ marginBottom: 14 }}>{msg}</div>}

      <div className="stats-row" style={{ marginBottom: 24 }}>
        {[
          { key: 'total',     label: 'Total Groups', value: stats.total,     color: 'var(--navy)' },
          { key: 'active',    label: 'Active',       value: stats.active,    color: '#10b981'     },
          { key: 'completed', label: 'Completed',    value: stats.completed, color: '#6b7280'     },
        ].map(({ key, label, value, color }) => (
          <div
            key={key}
            className="stat-card"
            onClick={() => setFilter(key)}
            style={{
              cursor: 'pointer',
              outline: filter === key ? `2px solid ${color}` : '2px solid transparent',
              transition: 'outline 0.15s, box-shadow 0.15s',
              boxShadow: filter === key ? `0 0 0 1px ${color}20` : undefined,
            }}
          >
            <div className="stat-value" style={{ color }}>{value}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </div>

      {days.length === 0 && !error && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--gray-400)' }}>
          {all.length === 0
            ? 'No groups. Click “Sync from Zoho” to pull the latest.'
            : `No ${filter} groups.`}
        </div>
      )}

      {days.map(day => (
        <section key={day} style={{ marginBottom: 26 }}>
          <h3 style={{ fontSize: '0.95rem', color: 'var(--navy)', margin: '0 0 8px' }}>
            {day} <span style={{ color: 'var(--gray-400)', fontWeight: 400, fontSize: '0.82rem' }}>· {byDay[day].length}</span>
          </h3>
          <div style={{ border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', overflow: 'hidden', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--gray-50)', borderBottom: '1px solid var(--gray-200)' }}>
                  {['Group Name', 'Activity', 'Time', 'Instructor', 'Start', 'End', 'Gender', 'Age', 'Cancellations', 'On Ritzoini'].map(h => (
                    <th key={h} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {byDay[day].map(g => (
                  <tr key={g.id} style={{ borderBottom: '1px solid var(--gray-100)' }}>
                    <td style={{ ...td, fontWeight: 600 }}>
                      {g.ritzoini_group_id ? (
                        <Link to={`/groups/${g.ritzoini_group_id}`} style={{ color: 'var(--navy)', textDecoration: 'none' }}>{g.group_name}</Link>
                      ) : (
                        <a href={zohoSessionUrl(g.id)} target="_blank" rel="noreferrer" style={{ color: '#6941C6', textDecoration: 'none' }}
                           title="Not linked to a Ritzoini group — opens the Zoho record">{g.group_name} ↗</a>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
                        {g.session_code && <span style={{ fontSize: '0.68rem', color: 'var(--gray-400)', fontWeight: 400 }}>{g.session_code}</span>}
                        {g.status && (
                          <span className={`badge badge-${statusKey(g.status)}`} style={{ fontSize: '0.58rem', padding: '1px 7px' }}>
                            {g.status}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={td}>{g.group_activity || '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtTime(g.start_time) || '—'}</td>
                    <td style={td}>
                      {g.instructor_name || '—'}
                      {g.instructor_phone && <div style={{ fontSize: '0.72rem', color: 'var(--gray-500)' }}>{g.instructor_phone}</div>}
                      {g.phone_missing && g.zoho_instructor_id && (
                        <div style={{ marginTop: 3 }}>
                          <div style={{ fontSize: '0.7rem', color: '#b45309', marginBottom: 2 }}>⚠ no phone — link to an instructor:</div>
                          <select
                            defaultValue=""
                            onChange={e => e.target.value && linkInstructor(g.zoho_instructor_id, e.target.value)}
                            style={{ fontSize: '0.72rem', padding: '2px 4px', borderRadius: 5, border: '1px solid var(--gray-300)', maxWidth: 170 }}>
                            <option value="">— pick —</option>
                            {instructors.map(i => (
                              <option key={i.id} value={i.id}>
                                {i.first_name} {i.last_name}{i.phone ? ` · ${i.phone}` : ''}
                              </option>
                            ))}
                          </select>
                          <div style={{ fontSize: '0.66rem', color: 'var(--gray-400)', marginTop: 2 }}>
                            or <Link to="/instructors" style={{ color: 'var(--gray-500)' }}>add in Instructors</Link>
                          </div>
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(g.start_date)}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(g.end_date)}</td>
                    <td style={td}>{g.group_type || '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {g.age_range || '—'}
                      {g.client_count > 0 && <div style={{ fontSize: '0.68rem', color: 'var(--gray-400)' }}>{g.client_count} client{g.client_count !== 1 ? 's' : ''}</div>}
                    </td>
                    <td style={td}>
                      {g.cancelled_dates.length === 0
                        ? <span style={{ color: 'var(--gray-400)' }}>—</span>
                        : g.cancelled_dates.map(d => (
                            <span key={d} style={{ display: 'inline-block', background: '#fef2f2', color: '#b91c1c', borderRadius: 5, padding: '1px 6px', fontSize: '0.72rem', margin: '0 4px 4px 0', whiteSpace: 'nowrap' }}>
                              {fmtDate(d)}
                            </span>
                          ))}
                    </td>
                    <td style={{ ...td, textAlign: 'center', whiteSpace: 'nowrap' }}>
                      {g.on_ritzoini ? (
                        <span style={{ color: '#12855C', fontWeight: 700 }}>✓</span>
                      ) : (
                        <button onClick={() => startAdd(g)}
                          style={{ fontSize: '0.68rem', fontWeight: 600, color: '#6941C6', background: 'none', border: '1px solid #d6bbfb', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>
                          + Add
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {addPrefill && (
        <CreateGroupModal
          initial={addPrefill}
          onClose={() => setAddPrefill(null)}
          onCreated={onGroupCreated}
        />
      )}
    </div>
  );
}

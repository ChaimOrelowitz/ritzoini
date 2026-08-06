import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';

const DAY_ORDER = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ZOHO_ORG = '871314197';
const zohoSessionUrl = (id) => `https://crm.zoho.com/crm/org${ZOHO_ORG}/tab/Session/${id}`;

function fmtDate(iso) {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

const th = { padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--gray-500)', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' };
const td = { padding: '8px 12px', fontSize: '0.82rem', color: 'var(--gray-700)', verticalAlign: 'top' };

export default function RosterPage() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState('');

  const [instructors, setInstructors] = useState([]);
  const load = useCallback(async () => {
    try {
      const [r, ins] = await Promise.all([api.getRoster(), api.getInstructors().catch(() => [])]);
      setRows(r);
      setInstructors((ins || []).slice().sort((a, b) => (a.last_name || '').localeCompare(b.last_name || '')));
    } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function linkInstructor(zohoInstructorId, ritzId) {
    try { await api.linkZohoInstructor(zohoInstructorId, ritzId || null); await load(); }
    catch (err) { setError('Link failed: ' + err.message); }
  }

  async function sync() {
    setSyncing(true); setMsg(''); setError('');
    try {
      const r = await api.syncZohoGroups();
      const c = r.cancellations;
      const cancelMsg = c && c.cancelled ? ` Cancelled ${c.cancelled} session${c.cancelled !== 1 ? 's' : ''}${c.skippedLocked ? `, skipped ${c.skippedLocked} locked` : ''}.` : '';
      setMsg(`Synced ${r.fetched} groups from Zoho.${cancelMsg}`);
      await load();
    }
    catch (err) { setError('Sync failed: ' + err.message); }
    finally { setSyncing(false); }
  }

  if (!rows && !error) return <div className="loading-screen"><div className="spinner" /></div>;

  const byDay = {};
  (rows || []).forEach(g => { (byDay[g.class_day || 'Unscheduled'] ||= []).push(g); });
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
        Your groups, synced from Zoho. {rows?.length || 0} groups
        {missingPhones > 0 && (
          <span style={{ color: '#b45309', fontWeight: 600 }}> · ⚠ {missingPhones} missing an instructor phone</span>
        )}
      </p>

      {error && <div className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div>}
      {msg && <div className="alert alert-success" style={{ marginBottom: 14 }}>{msg}</div>}

      {days.length === 0 && !error && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--gray-400)' }}>
          No groups. Click “Sync from Zoho” to pull the latest.
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
                      {g.session_code && <div style={{ fontSize: '0.68rem', color: 'var(--gray-400)', fontWeight: 400 }}>{g.session_code}</div>}
                    </td>
                    <td style={td}>{g.group_activity || '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtTime(g.start_at) || '—'}</td>
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
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(g.start_at)}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(g.end_at)}</td>
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
                    <td style={{ ...td, textAlign: 'center' }}>
                      {g.on_ritzoini
                        ? <span style={{ color: '#12855C', fontWeight: 700 }}>✓</span>
                        : <span style={{ color: 'var(--gray-300)' }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

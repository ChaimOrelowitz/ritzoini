import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../utils/api';

function fmtDob(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y}`;
}

function Field({ label, value }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{ fontSize: '0.88rem', color: value ? 'var(--gray-800)' : 'var(--gray-300)' }}>{value || '—'}</span>
    </div>
  );
}

function FieldWide({ label, value }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, gridColumn: '1 / -1' }}>
      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{ fontSize: '0.88rem', color: value ? 'var(--gray-800)' : 'var(--gray-300)' }}>{value || '—'}</span>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 14, paddingBottom: 6, borderBottom: '1px solid var(--gray-100)' }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '14px 24px' }}>
        {children}
      </div>
    </div>
  );
}

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function EditApptModal({ appt, onClose, onSaved }) {
  const [date, setDate]         = useState(appt.date);
  const [time, setTime]         = useState(appt.time?.slice(0, 5) || '');
  const [duration, setDuration] = useState(appt.duration || 45);
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      await api.patch(`/oo/appointments/${appt.id}`, { date, time, duration });
      onSaved();
    } catch (ex) { setErr(ex.message); setSaving(false); }
  }

  const labelSt = { display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 380 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ margin: 0, fontSize: '1rem' }}>Edit Appointment</h2>
          <button className="btn-ghost" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px' }}>
          <div>
            <label style={labelSt}>Date</label>
            <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} required />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={labelSt}>Time</label>
              <input type="time" className="input" value={time} onChange={e => setTime(e.target.value)} required />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelSt}>Duration</label>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                {[30, 45].map(d => (
                  <label key={d} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.88rem', cursor: 'pointer' }}>
                    <input type="radio" name="dur" value={d} checked={duration === d} onChange={() => setDuration(d)} />
                    {d} min
                  </label>
                ))}
              </div>
            </div>
          </div>
          {err && <p style={{ color: 'var(--danger)', margin: 0, fontSize: '0.82rem' }}>{err}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function OOClientDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [client, setClient]     = useState(null);
  const [appts, setAppts]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showRaw, setShowRaw]   = useState(false);
  const [syncingFs, setSyncingFs] = useState(false);
  const [fsMsg, setFsMsg]       = useState('');
  const [editAppt, setEditAppt]     = useState(null);
  const [deleting, setDeleting]     = useState(null);
  const [debugHtml, setDebugHtml]       = useState('');
  const [debugging, setDebugging]       = useState(false);
  const [debugFields, setDebugFields]   = useState(null);
  const [debuggingFields, setDebuggingFields] = useState(false);

  function loadClient() {
    return api.get(`/oo/clients/${id}`).then(setClient).catch(() => navigate('/oo/clients'));
  }

  const loadAppts = useCallback(() => {
    api.get(`/oo/appointments?client_id=${id}`).then(d => setAppts(Array.isArray(d) ? d : [])).catch(() => {});
  }, [id]);

  useEffect(() => {
    Promise.all([
      loadClient(),
      loadAppts(),
    ]).finally(() => setLoading(false));
  }, [id]); // eslint-disable-line

  async function debugEncounter() {
    setDebugging(true);
    setDebugHtml('');
    try {
      const r = await api.get(`/oo/clients/${id}/debug-encounter-html`);
      setDebugHtml(r.html_preview);
    } catch (ex) { setDebugHtml(`ERROR: ${ex.message}`); }
    finally { setDebugging(false); }
  }

  async function debugNoteFields() {
    setDebuggingFields(true);
    setDebugFields(null);
    try {
      const r = await api.get(`/oo/clients/${id}/debug-note-fields`);
      setDebugFields(r);
    } catch (ex) { setDebugFields({ error: ex.message }); }
    finally { setDebuggingFields(false); }
  }

  async function deleteAppt(apptId) {
    setDeleting(apptId);
    try {
      await api.delete(`/oo/appointments/${apptId}`);
      loadAppts();
    } catch (ex) { alert(ex.message); }
    finally { setDeleting(null); }
  }

  async function syncFacesheet() {
    setSyncingFs(true);
    setFsMsg('');
    try {
      const r = await api.post(`/oo/clients/${id}/sync-facesheet`, {});
      setFsMsg(`${r.diagnoses_count ?? r.count ?? 0} dx · ${r.tp_count ?? 0} TP problem${(r.tp_count ?? 0) !== 1 ? 's' : ''} synced`);
      await loadClient();
    } catch (ex) {
      setFsMsg(ex.message);
    } finally {
      setSyncingFs(false);
    }
  }

  if (loading) return <div style={{ padding: 32, color: 'var(--gray-400)' }}>Loading…</div>;
  if (!client) return null;

  const rs  = client.oo_referral_sources;
  const raw = client.insync_data || {};

  // Parse PrimaryPayers: "PAYER A (dates)!@#PAYER B (dates)"
  const primaryPayers = raw.PrimaryPayers
    ? raw.PrimaryPayers.split('!@#').map(s => s.trim()).filter(Boolean)
    : [];

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900 }}>
      {/* Back */}
      <button onClick={() => navigate('/oo/clients')} style={{ background: 'none', border: 'none', color: 'var(--gray-400)', cursor: 'pointer', fontSize: '0.82rem', padding: 0, marginBottom: 20 }}>
        ← Back to Clients
      </button>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, marginBottom: 28, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: '0 0 6px', fontSize: '1.4rem', fontWeight: 700, color: 'var(--navy)' }}>
            {client.last_name}, {client.first_name}
          </h2>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {client.mrn && <span style={{ fontSize: '0.78rem', color: 'var(--gray-500)' }}>MRN: <strong>{client.mrn}</strong></span>}
            {client.dob && <span style={{ fontSize: '0.78rem', color: 'var(--gray-500)' }}>DOB: {fmtDob(client.dob)}</span>}
            {client.sex && <span style={{ fontSize: '0.78rem', color: 'var(--gray-500)' }}>{client.sex === 'F' ? 'Female' : client.sex === 'M' ? 'Male' : client.sex}</span>}
            <span style={{
              fontSize: '0.72rem', fontWeight: 600, borderRadius: 4, padding: '2px 8px',
              background: client.status === 'active' ? '#dcfce7' : '#f3f4f6',
              color: client.status === 'active' ? '#166534' : '#6b7280',
            }}>{client.status}</span>
            {rs && (
              <span style={{ fontSize: '0.72rem', fontWeight: 600, background: '#dbeafe', color: '#1e40af', borderRadius: 4, padding: '2px 8px' }}>
                {rs.name}
              </span>
            )}
          </div>
        </div>
        {client.insync_patient_id && (
          <div style={{ fontSize: '0.72rem', color: 'var(--gray-400)', textAlign: 'right' }}>
            InSync ID: <strong style={{ color: 'var(--gray-600)' }}>{client.insync_patient_id}</strong>
          </div>
        )}
      </div>

      {/* Contact */}
      <Section title="Contact">
        <Field label="Phone"   value={client.phone} />
        <Field label="Mobile"  value={client.mobile} />
        <Field label="Email"   value={client.email || raw.PatientEmail || null} />
        <Field label="Age"     value={raw.PatientAge || null} />
        <FieldWide label="Address" value={client.address} />
      </Section>

      {/* InSync info */}
      <Section title="InSync">
        <Field label="Primary Provider"   value={raw.PrimaryProviderName || null} />
        <Field label="Referring Provider" value={client.referring_provider || raw.ReferringProviderName || null} />
        <Field label="Counselor"          value={client.counselor} />
        <Field label="Patient Note"       value={raw.PatientNote || null} />
        <Field label="Created By"         value={raw.Created_By ? `${raw.Created_By} on ${raw.Created_On || ''}` : null} />
        <Field label="Eligibility"        value={client.eligibility_result} />
      </Section>

      {/* Diagnoses */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, paddingBottom: 6, borderBottom: '1px solid var(--gray-100)' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            Diagnoses (Problem List)
            {raw.facesheet_synced_at && (
              <span style={{ fontWeight: 400, textTransform: 'none', marginLeft: 8, fontSize: '0.7rem' }}>
                synced {new Date(raw.facesheet_synced_at).toLocaleDateString()}
              </span>
            )}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {fsMsg && <span style={{ fontSize: '0.75rem', color: fsMsg.includes('ailed') || fsMsg.includes('rror') ? 'var(--danger)' : 'var(--success, #16a34a)' }}>{fsMsg}</span>}
            {client.insync_patient_id && (
              <button className="btn-ghost" style={{ fontSize: '0.75rem', padding: '4px 10px' }} onClick={syncFacesheet} disabled={syncingFs}>
                {syncingFs ? 'Syncing…' : 'Sync from InSync'}
              </button>
            )}
          </div>
        </div>
        {raw.diagnoses?.length > 0 ? (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: 'var(--gray-50)' }}>
                <th style={thSt}>ICD-10</th>
                <th style={thSt}>Problem</th>
                <th style={thSt}>Onset</th>
                <th style={thSt}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {raw.diagnoses.map((d, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--gray-100)' }}>
                  <td style={tdSt}><strong>{d.icd_10}</strong></td>
                  <td style={tdSt}>{d.problem}</td>
                  <td style={{ ...tdSt, color: 'var(--gray-400)', whiteSpace: 'nowrap' }}>{d.date_onset || '—'}</td>
                  <td style={{ ...tdSt, color: 'var(--gray-400)' }}>{d.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ color: 'var(--gray-300)', fontSize: '0.85rem', margin: 0 }}>
            {client.insync_patient_id ? 'No diagnoses synced yet — click "Sync from InSync"' : 'Sync client from InSync to enable facesheet sync.'}
          </p>
        )}
      </div>

      {/* Treatment Plan */}
      {raw.treatment_plan?.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 14, paddingBottom: 6, borderBottom: '1px solid var(--gray-100)' }}>
            Treatment Plan
          </div>
          {raw.treatment_plan.map((p, i) => (
            <div key={i} style={{ marginBottom: 20, padding: '14px 16px', background: 'var(--gray-50)', borderRadius: 8, border: '1px solid var(--gray-100)' }}>
              <div style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--navy)', marginBottom: 10 }}>{p.problem}</div>
              {p.long_term_goals?.map((g, j) => (
                <div key={j} style={{ marginBottom: 6 }}>
                  <span style={tpLabelSt}>LTG {j + 1}</span>
                  <span style={{ fontSize: '0.84rem', color: 'var(--gray-700)' }}>{g}</span>
                </div>
              ))}
              {p.short_term_goals?.map((g, j) => (
                <div key={j} style={{ marginBottom: 6 }}>
                  <span style={tpLabelSt}>STG {j + 1}</span>
                  <span style={{ fontSize: '0.84rem', color: 'var(--gray-700)' }}>{g}</span>
                </div>
              ))}
              {p.interventions?.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <span style={tpLabelSt}>Interventions</span>
                  <span style={{ fontSize: '0.84rem', color: 'var(--gray-500)' }}>{p.interventions.join(' · ')}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Appointments */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 14, paddingBottom: 6, borderBottom: '1px solid var(--gray-100)' }}>
          Scheduled Appointments
        </div>
        {appts.length === 0 ? (
          <p style={{ color: 'var(--gray-300)', fontSize: '0.85rem', margin: 0 }}>No appointments scheduled.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: 'var(--gray-50)' }}>
                <th style={thSt}>Date</th>
                <th style={thSt}>Time</th>
                <th style={thSt}>Duration</th>
                <th style={thSt}>Status</th>
                <th style={thSt}>Notes</th>
                <th style={thSt}></th>
              </tr>
            </thead>
            <tbody>
              {appts.map(a => (
                <tr key={a.id} style={{ borderBottom: '1px solid var(--gray-100)' }}>
                  <td style={tdSt}>{a.date}</td>
                  <td style={tdSt}>{fmt12(a.time)}</td>
                  <td style={tdSt}>{a.duration} min</td>
                  <td style={tdSt}>
                    <span style={{
                      fontSize: '0.72rem', fontWeight: 600, borderRadius: 4, padding: '2px 7px',
                      background: a.status === 'scheduled' ? '#dbeafe' : '#f3f4f6',
                      color: a.status === 'scheduled' ? '#1e40af' : '#6b7280',
                    }}>{a.status}</span>
                  </td>
                  <td style={{ ...tdSt, color: 'var(--gray-400)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.raw_notes || '—'}
                  </td>
                  <td style={{ ...tdSt, whiteSpace: 'nowrap' }}>
                    <button className="btn-ghost" style={{ fontSize: '0.75rem', padding: '3px 9px', marginRight: 4 }} onClick={() => setEditAppt(a)}>Edit</button>
                    <button
                      className="btn-ghost"
                      style={{ fontSize: '0.75rem', padding: '3px 9px', color: 'var(--danger)', borderColor: 'var(--danger)' }}
                      disabled={deleting === a.id}
                      onClick={() => { if (window.confirm(`Delete appointment on ${a.date} at ${fmt12(a.time)}?`)) deleteAppt(a.id); }}
                    >{deleting === a.id ? '…' : 'Delete'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Insurance */}
      <Section title="Insurance">
        <Field label="Current Payer" value={client.payer_plan_name} />
        {primaryPayers.length > 1 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, gridColumn: '1 / -1' }}>
            <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Payer History</span>
            {primaryPayers.map((p, i) => (
              <span key={i} style={{ fontSize: '0.85rem', color: 'var(--gray-700)' }}>{p}</span>
            ))}
          </div>
        ) : null}
      </Section>

      {/* Referral source */}
      {rs && (
        <Section title="Referral Source">
          <Field label="Name"         value={rs.name} />
          <Field label="Notes Email"  value={rs.notes_email} />
        </Section>
      )}

      {editAppt && (
        <EditApptModal
          appt={editAppt}
          onClose={() => setEditAppt(null)}
          onSaved={() => { setEditAppt(null); loadAppts(); }}
        />
      )}

      {/* DEBUG: note fields inspector */}
      {client.insync_patient_id && (
        <div style={{ marginTop: 8, marginBottom: 8 }}>
          <button onClick={debugNoteFields} disabled={debuggingFields} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: '#f59e0b', padding: 0 }}>
            {debuggingFields ? 'Fetching…' : '⚙ Debug: fetch note fields'}
          </button>
          {debugFields && (
            <pre style={{ marginTop: 8, background: '#1e1e1e', color: '#d4d4d4', border: '1px solid #444', borderRadius: 6, padding: 14, fontSize: '0.68rem', overflowX: 'auto', maxHeight: 400, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(debugFields, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* DEBUG: encounter HTML inspector */}
      {client.insync_patient_id && (
        <div style={{ marginTop: 8, marginBottom: 16 }}>
          <button onClick={debugEncounter} disabled={debugging} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: '#f59e0b', padding: 0 }}>
            {debugging ? 'Fetching…' : '⚙ Debug: fetch encounter HTML'}
          </button>
          {debugHtml && (
            <pre style={{ marginTop: 8, background: '#1e1e1e', color: '#d4d4d4', border: '1px solid #444', borderRadius: 6, padding: 14, fontSize: '0.68rem', overflowX: 'auto', maxHeight: 400, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {debugHtml}
            </pre>
          )}
        </div>
      )}

      {/* Raw InSync data */}
      {client.insync_data && (
        <div style={{ marginTop: 8 }}>
          <button onClick={() => setShowRaw(s => !s)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--gray-400)', padding: 0 }}>
            {showRaw ? '▾' : '▸'} Raw InSync data
          </button>
          {showRaw && (
            <pre style={{ marginTop: 8, background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 6, padding: 14, fontSize: '0.72rem', color: 'var(--gray-600)', overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
              {JSON.stringify(client.insync_data, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

const thSt    = { padding: '6px 10px', textAlign: 'left', fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--gray-200)' };
const tdSt    = { padding: '8px 10px', verticalAlign: 'top' };
const tpLabelSt = { display: 'inline-block', fontSize: '0.68rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', minWidth: 80, marginRight: 8 };

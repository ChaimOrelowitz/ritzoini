import { useState, useEffect } from 'react';
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

export default function OOClientDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showRaw, setShowRaw] = useState(false);
  const [syncingFs, setSyncingFs] = useState(false);
  const [fsMsg, setFsMsg] = useState('');

  function loadClient() {
    return api.get(`/oo/clients/${id}`).then(setClient).catch(() => navigate('/oo/clients'));
  }

  useEffect(() => {
    loadClient().finally(() => setLoading(false));
  }, [id]); // eslint-disable-line

  async function syncFacesheet() {
    setSyncingFs(true);
    setFsMsg('');
    try {
      const r = await api.post(`/oo/clients/${id}/sync-facesheet`, {});
      setFsMsg(`Synced ${r.count} diagnosis${r.count !== 1 ? 'es' : ''}`);
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
            {fsMsg && <span style={{ fontSize: '0.75rem', color: fsMsg.includes('ailed') || fsMsg.includes('Error') ? 'var(--danger)' : 'var(--success, #16a34a)' }}>{fsMsg}</span>}
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

const thSt = { padding: '6px 10px', textAlign: 'left', fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--gray-200)' };
const tdSt = { padding: '8px 10px', verticalAlign: 'top' };

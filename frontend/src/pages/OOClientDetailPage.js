import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import ApptCard, {
  goalText, goalTarget,
  fldLabel, modalLabelSt,
} from '../components/shared/OOApptCard';

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcAge(dob) {
  if (!dob) return null;
  const ms = Date.now() - new Date(dob + 'T12:00:00Z').getTime();
  return Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
}

function fmtDob(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y}`;
}

// ── Shared sub-components (used inside collapsible) ───────────────────────────

function RField({ label, value }) {
  if (!value) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: '0.63rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: '0.82rem', color: 'var(--gray-700)' }}>{value}</div>
    </div>
  );
}

function RSection({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--navy)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8, paddingBottom: 5, borderBottom: '1px solid var(--gray-100)' }}>
        {title}
      </div>
      {children}
    </div>
  );
}

// ── Constants ─────────────────────────────────────────────────────────────────

const EMPTY_EDIT_FORM = {
  first_name: '', last_name: '', dob: '', sex: '', phone: '', mobile: '',
  email: '', mrn: '', referral_source_id: '', ehr_id: '', status: 'active',
  mother_name: '', mother_phone: '', father_name: '', father_phone: '',
  mother_can_text: false, father_can_text: false,
};

const EMPTY_ADD_FORM = { date: '', time: '', duration: '45', repeat_weeks: '1' };

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function OOClientDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [client,   setClient]   = useState(null);
  const [appts,    setAppts]    = useState([]);
  const [sources,  setSources]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showRaw,  setShowRaw]  = useState(false);

  const [showClientDetails, setShowClientDetails] = useState(false);

  const [showEditModal, setShowEditModal] = useState(false);
  const [editForm,      setEditForm]      = useState(EMPTY_EDIT_FORM);
  const [savingClient,  setSavingClient]  = useState(false);
  const [clientSaveErr, setClientSaveErr] = useState('');

  const [showAddAppt,  setShowAddAppt]  = useState(false);
  const [addForm,      setAddForm]      = useState(EMPTY_ADD_FORM);
  const [addingAppt,   setAddingAppt]   = useState(false);
  const [addConflicts, setAddConflicts] = useState([]);

  const [clientNotes,    setClientNotes]    = useState('');
  const [notesSaveState, setNotesSaveState] = useState('idle');
  const notesSaveTimer = useRef(null);

  const [clientSummary,        setClientSummary]        = useState('');
  const [clientSummarySaveState, setClientSummarySaveState] = useState('idle');
  const [updatingClientSummary,  setUpdatingClientSummary]  = useState(false);
  const clientSummaryTimer = useRef(null);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting,          setDeleting]          = useState(false);
  const [archiving,         setArchiving]         = useState(false);

  const [syncingFs,       setSyncingFs]       = useState(false);
  const [fsMsg,           setFsMsg]           = useState('');
  const [debugFields,     setDebugFields]     = useState(null);
  const [debuggingFields, setDebuggingFields] = useState(false);
  const [debugHtml,       setDebugHtml]       = useState('');
  const [debugging,       setDebugging]       = useState(false);
  const [debugTpRaw,      setDebugTpRaw]      = useState(null);
  const [debuggingTp,     setDebuggingTp]     = useState(false);

  function loadClientData() {
    return api.get(`/oo/clients/${id}`).then(c => {
      setClient(c);
      setClientNotes(c.notes || '');
      setClientSummary(c.client_summary || '');
    }).catch(() => navigate('/oo/clients'));
  }

  const loadAppts = useCallback(() =>
    api.get(`/oo/appointments?client_id=${id}`)
      .then(d => setAppts(Array.isArray(d) ? [...d].sort((a, b) =>
        a.date !== b.date ? a.date.localeCompare(b.date) : a.time.localeCompare(b.time)
      ) : []))
      .catch(() => {})
  , [id]);

  useEffect(() => {
    Promise.all([
      loadClientData(),
      loadAppts(),
      api.get('/oo/clients/referral-sources').then(all => setSources(Array.isArray(all) ? all : [])).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, [id]); // eslint-disable-line

  function handleClientNotesChange(val) {
    setClientNotes(val);
    setNotesSaveState('saving');
    clearTimeout(notesSaveTimer.current);
    notesSaveTimer.current = setTimeout(async () => {
      try {
        await api.put(`/oo/clients/${id}`, { notes: val });
        setNotesSaveState('saved');
        setTimeout(() => setNotesSaveState('idle'), 2000);
      } catch { setNotesSaveState('idle'); }
    }, 1000);
  }

  function handleClientSummaryChange(val) {
    setClientSummary(val);
    setClientSummarySaveState('saving');
    clearTimeout(clientSummaryTimer.current);
    clientSummaryTimer.current = setTimeout(async () => {
      try {
        await api.put(`/oo/clients/${id}`, { client_summary: val });
        setClientSummarySaveState('saved');
        setTimeout(() => setClientSummarySaveState('idle'), 2000);
      } catch { setClientSummarySaveState('idle'); }
    }, 1000);
  }

  async function handleUpdateClientSummary() {
    setUpdatingClientSummary(true);
    try {
      const result = await api.updateClientSummary(id);
      setClientSummary(result.client_summary || '');
      setClient(prev => ({ ...prev, client_summary: result.client_summary }));
    } catch (ex) { alert(ex.message); }
    finally { setUpdatingClientSummary(false); }
  }

  function openEditClient() {
    setClientSaveErr('');
    setEditForm({
      first_name:   client.first_name   || '',
      last_name:    client.last_name    || '',
      dob:          client.dob          || '',
      sex:          client.sex          || '',
      phone:        client.phone        || '',
      mobile:       client.mobile       || '',
      email:        client.email        || '',
      mrn:          client.mrn          || '',
      referral_source_id: client.referral_source_id || '',
      ehr_id:       client.ehr_id       || '',
      status:       client.status       || 'active',
      mother_name:     client.mother_name     || '',
      mother_phone:    client.mother_phone    || '',
      father_name:     client.father_name     || '',
      father_phone:    client.father_phone    || '',
      mother_can_text: client.mother_can_text || false,
      father_can_text: client.father_can_text || false,
    });
    setShowEditModal(true);
  }

  async function handleSaveClient(e) {
    e.preventDefault();
    setSavingClient(true); setClientSaveErr('');
    try {
      const payload = { ...editForm, referral_source_id: editForm.referral_source_id || null, ehr_id: editForm.ehr_id || null };
      const updated = await api.put(`/oo/clients/${id}`, payload);
      setClient(updated);
      setShowEditModal(false);
    } catch (ex) {
      setClientSaveErr(ex.message || 'Save failed');
    } finally { setSavingClient(false); }
  }

  async function handleAddAppt(e) {
    e.preventDefault();
    if (!addForm.date || !addForm.time) return;
    setAddingAppt(true); setAddConflicts([]);
    try {
      const result = await api.post('/oo/appointments', {
        client_id:    id,
        date:         addForm.date,
        time:         addForm.time,
        duration:     parseInt(addForm.duration) || 45,
        repeat_weeks: parseInt(addForm.repeat_weeks) || 1,
      });
      const newAppts = result.appointments || [];
      setAppts(prev => [...prev, ...newAppts].sort((a, b) =>
        a.date !== b.date ? a.date.localeCompare(b.date) : a.time.localeCompare(b.time)
      ));
      if (result.conflicts?.length) {
        setAddConflicts(result.conflicts);
      } else {
        setShowAddAppt(false);
        setAddForm(EMPTY_ADD_FORM);
      }
    } catch (ex) { alert(ex.message); }
    finally { setAddingAppt(false); }
  }

  async function syncFacesheet() {
    setSyncingFs(true); setFsMsg('');
    try {
      const r = await api.post(`/oo/clients/${id}/sync-facesheet`, {});
      setFsMsg(`${r.diagnoses_count ?? 0} dx · ${r.tp_count ?? 0} TP synced`);
      await loadClientData();
    } catch (ex) { setFsMsg(ex.message); }
    finally { setSyncingFs(false); }
  }

  async function handleArchiveToggle() {
    const newStatus = client.status === 'archived' ? 'active' : 'archived';
    setArchiving(true);
    try {
      const updated = await api.put(`/oo/clients/${id}`, { status: newStatus });
      setClient(updated);
    } catch (ex) { alert(ex.message); }
    finally { setArchiving(false); }
  }

  async function handleArchiveFromDeleteModal() {
    setDeleting(true);
    try {
      const updated = await api.put(`/oo/clients/${id}`, { status: 'archived' });
      setClient(updated);
      setShowDeleteConfirm(false);
    } catch (ex) { alert(ex.message); }
    finally { setDeleting(false); }
  }

  async function handleDeletePermanently() {
    setDeleting(true);
    try {
      await api.delete(`/oo/clients/${id}`);
      navigate('/oo/clients');
    } catch (ex) {
      alert(ex.message);
      setDeleting(false);
    }
  }

  async function debugNoteFields() {
    setDebuggingFields(true); setDebugFields(null);
    try { setDebugFields(await api.get(`/oo/clients/${id}/debug-note-fields`)); }
    catch (ex) { setDebugFields({ error: ex.message }); }
    finally { setDebuggingFields(false); }
  }

  async function debugEncounter() {
    setDebugging(true); setDebugHtml('');
    try { setDebugHtml(JSON.stringify(await api.get(`/oo/clients/${id}/debug-encounter-html`), null, 2)); }
    catch (ex) { setDebugHtml(`ERROR: ${ex.message}`); }
    finally { setDebugging(false); }
  }

  async function debugTpRawFn() {
    setDebuggingTp(true); setDebugTpRaw(null);
    try { setDebugTpRaw(await api.get(`/oo/clients/${id}/debug-tp-raw`)); }
    catch (ex) { setDebugTpRaw({ error: ex.message }); }
    finally { setDebuggingTp(false); }
  }

  function handleApptUpdate(updated) {
    setAppts(prev => prev.map(a => a.id === updated.id ? { ...a, ...updated } : a));
  }
  function handleApptDelete(apptId) {
    setAppts(prev => prev.filter(a => a.id !== apptId));
  }

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (!client) return null;

  const rs  = client.referral;
  const ehr = client.ehr;
  const raw = client.insync_data || {};
  const age = calcAge(client.dob);
  const sexBadge = client.sex === 'M' ? 'M' : client.sex === 'F' ? 'F' : client.sex ? 'U' : null;

  const primaryPayers = raw.PrimaryPayers
    ? raw.PrimaryPayers.split('!@#').map(s => s.trim()).filter(Boolean)
    : [];

  const stats = {
    total:     appts.length,
    scheduled: appts.filter(a => a.status === 'scheduled').length,
    sent:      appts.filter(a => a.note_sent_at).length,
    done:      appts.filter(a => a.note_done_at).length,
  };

  const textareaFieldSt = {
    width: '100%', boxSizing: 'border-box', minHeight: 90,
    fontSize: '0.82rem', lineHeight: 1.55,
    border: '1px solid var(--gray-200)', borderRadius: 6,
    padding: '8px 10px', resize: 'vertical', fontFamily: 'inherit',
    background: 'white', color: 'var(--gray-800)',
  };

  return (
    <div style={{ padding: '24px 32px 48px', maxWidth: 1400 }}>
      <button className="back-link" onClick={() => navigate('/oo/clients')}>← Back to Clients</button>

      {client.status === 'archived' && (
        <div style={{ marginBottom: 14, padding: '8px 14px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.8rem', color: '#6b7280', fontWeight: 600 }}>
          This client is archived — hidden from the main clients list and Calls screen.
        </div>
      )}

      {/* ── Header ── */}
      <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', marginBottom: 16 }}>

        {/* Left — My Notes */}
        <div style={{ width: 320, flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
            <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>My Notes</span>
            {notesSaveState === 'saving' && <span style={{ fontSize: '0.68rem', color: 'var(--gold)' }}>Saving…</span>}
            {notesSaveState === 'saved'  && <span style={{ fontSize: '0.68rem', color: '#16a34a' }}>✓ Saved</span>}
          </div>
          <textarea
            value={clientNotes}
            onChange={e => handleClientNotesChange(e.target.value)}
            placeholder="Notes just for you…"
            style={textareaFieldSt}
          />
        </div>

        {/* Right — client identity */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Name + badges + action buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0 }}>{client.last_name}, {client.first_name}</h2>
            {sexBadge && (
              <span style={{ fontSize: '0.72rem', fontWeight: 700, background: 'var(--gray-100)', color: 'var(--gray-500)', borderRadius: 3, padding: '2px 6px', letterSpacing: '0.04em' }}>
                {sexBadge}
              </span>
            )}
            <span className={`badge badge-${client.status}`}>{client.status}</span>
            {rs  && <span style={{ background: 'var(--navy)', color: 'rgba(255,255,255,0.9)', borderRadius: 4, padding: '2px 8px', fontSize: '0.68rem', fontWeight: 600, letterSpacing: '0.02em' }}>{rs.name}</span>}
            {ehr && <span style={{ background: '#1e40af', color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: '0.68rem', fontWeight: 600, letterSpacing: '0.02em' }}>{ehr.name}</span>}
            <button className="btn btn-outline btn-sm" onClick={openEditClient}>Edit Client</button>
            <button
              className="btn btn-outline btn-sm"
              onClick={handleArchiveToggle}
              disabled={archiving}
              style={{ color: '#6b7280', borderColor: '#d1d5db' }}
            >
              {archiving ? '…' : client.status === 'archived' ? 'Unarchive' : 'Archive'}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => setShowDeleteConfirm(true)}
              style={{ color: '#dc2626', border: '1px solid #fca5a5', background: 'white' }}
            >
              Delete
            </button>
          </div>

          {/* DOB · session minutes */}
          {client.dob && (
            <div style={{ fontSize: '0.85rem', color: 'var(--gray-700)', marginBottom: 4 }}>
              {fmtDob(client.dob)}{age !== null ? ` (${age})` : ''}
              {raw.typical_session_minutes ? <span style={{ color: 'var(--gray-400)', marginLeft: 8 }}>· {raw.typical_session_minutes} min</span> : null}
            </div>
          )}

          {/* Mobile · Phone · Email */}
          {(client.mobile || client.phone || client.email || raw.PatientEmail) && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: '0.85rem', color: 'var(--gray-600)', marginBottom: 4 }}>
              {client.mobile && <span>{client.mobile}</span>}
              {client.phone  && <span>{client.phone}</span>}
              {(client.email || raw.PatientEmail) && <span>{client.email || raw.PatientEmail}</span>}
            </div>
          )}

          {/* Address · InSync link */}
          {(client.address || client.insync_patient_id) && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: '0.85rem', color: 'var(--gray-600)', marginBottom: 4 }}>
              {client.address && <span>{client.address}</span>}
              {client.insync_patient_id && (
                <a
                  href={`https://thedscenter.insynchcs.com/facesheet?pid=${client.insync_patient_id}`}
                  target="_blank" rel="noopener noreferrer"
                  style={{ color: '#1e40af', textDecoration: 'underline', fontWeight: 500 }}
                >
                  Open in InSync ↗
                </a>
              )}
            </div>
          )}

          {/* Mother / Father */}
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: '0.82rem', color: 'var(--gray-600)', marginBottom: 4 }}>
            <span>
              <strong style={{ color: 'var(--gray-400)', fontWeight: 600 }}>Mother:</strong>{' '}
              {client.mother_name
                ? <>{client.mother_name}{client.mother_phone && <span style={{ color: 'var(--gray-400)', marginLeft: 6 }}>{client.mother_phone} {client.mother_can_text ? <span title="Can text" style={{ color: '#16a34a' }}>💬</span> : <span title="No text" style={{ color: 'var(--gray-300)' }}>🚫</span>}</span>}</>
                : <span style={{ color: 'var(--gray-300)' }}>—</span>
              }
            </span>
            <span>
              <strong style={{ color: 'var(--gray-400)', fontWeight: 600 }}>Father:</strong>{' '}
              {client.father_name
                ? <>{client.father_name}{client.father_phone && <span style={{ color: 'var(--gray-400)', marginLeft: 6 }}>{client.father_phone} {client.father_can_text ? <span title="Can text" style={{ color: '#16a34a' }}>💬</span> : <span title="No text" style={{ color: 'var(--gray-300)' }}>🚫</span>}</span>}</>
                : <span style={{ color: 'var(--gray-300)' }}>—</span>
              }
            </span>
          </div>

          {/* DX badges + Sync DX */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 6 }}>
            {raw.diagnoses?.map((d, i) => (
              <span key={i} style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                background: '#eef2ff', color: 'var(--navy)', border: '1px solid #c7d2fe',
                borderRadius: 4, padding: '2px 8px', fontSize: '0.75rem',
              }}>
                <strong style={{ fontSize: '0.7rem', fontWeight: 700 }}>{d.icd_10}</strong>
                <span>{d.problem}</span>
              </span>
            ))}
            {client.insync_patient_id && (
              <button className="btn btn-outline btn-xs" onClick={syncFacesheet} disabled={syncingFs}
                style={{ fontSize: '0.72rem' }}>
                {syncingFs ? 'Syncing…' : 'Sync DX'}
              </button>
            )}
            {fsMsg && (
              <span style={{ fontSize: '0.72rem', color: fsMsg.includes('ailed') || fsMsg.includes('rror') ? '#dc2626' : '#16a34a' }}>{fsMsg}</span>
            )}
          </div>
        </div>
      </div>

      {/* ── Collapsible Client Details ── */}
      <div style={{ marginBottom: 20, border: '1px solid var(--gray-200)', borderRadius: 8, overflow: 'hidden' }}>
        <button
          onClick={() => setShowClientDetails(s => !s)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 8,
            padding: '9px 16px', background: 'var(--gray-50)', border: 'none',
            borderBottom: showClientDetails ? '1px solid var(--gray-200)' : 'none',
            cursor: 'pointer', textAlign: 'left',
          }}
        >
          <span style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>{showClientDetails ? '▾' : '▸'}</span>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--gray-600)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Client Details
          </span>
          {!showClientDetails && (
            <span style={{ fontSize: '0.72rem', color: 'var(--gray-400)', marginLeft: 4 }}>
              {[client.mrn && `MRN ${client.mrn}`, rs?.name, client.payer_plan_name].filter(Boolean).join(' · ')}
            </span>
          )}
        </button>

        {showClientDetails && (
          <div style={{ padding: '20px 24px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 40px' }}>

              {/* Col 1: client info + referral */}
              <div>
                <RSection title="Client Info">
                  <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
                    {client.mrn && (
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '0.63rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>MRN</div>
                        <div style={{ fontSize: '0.82rem', color: 'var(--gray-700)' }}>{client.mrn}</div>
                      </div>
                    )}
                    {client.insync_patient_id && (
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '0.63rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>InSync ID</div>
                        <div style={{ fontSize: '0.82rem', color: 'var(--gray-700)' }}>{client.insync_patient_id}</div>
                      </div>
                    )}
                  </div>
                  <RField label="Primary Provider"  value={raw.PrimaryProviderName || null} />
                  <RField label="Referring Provider" value={client.referring_provider || raw.ReferringProviderName || null} />
                  <RField label="Counselor"         value={client.counselor} />
                </RSection>
                {rs && (
                  <RSection title="Referral Source">
                    <RField label="Name"        value={rs.name} />
                    <RField label="Notes Email" value={rs.notes_email} />
                  </RSection>
                )}
              </div>

              {/* Col 2: insurance */}
              <div>
                <RSection title="Insurance">
                  <RField label="Current Payer" value={client.payer_plan_name} />
                  {primaryPayers.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: '0.63rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Payer History</div>
                      {primaryPayers.slice(0, 4).map((p, i) => (
                        <div key={i} style={{ fontSize: '0.78rem', color: 'var(--gray-600)', marginBottom: 2 }}>{p}</div>
                      ))}
                    </div>
                  )}
                </RSection>
              </div>

              {/* Col 3: treatment plan */}
              <div>
                <RSection title="Treatment Plan">
                  {raw.treatment_plan?.length > 0 ? raw.treatment_plan.map((p, i) => (
                    <div key={i} style={{ marginBottom: 14, padding: '10px 12px', background: 'var(--gray-50)', borderRadius: 6, border: '1px solid var(--gray-100)' }}>
                      <div style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--navy)', marginBottom: 6 }}>{p.problem}</div>
                      {p.long_term_goals?.map((g, j) => (
                        <div key={j} style={{ marginBottom: 5, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                          <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', whiteSpace: 'nowrap', marginTop: 2, minWidth: 38 }}>LTG {j + 1}</span>
                          <div style={{ flex: 1 }}>
                            <span style={{ fontSize: '0.78rem', color: 'var(--gray-700)', lineHeight: 1.4 }}>{goalText(g)}</span>
                            {goalTarget(g) && <span style={{ display: 'inline-block', marginLeft: 8, fontSize: '0.65rem', color: '#b45309', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 3, padding: '0 5px' }}>↳ {goalTarget(g)}</span>}
                          </div>
                        </div>
                      ))}
                      {p.short_term_goals?.map((g, j) => (
                        <div key={j} style={{ marginBottom: 5, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                          <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', whiteSpace: 'nowrap', marginTop: 2, minWidth: 38 }}>STG {j + 1}</span>
                          <div style={{ flex: 1 }}>
                            <span style={{ fontSize: '0.78rem', color: 'var(--gray-700)', lineHeight: 1.4 }}>{goalText(g)}</span>
                            {goalTarget(g) && <span style={{ display: 'inline-block', marginLeft: 8, fontSize: '0.65rem', color: '#b45309', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 3, padding: '0 5px' }}>↳ {goalTarget(g)}</span>}
                          </div>
                        </div>
                      ))}
                      {p.interventions?.length > 0 && (
                        <div style={{ marginTop: 4, display: 'flex', gap: 6 }}>
                          <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', whiteSpace: 'nowrap', marginTop: 2 }}>Interventions</span>
                          <span style={{ fontSize: '0.78rem', color: 'var(--gray-600)', lineHeight: 1.4 }}>{p.interventions.join(' · ')}</span>
                        </div>
                      )}
                    </div>
                  )) : (
                    <div style={{ fontSize: '0.78rem', color: 'var(--gray-300)' }}>
                      {client.insync_patient_id ? 'Sync from InSync to load' : 'No InSync ID linked'}
                    </div>
                  )}
                </RSection>
              </div>
            </div>

            {/* Client Summary — full width, below the 3-col grid */}
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--gray-100)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--navy)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                    Client Summary
                  </div>
                  {clientSummarySaveState === 'saving' && <span style={{ fontSize: '0.68rem', color: 'var(--gold)' }}>Saving…</span>}
                  {clientSummarySaveState === 'saved'  && <span style={{ fontSize: '0.68rem', color: '#16a34a' }}>✓ Saved</span>}
                </div>
                <button
                  onClick={handleUpdateClientSummary}
                  disabled={updatingClientSummary}
                  style={{
                    background: updatingClientSummary ? 'var(--gray-300)' : 'var(--navy)',
                    color: '#fff', border: 'none', borderRadius: 6,
                    padding: '4px 10px', fontSize: '0.7rem', fontWeight: 600,
                    cursor: updatingClientSummary ? 'not-allowed' : 'pointer',
                  }}
                >
                  {updatingClientSummary ? 'Updating…' : '✨ Update Summary'}
                </button>
              </div>
              <textarea
                value={clientSummary}
                onChange={e => handleClientSummaryChange(e.target.value)}
                placeholder="AI-maintained client summary — click ✨ Update Summary to generate from processed session notes…"
                style={{ ...textareaFieldSt, minHeight: 80 }}
              />
            </div>

            {/* Debug + raw — full width, below the 3-col grid */}
            {client.insync_patient_id && (
              <div style={{ borderTop: '1px solid var(--gray-100)', paddingTop: 12, marginTop: 4, display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <button onClick={debugNoteFields} disabled={debuggingFields}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.7rem', color: '#f59e0b', padding: 0 }}>
                  {debuggingFields ? 'Fetching…' : '⚙ Debug: note fields'}
                </button>
                <button onClick={debugEncounter} disabled={debugging}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.7rem', color: '#f59e0b', padding: 0 }}>
                  {debugging ? 'Fetching…' : '⚙ Debug: encounter HTML'}
                </button>
                <button onClick={debugTpRawFn} disabled={debuggingTp}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.7rem', color: '#f59e0b', padding: 0 }}>
                  {debuggingTp ? 'Fetching…' : '⚙ Debug: TP raw text + brackets'}
                </button>
              </div>
            )}
            {(debugFields || debugHtml || debugTpRaw) && (
              <div style={{ marginTop: 8 }}>
                {debugFields && <pre style={{ background: '#1e1e1e', color: '#d4d4d4', borderRadius: 6, padding: 10, fontSize: '0.62rem', overflowX: 'auto', maxHeight: 180, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(debugFields, null, 2)}</pre>}
                {debugHtml   && <pre style={{ background: '#1e1e1e', color: '#d4d4d4', borderRadius: 6, padding: 10, fontSize: '0.62rem', overflowX: 'auto', maxHeight: 180, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>{debugHtml}</pre>}
                {debugTpRaw  && <pre style={{ background: '#1e1e1e', color: '#d4d4d4', borderRadius: 6, padding: 10, fontSize: '0.62rem', overflowX: 'auto', maxHeight: 300, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(debugTpRaw, null, 2)}</pre>}
              </div>
            )}

            {client.insync_data && (
              <div style={{ marginTop: 8 }}>
                <button onClick={() => setShowRaw(s => !s)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.7rem', color: 'var(--gray-400)', padding: 0 }}>
                  {showRaw ? '▾' : '▸'} Raw InSync data
                </button>
                {showRaw && (
                  <pre style={{ marginTop: 6, background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 6, padding: 10, fontSize: '0.65rem', color: 'var(--gray-600)', overflowX: 'auto', maxHeight: 280, overflowY: 'auto' }}>
                    {JSON.stringify(client.insync_data, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Sessions ── */}
      <div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
            {[
              { label: 'Total',     value: stats.total,     color: 'var(--navy)' },
              { label: 'Scheduled', value: stats.scheduled, color: '#1e40af' },
              { label: 'Note Sent', value: stats.sent,      color: '#166534' },
              { label: 'Done',      value: stats.done,      color: 'var(--gold)' },
            ].map(({ label, value, color }) => (
              <div key={label} style={{
                flex: '1 1 70px', background: 'white', border: '1px solid var(--gray-100)',
                borderRadius: 8, padding: '8px 12px', textAlign: 'center',
              }}>
                <div style={{ fontSize: '1.6rem', fontWeight: 700, color, lineHeight: 1, fontFamily: "'DM Serif Display', Georgia, serif" }}>{value}</div>
                <div style={{ fontSize: '0.63rem', fontWeight: 600, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 3 }}>{label}</div>
              </div>
            ))}
          </div>

          <div className="card" style={{ marginBottom: 24 }}>
            <div className="card-header">
              <h3 style={{ fontSize: '1rem', color: 'var(--navy)' }}>Sessions</h3>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--gray-400)' }}>Click date/time to edit</span>
                <button className="btn btn-gold btn-xs" onClick={() => {
                  setShowAddAppt(s => !s); setAddConflicts([]);
                  if (!showAddAppt && raw.typical_session_minutes) setAddForm(f => ({ ...f, duration: String(raw.typical_session_minutes) }));
                }}>
                  + Add Session
                </button>
              </div>
            </div>

            {showAddAppt && (
              <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--gray-100)', background: 'var(--gray-50)' }}>
                <form onSubmit={handleAddAppt}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <label style={fldLabel}>Date</label>
                      <input type="date" className="form-input" value={addForm.date} required
                        onChange={e => setAddForm(f => ({ ...f, date: e.target.value }))}
                        style={{ fontSize: '0.85rem', width: 150 }} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <label style={fldLabel}>Time</label>
                      <input type="time" className="form-input" value={addForm.time} required
                        onChange={e => setAddForm(f => ({ ...f, time: e.target.value }))}
                        style={{ fontSize: '0.85rem', width: 115 }} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <label style={fldLabel}>Duration (min){raw.typical_session_minutes ? <span style={{ fontWeight: 400, color: 'var(--gray-400)', marginLeft: 4 }}>last: {raw.typical_session_minutes}</span> : null}</label>
                      <input type="number" className="form-input" value={addForm.duration} min="15" max="180"
                        onChange={e => setAddForm(f => ({ ...f, duration: e.target.value }))}
                        style={{ fontSize: '0.85rem', width: 72 }} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <label style={fldLabel}>Repeat (weeks)</label>
                      <input type="number" className="form-input" value={addForm.repeat_weeks} min="1" max="52"
                        onChange={e => setAddForm(f => ({ ...f, repeat_weeks: e.target.value }))}
                        style={{ fontSize: '0.85rem', width: 72 }} />
                    </div>
                    <button type="submit" className="btn btn-gold btn-sm" disabled={addingAppt}>
                      {addingAppt ? 'Adding…' : 'Add'}
                    </button>
                    <button type="button" className="btn btn-outline btn-sm"
                      onClick={() => { setShowAddAppt(false); setAddForm(EMPTY_ADD_FORM); setAddConflicts([]); }}>
                      Cancel
                    </button>
                  </div>
                  {addConflicts.length > 0 && (
                    <div style={{ marginTop: 8, fontSize: '0.78rem', color: '#92400e' }}>
                      ⚠ {addConflicts.length} conflict{addConflicts.length !== 1 ? 's' : ''}: {addConflicts.join(' · ')}
                    </div>
                  )}
                </form>
              </div>
            )}

            <div style={{ padding: '16px 20px' }}>
              {appts.length === 0 ? (
                <div className="empty-state" style={{ padding: '40px 20px' }}>
                  <div className="empty-icon">📅</div>
                  <p>No appointments yet. Click "+ Add Session" to create one.</p>
                </div>
              ) : appts.map(a => (
                <ApptCard key={a.id} appt={a} client={client} onUpdate={handleApptUpdate} onDelete={handleApptDelete} />
              ))}
            </div>
          </div>
      </div>

      {/* ── Delete Confirmation Modal ── */}
      {showDeleteConfirm && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: 460, maxWidth: '95vw' }}>
            <div className="modal-header">
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#dc2626' }}>
                Delete {client.first_name} {client.last_name}?
              </h3>
              <button onClick={() => setShowDeleteConfirm(false)} disabled={deleting} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: 'var(--gray-400)', lineHeight: 1 }}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: '0.85rem', color: 'var(--gray-700)', lineHeight: 1.6, margin: 0 }}>
                This permanently removes all their appointments, notes, and transcripts and cannot be undone.
                Archive instead to hide them without losing data.
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-sm" onClick={handleArchiveFromDeleteModal} disabled={deleting}
                style={{ marginRight: 'auto', background: '#059669', borderColor: '#059669', color: 'white' }}>
                Archive Instead
              </button>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowDeleteConfirm(false)} disabled={deleting}>Cancel</button>
              <button type="button" className="btn btn-sm" onClick={handleDeletePermanently} disabled={deleting}
                style={{ background: '#dc2626', borderColor: '#dc2626', color: 'white' }}>
                {deleting ? 'Deleting…' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Client Modal ── */}
      {showEditModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: 580, maxWidth: '95vw' }}>
            <div className="modal-header">
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--navy)' }}>
                Edit Client — {client.first_name} {client.last_name}
              </h3>
              <button onClick={() => setShowEditModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: 'var(--gray-400)', lineHeight: 1 }}>✕</button>
            </div>
            <div className="modal-body">
              <form id="edit-client-form" onSubmit={handleSaveClient}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 20px' }}>

                  <div style={{ gridColumn: 'span 2', fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em', paddingBottom: 6, borderBottom: '1px solid var(--gray-100)' }}>
                    Basic Info
                  </div>

                  {[
                    { key: 'first_name', label: 'First Name' },
                    { key: 'last_name',  label: 'Last Name'  },
                    { key: 'dob',        label: 'Date of Birth', type: 'date' },
                    { key: 'mrn',        label: 'MRN' },
                    { key: 'phone',      label: 'Phone',  type: 'tel' },
                    { key: 'mobile',     label: 'Mobile', type: 'tel' },
                    { key: 'email',      label: 'Email',  type: 'email', span: 2 },
                  ].map(({ key, label, type = 'text', span }) => (
                    <div key={key} style={{ gridColumn: span ? `span ${span}` : undefined, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label style={modalLabelSt}>{label}</label>
                      <input className="form-input" type={type} value={editForm[key]}
                        onChange={e => setEditForm(f => ({ ...f, [key]: e.target.value }))}
                        style={{ fontSize: '0.85rem' }} />
                    </div>
                  ))}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={modalLabelSt}>Sex</label>
                    <select className="form-input" value={editForm.sex} onChange={e => setEditForm(f => ({ ...f, sex: e.target.value }))} style={{ fontSize: '0.85rem' }}>
                      <option value="">—</option>
                      <option value="M">Male</option>
                      <option value="F">Female</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={modalLabelSt}>Status</label>
                    <select className="form-input" value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))} style={{ fontSize: '0.85rem' }}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                      {editForm.status === 'archived' && <option value="archived">Archived</option>}
                    </select>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={modalLabelSt}>Referral Source</label>
                    <select className="form-input" value={editForm.referral_source_id} onChange={e => setEditForm(f => ({ ...f, referral_source_id: e.target.value }))} style={{ fontSize: '0.85rem' }}>
                      <option value="">— None —</option>
                      {sources.filter(s => s.type !== 'ehr').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={modalLabelSt}>EHR</label>
                    <select className="form-input" value={editForm.ehr_id} onChange={e => setEditForm(f => ({ ...f, ehr_id: e.target.value }))} style={{ fontSize: '0.85rem' }}>
                      <option value="">— None —</option>
                      {sources.filter(s => s.type === 'ehr').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>

                  <div style={{ gridColumn: 'span 2', fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em', paddingBottom: 6, borderBottom: '1px solid var(--gray-100)', marginTop: 4 }}>
                    Parents / Guardians
                  </div>

                  {[
                    { nameKey: 'mother_name', phoneKey: 'mother_phone', textKey: 'mother_can_text', label: 'Mother' },
                    { nameKey: 'father_name', phoneKey: 'father_phone', textKey: 'father_can_text', label: 'Father' },
                  ].map(({ nameKey, phoneKey, textKey, label }) => (
                    <div key={nameKey} style={{ gridColumn: 'span 2', display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'end' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <label style={modalLabelSt}>{label} Name</label>
                        <input className="form-input" type="text" value={editForm[nameKey]}
                          onChange={e => setEditForm(f => ({ ...f, [nameKey]: e.target.value }))}
                          style={{ fontSize: '0.85rem' }} />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <label style={modalLabelSt}>{label} Phone</label>
                        <input className="form-input" type="tel" value={editForm[phoneKey]}
                          onChange={e => setEditForm(f => ({ ...f, [phoneKey]: e.target.value }))}
                          style={{ fontSize: '0.85rem' }} />
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.8rem', color: 'var(--gray-600)', cursor: 'pointer', paddingBottom: 6, whiteSpace: 'nowrap' }}>
                        <input type="checkbox" checked={!!editForm[textKey]}
                          onChange={e => setEditForm(f => ({ ...f, [textKey]: e.target.checked }))} />
                        Can text
                      </label>
                    </div>
                  ))}
                </div>

                {clientSaveErr && (
                  <div style={{ marginTop: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, fontSize: '0.8rem', color: '#dc2626' }}>
                    {clientSaveErr}
                  </div>
                )}
              </form>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowEditModal(false)}>Cancel</button>
              <button type="submit" form="edit-client-form" className="btn btn-primary btn-sm" disabled={savingClient}>
                {savingClient ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

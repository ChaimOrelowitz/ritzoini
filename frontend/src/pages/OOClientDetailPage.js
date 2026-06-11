import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../utils/api';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function fmtDateTime(ts) {
  if (!ts) return null;
  return new Date(ts).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function buildTpText(tp) {
  if (!tp?.length) return '';
  return tp.map(p => {
    const lines = [`Problem: ${p.problem}`];
    (p.long_term_goals  || []).forEach((g, i) => lines.push(`  LTG ${i + 1}: ${g}`));
    (p.short_term_goals || []).forEach((g, i) => lines.push(`  STG ${i + 1}: ${g}`));
    if (p.interventions?.length) lines.push(`  Interventions: ${p.interventions.join(', ')}`);
    return lines.join('\n');
  }).join('\n\n');
}

function buildPreviewText(client, appt, fields, tp) {
  const initials = `${client.first_name[0]}${client.last_name[0]}`.toUpperCase();
  const mrn      = client.mrn || '—';
  const modStr   = (fields.modalities || []).join(', ') || '—';

  return [
    `Client: ${initials} (MRN: ${mrn})`,
    `Date: ${appt.date || '—'}`,
    '',
    `Location of Meeting: ${fields.location_of_meeting || 'Telehealth - Video'}`,
    fields.additional_persons_present ? `Additional Person(s) Present: ${fields.additional_persons_present}` : null,
    fields.audio_only_reason          ? `Audio Only Reason: ${fields.audio_only_reason}` : null,
    '',
    `Content Discussed:\n${fields.content_discussed || '—'}`,
    '',
    `Interventions Used:\n${fields.interventions_used || '—'}`,
    '',
    `Modality: ${modStr}`,
    '',
    `Patient Response:\n${fields.patient_response || '—'}`,
    '',
    `Progress Toward Goals:\n${fields.progress_toward_goals || '—'}`,
    '',
    `Changes to Treatment Plan:\n${fields.treatment_plan_changes || '—'}`,
    fields.additional_comments ? `\nAdditional Comments:\n${fields.additional_comments}` : null,
    '',
    '── Treatment Plan ──',
    tp || '(not provided)',
  ].filter(l => l !== null).join('\n');
}

// ── Shared components ─────────────────────────────────────────────────────────

function Field({ label, value }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{ fontSize: '0.88rem', color: value ? 'var(--gray-800)' : 'var(--gray-400)' }}>{value || '—'}</span>
    </div>
  );
}

function FieldWide({ label, value }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, gridColumn: '1 / -1' }}>
      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{ fontSize: '0.88rem', color: value ? 'var(--gray-800)' : 'var(--gray-400)' }}>{value || '—'}</span>
    </div>
  );
}

function InfoSection({ title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 14, paddingBottom: 6, borderBottom: '1px solid var(--gray-100)' }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '14px 24px' }}>
        {children}
      </div>
    </div>
  );
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MODALITIES_LIST = ['CBT', 'EMDR', 'Sand Tray', 'Solution Focused', 'Client Centered', 'DBT', 'Art Therapy', 'Strength Based', 'Family Systems', 'Trauma Focused', 'Play Therapy', 'Mindfulness', 'Behavioral Role Play', 'Guided Imagery', 'Motivational Interviewing'];

const APPT_STATUS_STYLE = {
  scheduled: { bg: '#dbeafe', color: '#1e40af', border: '#93c5fd' },
  completed: { bg: '#dcfce7', color: '#166534', border: '#86efac' },
  cancelled: { bg: '#f3f4f6', color: '#6b7280', border: '#d1d5db' },
};

const fldLabel = { display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 };
const modalLabelSt = { fontSize: '0.72rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em' };

const EMPTY_EDIT_FORM = {
  first_name: '', last_name: '', dob: '', sex: '', phone: '', mobile: '',
  email: '', mrn: '', referral_source_id: '', status: 'active',
  mother_name: '', mother_phone: '', father_name: '', father_phone: '',
};

// ── Appointment Card ──────────────────────────────────────────────────────────

function ApptCard({ appt: initialAppt, client, onUpdate, onDelete }) {
  const tp = buildTpText(client.insync_data?.treatment_plan);
  const [appt,      setAppt]      = useState(initialAppt);
  const [editDate,  setEditDate]  = useState(false);
  const [editTime,  setEditTime]  = useState(false);
  const [localDate, setLocalDate] = useState(initialAppt.date || '');
  const [localTime, setLocalTime] = useState((initialAppt.time || '').slice(0, 5));
  const [localDur,  setLocalDur]  = useState(String(initialAppt.duration || 45));

  const [rawNotes,  setRawNotes]  = useState(initialAppt.raw_notes || '');
  const [saveState, setSaveState] = useState('idle');
  const saveTimer = useRef(null);

  const [processing, setProcessing] = useState(false);
  const [fields,     setFields]     = useState(null);
  const [sending,    setSending]    = useState(false);
  const [deleting,   setDeleting]   = useState(false);
  const [err,        setErr]        = useState('');

  useEffect(() => {
    setAppt(initialAppt);
    setRawNotes(initialAppt.raw_notes || '');
    setLocalDate(initialAppt.date || '');
    setLocalTime((initialAppt.time || '').slice(0, 5));
    setLocalDur(String(initialAppt.duration || 45));
  }, [initialAppt]);

  const style = APPT_STATUS_STYLE[appt.status] || APPT_STATUS_STYLE.scheduled;

  function handleNoteChange(val) {
    setRawNotes(val);
    setSaveState('saving');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const updated = await api.patch(`/oo/appointments/${appt.id}`, { raw_notes: val });
        setAppt(prev => ({ ...prev, ...updated }));
        onUpdate({ ...appt, ...updated, raw_notes: val });
        setSaveState('saved');
        setTimeout(() => setSaveState('idle'), 2000);
      } catch { setSaveState('idle'); }
    }, 1000);
  }

  async function handleCheckbox(field, checked) {
    const val = checked ? new Date().toISOString() : null;
    setAppt(prev => ({ ...prev, [field]: val }));
    try {
      const updated = await api.patch(`/oo/appointments/${appt.id}`, { [field]: val });
      setAppt(prev => ({ ...prev, ...updated }));
      onUpdate({ ...appt, ...updated, [field]: val });
    } catch {
      setAppt(prev => ({ ...prev, [field]: appt[field] }));
    }
  }

  async function saveDate() {
    setEditDate(false);
    if (localDate === appt.date) return;
    const updated = await api.patch(`/oo/appointments/${appt.id}`, { date: localDate });
    setAppt(prev => ({ ...prev, ...updated }));
    onUpdate({ ...appt, ...updated });
  }

  async function saveTime() {
    setEditTime(false);
    const updated = await api.patch(`/oo/appointments/${appt.id}`, {
      time: localTime + ':00',
      duration: parseInt(localDur) || 45,
    });
    setAppt(prev => ({ ...prev, ...updated }));
    onUpdate({ ...appt, ...updated });
  }

  async function handleProcess() {
    if (!rawNotes.trim()) { setErr('Write notes first.'); return; }
    setProcessing(true); setErr('');
    try {
      await api.patch(`/oo/appointments/${appt.id}`, { raw_notes: rawNotes });
      const r = await api.post(`/oo/appointments/${appt.id}/process-note`, { raw_notes: rawNotes, treatment_plan: tp });
      setFields(r.fields);
    } catch (ex) { setErr(ex.message); }
    finally { setProcessing(false); }
  }

  async function handleSend() {
    setSending(true); setErr('');
    try {
      await api.post(`/oo/appointments/${appt.id}/send-note`, { fields, treatment_plan: tp });
      const sentAt = new Date().toISOString();
      setAppt(prev => ({ ...prev, note_sent_at: sentAt }));
      onUpdate({ ...appt, note_sent_at: sentAt });
    } catch (ex) { setErr(ex.message); }
    finally { setSending(false); }
  }

  function updateField(key, val) { setFields(prev => ({ ...prev, [key]: val })); }

  function toggleModality(m) {
    setFields(prev => {
      const mods = prev.modalities || [];
      return { ...prev, modalities: mods.includes(m) ? mods.filter(x => x !== m) : [...mods, m] };
    });
  }

  async function handleDelete() {
    if (!window.confirm(`Delete appointment on ${fmtDate(appt.date)} at ${fmt12(appt.time)}?`)) return;
    setDeleting(true);
    try {
      await api.delete(`/oo/appointments/${appt.id}`);
      onDelete(appt.id);
    } catch (ex) { alert(ex.message); setDeleting(false); }
  }

  return (
    <div style={{
      background: 'white',
      border: `1px solid ${style.border}`,
      borderLeft: `5px solid ${style.border}`,
      borderRadius: 'var(--radius)',
      padding: '14px 18px',
      marginBottom: 10,
    }}>
      {/* Top row */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* Date + time */}
        <div style={{ minWidth: 160 }}>
          {editDate ? (
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              <input type="date" className="form-input" style={{ padding: '3px 6px', fontSize: '0.78rem', width: 140 }}
                value={localDate} onChange={e => setLocalDate(e.target.value)} autoFocus />
              <button className="btn btn-gold btn-xs" type="button" onClick={saveDate}>✓</button>
              <button className="btn btn-outline btn-xs" type="button" onClick={() => setEditDate(false)}>✕</button>
            </div>
          ) : (
            <div onClick={() => setEditDate(true)}
              style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '0.95rem', cursor: 'pointer', marginBottom: 3 }}>
              {fmtDate(appt.date)}
              <span style={{ color: 'var(--gray-400)', marginLeft: 5, fontSize: '0.68rem' }}>✏</span>
            </div>
          )}

          {editTime ? (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
              <input type="time" className="form-input" style={{ padding: '3px 6px', fontSize: '0.78rem', width: 100 }}
                value={localTime} onChange={e => setLocalTime(e.target.value)} />
              <input type="number" className="form-input" style={{ padding: '3px 6px', fontSize: '0.78rem', width: 62 }}
                value={localDur} onChange={e => setLocalDur(e.target.value)} placeholder="min" />
              <button className="btn btn-gold btn-xs" type="button" onClick={saveTime}>✓</button>
              <button className="btn btn-outline btn-xs" type="button" onClick={() => setEditTime(false)}>✕</button>
            </div>
          ) : (
            <div onClick={() => setEditTime(true)}
              style={{ fontSize: '0.75rem', color: 'var(--gray-400)', cursor: 'pointer', marginTop: 2 }}>
              {fmt12(appt.time)} · {appt.duration || 45} min
              <span style={{ color: 'var(--gray-400)', marginLeft: 4, fontSize: '0.68rem' }}>✏</span>
            </div>
          )}
        </div>

        {/* Status badge */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase' }}>Status</label>
          <div style={{
            padding: '5px 10px', fontSize: '0.82rem', width: 120,
            borderRadius: 'var(--radius)', border: `1.5px solid ${style.border}`,
            background: style.bg, color: style.color, fontWeight: 600,
            textTransform: 'capitalize', boxSizing: 'border-box',
          }}>
            {appt.status}
          </div>
        </div>

        {/* Checkboxes */}
        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', marginLeft: 'auto', flexWrap: 'wrap' }}>
          {[
            { field: 'note_sent_at', label: 'Note Sent' },
            { field: 'note_done_at', label: 'Done' },
          ].map(({ field, label }) => (
            <div key={field} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.8rem', color: 'var(--gray-800)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!appt[field]}
                  onChange={e => handleCheckbox(field, e.target.checked)}
                  style={{ width: 15, height: 15, accentColor: 'var(--navy)' }}
                />
                {label}
              </label>
              {appt[field] && (
                <div style={{ fontSize: '0.65rem', color: 'var(--gray-400)', whiteSpace: 'nowrap' }}>
                  {fmtDateTime(appt[field])}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Delete */}
        <button className="btn btn-danger btn-xs" type="button" onClick={handleDelete} disabled={deleting}>
          {deleting ? '…' : 'Delete'}
        </button>
      </div>

      {/* Notes */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
          Session Notes
          {saveState === 'saving' && <span style={{ color: 'var(--gold)', fontWeight: 500, fontSize: '0.72rem' }}>Saving…</span>}
          {saveState === 'saved'  && <span style={{ color: '#10b981', fontWeight: 500, fontSize: '0.72rem' }}>✓ Saved</span>}
        </div>
        <textarea
          className="form-textarea"
          value={rawNotes}
          onChange={e => handleNoteChange(e.target.value)}
          placeholder="Session notes…"
          style={{ minHeight: 72, fontSize: '0.875rem' }}
        />
        {err && <p style={{ color: '#dc2626', margin: '4px 0 0', fontSize: '0.78rem' }}>{err}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline btn-xs" type="button"
            onClick={handleProcess} disabled={processing || !rawNotes.trim()}>
            {processing ? 'Processing…' : fields ? 'Re-process with AI' : 'Process with AI'}
          </button>
          {fields && (
            <button className="btn btn-gold btn-xs" type="button" onClick={handleSend} disabled={sending}>
              {sending ? 'Sending…' : 'Send to Secretary'}
            </button>
          )}
        </div>
      </div>

      {/* AI fields + preview */}
      {fields && (
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--gray-100)' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            AI-Generated Fields
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={fldLabel}>Location of Meeting</label>
              <input className="form-input" value={fields.location_of_meeting || 'Telehealth - Video'}
                readOnly style={{ background: 'var(--gray-50)', fontSize: '0.85rem' }} />
            </div>
            <div>
              <label style={fldLabel}>Additional Person(s) Present</label>
              <input className="form-input" style={{ fontSize: '0.85rem' }}
                value={fields.additional_persons_present || ''}
                onChange={e => updateField('additional_persons_present', e.target.value)}
                placeholder="Leave blank if none" />
            </div>
            <div>
              <label style={fldLabel}>Content Discussed</label>
              <textarea className="form-textarea" style={{ minHeight: 56, fontSize: '0.85rem' }}
                value={fields.content_discussed || ''} onChange={e => updateField('content_discussed', e.target.value)} />
            </div>
            <div>
              <label style={fldLabel}>Interventions Used</label>
              <textarea className="form-textarea" style={{ minHeight: 48, fontSize: '0.85rem' }}
                value={fields.interventions_used || ''} onChange={e => updateField('interventions_used', e.target.value)} />
            </div>
            <div>
              <label style={fldLabel}>Modality</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
                {MODALITIES_LIST.map(m => {
                  const on = (fields.modalities || []).includes(m);
                  return (
                    <button key={m} type="button" onClick={() => toggleModality(m)} style={{
                      padding: '3px 9px', fontSize: '0.72rem', fontWeight: 600, borderRadius: 4, cursor: 'pointer',
                      border: `1.5px solid ${on ? 'var(--navy)' : 'var(--gray-200)'}`,
                      background: on ? 'var(--navy)' : 'transparent',
                      color: on ? '#fff' : 'var(--gray-400)',
                      transition: 'background 0.1s',
                    }}>{m}</button>
                  );
                })}
              </div>
            </div>
            <div>
              <label style={fldLabel}>Patient Response</label>
              <textarea className="form-textarea" style={{ minHeight: 48, fontSize: '0.85rem' }}
                value={fields.patient_response || ''} onChange={e => updateField('patient_response', e.target.value)} />
            </div>
            <div>
              <label style={fldLabel}>Progress Toward Goals</label>
              <textarea className="form-textarea" style={{ minHeight: 48, fontSize: '0.85rem' }}
                value={fields.progress_toward_goals || ''} onChange={e => updateField('progress_toward_goals', e.target.value)} />
            </div>
            <div>
              <label style={fldLabel}>Changes to Treatment Plan</label>
              <textarea className="form-textarea" style={{ minHeight: 48, fontSize: '0.85rem' }}
                value={fields.treatment_plan_changes || ''} onChange={e => updateField('treatment_plan_changes', e.target.value)} />
            </div>
            <div>
              <label style={fldLabel}>Additional Comments</label>
              <textarea className="form-textarea" style={{ minHeight: 40, fontSize: '0.85rem' }}
                value={fields.additional_comments || ''} onChange={e => updateField('additional_comments', e.target.value)} />
            </div>

            <div>
              <label style={fldLabel}>Email Preview</label>
              <pre style={{
                background: '#f8fafc', border: '1px solid var(--gray-200)', borderRadius: 6,
                padding: '12px 14px', fontSize: '0.78rem', lineHeight: 1.7,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit',
                margin: 0, color: 'var(--gray-600)',
              }}>
                {buildPreviewText(client, appt, fields, tp)}
              </pre>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <button className="btn btn-gold btn-sm" type="button" onClick={handleSend} disabled={sending}>
              {sending ? 'Sending…' : 'Send to Secretary'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function OOClientDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [client,   setClient]   = useState(null);
  const [appts,    setAppts]    = useState([]);
  const [sources,  setSources]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showRaw,  setShowRaw]  = useState(false);

  // Edit Client modal
  const [showEditModal,  setShowEditModal]  = useState(false);
  const [editForm,       setEditForm]       = useState(EMPTY_EDIT_FORM);
  const [savingClient,   setSavingClient]   = useState(false);

  // Debug/sync
  const [syncingFs,       setSyncingFs]       = useState(false);
  const [fsMsg,           setFsMsg]           = useState('');
  const [debugHtml,       setDebugHtml]       = useState('');
  const [debugging,       setDebugging]       = useState(false);
  const [debugFields,     setDebugFields]     = useState(null);
  const [debuggingFields, setDebuggingFields] = useState(false);

  function loadClientData() {
    return api.get(`/oo/clients/${id}`).then(setClient).catch(() => navigate('/oo/clients'));
  }

  const loadAppts = useCallback(() => {
    return api.get(`/oo/appointments?client_id=${id}`)
      .then(d => setAppts(Array.isArray(d) ? [...d].sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.time.localeCompare(b.time);
      }) : []))
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    Promise.all([
      loadClientData(),
      loadAppts(),
      api.get('/oo/clients/referral-sources').then(setSources).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, [id]); // eslint-disable-line

  // ── Edit Client modal ──

  function openEditClient() {
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
      status:       client.status       || 'active',
      mother_name:  client.mother_name  || '',
      mother_phone: client.mother_phone || '',
      father_name:  client.father_name  || '',
      father_phone: client.father_phone || '',
    });
    setShowEditModal(true);
  }

  async function handleSaveClient(e) {
    e.preventDefault();
    setSavingClient(true);
    try {
      const payload = { ...editForm, referral_source_id: editForm.referral_source_id || null };
      const updated = await api.put(`/oo/clients/${id}`, payload);
      setClient(updated);
      setShowEditModal(false);
    } finally { setSavingClient(false); }
  }

  // ── Appointment handlers ──

  async function syncFacesheet() {
    setSyncingFs(true); setFsMsg('');
    try {
      const r = await api.post(`/oo/clients/${id}/sync-facesheet`, {});
      setFsMsg(`${r.diagnoses_count ?? 0} dx · ${r.tp_count ?? 0} TP problem${(r.tp_count ?? 0) !== 1 ? 's' : ''} synced`);
      await loadClientData();
    } catch (ex) { setFsMsg(ex.message); }
    finally { setSyncingFs(false); }
  }

  async function debugEncounter() {
    setDebugging(true); setDebugHtml('');
    try {
      const r = await api.get(`/oo/clients/${id}/debug-encounter-html`);
      setDebugHtml(r.html_preview);
    } catch (ex) { setDebugHtml(`ERROR: ${ex.message}`); }
    finally { setDebugging(false); }
  }

  async function debugNoteFields() {
    setDebuggingFields(true); setDebugFields(null);
    try {
      const r = await api.get(`/oo/clients/${id}/debug-note-fields`);
      setDebugFields(r);
    } catch (ex) { setDebugFields({ error: ex.message }); }
    finally { setDebuggingFields(false); }
  }

  function handleApptUpdate(updated) {
    setAppts(prev => prev.map(a => a.id === updated.id ? { ...a, ...updated } : a));
  }

  function handleApptDelete(apptId) {
    setAppts(prev => prev.filter(a => a.id !== apptId));
  }

  // ── Render ──

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (!client) return null;

  const rs  = client.oo_referral_sources;
  const raw = client.insync_data || {};

  const primaryPayers = raw.PrimaryPayers
    ? raw.PrimaryPayers.split('!@#').map(s => s.trim()).filter(Boolean)
    : [];

  const age = calcAge(client.dob);

  const stats = {
    total:     appts.length,
    scheduled: appts.filter(a => a.status === 'scheduled').length,
    sent:      appts.filter(a => a.note_sent_at).length,
    done:      appts.filter(a => a.note_done_at).length,
  };

  // Info strip items
  const infoItems = [
    client.dob ? `${fmtDob(client.dob)}${age !== null ? ` (${age}y)` : ''}` : null,
    client.sex ? (client.sex === 'F' ? 'Female' : client.sex === 'M' ? 'Male' : client.sex) : null,
    client.phone || null,
    client.email || raw.PatientEmail || null,
  ].filter(Boolean);

  return (
    <div style={{ padding: '28px 32px', maxWidth: 960 }}>
      <button className="back-link" onClick={() => navigate('/oo/clients')}>← Back to Clients</button>

      {/* ── Header ── */}
      <div className="page-header" style={{ marginBottom: 8 }}>
        <div style={{ flex: 1 }}>

          {/* Name row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0 }}>{client.last_name}, {client.first_name}</h2>
            <span className={`badge badge-${client.status}`}>{client.status}</span>
            {rs && <span className="badge" style={{ background: '#dbeafe', color: '#1e40af' }}>{rs.name}</span>}
            <button
              className="btn btn-outline btn-sm"
              onClick={openEditClient}
              style={{ marginLeft: 'auto' }}
            >
              Edit Client
            </button>
          </div>

          {/* Info strip */}
          {infoItems.length > 0 && (
            <div style={{
              display: 'flex', flexWrap: 'wrap',
              background: 'var(--gray-50)', borderRadius: 8,
              border: '1px solid var(--gray-100)', overflow: 'hidden',
              marginBottom: 8,
            }}>
              {infoItems.map((val, i) => (
                <div key={i} style={{
                  padding: '8px 16px', fontSize: '0.82rem', color: 'var(--gray-700)',
                  borderRight: i < infoItems.length - 1 ? '1px solid var(--gray-200)' : 'none',
                }}>
                  {val}
                </div>
              ))}
            </div>
          )}

          {/* Mother / Father */}
          {(client.mother_name || client.father_name) && (
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 6 }}>
              {client.mother_name && (
                <div style={{ fontSize: '0.82rem', color: 'var(--gray-600)' }}>
                  <span style={{ fontWeight: 600, color: 'var(--gray-500)' }}>Mother:</span>{' '}
                  {client.mother_name}
                  {client.mother_phone && <span style={{ color: 'var(--gray-400)', marginLeft: 6 }}>{client.mother_phone}</span>}
                </div>
              )}
              {client.father_name && (
                <div style={{ fontSize: '0.82rem', color: 'var(--gray-600)' }}>
                  <span style={{ fontWeight: 600, color: 'var(--gray-500)' }}>Father:</span>{' '}
                  {client.father_name}
                  {client.father_phone && <span style={{ color: 'var(--gray-400)', marginLeft: 6 }}>{client.father_phone}</span>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Stats ── */}
      <div className="stats-row" style={{ marginBottom: 28 }}>
        <div className="stat-card"><div className="stat-value">{stats.total}</div><div className="stat-label">Total</div></div>
        <div className="stat-card"><div className="stat-value" style={{ color: '#1e40af' }}>{stats.scheduled}</div><div className="stat-label">Scheduled</div></div>
        <div className="stat-card"><div className="stat-value" style={{ color: '#166534' }}>{stats.sent}</div><div className="stat-label">Note Sent</div></div>
        <div className="stat-card"><div className="stat-value" style={{ color: 'var(--gold)' }}>{stats.done}</div><div className="stat-label">Done</div></div>
      </div>

      {/* ── Diagnoses (moved up) ── */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, paddingBottom: 6, borderBottom: '1px solid var(--gray-100)' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            Diagnoses
            {raw.facesheet_synced_at && (
              <span style={{ fontWeight: 400, textTransform: 'none', marginLeft: 8, fontSize: '0.7rem' }}>
                synced {new Date(raw.facesheet_synced_at).toLocaleDateString()}
              </span>
            )}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {fsMsg && <span style={{ fontSize: '0.75rem', color: fsMsg.includes('ailed') || fsMsg.includes('rror') ? '#dc2626' : '#16a34a' }}>{fsMsg}</span>}
            {client.insync_patient_id && (
              <button className="btn btn-outline btn-xs" onClick={syncFacesheet} disabled={syncingFs}>
                {syncingFs ? 'Syncing…' : 'Sync from InSync'}
              </button>
            )}
          </div>
        </div>
        {raw.diagnoses?.length > 0 ? (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: 'var(--gray-50)' }}>
                {['ICD-10', 'Problem', 'Onset', 'Notes'].map(h => (
                  <th key={h} style={thSt}>{h}</th>
                ))}
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
          <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', margin: 0 }}>
            {client.insync_patient_id ? 'No diagnoses synced — click "Sync from InSync"' : 'No InSync ID linked.'}
          </p>
        )}
      </div>

      {/* ── Sessions ── */}
      <div className="card" style={{ marginBottom: 28 }}>
        <div className="card-header">
          <h3 style={{ fontSize: '1rem', color: 'var(--navy)' }}>Sessions</h3>
          <span style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>Notes auto-save · Click date/time to edit</span>
        </div>
        <div style={{ padding: '16px 20px' }}>
          {appts.length === 0 ? (
            <div className="empty-state" style={{ padding: '40px 20px' }}>
              <div className="empty-icon">📅</div>
              <p>No appointments yet.</p>
            </div>
          ) : appts.map(a => (
            <ApptCard
              key={a.id}
              appt={a}
              client={client}
              onUpdate={handleApptUpdate}
              onDelete={handleApptDelete}
            />
          ))}
        </div>
      </div>

      {/* ── Treatment Plan ── */}
      {raw.treatment_plan?.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 14, paddingBottom: 6, borderBottom: '1px solid var(--gray-100)' }}>
            Treatment Plan
          </div>
          {raw.treatment_plan.map((p, i) => (
            <div key={i} style={{ marginBottom: 18, padding: '14px 16px', background: 'var(--gray-50)', borderRadius: 8, border: '1px solid var(--gray-100)' }}>
              <div style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--navy)', marginBottom: 10 }}>{p.problem}</div>
              {p.long_term_goals?.map((g, j) => (
                <div key={j} style={{ marginBottom: 5 }}>
                  <span style={tpLabelSt}>LTG {j + 1}</span>
                  <span style={{ fontSize: '0.84rem', color: 'var(--gray-800)' }}>{g}</span>
                </div>
              ))}
              {p.short_term_goals?.map((g, j) => (
                <div key={j} style={{ marginBottom: 5 }}>
                  <span style={tpLabelSt}>STG {j + 1}</span>
                  <span style={{ fontSize: '0.84rem', color: 'var(--gray-800)' }}>{g}</span>
                </div>
              ))}
              {p.interventions?.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <span style={tpLabelSt}>Interventions</span>
                  <span style={{ fontSize: '0.84rem', color: 'var(--gray-600)' }}>{p.interventions.join(' · ')}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Insurance ── */}
      <InfoSection title="Insurance">
        <Field label="Current Payer" value={client.payer_plan_name} />
        {primaryPayers.length > 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, gridColumn: '1 / -1' }}>
            <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Payer History</span>
            {primaryPayers.map((p, i) => (
              <span key={i} style={{ fontSize: '0.85rem', color: 'var(--gray-800)' }}>{p}</span>
            ))}
          </div>
        )}
      </InfoSection>

      {/* ── Referral Source ── */}
      {rs && (
        <InfoSection title="Referral Source">
          <Field label="Name"        value={rs.name} />
          <Field label="Notes Email" value={rs.notes_email} />
        </InfoSection>
      )}

      {/* ── Client Info (MRN, InSync ID — secondary) ── */}
      <InfoSection title="Client Info">
        <Field label="MRN"              value={client.mrn} />
        <Field label="InSync ID"        value={client.insync_patient_id ? String(client.insync_patient_id) : null} />
        <Field label="Mobile"           value={client.mobile} />
        <Field label="Primary Provider" value={raw.PrimaryProviderName || null} />
        <Field label="Referring Provider" value={client.referring_provider || raw.ReferringProviderName || null} />
        <Field label="Counselor"        value={client.counselor} />
        <Field label="Eligibility"      value={client.eligibility_result} />
        <FieldWide label="Address"      value={client.address} />
      </InfoSection>

      {/* ── Debug ── */}
      {client.insync_patient_id && (
        <div style={{ marginTop: 8 }}>
          <button onClick={debugNoteFields} disabled={debuggingFields}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: '#f59e0b', padding: 0 }}>
            {debuggingFields ? 'Fetching…' : '⚙ Debug: note fields'}
          </button>
          {debugFields && (
            <pre style={{ marginTop: 8, background: '#1e1e1e', color: '#d4d4d4', borderRadius: 6, padding: 14, fontSize: '0.68rem', overflowX: 'auto', maxHeight: 300, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(debugFields, null, 2)}
            </pre>
          )}
        </div>
      )}
      {client.insync_patient_id && (
        <div style={{ marginTop: 8, marginBottom: 16 }}>
          <button onClick={debugEncounter} disabled={debugging}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: '#f59e0b', padding: 0 }}>
            {debugging ? 'Fetching…' : '⚙ Debug: encounter HTML'}
          </button>
          {debugHtml && (
            <pre style={{ marginTop: 8, background: '#1e1e1e', color: '#d4d4d4', borderRadius: 6, padding: 14, fontSize: '0.68rem', overflowX: 'auto', maxHeight: 300, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {debugHtml}
            </pre>
          )}
        </div>
      )}

      {/* ── Raw InSync data ── */}
      {client.insync_data && (
        <div style={{ marginTop: 8 }}>
          <button onClick={() => setShowRaw(s => !s)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--gray-400)', padding: 0 }}>
            {showRaw ? '▾' : '▸'} Raw InSync data
          </button>
          {showRaw && (
            <pre style={{ marginTop: 8, background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 6, padding: 14, fontSize: '0.72rem', color: 'var(--gray-600)', overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
              {JSON.stringify(client.insync_data, null, 2)}
            </pre>
          )}
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

                  {/* Basic info */}
                  <div style={{ gridColumn: 'span 2', fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em', paddingBottom: 6, borderBottom: '1px solid var(--gray-100)' }}>
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
                      <input
                        className="form-input"
                        type={type}
                        value={editForm[key]}
                        onChange={e => setEditForm(f => ({ ...f, [key]: e.target.value }))}
                        style={{ fontSize: '0.85rem' }}
                      />
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
                    </select>
                  </div>

                  <div style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={modalLabelSt}>Referral Source</label>
                    <select className="form-input" value={editForm.referral_source_id} onChange={e => setEditForm(f => ({ ...f, referral_source_id: e.target.value }))} style={{ fontSize: '0.85rem' }}>
                      <option value="">— None —</option>
                      {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>

                  {/* Parents */}
                  <div style={{ gridColumn: 'span 2', fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em', paddingBottom: 6, borderBottom: '1px solid var(--gray-100)', marginTop: 4 }}>
                    Parents / Guardians
                  </div>

                  {[
                    { key: 'mother_name',  label: 'Mother Name'  },
                    { key: 'mother_phone', label: 'Mother Phone', type: 'tel' },
                    { key: 'father_name',  label: 'Father Name'  },
                    { key: 'father_phone', label: 'Father Phone', type: 'tel' },
                  ].map(({ key, label, type = 'text' }) => (
                    <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label style={modalLabelSt}>{label}</label>
                      <input
                        className="form-input"
                        type={type}
                        value={editForm[key]}
                        onChange={e => setEditForm(f => ({ ...f, [key]: e.target.value }))}
                        style={{ fontSize: '0.85rem' }}
                      />
                    </div>
                  ))}
                </div>
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

const thSt = { padding: '6px 10px', textAlign: 'left', fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--gray-200)' };
const tdSt = { padding: '8px 10px', verticalAlign: 'top' };
const tpLabelSt = { display: 'inline-block', fontSize: '0.68rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', minWidth: 80, marginRight: 8 };

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

function goalText(g) { return typeof g === 'string' ? g : g.text; }
function goalTarget(g) { return typeof g === 'string' ? null : g.target_date; }

function buildTpText(tp) {
  if (!tp?.length) return '';
  return tp.map(p => {
    const lines = [`Problem: ${p.problem}`];
    (p.long_term_goals  || []).forEach((g, i) => {
      const td = goalTarget(g);
      lines.push(`  LTG ${i + 1}: ${goalText(g)}${td ? ` [Target: ${td}]` : ''}`);
    });
    (p.short_term_goals || []).forEach((g, i) => {
      const td = goalTarget(g);
      lines.push(`  STG ${i + 1}: ${goalText(g)}${td ? ` [Target: ${td}]` : ''}`);
    });
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

// ── Right column components ───────────────────────────────────────────────────

function RField({ label, value }) {
  if (!value) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: '0.63rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: '0.82rem', color: 'var(--gray-700)' }}>{value}</div>
    </div>
  );
}

function RSection({ title, action, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, paddingBottom: 5, borderBottom: '1px solid var(--gray-100)' }}>
        <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--navy)', textTransform: 'uppercase', letterSpacing: '0.07em', flex: 1 }}>{title}</span>
        {action}
      </div>
      {children}
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
  mother_can_text: false, father_can_text: false,
};

const EMPTY_ADD_FORM = { date: '', time: '', duration: '45', repeat_weeks: '1' };

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
  const [processing,     setProcessing]     = useState(false);
  const [fields,         setFields]         = useState(initialAppt.ai_fields || null);
  const [sending,        setSending]        = useState(false);
  const [deleting,       setDeleting]       = useState(false);
  const [err,            setErr]            = useState('');
  const [showNoteModal,  setShowNoteModal]  = useState(false);
  const [pushing,        setPushing]        = useState(false);
  const [pushMsg,        setPushMsg]        = useState('');

  useEffect(() => {
    setAppt(initialAppt);
    setRawNotes(initialAppt.raw_notes || '');
    setLocalDate(initialAppt.date || '');
    setLocalTime((initialAppt.time || '').slice(0, 5));
    setLocalDur(String(initialAppt.duration || 45));
    setFields(initialAppt.ai_fields || null);
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
    } catch { setAppt(prev => ({ ...prev, [field]: appt[field] })); }
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
      time: localTime + ':00', duration: parseInt(localDur) || 45,
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

  async function handlePushToInsync() {
    if (!window.confirm(`Push this appointment (${fmtDate(appt.date)} ${fmt12(appt.time)}) to InSync?`)) return;
    setPushing(true); setPushMsg('');
    try {
      const res = await api.post(`/oo/appointments/${appt.id}/push-to-insync`, {});
      setPushMsg(`✓ Created in InSync${res.insync_visit_id ? ` (visit ${res.insync_visit_id})` : ''}`);
      setAppt(a => ({ ...a, insync_visit_id: res.insync_visit_id }));
    } catch (ex) {
      setPushMsg(`Error: ${ex.message}`);
    } finally {
      setPushing(false);
    }
  }

  return (
    <div style={{
      background: 'white', border: `1px solid ${style.border}`,
      borderLeft: `5px solid ${style.border}`, borderRadius: 'var(--radius)',
      padding: '14px 18px', marginBottom: 10,
    }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
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
              {fmtDate(appt.date)}<span style={{ color: 'var(--gray-400)', marginLeft: 5, fontSize: '0.68rem' }}>✏</span>
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
              {fmt12(appt.time)} · {appt.duration || 45} min<span style={{ marginLeft: 4, fontSize: '0.68rem' }}>✏</span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase' }}>Status</label>
          <div style={{
            padding: '5px 10px', fontSize: '0.82rem', width: 110, borderRadius: 'var(--radius)',
            border: `1.5px solid ${style.border}`, background: style.bg, color: style.color,
            fontWeight: 600, textTransform: 'capitalize', boxSizing: 'border-box',
          }}>{appt.status}</div>
        </div>

        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', marginLeft: 'auto', flexWrap: 'wrap' }}>
          {[{ field: 'note_sent_at', label: 'Note Sent' }, { field: 'note_done_at', label: 'Done' }].map(({ field, label }) => (
            <div key={field} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.8rem', color: 'var(--gray-800)', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!appt[field]} onChange={e => handleCheckbox(field, e.target.checked)}
                  style={{ width: 15, height: 15, accentColor: 'var(--navy)' }} />
                {label}
              </label>
              {appt[field] && <div style={{ fontSize: '0.65rem', color: 'var(--gray-400)', whiteSpace: 'nowrap' }}>{fmtDateTime(appt[field])}</div>}
            </div>
          ))}
        </div>

        <button className="btn btn-danger btn-xs" type="button" onClick={handleDelete} disabled={deleting}>
          {deleting ? '…' : 'Delete'}
        </button>
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
          Session Notes
          {saveState === 'saving' && <span style={{ color: 'var(--gold)', fontWeight: 500, fontSize: '0.72rem' }}>Saving…</span>}
          {saveState === 'saved'  && <span style={{ color: '#10b981', fontWeight: 500, fontSize: '0.72rem' }}>✓ Saved</span>}
        </div>
        <textarea className="form-textarea" value={rawNotes} onChange={e => handleNoteChange(e.target.value)}
          placeholder="Session notes…" style={{ minHeight: 72, fontSize: '0.875rem' }} />
        {err && <p style={{ color: '#dc2626', margin: '4px 0 0', fontSize: '0.78rem' }}>{err}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-outline btn-xs" type="button" onClick={handleProcess} disabled={processing || !rawNotes.trim()}>
            {processing ? 'Processing…' : fields ? 'Re-process' : 'Process with AI'}
          </button>
          <button
            className="btn btn-xs"
            type="button"
            onClick={() => fields && setShowNoteModal(true)}
            style={{
              background: fields ? 'var(--gold)' : 'var(--gray-100)',
              color: fields ? 'var(--navy)' : 'var(--gray-400)',
              border: `1px solid ${fields ? 'var(--gold)' : 'var(--gray-200)'}`,
              cursor: fields ? 'pointer' : 'default',
              fontWeight: 600,
            }}
            title={fields ? 'Open AI note' : 'No AI note yet — write notes and click Process with AI'}
          >
            {fields ? 'Open Note →' : 'No AI note'}
          </button>
          <button
            className="btn btn-xs"
            type="button"
            onClick={handlePushToInsync}
            disabled={pushing}
            style={{
              background: appt.insync_visit_id ? '#dcfce7' : 'var(--navy)',
              color: appt.insync_visit_id ? '#15803d' : 'white',
              border: `1px solid ${appt.insync_visit_id ? '#86efac' : 'var(--navy)'}`,
              fontWeight: 600,
            }}
            title={appt.insync_visit_id ? `Already in InSync (visit ${appt.insync_visit_id})` : 'Create this appointment in InSync'}
          >
            {pushing ? 'Pushing…' : appt.insync_visit_id ? '✓ In InSync' : 'Push to InSync'}
          </button>
          {pushMsg && <span style={{ fontSize: '0.7rem', color: pushMsg.startsWith('Error') ? '#dc2626' : '#16a34a' }}>{pushMsg}</span>}
          {appt.note_sent_at && (
            <span style={{ fontSize: '0.7rem', color: '#16a34a' }}>✓ sent {fmtDateTime(appt.note_sent_at)}</span>
          )}
        </div>
      </div>

      {/* ── Note modal ── */}
      {showNoteModal && fields && (
        <div className="modal-overlay" onClick={() => setShowNoteModal(false)}>
          <div className="modal" style={{ width: 640, maxWidth: '96vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
            onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--navy)' }}>
                  Session Note — {fmtDate(appt.date)}
                </h3>
                <div style={{ fontSize: '0.72rem', color: 'var(--gray-400)', marginTop: 2 }}>
                  {client.last_name}, {client.first_name} · {fmt12(appt.time)}
                </div>
              </div>
              <button onClick={() => setShowNoteModal(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: 'var(--gray-400)', lineHeight: 1 }}>✕</button>
            </div>

            <div className="modal-body" style={{ overflowY: 'auto', flex: 1 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={fldLabel}>Location of Meeting</label>
                  <input className="form-input" value={fields.location_of_meeting || 'Telehealth - Video'} readOnly
                    style={{ background: 'var(--gray-50)', fontSize: '0.85rem' }} />
                </div>
                <div>
                  <label style={fldLabel}>Additional Person(s) Present</label>
                  <input className="form-input" style={{ fontSize: '0.85rem' }} value={fields.additional_persons_present || ''}
                    onChange={e => updateField('additional_persons_present', e.target.value)} placeholder="Leave blank if none" />
                </div>
                <div>
                  <label style={fldLabel}>Content Discussed</label>
                  <textarea className="form-textarea" style={{ minHeight: 72, fontSize: '0.85rem' }}
                    value={fields.content_discussed || ''} onChange={e => updateField('content_discussed', e.target.value)} />
                </div>
                <div>
                  <label style={fldLabel}>Interventions Used</label>
                  <textarea className="form-textarea" style={{ minHeight: 56, fontSize: '0.85rem' }}
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
                          background: on ? 'var(--navy)' : 'transparent', color: on ? '#fff' : 'var(--gray-400)',
                        }}>{m}</button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <label style={fldLabel}>Patient Response</label>
                  <textarea className="form-textarea" style={{ minHeight: 56, fontSize: '0.85rem' }}
                    value={fields.patient_response || ''} onChange={e => updateField('patient_response', e.target.value)} />
                </div>
                <div>
                  <label style={fldLabel}>Progress Toward Goals</label>
                  <textarea className="form-textarea" style={{ minHeight: 56, fontSize: '0.85rem' }}
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
                  <pre style={{ background: '#f8fafc', border: '1px solid var(--gray-200)', borderRadius: 6, padding: '12px 14px', fontSize: '0.78rem', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: 0, color: 'var(--gray-600)' }}>
                    {buildPreviewText(client, appt, fields, tp)}
                  </pre>
                </div>
              </div>
              {err && <p style={{ color: '#dc2626', margin: '12px 0 0', fontSize: '0.82rem' }}>{err}</p>}
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowNoteModal(false)}>Close</button>
              <button type="button" className="btn btn-gold btn-sm" onClick={handleSend} disabled={sending}>
                {sending ? 'Sending…' : 'Send to Secretary'}
              </button>
            </div>
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

  const [showEditModal, setShowEditModal] = useState(false);
  const [editForm,      setEditForm]      = useState(EMPTY_EDIT_FORM);
  const [savingClient,  setSavingClient]  = useState(false);
  const [clientSaveErr, setClientSaveErr] = useState('');

  const [showAddAppt,  setShowAddAppt]  = useState(false);
  const [addForm,      setAddForm]      = useState(EMPTY_ADD_FORM);
  const [addingAppt,   setAddingAppt]   = useState(false);
  const [addConflicts, setAddConflicts] = useState([]);

  const [clientNotes,     setClientNotes]     = useState('');
  const [notesSaveState,  setNotesSaveState]  = useState('idle');
  const notesSaveTimer = useRef(null);

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
    }).catch(() => navigate('/oo/clients'));
  }

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
      const payload = { ...editForm, referral_source_id: editForm.referral_source_id || null };
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
      setAppts(prev => [...prev, ...newAppts].sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.time.localeCompare(b.time);
      }));
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

  const rs  = client.oo_referral_sources;
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

  const lastNote = [...appts].reverse().find(a => a.raw_notes?.trim());

  return (
    <div style={{ padding: '24px 32px 48px', maxWidth: 1400 }}>
      <button className="back-link" onClick={() => navigate('/oo/clients')}>← Back to Clients</button>

      {/* ── Header ── */}
      <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', marginBottom: 20 }}>

        {/* Left — personal notes */}
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
            style={{
              width: '100%', boxSizing: 'border-box',
              minHeight: 110, fontSize: '0.82rem', lineHeight: 1.55,
              border: '1px solid var(--gray-200)', borderRadius: 6,
              padding: '8px 10px', resize: 'vertical', fontFamily: 'inherit',
              background: 'white', color: 'var(--gray-800)',
            }}
          />
        </div>

        {/* Right — client info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Name + sex + status + referral + Edit button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0 }}>{client.last_name}, {client.first_name}</h2>
            {sexBadge && (
              <span style={{ fontSize: '0.72rem', fontWeight: 700, background: 'var(--gray-100)', color: 'var(--gray-500)', borderRadius: 3, padding: '2px 6px', letterSpacing: '0.04em' }}>
                {sexBadge}
              </span>
            )}
            <span className={`badge badge-${client.status}`}>{client.status}</span>
            {rs && <span style={{ background: 'var(--navy)', color: 'rgba(255,255,255,0.9)', borderRadius: 4, padding: '2px 8px', fontSize: '0.68rem', fontWeight: 600, letterSpacing: '0.02em' }}>{rs.name}</span>}
            <button className="btn btn-outline btn-sm" onClick={openEditClient}>Edit Client</button>
          </div>

          {/* DOB (age) · last session duration */}
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

          {/* Mother / Father — always show */}
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

          {/* DX badges + Sync */}
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

      {/* ── 3-column body ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0 }}>

        {/* Left — stats + sessions */}
        <div style={{ flex: 6, paddingRight: 28, minWidth: 0 }}>

          {/* Stats */}
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

          {/* Sessions card */}
          <div className="card" style={{ marginBottom: 24 }}>
            <div className="card-header">
              <h3 style={{ fontSize: '1rem', color: 'var(--navy)' }}>Sessions</h3>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--gray-400)' }}>Click date/time to edit</span>
                <button className="btn btn-gold btn-xs" onClick={() => { setShowAddAppt(s => !s); setAddConflicts([]); if (!showAddAppt && raw.typical_session_minutes) setAddForm(f => ({ ...f, duration: String(raw.typical_session_minutes) })); }}>
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

        {/* Divider */}
        <div style={{ width: 1, background: 'var(--gray-200)', alignSelf: 'stretch', flexShrink: 0 }} />

        {/* Middle — last note + treatment plan */}
        <div style={{ flex: 4, padding: '0 24px', minWidth: 0 }}>

          {/* Last written note */}
          {lastNote ? (
            <RSection title="Last Note">
              <div style={{ fontSize: '0.7rem', color: 'var(--gray-400)', marginBottom: 6 }}>
                {fmtDate(lastNote.date)} · {fmt12(lastNote.time)}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--gray-700)', whiteSpace: 'pre-wrap', lineHeight: 1.6, background: 'var(--gray-50)', borderRadius: 6, padding: '8px 10px', border: '1px solid var(--gray-100)' }}>
                {lastNote.raw_notes}
              </div>
            </RSection>
          ) : (
            <RSection title="Last Note">
              <div style={{ fontSize: '0.78rem', color: 'var(--gray-300)' }}>No notes written yet</div>
            </RSection>
          )}

          {/* Treatment Plan */}
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

        {/* Divider */}
        <div style={{ width: 1, background: 'var(--gray-200)', alignSelf: 'stretch', flexShrink: 0 }} />

        {/* Right — client info, referral, insurance, debug */}
        <div style={{ flex: 3, paddingLeft: 24, minWidth: 0 }}>

          {/* Client Info */}
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
            <RField label="Address"           value={client.address} />
          </RSection>

          {/* Referral Source */}
          {rs && (
            <RSection title="Referral Source">
              <RField label="Name"        value={rs.name} />
              <RField label="Notes Email" value={rs.notes_email} />
            </RSection>
          )}

          {/* Insurance */}
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

          {/* Debug */}
          {client.insync_patient_id && (
            <div style={{ marginBottom: 16 }}>
              <button onClick={debugNoteFields} disabled={debuggingFields}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.7rem', color: '#f59e0b', padding: 0, display: 'block', marginBottom: 5 }}>
                {debuggingFields ? 'Fetching…' : '⚙ Debug: note fields'}
              </button>
              {debugFields && (
                <pre style={{ background: '#1e1e1e', color: '#d4d4d4', borderRadius: 6, padding: 10, fontSize: '0.62rem', overflowX: 'auto', maxHeight: 180, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(debugFields, null, 2)}
                </pre>
              )}
              <button onClick={debugEncounter} disabled={debugging}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.7rem', color: '#f59e0b', padding: 0, display: 'block', marginBottom: 5 }}>
                {debugging ? 'Fetching…' : '⚙ Debug: encounter HTML'}
              </button>
              {debugHtml && (
                <pre style={{ background: '#1e1e1e', color: '#d4d4d4', borderRadius: 6, padding: 10, fontSize: '0.62rem', overflowX: 'auto', maxHeight: 180, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                  {debugHtml}
                </pre>
              )}
              <button onClick={debugTpRawFn} disabled={debuggingTp}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.7rem', color: '#f59e0b', padding: 0, display: 'block', marginBottom: 5 }}>
                {debuggingTp ? 'Fetching…' : '⚙ Debug: TP raw text + brackets'}
              </button>
              {debugTpRaw && (
                <pre style={{ background: '#1e1e1e', color: '#d4d4d4', borderRadius: 6, padding: 10, fontSize: '0.62rem', overflowX: 'auto', maxHeight: 300, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(debugTpRaw, null, 2)}
                </pre>
              )}
            </div>
          )}

          {/* Raw InSync */}
          {client.insync_data && (
            <div style={{ marginTop: 4 }}>
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
      </div>

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
                    </select>
                  </div>

                  <div style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={modalLabelSt}>Referral Source</label>
                    <select className="form-input" value={editForm.referral_source_id} onChange={e => setEditForm(f => ({ ...f, referral_source_id: e.target.value }))} style={{ fontSize: '0.85rem' }}>
                      <option value="">— None —</option>
                      {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
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

const tpLabelSt = { display: 'inline-block', fontSize: '0.68rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', minWidth: 80, marginRight: 8 };

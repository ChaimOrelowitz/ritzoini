import { useState, useEffect, useRef } from 'react';
import { api } from '../../utils/api';

// ── Helpers ──────────────────────────────────────────────────────────────────

export function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

export function fmtDateTime(ts) {
  if (!ts) return null;
  return new Date(ts).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

export function goalText(g) { return typeof g === 'string' ? g : g.text; }
export function goalTarget(g) { return typeof g === 'string' ? null : g.target_date; }

export function buildTpText(tp) {
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
    `Location of Meeting: ${fields.location_of_meeting || 'Audio only Telehealth'}`,
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

// ── Constants ─────────────────────────────────────────────────────────────────

export const MODALITIES_LIST = ['CBT', 'EMDR', 'Sand Tray', 'Solution Focused', 'Client Centered', 'DBT', 'Art Therapy', 'Strength Based', 'Family Systems', 'Trauma Focused', 'Play Therapy', 'Mindfulness', 'Behavioral Role Play', 'Guided Imagery', 'Motivational Interviewing'];

// InSync ControlId_112 location options. Values confirmed from HAR; extend when remaining IDs are provided.
export const LOCATION_OPTIONS = [
  { value: '3', label: 'Audio only Telehealth' },
];
const AUTO_AUDIO_REASON = 'Client does not have internet access.';

export const APPT_STATUS_STYLE = {
  scheduled: { bg: '#dbeafe', color: '#1e40af', border: '#93c5fd' },
  completed: { bg: '#dcfce7', color: '#166534', border: '#86efac' },
  cancelled: { bg: '#f3f4f6', color: '#6b7280', border: '#d1d5db' },
};

export const fldLabel = { display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 };
export const modalLabelSt = { fontSize: '0.72rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em' };

// flex + aspect-ratio (instead of a fixed px size) so the 4 buttons always
// share the row evenly and stay square, regardless of how narrow the
// surrounding column is.
const SQUARE_BTN = {
  flex: '1 1 0', minWidth: 0, aspectRatio: '1', display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 3,
  fontSize: '0.68rem', lineHeight: 1.2, padding: '4px', overflow: 'hidden',
  borderRadius: 12, borderWidth: 1.5, borderStyle: 'solid', boxSizing: 'border-box',
};

// ── Appointment Card ──────────────────────────────────────────────────────────

export default function ApptCard({ appt: initialAppt, client, onUpdate, onDelete }) {
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
  const [processing,      setProcessing]      = useState(false);
  const [fields,          setFields]          = useState(initialAppt.ai_fields || null);
  const [deleting,        setDeleting]        = useState(false);
  const [err,             setErr]             = useState('');
  const [showNoteModal,   setShowNoteModal]   = useState(false);
  const [pushing,         setPushing]         = useState(false);
  const [pushMsg,         setPushMsg]         = useState('');
  const [pushConfirm,     setPushConfirm]     = useState(false);
  const pushConfirmTimer = useRef(null);
  const [pushingNote,     setPushingNote]     = useState(false);
  const [pushNoteMsg,     setPushNoteMsg]     = useState('');
  const [endingEncounter, setEndingEncounter] = useState(false);

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

  function handleLocationChange(val) {
    const opt = LOCATION_OPTIONS.find(o => o.value === val) || LOCATION_OPTIONS[0];
    setFields(prev => ({
      ...prev,
      location_value: opt.value,
      location_of_meeting: opt.label,
      audio_only_reason: opt.value === '3'
        ? (!prev.audio_only_reason || prev.audio_only_reason === AUTO_AUDIO_REASON ? AUTO_AUDIO_REASON : prev.audio_only_reason)
        : (prev.audio_only_reason === AUTO_AUDIO_REASON ? '' : prev.audio_only_reason),
    }));
  }

  async function handleStatusChange(newStatus) {
    const prev = appt.status;
    setAppt(a => ({ ...a, status: newStatus }));
    try {
      const updated = await api.patch(`/oo/appointments/${appt.id}`, { status: newStatus });
      setAppt(a => ({ ...a, ...updated }));
      onUpdate({ ...appt, ...updated, status: newStatus });
    } catch (ex) {
      setAppt(a => ({ ...a, status: prev }));
      alert(ex.message);
    }
  }

  async function handleEndEncounter() {
    if (!window.confirm('End this InSync encounter?')) return;
    setEndingEncounter(true);
    try {
      const res = await api.post(`/oo/appointments/${appt.id}/end-insync-encounter`, {});
      const updates = { note_done_at: res.note_done_at, status: res.status || 'completed' };
      setAppt(a => ({ ...a, ...updates }));
      onUpdate({ ...appt, ...updates });
    } catch (ex) {
      alert(ex.message);
    } finally {
      setEndingEncounter(false);
    }
  }

  function openNoteModal() {
    if (!fields) return;
    // Pre-fill location defaults when modal opens for the first time
    if (!fields.location_value) {
      setFields(prev => ({
        ...prev,
        location_value: '3',
        location_of_meeting: 'Audio only Telehealth',
        audio_only_reason: prev.audio_only_reason || AUTO_AUDIO_REASON,
      }));
    }
    setShowNoteModal(true);
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

  // Pushes the note to InSync only — does NOT close the encounter, so the
  // note can be reviewed in InSync first before ending it separately.
  async function handlePushNoteToInsync() {
    if (!window.confirm(`Push note for ${fmtDate(appt.date)} to InSync?`)) return;
    setPushingNote(true); setPushNoteMsg('');
    try {
      const res = await api.post(`/oo/appointments/${appt.id}/push-note-to-insync`, {
        location_value:   fields?.location_value   || '3',
        location_label:   fields?.location_of_meeting || 'Audio only Telehealth',
        audio_only_reason: fields?.audio_only_reason || AUTO_AUDIO_REASON,
      });
      const updates = { insync_encounter_id: res.insync_encounter_id };
      setAppt(a => ({ ...a, ...updates }));
      onUpdate({ ...appt, ...updates });
      setPushNoteMsg(`✓ Note saved in InSync (encounter ${res.insync_encounter_id})`);
    } catch (ex) {
      setPushNoteMsg(`Error: ${ex.message}`);
    } finally {
      setPushingNote(false);
    }
  }

  // First click arms the button (shows "Confirm?" in place of a popup);
  // second click within 3s actually pushes. Clicking elsewhere lets it expire.
  function handlePushToInsyncClick() {
    if (!pushConfirm) {
      setPushConfirm(true);
      clearTimeout(pushConfirmTimer.current);
      pushConfirmTimer.current = setTimeout(() => setPushConfirm(false), 3000);
      return;
    }
    clearTimeout(pushConfirmTimer.current);
    setPushConfirm(false);
    handlePushToInsync();
  }

  async function handlePushToInsync() {
    setPushing(true); setPushMsg('');
    try {
      const res = await api.post(`/oo/appointments/${appt.id}/push-to-insync`, {});
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
          <select
            value={appt.status}
            onChange={e => handleStatusChange(e.target.value)}
            style={{
              padding: '5px 10px', fontSize: '0.82rem', width: 120, borderRadius: 'var(--radius)',
              border: `1.5px solid ${style.border}`, background: style.bg, color: style.color,
              fontWeight: 600, textTransform: 'capitalize', boxSizing: 'border-box', cursor: 'pointer',
            }}
          >
            {['scheduled', 'completed', 'cancelled'].map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', marginLeft: 'auto', flexWrap: 'wrap' }}>
          {[{ field: 'note_done_at', label: 'Done' }].map(({ field, label }) => (
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
          {appt.transcript_attached_at && (
            <span style={{
              fontSize: '0.65rem', fontWeight: 700, textTransform: 'none', letterSpacing: 0,
              background: '#dcfce7', color: '#15803d', borderRadius: 4, padding: '2px 6px',
            }} title={`Zoom transcript attached ${fmtDateTime(appt.transcript_attached_at)}`}>
              📞 From Zoom transcript
            </span>
          )}
          {saveState === 'saving' && <span style={{ color: 'var(--gold)', fontWeight: 500, fontSize: '0.72rem' }}>Saving…</span>}
          {saveState === 'saved'  && <span style={{ color: '#10b981', fontWeight: 500, fontSize: '0.72rem' }}>✓ Saved</span>}
        </div>
        <textarea className="form-textarea" value={rawNotes} onChange={e => handleNoteChange(e.target.value)}
          placeholder="Session notes…" style={{ minHeight: 72, fontSize: '0.875rem' }} />
        {err && <p style={{ color: '#dc2626', margin: '4px 0 0', fontSize: '0.78rem' }}>{err}</p>}
        <div style={{ marginTop: 8 }}>

          {/* Row 1 — 4 equal squares */}
          <div style={{ display: 'flex', gap: 8 }}>
            {/* 1. Push Appt — once pushed becomes a single green link */}
            {appt.insync_visit_id ? (
              <a href="https://thedscenter.insynchcs.com/Scheduler/Index" target="_blank" rel="noopener noreferrer"
                style={{
                  ...SQUARE_BTN, fontWeight: 700, textDecoration: 'none', cursor: 'pointer',
                  background: '#dcfce7', color: '#15803d', borderColor: '#86efac',
                }}
                title={`Visit ${appt.insync_visit_id} in InSync`}
              >
                <span>✓ Appt Pushed</span>
                <span style={{ textDecoration: 'underline', fontWeight: 600 }}>Visit {appt.insync_visit_id} ↗</span>
              </a>
            ) : (
              <button className="btn" type="button" onClick={handlePushToInsyncClick} disabled={pushing}
                style={{
                  ...SQUARE_BTN, fontWeight: 700,
                  background: pushConfirm ? '#fef3c7' : 'var(--navy)',
                  color: pushConfirm ? '#92400e' : 'white',
                  borderColor: pushConfirm ? '#fde68a' : 'var(--navy)',
                }}
                title={pushConfirm ? 'Click again to confirm' : 'Create appointment in InSync'}
              >
                {pushing ? 'Pushing…' : pushConfirm ? 'Confirm Push?' : 'Push Appt'}
              </button>
            )}

            {/* 2. Process Note */}
            <button className="btn" type="button" onClick={handleProcess} disabled={processing || !rawNotes.trim()}
              style={{ ...SQUARE_BTN, fontWeight: 700, background: 'white', color: 'var(--navy)', borderColor: 'var(--gray-200)' }}
              title={!rawNotes.trim() ? 'Write notes first' : fields ? 'Re-run AI processing' : 'Generate structured note with AI'}
            >
              {processing ? 'Processing…' : fields ? 'Re-process' : 'Process Note'}
            </button>

            {/* 3. View Note — grey until a processed note exists */}
            <button className="btn" type="button" onClick={openNoteModal}
              style={{
                ...SQUARE_BTN, fontWeight: 700,
                background: fields ? 'var(--gold)' : 'var(--gray-100)',
                color: fields ? 'var(--navy)' : 'var(--gray-400)',
                borderColor: fields ? 'var(--gold)' : 'var(--gray-200)',
                cursor: fields ? 'pointer' : 'default',
              }}
              title={fields ? 'Open AI note' : 'No AI note yet'}
            >
              {fields ? 'View Note' : 'No Note'}
            </button>

            {/* 4. Push Note — once pushed becomes a green link with encounter ID */}
            {appt.insync_encounter_id ? (
              <a href="https://thedscenter.insynchcs.com/Scheduler/Index" target="_blank" rel="noopener noreferrer"
                style={{
                  ...SQUARE_BTN, fontWeight: 700, textDecoration: 'none', cursor: 'pointer',
                  background: '#dcfce7', color: '#15803d', borderColor: '#86efac',
                }}
                title={`Encounter ${appt.insync_encounter_id} in InSync`}
              >
                <span>✓ Note Pushed</span>
                <span style={{ textDecoration: 'underline', fontWeight: 600 }}>Enc {appt.insync_encounter_id} ↗</span>
              </a>
            ) : (
              <button className="btn" type="button" onClick={handlePushNoteToInsync}
                disabled={pushingNote || !appt.insync_visit_id || !fields}
                style={{
                  ...SQUARE_BTN, fontWeight: 700,
                  background: (!appt.insync_visit_id || !fields) ? 'var(--gray-100)' : '#1e40af',
                  color: (!appt.insync_visit_id || !fields) ? 'var(--gray-400)' : 'white',
                  borderColor: (!appt.insync_visit_id || !fields) ? 'var(--gray-200)' : '#1e40af',
                  cursor: (!appt.insync_visit_id || !fields) ? 'default' : 'pointer',
                }}
                title={
                  !appt.insync_visit_id ? 'Push appointment to InSync first'
                  : !fields ? 'Process note with AI first'
                  : 'Push note to InSync'
                }
              >
                {pushingNote ? 'Pushing…' : 'Push Note'}
              </button>
            )}
          </div>

          {/* Row 2 — End Encounter pill */}
          <button type="button" onClick={handleEndEncounter}
            disabled={endingEncounter || !appt.insync_encounter_id || !!appt.note_done_at}
            style={{
              marginTop: 8, width: '100%', padding: '7px 16px', borderRadius: 999,
              borderWidth: 1.5, borderStyle: 'solid', fontWeight: 700, fontSize: '0.78rem',
              boxSizing: 'border-box',
              cursor: (!appt.insync_encounter_id || appt.note_done_at) ? 'default' : 'pointer',
              background:  appt.note_done_at ? '#dcfce7' : !appt.insync_encounter_id ? 'var(--gray-100)' : 'var(--navy)',
              color:       appt.note_done_at ? '#15803d' : !appt.insync_encounter_id ? 'var(--gray-400)' : 'white',
              borderColor: appt.note_done_at ? '#86efac' : !appt.insync_encounter_id ? 'var(--gray-200)' : 'var(--navy)',
            }}
          >
            {endingEncounter ? 'Ending…' : appt.note_done_at ? '✓ Encounter Closed' : 'End Encounter'}
          </button>
          {appt.note_done_at && appt.insync_encounter_id && (
            <a href="https://thedscenter.insynchcs.com/Scheduler/Index" target="_blank" rel="noopener noreferrer"
              style={{ display: 'block', textAlign: 'center', marginTop: 4, fontSize: '0.72rem', color: '#1e40af', textDecoration: 'underline', fontWeight: 600 }}>
              Encounter {appt.insync_encounter_id} ↗
            </a>
          )}

          {/* Error messages */}
          {(pushMsg || (pushNoteMsg && pushNoteMsg.startsWith('Error'))) && (
            <div style={{ marginTop: 6, fontSize: '0.72rem' }}>
              {pushMsg && <span style={{ color: '#dc2626' }}>{pushMsg}</span>}
              {pushNoteMsg && pushNoteMsg.startsWith('Error') && <span style={{ color: '#dc2626', marginLeft: 6 }}>{pushNoteMsg}</span>}
            </div>
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
                  <select className="form-input"
                    value={fields.location_value || '3'}
                    onChange={e => handleLocationChange(e.target.value)}
                    style={{ fontSize: '0.85rem' }}
                  >
                    {LOCATION_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                {(fields.location_value || '3') === '3' && (
                  <div>
                    <label style={fldLabel}>If audio only, please provide reasoning</label>
                    <input className="form-input" style={{ fontSize: '0.85rem' }}
                      value={fields.audio_only_reason || ''}
                      onChange={e => updateField('audio_only_reason', e.target.value)} />
                  </div>
                )}
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

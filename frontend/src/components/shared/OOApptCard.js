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

// ── Constants ─────────────────────────────────────────────────────────────────

export const MODALITIES_LIST = ['CBT', 'EMDR', 'Sand Tray', 'Solution Focused', 'Client Centered', 'DBT', 'Art Therapy', 'Strength Based', 'Family Systems', 'Trauma Focused', 'Play Therapy', 'Mindfulness', 'Behavioral Role Play', 'Guided Imagery', 'Motivational Interviewing'];

export const APPT_STATUS_STYLE = {
  scheduled: { bg: '#dbeafe', color: '#1e40af', border: '#93c5fd' },
  completed: { bg: '#dcfce7', color: '#166534', border: '#86efac' },
  cancelled: { bg: '#f3f4f6', color: '#6b7280', border: '#d1d5db' },
};

export const fldLabel = { display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 };
export const modalLabelSt = { fontSize: '0.72rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em' };

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
  const [processing,     setProcessing]     = useState(false);
  const [fields,         setFields]         = useState(initialAppt.ai_fields || null);
  const [sending,        setSending]        = useState(false);
  const [deleting,       setDeleting]       = useState(false);
  const [err,            setErr]            = useState('');
  const [showNoteModal,  setShowNoteModal]  = useState(false);
  const [pushing,        setPushing]        = useState(false);
  const [pushMsg,        setPushMsg]        = useState('');
  const [pushingNote,      setPushingNote]      = useState(false);
  const [pushNoteMsg,      setPushNoteMsg]      = useState('');
  const [endingEncounter,  setEndingEncounter]  = useState(false);
  const [endEncounterMsg,  setEndEncounterMsg]  = useState('');

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

  async function handlePushNoteToInsync() {
    if (!window.confirm(`Push note for ${fmtDate(appt.date)} to InSync?`)) return;
    setPushingNote(true); setPushNoteMsg('');
    try {
      const res = await api.post(`/oo/appointments/${appt.id}/push-note-to-insync`, {});
      setPushNoteMsg(`✓ Note saved in InSync (encounter ${res.insync_encounter_id})`);
      setAppt(a => ({ ...a, insync_encounter_id: res.insync_encounter_id }));
    } catch (ex) {
      setPushNoteMsg(`Error: ${ex.message}`);
    } finally {
      setPushingNote(false);
    }
  }

  async function handleEndEncounter() {
    if (!window.confirm('End and close this encounter in InSync?')) return;
    setEndingEncounter(true); setEndEncounterMsg('');
    try {
      const res = await api.post(`/oo/appointments/${appt.id}/end-insync-encounter`, {});
      setEndEncounterMsg('✓ Encounter closed');
      setAppt(a => ({ ...a, note_done_at: res.note_done_at || a.note_done_at }));
      onUpdate({ ...appt, note_done_at: res.note_done_at });
    } catch (ex) {
      setEndEncounterMsg(`Error: ${ex.message}`);
    } finally {
      setEndingEncounter(false);
    }
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>

          {/* Line 1: Push appointment to InSync */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-xs" type="button" onClick={handlePushToInsync} disabled={pushing}
              style={{
                background: appt.insync_visit_id ? '#dcfce7' : 'var(--navy)',
                color: appt.insync_visit_id ? '#15803d' : 'white',
                border: `1px solid ${appt.insync_visit_id ? '#86efac' : 'var(--navy)'}`,
                fontWeight: 600,
              }}
              title={appt.insync_visit_id ? `Visit ${appt.insync_visit_id} in InSync` : 'Create appointment in InSync'}
            >
              {pushing ? 'Pushing…' : appt.insync_visit_id ? '✓ Pushed to InSync' : 'Push to InSync'}
            </button>
            {appt.insync_visit_id && (
              <a href="https://thedscenter.insynchcs.com/Scheduler/Index" target="_blank" rel="noopener noreferrer"
                style={{ fontSize: '0.72rem', color: '#15803d', textDecoration: 'underline', fontWeight: 600 }}>
                Visit {appt.insync_visit_id} ↗
              </a>
            )}
            {pushMsg && <span style={{ fontSize: '0.7rem', color: pushMsg.startsWith('Error') ? '#dc2626' : '#16a34a' }}>{pushMsg}</span>}
          </div>

          {/* Line 2: AI note */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-outline btn-xs" type="button" onClick={handleProcess} disabled={processing || !rawNotes.trim()}>
              {processing ? 'Processing…' : fields ? 'Re-process' : 'Process with AI'}
            </button>
            <button className="btn btn-xs" type="button" onClick={() => fields && setShowNoteModal(true)}
              style={{
                background: fields ? 'var(--gold)' : 'var(--gray-100)',
                color: fields ? 'var(--navy)' : 'var(--gray-400)',
                border: `1px solid ${fields ? 'var(--gold)' : 'var(--gray-200)'}`,
                cursor: fields ? 'pointer' : 'default', fontWeight: 600,
              }}
              title={fields ? 'Open AI note' : 'No AI note yet'}
            >
              {fields ? 'Open Note →' : 'No AI note'}
            </button>
            {appt.note_sent_at && <span style={{ fontSize: '0.7rem', color: '#16a34a' }}>✓ sent {fmtDateTime(appt.note_sent_at)}</span>}
          </div>

          {/* Line 3: Push note + End Encounter */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-xs" type="button" onClick={handlePushNoteToInsync}
              disabled={pushingNote || (!appt.insync_visit_id || !fields)}
              style={{
                background: appt.insync_encounter_id ? '#dcfce7' : '#1e40af',
                color: appt.insync_encounter_id ? '#15803d' : (!appt.insync_visit_id || !fields) ? 'var(--gray-400)' : 'white',
                border: `1px solid ${appt.insync_encounter_id ? '#86efac' : (!appt.insync_visit_id || !fields) ? 'var(--gray-200)' : '#1e40af'}`,
                fontWeight: 600,
                cursor: (!appt.insync_visit_id || !fields) ? 'default' : 'pointer',
              }}
              title={!appt.insync_visit_id ? 'Push appointment to InSync first' : !fields ? 'Process note with AI first' : appt.insync_encounter_id ? `Encounter ${appt.insync_encounter_id} in InSync` : 'Push note to InSync'}
            >
              {pushingNote ? 'Pushing Note…' : appt.insync_encounter_id ? '✓ Note in InSync' : 'Push Note to InSync'}
            </button>
            {appt.insync_encounter_id && (
              <a href="https://thedscenter.insynchcs.com/Scheduler/Index" target="_blank" rel="noopener noreferrer"
                style={{ fontSize: '0.72rem', color: '#1e40af', textDecoration: 'underline', fontWeight: 600 }}>
                Encounter {appt.insync_encounter_id} ↗
              </a>
            )}
            {appt.insync_encounter_id && (
              <button className="btn btn-xs" type="button" onClick={handleEndEncounter} disabled={endingEncounter}
                style={{ background: 'var(--navy)', color: 'white', border: '1px solid var(--navy)', fontWeight: 600 }}>
                {endingEncounter ? 'Ending…' : 'End Encounter'}
              </button>
            )}
            {pushNoteMsg && <span style={{ fontSize: '0.7rem', color: pushNoteMsg.startsWith('Error') ? '#dc2626' : '#16a34a' }}>{pushNoteMsg}</span>}
            {endEncounterMsg && <span style={{ fontSize: '0.7rem', color: endEncounterMsg.startsWith('Error') ? '#dc2626' : '#16a34a' }}>{endEncounterMsg}</span>}
          </div>

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

import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { api } from '../utils/api';

// Portal POC — transcribe finished peer-support notes from the portal CRM into
// InSync. The screen is deliberately three-beat: upload, REVIEW, run. Nothing
// reaches InSync until a human has looked at every row.

const fmtDate = iso => {
  if (!iso) return '—';
  const [y, m, d] = String(iso).split('-');
  return `${m}/${d}/${y}`;
};

const clockOf = mins => {
  if (mins === null || mins === undefined || Number.isNaN(Number(mins))) return '—';
  const h = Math.floor(mins / 60), mi = mins % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mi).padStart(2, '0')} ${ampm}`;
};

const STATUS_STYLE = {
  ready:           { bg: '#dcfce7', fg: '#166534', label: 'Ready' },
  needs_attention: { bg: '#fef9c3', fg: '#854d0e', label: 'Needs attention' },
  duplicate:       { bg: '#e5e7eb', fg: '#374151', label: 'Already done' },
  done:            { bg: '#dbeafe', fg: '#1e40af', label: 'Written to InSync' },
  failed:          { bg: '#fee2e2', fg: '#991b1b', label: 'Failed' },
  skipped:         { bg: '#e5e7eb', fg: '#374151', label: 'Skipped' },
};

function Pill({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.needs_attention;
  return (
    <span style={{
      background: s.bg, color: s.fg, fontSize: '0.7rem', fontWeight: 700,
      padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
    }}>{s.label}</span>
  );
}

function Banner({ tone = 'warn', children }) {
  const tones = {
    warn:  { bg: '#fef3c7', fg: '#92400e', bd: '#fde68a' },
    error: { bg: '#fee2e2', fg: '#991b1b', bd: '#fecaca' },
    info:  { bg: '#eff6ff', fg: '#1e40af', bd: '#bfdbfe' },
    ok:    { bg: '#dcfce7', fg: '#166534', bd: '#bbf7d0' },
  }[tone];
  return (
    <div style={{
      background: tones.bg, color: tones.fg, border: `1px solid ${tones.bd}`,
      borderRadius: 'var(--radius)', padding: '10px 14px', fontSize: '0.82rem',
      marginBottom: 12, lineHeight: 1.5,
    }}>{children}</div>
  );
}

const card = {
  background: '#fff', border: '1px solid var(--gray-100)',
  borderRadius: 'var(--radius)', padding: 16, marginBottom: 14,
};
const th = { textAlign: 'left', fontSize: '0.7rem', textTransform: 'uppercase',
  letterSpacing: '0.04em', color: 'var(--gray-400)', padding: '6px 8px', whiteSpace: 'nowrap' };
const td = { padding: '8px', fontSize: '0.82rem', verticalAlign: 'top', borderTop: '1px solid var(--gray-100)' };

// ---------------------------------------------------------------------------
// Client confirmation — the one-time human binding of a portal client to an
// InSync patient. Ambiguity must never resolve itself.
// ---------------------------------------------------------------------------

// InSync matches patients on "Last, First" and returns nothing for "First Last",
// so the manual search has to start where resolution starts — otherwise typing
// the name straight off the row finds nobody.
function lastFirst(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts.join(' ');
  return `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`;
}

function ClientConfirmModal({ note, resolution, onClose, onConfirmed }) {
  const [q, setQ] = useState(lastFirst(note.clientName));
  const [rows, setRows] = useState(resolution.client_candidates || []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function search() {
    setBusy(true); setErr('');
    try {
      const r = await api.get(`/portal/patients?q=${encodeURIComponent(q)}`);
      setRows(r.map(x => ({ ...x, dob_matches: x.dob === note.clientDateOfBirth })));
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  async function confirm(row) {
    if (!window.confirm(
      `Bind portal client "${note.clientName}" (DOB ${fmtDate(note.clientDateOfBirth)}) to ` +
      `InSync patient ${row.name} (ID ${row.patientId}, DOB ${fmtDate(row.dob)})?\n\n` +
      `Every future note for this client will go into that chart.`)) return;
    setBusy(true); setErr('');
    try {
      await api.post('/portal/clients', {
        portal_client_name: note.clientName,
        portal_client_dob: note.clientDateOfBirth,
        insync_patient_id: row.patientId,
        insync_patient_name: row.name,
        insync_mrn: row.mrn,
      });
      onConfirmed();
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 720 }}>
        <div className="modal-header">
          <h3>Confirm InSync patient</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {err && <div className="alert alert-error">{err}</div>}
          <Banner tone="warn">
            Portal client <strong>{note.clientName}</strong>, DOB <strong>{fmtDate(note.clientDateOfBirth)}</strong>.
            Confirm the matching InSync patient once — every later note for this client reuses it.
            A note filed in the wrong chart is not recoverable, so check the date of birth.
          </Banner>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input className="form-input" value={q} onChange={e => setQ(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && search()} placeholder="Search InSync patients…" />
            <button className="btn btn-outline" onClick={search} disabled={busy}>Search</button>
          </div>
          {!rows.length && <p style={{ color: 'var(--gray-400)', fontSize: '0.82rem' }}>No candidates.</p>}
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {rows.map(r => (
                <tr key={r.patientId}>
                  <td style={td}>
                    <strong>{r.name}</strong>
                    <div style={{ color: 'var(--gray-400)', fontSize: '0.75rem' }}>
                      ID {r.patientId}{r.mrn ? ` · MRN ${r.mrn}` : ''}{r.primaryProvider ? ` · ${r.primaryProvider}` : ''}
                    </div>
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <span style={{ color: r.dob_matches ? '#166534' : '#991b1b', fontWeight: 700 }}>
                      {fmtDate(r.dob)} {r.dob_matches ? '✓' : '✗ DOB differs'}
                    </span>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button className="btn btn-gold" disabled={busy} onClick={() => confirm(r)}>Bind</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One staged note on the review screen.
// ---------------------------------------------------------------------------

function ReviewRow({ runId, row, onChanged, onConfirmClient, onRunOne, running, signOnRun }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const r = row.resolution || {};
  const note = row.note || {};
  const flags = row.flags || [];
  const manualFields = (r.note_fields && Object.keys(r.note_fields)) || [];

  async function patch(body) {
    setBusy(true);
    try { await api.patch(`/portal/runs/${runId}/notes/${row.id}`, body); await onChanged(); }
    catch (ex) { alert(ex.message); }
    finally { setBusy(false); }
  }

  const flagFor = field => flags.filter(f => f.field === field);
  const warn = field => flagFor(field).length ? ' ⚠' : '';

  return (
    <>
      <tr>
        <td style={td}>
          <button onClick={() => setOpen(o => !o)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            color: 'var(--navy)', fontWeight: 600, fontSize: '0.82rem', textAlign: 'left',
          }}>{open ? '▾' : '▸'} {note.peerName}{warn('peer')}</button>
          {r.provider_id && <div style={{ color: 'var(--gray-400)', fontSize: '0.72rem' }}>provider {r.provider_id}</div>}
        </td>
        <td style={td}>
          {note.clientName}{warn('client')}
          <div style={{ color: 'var(--gray-400)', fontSize: '0.72rem' }}>
            DOB {fmtDate(note.clientDateOfBirth)}
            {r.patient_id ? ` · patient ${r.patient_id}` : ''}
          </div>
          {!r.patient_id && row.status !== 'duplicate' && (
            <button className="btn btn-outline" style={{ marginTop: 4, fontSize: '0.72rem', padding: '2px 8px' }}
              onClick={() => onConfirmClient(row)}>Confirm patient…</button>
          )}
        </td>
        <td style={td}>
          {fmtDate(note.sessionDate)}
          <div style={{ color: 'var(--gray-400)', fontSize: '0.72rem' }}>
            {clockOf(note.sessionStartMinutes)} · {note.durationMinutes} min
          </div>
        </td>
        <td style={{ ...td, minWidth: 240 }}>
          <select className="form-select" style={{ fontSize: '0.78rem' }} disabled={busy || row.status === 'done'}
            value={r.visit_type_id || ''}
            onChange={e => patch({ visit_type_override: e.target.value })}>
            <option value="">— select an encounter type —</option>
            {(r.type_candidates || []).map(t => (
              <option key={t.VisitTypeID} value={t.VisitTypeID}>
                {t.VisitType} [{t.VisitTypeID}]
              </option>
            ))}
          </select>
          <div style={{ color: 'var(--gray-400)', fontSize: '0.72rem', marginTop: 3 }}>
            {r.visit_type_id
              ? `${r.visit_type_auto ? 'auto-matched' : 'overridden'}${r.visit_type_offsite ? ' · OFFSITE form' : ''}`
              : (flagFor('encounter_type')[0]?.message || 'not matched')}
          </div>

        </td>
        <td style={{ ...td, color: 'var(--gray-400)', fontSize: '0.75rem' }}>checked on run</td>
        <td style={td}>
          <Pill status={row.status} />
          {(r.needs || []).length > 0 && (
            <ul style={{ margin: '5px 0 0', paddingLeft: 15, listStyle: 'disc' }}>
              {r.needs.map((n, i) => (
                <li key={i} style={{ fontSize: '0.72rem', color: '#991b1b', lineHeight: 1.35 }}>{n}</li>
              ))}
            </ul>
          )}
        </td>
        <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
          {row.status === 'ready' && (
            <>
              {/* Per-note execution. The batch GO runs everything Ready; this
                  runs exactly this row, which is how you do the first live one. */}
              <button className="btn btn-outline" style={{ fontSize: '0.72rem', padding: '2px 8px', marginBottom: 4 }}
                disabled={busy || running} onClick={() => onRunOne(row, 'dry_run')}>
                Dry run
              </button>
              <br />
              <button className="btn btn-gold" style={{ fontSize: '0.72rem', padding: '2px 8px', marginBottom: 4 }}
                disabled={busy || running} onClick={() => onRunOne(row, 'live')}>
                {signOnRun ? 'Run live + sign' : 'Run live'}
              </button>
              <br />
            </>
          )}
          {r.calendar_hold && (
            // The hold survives re-resolution on purpose, so clearing it is an
            // explicit act. The next run re-checks the calendar regardless, so
            // this cannot push a note past a genuinely closed encounter.
            <>
              <button className="btn btn-outline" style={{ fontSize: '0.72rem', padding: '2px 8px', marginBottom: 4 }}
                disabled={busy || running}
                onClick={() => {
                  if (!window.confirm(
                    'Clear this hold?\n\n' + r.calendar_hold + '\n\n' +
                    'Do this only after looking at that encounter in InSync and deciding this note ' +
                    'still needs to go in. The next run re-checks the calendar either way.')) return;
                  patch({ clear_calendar_hold: true });
                }}>
                Reviewed — clear hold
              </button>
              <br />
            </>
          )}
          {row.status !== 'done' && (
            <button className="btn btn-outline" style={{ fontSize: '0.72rem', padding: '2px 8px' }}
              disabled={busy || running}
              onClick={() => patch({ status: row.status === 'skipped' ? 'needs_attention' : 'skipped' })}>
              {row.status === 'skipped' ? 'Unskip' : 'Skip'}
            </button>
          )}
        </td>
      </tr>

      {open && (
        <tr>
          <td colSpan={7} style={{ ...td, background: 'var(--gray-50, #fafafa)' }}>
            {flags.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                {flags.map((f, i) => (
                  <div key={i} style={{
                    fontSize: '0.78rem', color: f.blocking === false ? '#854d0e' : '#991b1b',
                    marginBottom: 2,
                  }}>
                    {f.blocking === false ? '•' : '⚠'} <strong>{f.field}</strong> — {f.message}
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: '0.75rem', color: 'var(--gray-400)', marginBottom: 6 }}>
              Note fields as they will be written. Portal-authored text is read-only — this app
              never edits clinical content. Fields with no portal source are typed here by you.
            </div>

            {manualFields.map(control => {
              const meta = (window.__PORTAL_NOTE_FIELDS || []).find(f => f.control === control) || {};
              const isManual = !!meta.manual;
              const value = r.note_fields[control];
              const display = control === 'ControlId_20'
                ? (note.interventions || []).join(', ')
                : value;
              return (
                <div key={control} style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-600)' }}>
                    {meta.label || control}
                    <span style={{ fontWeight: 400, color: 'var(--gray-400)' }}>
                      {' '}· {control}
                      {!isManual && ` · portal: ${meta.source}`}
                      {isManual && meta.mirrors && !r.manual?.[control] && ' · auto-filled from the interventions — edit to elaborate'}
                      {isManual && meta.mirrors && r.manual?.[control] && ' · edited'}
                      {isManual && !meta.mirrors && ' · entered here'}
                    </span>
                  </label>
                  {isManual ? (
                    <textarea
                      className="form-input" rows={2}
                      // Show what will actually be SENT, not just the operator
                      // override. ControlId_7 is auto-filled from the
                      // interventions, and rendering only `manual` made a
                      // populated field look empty on screen.
                      key={`${control}-${r.manual?.[control] ?? ''}-${value ?? ''}`}
                      defaultValue={r.manual?.[control] || value || ''}
                      disabled={busy || row.status === 'done'}
                      placeholder={meta.offsiteOnly
                        ? 'Required by the Offsite template — the portal export carries no field for it'
                        : 'The portal export carries no field for this'}
                      onBlur={e => {
                        const v = e.target.value;
                        if (v !== (r.manual?.[control] || value || '')) patch({ manual: { [control]: v } });
                      }}
                      style={{ width: '100%', fontSize: '0.78rem', fontFamily: 'inherit' }} />
                  ) : (
                    <div style={{
                      whiteSpace: 'pre-wrap', fontSize: '0.78rem', background: '#fff',
                      border: '1px solid var(--gray-100)', borderRadius: 4, padding: '6px 8px',
                      maxHeight: 160, overflowY: 'auto',
                      color: display ? 'inherit' : 'var(--gray-400)',
                    }}>{display || '(empty in the portal note)'}</div>
                  )}
                </div>
              );
            })}

            <button className="btn btn-outline" style={{ fontSize: '0.72rem', padding: '2px 8px', marginTop: 4 }}
              onClick={async () => {
                try {
                  const p = await api.get(`/portal/runs/${runId}/notes/${row.id}/payloads`);
                  const w = window.open('', '_blank');
                  if (p.billing) {
                    w.document.write('<h3>Billing resolved live from InSync</h3><pre>'
                      + JSON.stringify(p.billing, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                      + '</pre><hr>');
                  }
                  w.document.write('<pre>' + JSON.stringify(p, null, 2)
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>');
                  w.document.title = `Payloads — ${note.clientName} ${note.sessionDate}`;
                } catch (ex) { alert(ex.message); }
              }}>
              View prepared payloads (payload-diff gate)
            </button>

          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Peers tab
// ---------------------------------------------------------------------------

function PeerEditor({ peer, onClose, onSaved }) {
  const isNew = !peer.id;
  const [form, setForm] = useState({
    portal_peer_name: peer.portal_peer_name || '',
    insync_provider_id: peer.insync_provider_id || '',
    insync_provider_name: peer.insync_provider_name || '',
    insync_username: peer.insync_username || '',
    insync_password: '',
    signing_pin: '',
    is_active: peer.is_active !== false,
    notes: peer.notes || '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [suggestions, setSuggestions] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function lookup() {
    setBusy(true); setErr('');
    try {
      const r = await api.get(`/portal/providers?q=${encodeURIComponent(form.portal_peer_name)}`);
      setSuggestions([...r.exact, ...r.near].slice(0, 8));
      if (!r.exact.length && !r.near.length) setErr('No provider in the InSync directory matched that name.');
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setErr('');
    const body = { ...form };
    // An untouched secret field means "leave it as it is".
    if (!body.insync_password) delete body.insync_password;
    if (!body.signing_pin) delete body.signing_pin;
    try {
      if (isNew) await api.post('/portal/peers', body);
      else await api.patch(`/portal/peers/${peer.id}`, body);
      onSaved();
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 620 }}>
        <div className="modal-header">
          <h3>{isNew ? 'Add peer' : form.portal_peer_name}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {err && <div className="alert alert-error">{err}</div>}
          <div className="form-group">
            <label className="form-label">Portal peer name</label>
            <input className="form-input" value={form.portal_peer_name}
              onChange={e => set('portal_peer_name', e.target.value)}
              placeholder="Exactly as the portal export spells it" />
          </div>

          <div className="form-group">
            <label className="form-label">InSync provider</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="form-input" value={form.insync_provider_id}
                onChange={e => set('insync_provider_id', e.target.value)} placeholder="Provider ID" style={{ maxWidth: 140 }} />
              <input className="form-input" value={form.insync_provider_name}
                onChange={e => set('insync_provider_name', e.target.value)} placeholder="Last, First" />
              <button className="btn btn-outline" onClick={lookup} disabled={busy || !form.portal_peer_name}>Look up</button>
            </div>
            {suggestions && (
              <div style={{ marginTop: 6 }}>
                {suggestions.map(s => (
                  <button key={s.id} className="btn btn-outline"
                    style={{ fontSize: '0.75rem', padding: '2px 8px', marginRight: 6, marginBottom: 4 }}
                    onClick={() => { set('insync_provider_id', s.id); set('insync_provider_name', s.name); }}>
                    {s.name} [{s.id}]{s.active ? '' : ' (inactive)'}
                  </button>
                ))}
              </div>
            )}
          </div>

          <Banner tone="warn">
            The password and PIN below are encrypted before they are stored and are never
            returned by the API, shown again, or written to the activity log. Leave a field
            blank to keep what is already on file.
          </Banner>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">InSync username</label>
              <input className="form-input" value={form.insync_username} autoComplete="off"
                onChange={e => set('insync_username', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">InSync password {peer.has_password && <span style={{ color: '#166534' }}>· on file</span>}</label>
              <input className="form-input" type="password" value={form.insync_password} autoComplete="new-password"
                onChange={e => set('insync_password', e.target.value)} placeholder={peer.has_password ? '••••••••' : ''} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Signing PIN {peer.has_pin && <span style={{ color: '#166534' }}>· on file</span>}</label>
            <input className="form-input" type="password" value={form.signing_pin} autoComplete="new-password"
              onChange={e => set('signing_pin', e.target.value)} placeholder={peer.has_pin ? '••••' : ''} style={{ maxWidth: 160 }} />
          </div>
          <div className="form-group">
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.is_active} onChange={e => set('is_active', e.target.checked)} />
              <span style={{ fontSize: '0.82rem' }}>Active</span>
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={busy || !form.portal_peer_name}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function PortalPOCPage() {
  const [tab, setTab] = useState('runs');
  const [status, setStatus] = useState(null);
  const [runs, setRuns] = useState([]);
  const [peers, setPeers] = useState([]);
  const [clients, setClients] = useState([]);
  const [processed, setProcessed] = useState([]);
  const [current, setCurrent] = useState(null);      // { run, notes }
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [editingPeer, setEditingPeer] = useState(null);
  const [confirmingClient, setConfirmingClient] = useState(null);
  // Whether a run signs. Shared by the batch GO and the per-note buttons so the
  // two can never mean different things.
  const [signOnRun, setSignOnRun] = useState(false);
  const [filterPeer, setFilterPeer] = useState('');
  const [filterClient, setFilterClient] = useState('');
  const fileRef = useRef(null);
  const lastEventId = useRef(0);
  const pollRef = useRef(null);

  const loadStatic = useCallback(async () => {
    const [s, r, p, c, h] = await Promise.all([
      api.get('/portal/status').catch(e => ({ error: e.message })),
      api.get('/portal/runs').catch(() => []),
      api.get('/portal/peers').catch(() => []),
      api.get('/portal/clients').catch(() => []),
      api.get('/portal/processed').catch(() => []),
    ]);
    setStatus(s);
    // Field metadata drives the review screen's note editor labels.
    if (s?.note_fields) window.__PORTAL_NOTE_FIELDS = s.note_fields;
    setRuns(Array.isArray(r) ? r : []);
    setPeers(Array.isArray(p) ? p : []);
    setClients(Array.isArray(c) ? c : []);
    setProcessed(Array.isArray(h) ? h : []);
    setLoading(false);
  }, []);

  useEffect(() => { loadStatic(); }, [loadStatic]);

  const openRun = useCallback(async (id) => {
    const d = await api.get(`/portal/runs/${id}`);
    setCurrent(d);
    setTab('review');
    lastEventId.current = 0;
    const ev = await api.get(`/portal/runs/${id}/events?after=0`).catch(() => []);
    setEvents(ev);
    if (ev.length) lastEventId.current = ev[ev.length - 1].id;
  }, []);

  const refreshCurrent = useCallback(async () => {
    if (!current?.run?.id) return;
    const d = await api.get(`/portal/runs/${current.run.id}`);
    setCurrent(d);
  }, [current?.run?.id]);

  // Follow a running batch. The run happens server-side and the log is the
  // window into it — poll until the run stops reporting "executing".
  useEffect(() => {
    if (!current?.run?.id) return;
    if (current.run.status !== 'executing') { clearInterval(pollRef.current); return; }
    pollRef.current = setInterval(async () => {
      try {
        const ev = await api.get(`/portal/runs/${current.run.id}/events?after=${lastEventId.current}`);
        if (ev.length) {
          lastEventId.current = ev[ev.length - 1].id;
          setEvents(e => [...e, ...ev]);
        }
        const d = await api.get(`/portal/runs/${current.run.id}`);
        setCurrent(d);
        if (d.run.status !== 'executing') { clearInterval(pollRef.current); loadStatic(); }
      } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(pollRef.current);
  }, [current?.run?.id, current?.run?.status, loadStatic]);

  async function upload(file) {
    setBusy('upload');
    try {
      const payload = JSON.parse(await file.text());
      const r = await api.post('/portal/runs', { filename: file.name, payload });
      if (r.resolve_error) alert(`Staged, but resolution failed:\n${r.resolve_error}`);
      await loadStatic();
      await openRun(r.run_id);
    } catch (ex) { alert(ex.message); }
    finally { setBusy(''); if (fileRef.current) fileRef.current.value = ''; }
  }

  async function reresolve() {
    setBusy('resolve');
    try { await api.post(`/portal/runs/${current.run.id}/resolve`, {}); await refreshCurrent(); }
    catch (ex) { alert(ex.message); }
    finally { setBusy(''); }
  }

  // Run exactly one note. Same endpoint as the batch, scoped by note_ids — which
  // is how you send the first live encounter without committing to all of them.
  async function runOne(row, mode) {
    const who = `${row.note.clientName} — ${fmtDate(row.note.sessionDate)} ${row.note.sessionStartClock || ''}`;
    if (mode === 'live') {
      if (!window.confirm(
        `LIVE — ONE NOTE\n\n${who}\n${row.resolution.visit_type_name}\n\n` +
        `This creates and closes a real encounter in InSync as ${row.resolution.peer_name || row.note.peerName}` +
        `${signOnRun ? ', and signs it with their PIN' : ', without signing'}.\n\nContinue?`)) return;
      if (signOnRun && !window.confirm(
        `SIGNING\n\nThis commits a billable clinical note under ${row.resolution.peer_name || row.note.peerName}'s ` +
        `credentials.\n\nSign it?`)) return;
    }
    setBusy('execute');
    try {
      await api.post(`/portal/runs/${current.run.id}/execute`, {
        mode, sign: mode === 'live' && signOnRun, confirm: mode === 'live', note_ids: [row.id],
      });
      setEvents([]); lastEventId.current = 0;
      setCurrent(c => ({ ...c, run: { ...c.run, status: 'executing' } }));
    } catch (ex) { alert(ex.message); }
    finally { setBusy(''); }
  }

  async function execute(mode, sign) {
    const readyCount = (current?.notes || []).filter(n => n.status === 'ready').length;
    if (!readyCount) return alert('No rows are Ready. Resolve the flagged rows first.');
    if (mode === 'live') {
      if (!window.confirm(
        `LIVE RUN\n\nThis creates and closes ${readyCount} real encounter(s) in InSync, ` +
        `logged in as each peer.\n\nOnly rows marked Ready will run. Continue?`)) return;
      if (sign && !window.confirm(
        `SIGNING\n\nEach note will be signed with the peer's own PIN. A signed note is a ` +
        `billable clinical record committed under that peer's credentials.\n\nSign after closing?`)) return;
    }
    setBusy('execute');
    try {
      await api.post(`/portal/runs/${current.run.id}/execute`,
        { mode, sign: !!sign, confirm: mode === 'live' });
      setEvents([]); lastEventId.current = 0;
      setCurrent(c => ({ ...c, run: { ...c.run, status: 'executing' } }));
    } catch (ex) { alert(ex.message); }
    finally { setBusy(''); }
  }

  if (loading) return <div style={{ padding: 32, color: 'var(--gray-400)' }}>Loading…</div>;

  const notes = current?.notes || [];
  const counts = notes.reduce((a, n) => ({ ...a, [n.status]: (a[n.status] || 0) + 1 }), {});

  // Filter options come from the notes themselves, so they can only ever offer
  // something that is actually in this upload.
  const peerNames = [...new Set(notes.map(n => n.note.peerName).filter(Boolean))].sort();
  const clientNames = [...new Set(notes
    .filter(n => !filterPeer || n.note.peerName === filterPeer)
    .map(n => n.note.clientName).filter(Boolean))].sort();

  const visible = notes.filter(n =>
    (!filterPeer || n.note.peerName === filterPeer) &&
    (!filterClient || n.note.clientName === filterClient));

  // Peer -> client -> notes. A peer works one InSync session at a time and a
  // client is one chart, so that is the order the work actually happens in.
  const grouped = [];
  for (const row of visible) {
    const peerName = row.note.peerName || '(no peer)';
    let peer = grouped.find(g => g.peer === peerName);
    if (!peer) { peer = { peer: peerName, clients: [], count: 0, ready: 0 }; grouped.push(peer); }
    const clientName = row.note.clientName || '(no client)';
    let client = peer.clients.find(c => c.client === clientName);
    if (!client) { client = { client: clientName, rows: [], ready: 0 }; peer.clients.push(client); }
    client.rows.push(row);
    peer.count++;
    if (row.status === 'ready') { peer.ready++; client.ready++; }
  }
  grouped.sort((a, b) => a.peer.localeCompare(b.peer));
  for (const g of grouped) {
    g.clients.sort((a, b) => a.client.localeCompare(b.client));
    for (const c of g.clients) c.rows.sort((a, b) =>
      (a.note.sessionDate || '').localeCompare(b.note.sessionDate || '') ||
      (a.note.sessionStartMinutes || 0) - (b.note.sessionStartMinutes || 0));
  }
  const running = current?.run?.status === 'executing';

  const TABS = [
    ['runs', `Uploads (${runs.length})`],
    ['review', current ? `Review (${notes.length})` : 'Review'],
    ['peers', `Peers (${peers.length})`],
    ['clients', `Clients (${clients.length})`],
    ['history', `History (${processed.length})`],
  ];

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1240, margin: '0 auto' }}>
      <h2 style={{ margin: '0 0 2px' }}>Portal POC</h2>
      <p style={{ color: 'var(--gray-400)', fontSize: '0.82rem', margin: '0 0 16px' }}>
        Transcribe finished peer-support notes from the portal into InSync — as each peer,
        after review.
      </p>

      {status?.error && <Banner tone="error">Status check failed: {status.error}</Banner>}
      {status && !status.credentials_configured && (
        <Banner tone="error">
          <strong>PORTAL_CRED_KEY is not set.</strong> Peer InSync passwords and signing PINs
          cannot be stored or read until it is. Generate one with
          {' '}<code>node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"</code>
          {' '}and set it in the backend environment.
        </Banner>
      )}
      {status && !status.admin_insync_configured && (
        <Banner tone="error">
          <strong>Admin InSync login is not configured.</strong> Resolution (peer, client and
          encounter-type lookups) cannot run without it.
        </Banner>
      )}
      {status && status.captured_visit_type_id && (
        <Banner tone="info">
          CPT code, modifiers, units and place of service are read from InSync for whichever
          encounter type each note resolves to — they are never taken from the stored request
          templates (captured against type <strong>{status.captured_visit_type_id}</strong>).
          Offsite types are switched off: the portal has no field for the justification their
          note form requires.
        </Banner>
      )}
      {status && status.missing_captures?.length > 0 && (
        <Banner tone="warn">
          <strong>Live execution is blocked.</strong> No captured request template for:{' '}
          <strong>{status.missing_captures.join(', ')}</strong>. Dry runs work and prepare every
          other payload. To unblock, capture those calls in a HAR and run{' '}
          <code>node scripts/extract-insync-captures.js &lt;har-dir&gt;</code>.
        </Banner>
      )}

      <div style={{ display: 'flex', gap: 18, borderBottom: '1px solid var(--gray-100)', marginBottom: 16 }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '6px 0',
            fontSize: '0.82rem', fontWeight: tab === k ? 700 : 400,
            color: tab === k ? 'var(--navy)' : 'var(--gray-400)',
            borderBottom: tab === k ? '2px solid var(--navy)' : '2px solid transparent',
          }}>{label}</button>
        ))}
      </div>

      {/* ---- Uploads ---- */}
      {tab === 'runs' && (
        <>
          <div style={card}>
            <h3 style={{ margin: '0 0 8px', fontSize: '0.95rem' }}>Upload a portal export</h3>
            <p style={{ color: 'var(--gray-400)', fontSize: '0.8rem', margin: '0 0 10px' }}>
              The JSON the Chrome extension exports from portal.linksnetwork.com. Notes already
              processed — or already marked entered in InSync by the portal — are staged as
              duplicates and excluded.
            </p>
            <input ref={fileRef} type="file" accept="application/json,.json"
              onChange={e => e.target.files?.[0] && upload(e.target.files[0])}
              disabled={busy === 'upload'} />
          </div>

          <div style={card}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>Uploaded</th><th style={th}>File</th><th style={th}>Notes</th>
                <th style={th}>Duplicates</th><th style={th}>Status</th><th style={th}>Last run</th><th style={th} />
              </tr></thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id}>
                    <td style={td}>{new Date(r.uploaded_at).toLocaleString()}</td>
                    <td style={td}>{r.source_filename || '—'}</td>
                    <td style={td}>{r.note_count}</td>
                    <td style={td}>{r.duplicate_count}</td>
                    <td style={td}>{r.status}</td>
                    <td style={td}>{r.last_execution_mode || '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button className="btn btn-outline" style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                        onClick={() => openRun(r.id)}>Review</button>
                    </td>
                  </tr>
                ))}
                {!runs.length && <tr><td style={td} colSpan={7}>No uploads yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ---- Review ---- */}
      {tab === 'review' && !current && (
        <div style={card}><p style={{ color: 'var(--gray-400)', fontSize: '0.85rem' }}>
          Pick an upload from the Uploads tab.</p></div>
      )}

      {tab === 'review' && current && (
        <>
          <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <strong style={{ fontSize: '0.9rem' }}>{current.run.source_filename || 'Upload'}</strong>
              <div style={{ color: 'var(--gray-400)', fontSize: '0.78rem' }}>
                {Object.entries(counts).map(([k, v]) => `${v} ${(STATUS_STYLE[k] || {}).label || k}`).join(' · ')}
              </div>
            </div>
            <button className="btn btn-outline" onClick={reresolve} disabled={busy || running}>
              {busy === 'resolve' ? 'Resolving…' : 'Re-resolve'}
            </button>
            <button className="btn btn-outline" onClick={() => execute('dry_run', false)} disabled={busy || running}
              title="Signs in as each peer read-only to check their calendar. Writes nothing.">
              Dry run
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={signOnRun} onChange={e => setSignOnRun(e.target.checked)} />
              Sign after closing
            </label>
            <button className="btn btn-gold" onClick={() => execute('live', signOnRun)}
              disabled={busy || running || !status?.live_ready}>
              GO — run all Ready {signOnRun ? '& sign' : 'live'}
            </button>
          </div>

          <Banner tone="info">
            Only rows marked <strong>Ready</strong> run. Everything else lists what it needs in the
            Status column. Each Ready row can be dry-run or sent live on its own — start with one —
            or use GO to run every Ready row. Whether an appointment already exists is only knowable
            once signed in as the peer, so it resolves during the run.
          </Banner>

          <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', paddingTop: 12, paddingBottom: 12 }}>
            <label style={{ fontSize: '0.78rem', color: 'var(--gray-600)' }}>
              Peer{' '}
              <select className="form-select" style={{ fontSize: '0.78rem', minWidth: 170 }}
                value={filterPeer}
                onChange={e => { setFilterPeer(e.target.value); setFilterClient(''); }}>
                <option value="">All peers ({peerNames.length})</option>
                {peerNames.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label style={{ fontSize: '0.78rem', color: 'var(--gray-600)' }}>
              Client{' '}
              <select className="form-select" style={{ fontSize: '0.78rem', minWidth: 190 }}
                value={filterClient} onChange={e => setFilterClient(e.target.value)}>
                <option value="">All clients ({clientNames.length})</option>
                {clientNames.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            {(filterPeer || filterClient) && (
              <button className="btn btn-outline" style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                onClick={() => { setFilterPeer(''); setFilterClient(''); }}>Clear filters</button>
            )}
            <span style={{ marginLeft: 'auto', fontSize: '0.78rem', color: 'var(--gray-400)' }}>
              showing {visible.length} of {notes.length} note{notes.length === 1 ? '' : 's'}
            </span>
          </div>

          <div style={{ ...card, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
              <thead><tr>
                <th style={th}>Peer</th><th style={th}>Client</th><th style={th}>Session</th>
                <th style={th}>Encounter type</th><th style={th}>Appointment</th>
                <th style={th}>Status</th><th style={th} />
              </tr></thead>
              {grouped.map(group => (
                <tbody key={group.peer}>
                  <tr>
                    <td colSpan={7} style={{
                      padding: '10px 8px 6px', borderTop: '2px solid var(--navy)',
                      fontWeight: 700, fontSize: '0.85rem', color: 'var(--navy)',
                      background: 'var(--gray-50, #fafafa)',
                    }}>
                      {group.peer}
                      <span style={{ fontWeight: 400, color: 'var(--gray-400)', fontSize: '0.75rem' }}>
                        {' '}· {group.count} note{group.count === 1 ? '' : 's'} ·{' '}
                        {group.clients.length} client{group.clients.length === 1 ? '' : 's'} ·{' '}
                        {group.ready} ready
                      </span>
                    </td>
                  </tr>
                  {group.clients.map(client => (
                    <Fragment key={client.client}>
                      <tr>
                        <td colSpan={7} style={{
                          padding: '6px 8px 4px 26px', borderTop: '1px solid var(--gray-100)',
                          fontWeight: 600, fontSize: '0.78rem', color: 'var(--gray-600)',
                        }}>
                          {client.client}
                          <span style={{ fontWeight: 400, color: 'var(--gray-400)' }}>
                            {' '}· {client.rows.length} note{client.rows.length === 1 ? '' : 's'} ·{' '}
                            {client.ready} ready
                          </span>
                        </td>
                      </tr>
                      {client.rows.map(row => (
                        <ReviewRow key={row.id} runId={current.run.id} row={row}
                          onChanged={refreshCurrent}
                          onConfirmClient={setConfirmingClient}
                          onRunOne={runOne} running={running} signOnRun={signOnRun} />
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              ))}
              {!grouped.length && (
                <tbody><tr><td style={td} colSpan={7}>
                  {notes.length ? 'No notes match those filters.' : 'No notes staged.'}
                </td></tr></tbody>
              )}
            </table>
          </div>

          <div style={card}>
            <h3 style={{ margin: '0 0 8px', fontSize: '0.9rem' }}>
              Activity log {running && <span style={{ color: 'var(--gray-400)', fontWeight: 400 }}>· running…</span>}
            </h3>
            <div style={{
              background: '#0f172a', color: '#e2e8f0', borderRadius: 6, padding: 12,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '0.74rem', maxHeight: 320, overflowY: 'auto', lineHeight: 1.6,
            }}>
              {events.length === 0 && <div style={{ color: '#64748b' }}>No activity yet.</div>}
              {events.map(e => (
                <div key={e.id} style={{ color: e.level === 'error' ? '#fca5a5' : e.level === 'warn' ? '#fcd34d' : '#e2e8f0' }}>
                  <span style={{ color: '#64748b' }}>{new Date(e.at).toLocaleTimeString()} </span>
                  <span style={{ color: '#7dd3fc' }}>[{e.step}] </span>
                  {e.message}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ---- Peers ---- */}
      {tab === 'peers' && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Peers</h3>
            <button className="btn btn-gold" onClick={() => setEditingPeer({})}>Add peer</button>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Portal name</th><th style={th}>InSync provider</th><th style={th}>Username</th>
              <th style={th}>Password</th><th style={th}>PIN</th><th style={th}>Active</th><th style={th} />
            </tr></thead>
            <tbody>
              {peers.map(p => (
                <tr key={p.id}>
                  <td style={td}><strong>{p.portal_peer_name}</strong></td>
                  <td style={td}>{p.insync_provider_name || '—'}{p.insync_provider_id ? ` [${p.insync_provider_id}]` : ''}</td>
                  <td style={td}>{p.insync_username || <span style={{ color: '#991b1b' }}>missing</span>}</td>
                  <td style={td}>{p.has_password ? '✓ on file' : <span style={{ color: '#991b1b' }}>missing</span>}</td>
                  <td style={td}>{p.has_pin ? '✓ on file' : <span style={{ color: '#991b1b' }}>missing</span>}</td>
                  <td style={td}>{p.is_active ? 'Yes' : 'No'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button className="btn btn-outline" style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                      onClick={() => setEditingPeer(p)}>Edit</button>
                  </td>
                </tr>
              ))}
              {!peers.length && <tr><td style={td} colSpan={7}>No peers yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Clients ---- */}
      {tab === 'clients' && (
        <div style={card}>
          <h3 style={{ margin: '0 0 4px', fontSize: '0.95rem' }}>Confirmed client bindings</h3>
          <p style={{ color: 'var(--gray-400)', fontSize: '0.8rem', margin: '0 0 10px' }}>
            Each portal client is bound to an InSync patient once, by hand. Later runs reuse the
            binding instead of re-searching. Remove one only if it is wrong.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Portal client</th><th style={th}>DOB</th><th style={th}>InSync patient</th>
              <th style={th}>MRN</th><th style={th}>Confirmed</th><th style={th} />
            </tr></thead>
            <tbody>
              {clients.map(c => (
                <tr key={c.id}>
                  <td style={td}><strong>{c.portal_client_name}</strong></td>
                  <td style={td}>{fmtDate(c.portal_client_dob)}</td>
                  <td style={td}>{c.insync_patient_name || '—'} [{c.insync_patient_id}]</td>
                  <td style={td}>{c.insync_mrn || '—'}</td>
                  <td style={td}>{new Date(c.confirmed_at).toLocaleDateString()}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button className="btn btn-outline" style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                      onClick={async () => {
                        if (!window.confirm(`Remove the binding for ${c.portal_client_name}? It will have to be confirmed again.`)) return;
                        try { await api.delete(`/portal/clients/${c.id}`); await loadStatic(); }
                        catch (ex) { alert(ex.message); }
                      }}>Remove</button>
                  </td>
                </tr>
              ))}
              {!clients.length && <tr><td style={td} colSpan={6}>Nothing bound yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- History ---- */}
      {tab === 'history' && (
        <div style={card}>
          <h3 style={{ margin: '0 0 10px', fontSize: '0.95rem' }}>Processed notes</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Processed</th><th style={th}>Peer</th><th style={th}>Client</th>
              <th style={th}>Session</th><th style={th}>Visit</th><th style={th}>Encounter</th>
              <th style={th}>Signed</th><th style={th}>Status</th>
            </tr></thead>
            <tbody>
              {processed.map(p => (
                <tr key={p.portal_note_uuid}>
                  <td style={td}>{new Date(p.processed_at).toLocaleString()}</td>
                  <td style={td}>{p.peer_name || '—'}</td>
                  <td style={td}>{p.client_name || '—'}</td>
                  <td style={td}>{fmtDate(p.session_date)}</td>
                  <td style={td}>{p.insync_visit_id || '—'}{p.appointment_reused ? ' (reused)' : ''}</td>
                  <td style={td}>{p.insync_encounter_id || '—'}</td>
                  <td style={td}>{p.signed ? '✓' : '—'}</td>
                  <td style={td}>
                    <Pill status={p.status} />
                    {p.error_detail && <div style={{ color: '#991b1b', fontSize: '0.72rem', marginTop: 2 }}>{p.error_detail}</div>}
                  </td>
                </tr>
              ))}
              {!processed.length && <tr><td style={td} colSpan={8}>Nothing processed yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {editingPeer && (
        <PeerEditor peer={editingPeer} onClose={() => setEditingPeer(null)}
          onSaved={async () => { setEditingPeer(null); await loadStatic(); }} />
      )}
      {confirmingClient && (
        <ClientConfirmModal note={confirmingClient.note} resolution={confirmingClient.resolution || {}}
          onClose={() => setConfirmingClient(null)}
          onConfirmed={async () => {
            setConfirmingClient(null);
            await reresolve();
            await loadStatic();
          }} />
      )}
    </div>
  );
}

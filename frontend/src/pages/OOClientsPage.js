import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';

// ── Helpers ────────────────────────────────────────────────────────────────

function calcAge(dob) {
  if (!dob) return null;
  const ms = Date.now() - new Date(dob + 'T12:00:00Z').getTime();
  return Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
}

function getDow(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay();
}

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtDob(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y}`;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

const DAY_STYLES = [
  { dot: '#93c5fd' },
  { dot: '#6ee7b7' },
  { dot: '#fde68a' },
  { dot: '#c4b5fd' },
  { dot: '#fdba74' },
  { dot: '#f9a8d4' },
];

const NOT_ASSIGNED_STYLE = { dot: 'var(--gray-400)', muted: true };

const EMPTY_FORM = {
  first_name: '', last_name: '', dob: '', sex: '', phone: '', mobile: '',
  email: '', mrn: '', referral_source_id: '', program: '', status: 'active',
};

// ── Client Card ────────────────────────────────────────────────────────────

function ClientCard({ client, nextAppt }) {
  const navigate = useNavigate();
  const age = calcAge(client.dob);

  return (
    <div
      onClick={() => navigate(`/oo/clients/${client.id}`)}
      style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '9px 14px',
        borderRadius: 8, background: 'white', border: '1px solid var(--gray-100)',
        cursor: 'pointer', marginBottom: 5, transition: 'background 0.1s, box-shadow 0.1s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--gray-50)'; e.currentTarget.style.boxShadow = '0 1px 4px rgba(0,0,0,0.06)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'white'; e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '0.9rem' }}>
          {client.last_name}, {client.first_name}
        </div>
        {nextAppt ? (
          <div style={{ fontSize: '0.73rem', color: 'var(--gray-400)', marginTop: 1 }}>
            {DAY_NAMES[getDow(nextAppt.date)]} · {fmt12(nextAppt.time)} · {nextAppt.duration || 45}min
          </div>
        ) : client.dob ? (
          <div style={{ fontSize: '0.73rem', color: 'var(--gray-300)', marginTop: 1 }}>DOB {fmtDob(client.dob)}</div>
        ) : null}
      </div>

      {(age !== null || client.sex) && (
        <div style={{ fontSize: '0.78rem', color: 'var(--gray-500)', whiteSpace: 'nowrap', fontWeight: 500 }}>
          {[age !== null ? `${age}y` : null, client.sex].filter(Boolean).join(' · ')}
        </div>
      )}

      {client.referral && (
        <span style={{ background: 'var(--navy)', color: 'rgba(255,255,255,0.9)', borderRadius: 4, padding: '2px 8px', fontSize: '0.68rem', fontWeight: 600, whiteSpace: 'nowrap', letterSpacing: '0.02em' }}>
          {client.referral.name}
        </span>
      )}

      <span style={{ color: 'var(--gray-300)', fontSize: '0.8rem' }}>›</span>
    </div>
  );
}

// ── Day Section ────────────────────────────────────────────────────────────

function DaySection({ title, clients, nextApptMap, style, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const isMuted = !!style.muted;

  return (
    <div style={{ marginBottom: 10 }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px',
          borderRadius: open ? '8px 8px 0 0' : 8,
          background: isMuted ? 'var(--gray-100)' : 'var(--navy)',
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: style.dot, flexShrink: 0 }} />
        <span style={{ fontWeight: 700, fontSize: '0.88rem', color: isMuted ? 'var(--gray-600)' : '#fff', flex: 1 }}>
          {title}
        </span>
        <span style={{ fontSize: '0.75rem', color: isMuted ? 'var(--gray-400)' : 'rgba(255,255,255,0.55)' }}>
          {clients.length} client{clients.length !== 1 ? 's' : ''}
        </span>
        <span style={{ fontSize: '0.72rem', color: isMuted ? 'var(--gray-400)' : 'rgba(255,255,255,0.35)', marginLeft: 4 }}>
          {open ? '▾' : '▸'}
        </span>
      </div>

      {open && (
        <div style={{
          padding: '8px 8px 4px',
          background: 'white',
          border: '1px solid var(--gray-100)',
          borderTop: 'none',
          borderRadius: '0 0 8px 8px',
        }}>
          {clients.length === 0 ? (
            <div style={{ fontSize: '0.78rem', color: 'var(--gray-300)', padding: '8px 6px' }}>No clients</div>
          ) : (
            clients.map(c => (
              <ClientCard key={c.id} client={c} nextAppt={nextApptMap[c.id] || null} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function OOClientsPage() {
  const [clients,     setClients]     = useState([]);
  const [nextApptMap, setNextApptMap] = useState({});
  const [sources,     setSources]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [search,      setSearch]      = useState('');

  // Add/Edit modal
  const [showModal,  setShowModal]  = useState(false);
  const [editClient, setEditClient] = useState(null);
  const [form,       setForm]       = useState(EMPTY_FORM);
  const [saving,     setSaving]     = useState(false);

  // Import
  const [showImport,   setShowImport]   = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importing,    setImporting]    = useState(false);
  const fileRef = useRef();

  // InSync
  const [showInSyncSettings, setShowInSyncSettings] = useState(false);
  const [inSyncUser, setInSyncUser] = useState('');
  const [inSyncPass, setInSyncPass] = useState('');
  const [syncing,    setSyncing]    = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  // Assign referral source
  const [showAssign,    setShowAssign]    = useState(false);
  const [assignSourceId, setAssignSourceId] = useState('');
  const [assignPaste,   setAssignPaste]   = useState('');
  const [assignPreview, setAssignPreview] = useState(null);
  const [assignLoading, setAssignLoading] = useState(false);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const today = new Date().toISOString().split('T')[0];
      const [clientsData, sourcesData, apptData] = await Promise.all([
        api.get('/oo/clients'),
        api.get('/oo/clients/referral-sources'),
        api.get(`/oo/appointments?week_start=${today}`),
      ]);
      setClients(clientsData);
      setSources(sourcesData);

      // Build client → next scheduled appointment map
      const upcoming = (Array.isArray(apptData) ? apptData : []).filter(a => a.status === 'scheduled');
      const map = {};
      for (const appt of upcoming) {
        const cid = appt.client_id;
        if (!map[cid] ||
            appt.date < map[cid].date ||
            (appt.date === map[cid].date && appt.time < map[cid].time)) {
          map[cid] = appt;
        }
      }
      setNextApptMap(map);
    } finally {
      setLoading(false);
    }
  }

  // ── Modal ──────────────────────────────────────────────────────────────

  function openAdd() {
    setEditClient(null);
    setForm(EMPTY_FORM);
    setShowModal(true);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form, referral_source_id: form.referral_source_id || null };
      if (editClient) {
        const updated = await api.put(`/oo/clients/${editClient.id}`, payload);
        setClients(cs => cs.map(c => c.id === updated.id ? updated : c));
      } else {
        const created = await api.post('/oo/clients', payload);
        setClients(cs => [...cs, created]);
      }
      setShowModal(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this client?')) return;
    await api.delete(`/oo/clients/${id}`);
    setClients(cs => cs.filter(c => c.id !== id));
  }

  // ── InSync ─────────────────────────────────────────────────────────────

  async function handleSaveInSyncCreds() {
    await Promise.all([
      api.post('/settings/insync_username', { value: inSyncUser }),
      api.post('/settings/insync_password', { value: inSyncPass }),
    ]);
    setShowInSyncSettings(false);
  }

  async function handleSync() {
    setSyncing(true); setSyncResult(null);
    try {
      const result = await api.post('/oo/clients/sync-insync', {});
      setSyncResult(result);
      await loadAll();
    } catch (err) {
      setSyncResult({ error: err.message });
    } finally { setSyncing(false); }
  }

  // ── Assign Referral Source ─────────────────────────────────────────────

  async function handleAssignPreview() {
    if (!assignSourceId || !assignPaste.trim()) return;
    setAssignLoading(true); setAssignPreview(null);
    try {
      const result = await api.post('/oo/clients/assign-referral', {
        referral_source_id: assignSourceId, paste_text: assignPaste,
      });
      setAssignPreview(result);
    } catch (err) { setAssignPreview({ error: err.message }); }
    finally { setAssignLoading(false); }
  }

  async function handleAssignConfirm() {
    if (!assignPreview?.matched?.length) return;
    setAssignLoading(true);
    try {
      await api.post('/oo/clients/assign-referral/confirm', {
        referral_source_id: assignSourceId,
        client_ids: assignPreview.matched.map(c => c.id),
      });
      await loadAll();
      setShowAssign(false); setAssignPaste(''); setAssignPreview(null); setAssignSourceId('');
    } finally { setAssignLoading(false); }
  }

  // ── Import ─────────────────────────────────────────────────────────────

  async function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    setImporting(true); setImportResult(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const result = await api.postForm('/oo/clients/import/insync', formData);
      setImportResult(result);
      await loadAll();
    } catch (err) { setImportResult({ error: err.message }); }
    finally { setImporting(false); fileRef.current.value = ''; }
  }

  // ── Grouping ───────────────────────────────────────────────────────────

  const filtered = clients.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (c.first_name || '').toLowerCase().includes(q) ||
      (c.last_name  || '').toLowerCase().includes(q) ||
      (c.mrn        || '').toLowerCase().includes(q) ||
      (c.referral?.name || '').toLowerCase().includes(q)
    );
  });

  const sorted = [...filtered].sort((a, b) => (a.last_name || '').localeCompare(b.last_name || ''));

  // Group by day of week of next scheduled appointment (0=Sun…5=Fri); else notAssigned
  const groups = { notAssigned: [], 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const client of sorted) {
    const nextAppt = nextApptMap[client.id];
    if (!nextAppt) {
      groups.notAssigned.push(client);
    } else {
      const dow = getDow(nextAppt.date);
      if (groups[dow] !== undefined) {
        groups[dow].push(client);
      } else {
        groups.notAssigned.push(client); // Saturday or other → Not Assigned
      }
    }
  }

  const activeDays = [0, 1, 2, 3, 4, 5].filter(d => groups[d].length > 0);

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '24px 32px' }}>

      {/* Header toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--navy)', margin: 0, flex: 1 }}>Clients</h2>
        <input
          className="input"
          placeholder="Search name, MRN, referral source…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: 240, fontSize: '0.85rem' }}
        />
        <button className="btn btn-outline btn-sm" onClick={handleSync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync from InSync DSC'}
        </button>
        <button className="btn btn-outline btn-sm" onClick={() => setShowInSyncSettings(s => !s)} title="Configure InSync credentials">⚙</button>
        <button className="btn btn-outline btn-sm" onClick={() => setShowImport(s => !s)}>Import Excel</button>
        <button className="btn btn-outline btn-sm" onClick={() => { setShowAssign(s => !s); setAssignPreview(null); }}>Assign Referral Source</button>
        <button className="btn btn-primary btn-sm" onClick={openAdd}>+ Add Client</button>
      </div>

      {/* InSync credentials panel */}
      {showInSyncSettings && (
        <div style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 8, padding: '14px 20px', marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 200px' }}>
            <label style={labelSt}>InSync Username</label>
            <input className="input" value={inSyncUser} onChange={e => setInSyncUser(e.target.value)} placeholder="Corelowitz" style={{ fontSize: '0.85rem' }} autoComplete="off" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 200px' }}>
            <label style={labelSt}>InSync Password</label>
            <input className="input" type="password" value={inSyncPass} onChange={e => setInSyncPass(e.target.value)} style={{ fontSize: '0.85rem' }} autoComplete="new-password" />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={handleSaveInSyncCreds} disabled={!inSyncUser.trim() || !inSyncPass.trim()}>Save</button>
            <button className="btn btn-outline btn-sm" onClick={() => setShowInSyncSettings(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Sync result */}
      {syncResult && (
        <div style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8, fontSize: '0.82rem',
          background: syncResult.error ? '#fef2f2' : '#f0fdf4',
          border: `1px solid ${syncResult.error ? '#fca5a5' : '#86efac'}`,
          color: syncResult.error ? '#dc2626' : '#166534',
        }}>
          {syncResult.error
            ? `Error: ${syncResult.error}`
            : `Sync complete — ${syncResult.created} created, ${syncResult.updated} updated${syncResult.skipped > 0 ? `, ${syncResult.skipped} skipped` : ''} (${syncResult.total} total from InSync)`}
        </div>
      )}

      {/* Import panel */}
      {showImport && (
        <div style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 8, padding: '14px 20px', marginBottom: 20, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--gray-600)', marginBottom: 4 }}>Upload InSync Excel export</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>Matches on First Name + Last Name + DOB. New clients are created; existing ones are updated.</div>
          </div>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleImport} disabled={importing} style={{ fontSize: '0.82rem' }} />
          {importing && <span style={{ fontSize: '0.8rem', color: 'var(--gray-400)' }}>Importing…</span>}
          {importResult && !importResult.error && (
            <span style={{ fontSize: '0.8rem', color: '#166534', fontWeight: 600 }}>
              Done — {importResult.created} created, {importResult.updated} updated{importResult.skipped > 0 ? `, ${importResult.skipped} skipped` : ''}
            </span>
          )}
          {importResult?.error && <span style={{ fontSize: '0.8rem', color: '#dc2626' }}>{importResult.error}</span>}
        </div>
      )}

      {/* Assign Referral Source panel */}
      {showAssign && (
        <div style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 8, padding: '16px 20px', marginBottom: 20 }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--gray-600)', marginBottom: 12 }}>Assign Referral Source</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
              <label style={labelSt}>Referral Source</label>
              <select className="input" value={assignSourceId} onChange={e => { setAssignSourceId(e.target.value); setAssignPreview(null); }} style={{ fontSize: '0.85rem' }}>
                <option value="">— Select —</option>
                {sources.filter(s => s.type !== 'ehr').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 300px' }}>
              <label style={labelSt}>Paste Client List</label>
              <textarea
                className="input"
                value={assignPaste}
                onChange={e => { setAssignPaste(e.target.value); setAssignPreview(null); }}
                rows={6}
                placeholder={"Mendel\nTaub   11/13/2025\n\nMoshe Gutman   03/11/2013"}
                style={{ fontSize: '0.82rem', fontFamily: 'monospace', resize: 'vertical' }}
              />
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" onClick={handleAssignPreview} disabled={assignLoading || !assignSourceId || !assignPaste.trim()}>
              {assignLoading ? 'Matching…' : 'Preview Matches'}
            </button>
            {assignPreview?.matched?.length > 0 && (
              <button className="btn btn-primary btn-sm" onClick={handleAssignConfirm} disabled={assignLoading}
                style={{ background: '#166534', borderColor: '#166534' }}>
                Confirm — assign {assignPreview.matched.length} client{assignPreview.matched.length !== 1 ? 's' : ''}
              </button>
            )}
            <button className="btn btn-outline btn-sm" onClick={() => { setShowAssign(false); setAssignPaste(''); setAssignPreview(null); setAssignSourceId(''); }}>Close</button>
          </div>
          {assignPreview && !assignPreview.error && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: '0.72rem', color: 'var(--gray-400)', marginBottom: 10 }}>
                Parsed {assignPreview.total} entr{assignPreview.total === 1 ? 'y' : 'ies'} from paste:
                {assignPreview.parsed?.map((c, i) => (
                  <span key={i} style={{ marginLeft: 8, color: 'var(--gray-500)' }}>
                    {c.first_name} {c.last_name}{c.dob ? ` (${fmtDob(c.dob)})` : ''}
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                {assignPreview.matched.length > 0 && (
                  <div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#166534', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                      Matched ({assignPreview.matched.length})
                    </div>
                    {assignPreview.matched.map((c, i) => (
                      <div key={i} style={{ fontSize: '0.8rem', color: '#166534', padding: '2px 0' }}>
                        ✓ {c.first_name} {c.last_name} {c.dob ? `· ${fmtDob(c.dob)}` : ''}
                      </div>
                    ))}
                  </div>
                )}
                {assignPreview.unmatched.length > 0 && (
                  <div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                      Not found ({assignPreview.unmatched.length})
                    </div>
                    {assignPreview.unmatched.map((c, i) => (
                      <div key={i} style={{ fontSize: '0.8rem', color: '#92400e', padding: '2px 0' }}>
                        ✗ {c.first_name} {c.last_name} {c.dob ? `· ${fmtDob(c.dob)}` : ''}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          {assignPreview?.error && (
            <div style={{ marginTop: 10, fontSize: '0.8rem', color: '#dc2626' }}>{assignPreview.error}</div>
          )}
        </div>
      )}

      {/* Grouped sections */}
      {loading ? (
        <div style={{ color: 'var(--gray-400)', fontSize: '0.85rem' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ color: 'var(--gray-400)', fontSize: '0.85rem', padding: '20px 0' }}>
          {search ? 'No matches.' : 'No clients yet. Add one or import from InSync.'}
        </div>
      ) : (
        <>
          <DaySection
            title="Not Assigned"
            clients={groups.notAssigned}
            nextApptMap={nextApptMap}
            style={NOT_ASSIGNED_STYLE}
            defaultOpen={groups.notAssigned.length > 0}
          />
          {activeDays.map(dow => (
            <DaySection
              key={dow}
              title={DAY_NAMES[dow]}
              clients={groups[dow]}
              nextApptMap={nextApptMap}
              style={DAY_STYLES[dow]}
              defaultOpen
            />
          ))}
        </>
      )}

      {/* Add Client Modal */}
      {showModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: 520, maxWidth: '95vw' }}>
            <div className="modal-header">
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--navy)' }}>
                {editClient ? 'Edit Client' : 'Add Client'}
              </h3>
              <button onClick={() => setShowModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: 'var(--gray-400)', lineHeight: 1 }}>✕</button>
            </div>
            <div className="modal-body">
              <form id="add-client-form" onSubmit={handleSave}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' }}>
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
                      <label style={labelSt}>{label}</label>
                      <input
                        className="input"
                        type={type}
                        value={form[key]}
                        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                        style={{ fontSize: '0.85rem' }}
                      />
                    </div>
                  ))}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={labelSt}>Sex</label>
                    <select className="input" value={form.sex} onChange={e => setForm(f => ({ ...f, sex: e.target.value }))} style={{ fontSize: '0.85rem' }}>
                      <option value="">—</option>
                      <option value="M">Male</option>
                      <option value="F">Female</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={labelSt}>Status</label>
                    <select className="input" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} style={{ fontSize: '0.85rem' }}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>

                  <div style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={labelSt}>Referral Source</label>
                    <select className="input" value={form.referral_source_id} onChange={e => setForm(f => ({ ...f, referral_source_id: e.target.value }))} style={{ fontSize: '0.85rem' }}>
                      <option value="">— None —</option>
                      {sources.filter(s => s.type !== 'ehr').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                </div>
              </form>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowModal(false)}>Cancel</button>
              <button type="submit" form="add-client-form" className="btn btn-primary btn-sm" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const labelSt = {
  fontSize: '0.72rem', fontWeight: 600, color: 'var(--gray-500)',
  textTransform: 'uppercase', letterSpacing: '0.05em',
};

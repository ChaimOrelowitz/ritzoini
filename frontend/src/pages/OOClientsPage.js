import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';

// ── Helpers ────────────────────────────────────────────────────────────────────

function calcAge(dob) {
  if (!dob) return null;
  const ms = Date.now() - new Date(dob + 'T12:00:00Z').getTime();
  return Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
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

function fmtDateShort(iso) {
  if (!iso) return '';
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

function addMinutes(timeStr, mins) {
  if (!timeStr) return null;
  const [h, m] = timeStr.slice(0, 5).split(':').map(Number);
  const total = h * 60 + m + (parseInt(mins) || 0);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// ── Status logic ───────────────────────────────────────────────────────────────

function computeStatus(client, nextAppt) {
  if (client.status !== 'active') return 'inactive';
  const noPhone    = !client.phone && !client.mobile && !client.mother_phone && !client.father_phone;
  const noInsync   = !client.insync_patient_id;
  const noReferral = !client.referral?.notes_email;
  const noAppt     = !nextAppt;
  const issues     = [noPhone, noInsync, noReferral, noAppt].filter(Boolean).length;
  if (issues >= 2) return 'problem';
  if (noAppt)      return 'needs_appt';
  if (noPhone)     return 'missing_contact';
  if (noInsync)    return 'missing_insync';
  if (noReferral)  return 'missing_referral';
  return 'ready';
}

const STATUS_BADGE = {
  ready:            { bg: '#dcfce7', color: '#166534', label: 'Ready' },
  needs_appt:       { bg: '#fef3c7', color: '#92400e', label: 'Needs Appt' },
  missing_contact:  { bg: '#fff7ed', color: '#c2410c', label: 'No Phone' },
  missing_insync:   { bg: '#eff6ff', color: '#1d4ed8', label: 'No InSync' },
  missing_referral: { bg: '#faf5ff', color: '#6d28d9', label: 'No Referral' },
  inactive:         { bg: '#f3f4f6', color: '#6b7280', label: 'Inactive' },
  problem:          { bg: '#fef2f2', color: '#dc2626', label: '⚠ Problem' },
};

// ── Schedule maps ──────────────────────────────────────────────────────────────
// Pass 1: find modal DOW per client from all future scheduled appointments.
// Pass 2: on that modal DOW, find modal time and modal duration.

function buildScheduleMaps(apptData) {
  const dayCount = {};
  for (const a of apptData) {
    if (a.status !== 'scheduled') continue;
    const dow = new Date(a.date + 'T12:00:00Z').getUTCDay();
    if (dow === 6) continue;
    if (!dayCount[a.client_id]) dayCount[a.client_id] = {};
    dayCount[a.client_id][dow] = (dayCount[a.client_id][dow] || 0) + 1;
  }
  const dayMap = {};
  for (const [cid, counts] of Object.entries(dayCount)) {
    dayMap[cid] = parseInt(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
  }

  const timeCount = {};
  const durCount  = {};
  for (const a of apptData) {
    if (a.status !== 'scheduled') continue;
    const dow = new Date(a.date + 'T12:00:00Z').getUTCDay();
    const cid = a.client_id;
    if (dayMap[cid] !== dow) continue;
    if (!timeCount[cid]) timeCount[cid] = {};
    timeCount[cid][a.time] = (timeCount[cid][a.time] || 0) + 1;
    const dur = a.duration || 45;
    if (!durCount[cid]) durCount[cid] = {};
    durCount[cid][dur] = (durCount[cid][dur] || 0) + 1;
  }

  const timeMap = {};
  const durMap  = {};
  for (const cid of Object.keys(timeCount)) {
    timeMap[cid] = Object.entries(timeCount[cid]).sort((a, b) => b[1] - a[1])[0][0];
  }
  for (const cid of Object.keys(durCount)) {
    durMap[cid] = parseInt(Object.entries(durCount[cid]).sort((a, b) => b[1] - a[1])[0][0]);
  }

  return { dayMap, timeMap, durMap };
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

const DAY_STYLES = [
  { dot: '#93c5fd' },
  { dot: '#6ee7b7' },
  { dot: '#fde68a' },
  { dot: '#c4b5fd' },
  { dot: '#fdba74' },
  { dot: '#f9a8d4' },
];

const NEEDS_SETUP_STYLE = { dot: '#fca5a5', muted: true };

const EMPTY_FORM = {
  first_name: '', last_name: '', dob: '', sex: '', phone: '', mobile: '',
  email: '', mrn: '', referral_source_id: '', status: 'active',
};

const FILTERS = [
  { key: 'all',          label: 'All' },
  { key: 'active',       label: 'Active' },
  { key: 'inactive',     label: 'Inactive' },
  { key: 'no_appt',      label: 'No Future Appt' },
  { key: 'no_phone',     label: 'Missing Phone' },
  { key: 'no_insync',    label: 'Missing InSync' },
  { key: 'no_referral',  label: 'Missing Referral' },
  { key: 'problems',     label: '⚠ Problems' },
];

// ── Client Card (redesigned) ───────────────────────────────────────────────────

function ClientCard({ client, nextAppt, scheduleDay, scheduleTime, scheduleDur }) {
  const navigate   = useNavigate();
  const age        = calcAge(client.dob);
  const status     = computeStatus(client, nextAppt);
  const badge      = STATUS_BADGE[status] || STATUS_BADGE.ready;
  const isArchived = client.status === 'archived';

  // Schedule rhythm: "Tuesdays · 7:00–7:45 PM"
  const rhythmStr = (scheduleDay != null && scheduleTime)
    ? `${DAY_NAMES[scheduleDay]}s · ${fmt12(scheduleTime)}–${fmt12(addMinutes(scheduleTime, scheduleDur || 45))}`
    : null;

  // Contact: prefer parent names, fall back to direct phone
  const motherLine = client.mother_name
    ? `${client.mother_name}${client.mother_phone ? ' · ' + client.mother_phone : ''}`
    : null;
  const fatherLine = client.father_name
    ? `${client.father_name}${client.father_phone ? ' · ' + client.father_phone : ''}`
    : null;
  const directPhone = client.mobile || client.phone;
  const contactLine = motherLine || fatherLine || directPhone || null;

  return (
    <div
      onClick={() => navigate(`/oo/clients/${client.id}`)}
      style={{
        display: 'flex', flexDirection: 'column', gap: 3,
        padding: '10px 14px', borderRadius: 7,
        background: isArchived ? 'var(--gray-50)' : 'white',
        border: '1px solid var(--gray-100)',
        opacity: isArchived ? 0.7 : 1,
        cursor: 'pointer', marginBottom: 5,
        transition: 'background 0.1s, box-shadow 0.1s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--gray-50)'; e.currentTarget.style.boxShadow = '0 1px 4px rgba(0,0,0,0.06)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = isArchived ? 'var(--gray-50)' : 'white'; e.currentTarget.style.boxShadow = 'none'; }}
    >
      {/* Row 1: name · age/sex · rhythm · next appt · badge · arrow */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <div style={{
          fontWeight: 700, fontSize: '0.9rem',
          color: isArchived ? 'var(--gray-500)' : 'var(--navy)',
          flexShrink: 0, minWidth: 170,
        }}>
          {client.last_name}, {client.first_name}
        </div>

        {(age !== null || client.sex) && (
          <div style={{ fontSize: '0.72rem', color: 'var(--gray-400)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {[age !== null ? `${age}y` : null, client.sex].filter(Boolean).join(' · ')}
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          {rhythmStr && (
            <span style={{ fontSize: '0.75rem', color: 'var(--gray-500)', whiteSpace: 'nowrap' }}>
              {rhythmStr}
            </span>
          )}
        </div>

        {nextAppt && (
          <div style={{ fontSize: '0.72rem', color: 'var(--gray-500)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            Next: <strong>{fmtDateShort(nextAppt.date)}</strong>
          </div>
        )}

        {isArchived ? (
          <span style={{ background: 'var(--gray-200)', color: 'var(--gray-500)', borderRadius: 4, padding: '2px 7px', fontSize: '0.68rem', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>
            Archived
          </span>
        ) : (
          <span style={{ background: badge.bg, color: badge.color, borderRadius: 4, padding: '2px 7px', fontSize: '0.68rem', fontWeight: 700, whiteSpace: 'nowrap', letterSpacing: '0.02em', flexShrink: 0 }}>
            {badge.label}
          </span>
        )}

        <span style={{ color: 'var(--gray-300)', fontSize: '0.8rem', flexShrink: 0 }}>›</span>
      </div>

      {/* Row 2: contact + referral badge */}
      {(contactLine || client.referral?.name) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {contactLine && (
            <div style={{ fontSize: '0.72rem', color: 'var(--gray-400)' }}>{contactLine}</div>
          )}
          {client.referral?.name && (
            <span style={{ fontSize: '0.65rem', fontWeight: 600, background: 'var(--navy)', color: 'rgba(255,255,255,0.85)', borderRadius: 3, padding: '1px 6px', flexShrink: 0 }}>
              {client.referral.name}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Day Section ────────────────────────────────────────────────────────────────

function DaySection({ title, clients, nextApptMap, scheduleMaps, style, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const isMuted = !!style.muted;
  const { dayMap, timeMap, durMap } = scheduleMaps;

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
        <span style={{ fontWeight: 700, fontSize: '0.88rem', color: isMuted ? 'var(--gray-700)' : '#fff', flex: 1 }}>
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
          padding: '8px 8px 4px', background: 'white',
          border: '1px solid var(--gray-100)', borderTop: 'none',
          borderRadius: '0 0 8px 8px',
        }}>
          {clients.length === 0 ? (
            <div style={{ fontSize: '0.78rem', color: 'var(--gray-300)', padding: '8px 6px' }}>No clients</div>
          ) : clients.map(c => (
            <ClientCard
              key={c.id}
              client={c}
              nextAppt={nextApptMap[c.id] || null}
              scheduleDay={dayMap[c.id] ?? null}
              scheduleTime={timeMap[c.id] || null}
              scheduleDur={durMap[c.id] || 45}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function OOClientsPage() {
  const [clients,      setClients]      = useState([]);
  const [nextApptMap,  setNextApptMap]  = useState({});
  const [scheduleMaps, setScheduleMaps] = useState({ dayMap: {}, timeMap: {}, durMap: {} });
  const [sources,      setSources]      = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState('');
  const [activeFilter, setActiveFilter] = useState('all');

  const [showModal,  setShowModal]  = useState(false);
  const [editClient, setEditClient] = useState(null);
  const [form,       setForm]       = useState(EMPTY_FORM);
  const [saving,     setSaving]     = useState(false);

  const [showImport,   setShowImport]   = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importing,    setImporting]    = useState(false);
  const fileRef = useRef();

  const [showArchived, setShowArchived] = useState(false);

  const [showInSyncSettings, setShowInSyncSettings] = useState(false);
  const [inSyncUser,  setInSyncUser]  = useState('');
  const [inSyncPass,  setInSyncPass]  = useState('');
  const [syncing,     setSyncing]     = useState(false);
  const [syncResult,  setSyncResult]  = useState(null);

  const [showAssign,     setShowAssign]     = useState(false);
  const [assignSourceId, setAssignSourceId] = useState('');
  const [assignPaste,    setAssignPaste]    = useState('');
  const [assignPreview,  setAssignPreview]  = useState(null);
  const [assignLoading,  setAssignLoading]  = useState(false);

  useEffect(() => { loadAll(false); }, []);

  async function loadAll(withArchived = false) {
    setLoading(true);
    try {
      const today = new Date().toISOString().split('T')[0];
      const [clientsData, sourcesData, apptData] = await Promise.all([
        api.get(withArchived ? '/oo/clients?show_archived=true' : '/oo/clients'),
        api.get('/oo/clients/referral-sources'),
        api.get(`/oo/appointments?week_start=${today}`),
      ]);
      setClients(clientsData);
      setSources(sourcesData);

      const appts = Array.isArray(apptData) ? apptData : [];

      // nextApptMap: earliest future scheduled appointment per client
      const upcoming = appts.filter(a => a.status === 'scheduled');
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
      setScheduleMaps(buildScheduleMaps(appts));
    } finally {
      setLoading(false);
    }
  }

  // ── Handlers ─────────────────────────────────────────────────────────────────

  function openAdd() { setEditClient(null); setForm(EMPTY_FORM); setShowModal(true); }

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
    } finally { setSaving(false); }
  }

  async function handleToggleArchived() {
    const next = !showArchived;
    setShowArchived(next);
    await loadAll(next);
  }

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
      await loadAll(showArchived);
    } catch (err) { setSyncResult({ error: err.message }); }
    finally { setSyncing(false); }
  }

  async function handleAssignPreview() {
    if (!assignSourceId || !assignPaste.trim()) return;
    setAssignLoading(true); setAssignPreview(null);
    try {
      setAssignPreview(await api.post('/oo/clients/assign-referral', {
        referral_source_id: assignSourceId, paste_text: assignPaste,
      }));
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
      await loadAll(showArchived);
      setShowAssign(false); setAssignPaste(''); setAssignPreview(null); setAssignSourceId('');
    } finally { setAssignLoading(false); }
  }

  async function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    setImporting(true); setImportResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const result = await api.postForm('/oo/clients/import/insync', fd);
      setImportResult(result);
      await loadAll(showArchived);
    } catch (err) { setImportResult({ error: err.message }); }
    finally { setImporting(false); fileRef.current.value = ''; }
  }

  // ── Summary stats ─────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const active = clients.filter(c => c.status === 'active');
    return {
      active:    active.length,
      scheduled: active.filter(c =>  nextApptMap[c.id]).length,
      noAppt:    active.filter(c => !nextApptMap[c.id]).length,
      noPhone:   active.filter(c => !c.phone && !c.mobile && !c.mother_phone && !c.father_phone).length,
      noInsync:  active.filter(c => !c.insync_patient_id).length,
      problems:  active.filter(c =>  computeStatus(c, nextApptMap[c.id]) === 'problem').length,
    };
  }, [clients, nextApptMap]);

  // ── Filter + search ───────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    let list = clients.filter(c => c.status === 'archived' ? showArchived : true);

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(c =>
        (c.first_name || '').toLowerCase().includes(q) ||
        (c.last_name  || '').toLowerCase().includes(q) ||
        (c.mrn        || '').toLowerCase().includes(q) ||
        (c.referral?.name || '').toLowerCase().includes(q)
      );
    }

    if (activeFilter !== 'all') {
      list = list.filter(c => {
        if (c.status === 'archived') return false;
        const st = computeStatus(c, nextApptMap[c.id]);
        if (activeFilter === 'active')      return c.status === 'active';
        if (activeFilter === 'inactive')    return c.status === 'inactive';
        if (activeFilter === 'no_appt')     return c.status === 'active' && !nextApptMap[c.id];
        if (activeFilter === 'no_phone')    return !c.phone && !c.mobile && !c.mother_phone && !c.father_phone;
        if (activeFilter === 'no_insync')   return !c.insync_patient_id;
        if (activeFilter === 'no_referral') return !c.referral?.notes_email;
        if (activeFilter === 'problems')    return st === 'problem';
        return true;
      });
    }

    return [...list].sort((a, b) => (a.last_name || '').localeCompare(b.last_name || ''));
  }, [clients, search, activeFilter, nextApptMap, showArchived]);

  // ── Grouping ──────────────────────────────────────────────────────────────────

  const { archivedClients, groups } = useMemo(() => {
    const archived = filtered.filter(c => c.status === 'archived');
    const main     = filtered.filter(c => c.status !== 'archived');
    const grps     = { noSchedule: [], 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] };
    for (const c of main) {
      const dow = scheduleMaps.dayMap[c.id];
      if (dow != null && grps[dow] !== undefined) {
        grps[dow].push(c);
      } else {
        grps.noSchedule.push(c);
      }
    }
    return { archivedClients: archived, groups: grps };
  }, [filtered, scheduleMaps]);

  const activeDays = [0, 1, 2, 3, 4, 5].filter(d => groups[d].length > 0);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '24px 32px' }}>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--navy)', margin: 0 }}>Clients</h2>
        <input
          className="input"
          placeholder="Search name, MRN, referral…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: 240, fontSize: '0.85rem' }}
        />
        <div style={{ flex: 1 }} />
        <button className="btn btn-sm btn-outline" onClick={handleToggleArchived}
          style={showArchived ? { background: 'var(--gray-600)', borderColor: 'var(--gray-600)', color: 'white' } : {}}>
          {showArchived ? 'Showing Archived' : 'Show Archived'}
        </button>
        <button className="btn btn-outline btn-sm" onClick={handleSync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync InSync'}
        </button>
        <button className="btn btn-outline btn-sm" onClick={() => setShowInSyncSettings(s => !s)} title="Configure InSync credentials">⚙</button>
        <button className="btn btn-outline btn-sm" onClick={() => setShowImport(s => !s)}>Import</button>
        <button className="btn btn-outline btn-sm" onClick={() => { setShowAssign(s => !s); setAssignPreview(null); }}>Assign Source</button>
        <button className="btn btn-primary btn-sm" onClick={openAdd}>+ Add Client</button>
      </div>

      {/* InSync credentials panel */}
      {showInSyncSettings && (
        <div style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 8, padding: '14px 20px', marginBottom: 14, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 200px' }}>
            <label style={labelSt}>InSync Username</label>
            <input className="input" value={inSyncUser} onChange={e => setInSyncUser(e.target.value)} style={{ fontSize: '0.85rem' }} autoComplete="off" />
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
          marginBottom: 14, padding: '10px 16px', borderRadius: 8, fontSize: '0.82rem',
          background: syncResult.error ? '#fef2f2' : '#f0fdf4',
          border: `1px solid ${syncResult.error ? '#fca5a5' : '#86efac'}`,
          color: syncResult.error ? '#dc2626' : '#166534',
        }}>
          {syncResult.error
            ? `Error: ${syncResult.error}`
            : `Sync complete — ${syncResult.created} created, ${syncResult.updated} updated${syncResult.skipped > 0 ? `, ${syncResult.skipped} skipped` : ''} (${syncResult.total} total)`}
        </div>
      )}

      {/* Import panel */}
      {showImport && (
        <div style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 8, padding: '14px 20px', marginBottom: 14, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--gray-600)', marginBottom: 4 }}>Upload InSync Excel export</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>Matches on First Name + Last Name + DOB. New clients created; existing ones updated.</div>
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
        <div style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 8, padding: '16px 20px', marginBottom: 14 }}>
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
                rows={5}
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
                Parsed {assignPreview.total} entr{assignPreview.total === 1 ? 'y' : 'ies'}:
                {assignPreview.parsed?.map((c, i) => (
                  <span key={i} style={{ marginLeft: 8, color: 'var(--gray-500)' }}>
                    {c.first_name} {c.last_name}{c.dob ? ` (${fmtDob(c.dob)})` : ''}
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                {assignPreview.matched.length > 0 && (
                  <div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#166534', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Matched ({assignPreview.matched.length})</div>
                    {assignPreview.matched.map((c, i) => (
                      <div key={i} style={{ fontSize: '0.8rem', color: '#166534', padding: '2px 0' }}>✓ {c.first_name} {c.last_name}{c.dob ? ` · ${fmtDob(c.dob)}` : ''}</div>
                    ))}
                  </div>
                )}
                {assignPreview.unmatched.length > 0 && (
                  <div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Not found ({assignPreview.unmatched.length})</div>
                    {assignPreview.unmatched.map((c, i) => (
                      <div key={i} style={{ fontSize: '0.8rem', color: '#92400e', padding: '2px 0' }}>✗ {c.first_name} {c.last_name}{c.dob ? ` · ${fmtDob(c.dob)}` : ''}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          {assignPreview?.error && <div style={{ marginTop: 10, fontSize: '0.8rem', color: '#dc2626' }}>{assignPreview.error}</div>}
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--gray-400)', fontSize: '0.85rem' }}>Loading…</div>
      ) : (
        <>
          {/* Summary stat cards */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            {[
              { label: 'Active',         value: stats.active,    color: 'var(--navy)', filter: 'active' },
              { label: 'Scheduled',      value: stats.scheduled, color: '#166534',     filter: null },
              { label: 'No Future Appt', value: stats.noAppt,    color: '#92400e',     filter: 'no_appt',  warn: stats.noAppt > 0 },
              { label: 'Missing Phone',  value: stats.noPhone,   color: '#c2410c',     filter: 'no_phone', warn: stats.noPhone > 0 },
              { label: 'Missing InSync', value: stats.noInsync,  color: '#1d4ed8',     filter: 'no_insync' },
              { label: '⚠ Problems',     value: stats.problems,  color: '#dc2626',     filter: 'problems', warn: stats.problems > 0 },
            ].map(({ label, value, color, filter, warn }) => (
              <div
                key={label}
                onClick={() => filter && setActiveFilter(f => f === filter ? 'all' : filter)}
                style={{
                  flex: '1 1 100px',
                  background: 'white',
                  border: `1px solid ${warn && value > 0 ? '#fca5a5' : 'var(--gray-100)'}`,
                  borderRadius: 8, padding: '10px 14px', textAlign: 'center',
                  cursor: filter ? 'pointer' : 'default',
                  boxShadow: activeFilter === filter && filter ? '0 0 0 2px var(--navy)' : 'none',
                  transition: 'box-shadow 0.12s',
                }}
              >
                <div style={{ fontSize: '1.7rem', fontWeight: 700, color, lineHeight: 1, fontFamily: "'DM Serif Display', Georgia, serif" }}>{value}</div>
                <div style={{ fontSize: '0.62rem', fontWeight: 600, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 3 }}>{label}</div>
              </div>
            ))}
          </div>

          {/* Filter pills */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
            {FILTERS.map(f => (
              <button
                key={f.key}
                onClick={() => setActiveFilter(f.key)}
                style={{
                  padding: '4px 12px', fontSize: '0.75rem',
                  fontWeight: activeFilter === f.key ? 700 : 500,
                  borderRadius: 20, border: '1px solid',
                  borderColor: activeFilter === f.key ? 'var(--navy)' : 'var(--gray-200)',
                  background: activeFilter === f.key ? 'var(--navy)' : 'white',
                  color: activeFilter === f.key ? 'white' : 'var(--gray-600)',
                  cursor: 'pointer', transition: 'all 0.12s',
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Roster */}
          {filtered.length === 0 ? (
            <div style={{ color: 'var(--gray-400)', fontSize: '0.85rem', padding: '20px 0' }}>
              {search ? 'No matches.' : activeFilter !== 'all' ? 'No clients match this filter.' : 'No clients yet. Add one or import from InSync.'}
            </div>
          ) : (
            <>
              {activeDays.map(dow => (
                <DaySection
                  key={dow}
                  title={DAY_NAMES[dow] + 's'}
                  clients={groups[dow]}
                  nextApptMap={nextApptMap}
                  scheduleMaps={scheduleMaps}
                  style={DAY_STYLES[dow]}
                  defaultOpen
                />
              ))}

              {groups.noSchedule.length > 0 && (
                <DaySection
                  title="No Schedule / Needs Setup"
                  clients={groups.noSchedule}
                  nextApptMap={nextApptMap}
                  scheduleMaps={scheduleMaps}
                  style={NEEDS_SETUP_STYLE}
                  defaultOpen
                />
              )}

              {showArchived && archivedClients.length > 0 && (
                <DaySection
                  title="Archived"
                  clients={archivedClients}
                  nextApptMap={nextApptMap}
                  scheduleMaps={scheduleMaps}
                  style={{ dot: 'var(--gray-300)', muted: true }}
                  defaultOpen
                />
              )}
            </>
          )}
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
                      <input className="input" type={type} value={form[key]}
                        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                        style={{ fontSize: '0.85rem' }} />
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
              <button type="submit" form="add-client-form" className="btn btn-primary btn-sm" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
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

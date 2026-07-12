import { useState, useEffect, useRef } from 'react';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import supabase from '../supabaseClient';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, mo, d] = iso.split('-');
  return `${mo}/${d}/${y}`;
}

function fmtTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

const blankCohort = { name: '', day_of_week: '1', time: '10:00' };

// ── Tab navigator ─────────────────────────────────────────────────────────────

function TabBar({ tab, setTab, isAdmin }) {
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 28, borderBottom: '2px solid var(--gray-200)', paddingBottom: 0 }}>
      {[['schedule', 'Schedule'], ...(isAdmin ? [['cosign', 'Co-Sign Review']] : [])].map(([key, label]) => (
        <button key={key} onClick={() => setTab(key)} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '8px 18px', fontSize: '0.9rem', fontWeight: tab === key ? 700 : 500,
          color: tab === key ? 'var(--navy)' : 'var(--gray-500)',
          borderBottom: tab === key ? '2px solid var(--navy)' : '2px solid transparent',
          marginBottom: -2, transition: 'color .15s',
        }}>{label}</button>
      ))}
    </div>
  );
}

// ── Schedule tab (existing) ───────────────────────────────────────────────────

function ScheduleTab() {
  const [cohorts,  setCohorts]  = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showAdd,   setShowAdd]   = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form,      setForm]      = useState(blankCohort);
  const [saving,    setSaving]    = useState(false);
  const [genOpen,  setGenOpen]  = useState({});
  const [genForm,  setGenForm]  = useState({});
  const [genBusy,  setGenBusy]  = useState({});

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const [c, s] = await Promise.all([
      api.get('/ps/cohorts').catch(() => []),
      api.get('/ps/sessions').catch(() => []),
    ]);
    setCohorts(Array.isArray(c) ? c : []);
    setSessions(Array.isArray(s) ? s : []);
    setLoading(false);
  }

  function openAdd() { setForm(blankCohort); setEditingId(null); setShowAdd(true); }
  function openEdit(c) { setForm({ name: c.name, day_of_week: String(c.day_of_week), time: c.time.slice(0, 5) }); setEditingId(c.id); setShowAdd(true); }

  async function saveCohort() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      if (editingId) {
        const updated = await api.put(`/ps/cohorts/${editingId}`, form);
        setCohorts(cs => cs.map(c => c.id === editingId ? updated : c));
      } else {
        const created = await api.post('/ps/cohorts', form);
        setCohorts(cs => [...cs, created]);
      }
      setShowAdd(false);
    } catch (ex) { alert(ex.message); }
    finally { setSaving(false); }
  }

  async function deleteCohort(id) {
    if (!window.confirm('Delete this cohort and all its sessions?')) return;
    await api.delete(`/ps/cohorts/${id}`);
    setCohorts(cs => cs.filter(c => c.id !== id));
    setSessions(ss => ss.filter(s => s.cohort_id !== id));
  }

  function toggleGen(id) {
    setGenOpen(o => ({ ...o, [id]: !o[id] }));
    setGenForm(f => ({ ...f, [id]: f[id] || { start_date: '', occurrences: '10' } }));
  }

  async function generate(cohortId) {
    const { start_date, occurrences } = genForm[cohortId] || {};
    if (!start_date || !occurrences) return;
    setGenBusy(b => ({ ...b, [cohortId]: true }));
    try {
      await api.post(`/ps/cohorts/${cohortId}/generate`, { start_date, occurrences: parseInt(occurrences) });
      const s = await api.get('/ps/sessions').catch(() => []);
      setSessions(Array.isArray(s) ? s : []);
      setGenOpen(o => ({ ...o, [cohortId]: false }));
    } catch (ex) { alert(ex.message); }
    finally { setGenBusy(b => ({ ...b, [cohortId]: false })); }
  }

  async function toggleStatus(sess) {
    const next = sess.status === 'completed' ? 'scheduled' : 'completed';
    const updated = await api.patch(`/ps/sessions/${sess.id}`, { status: next });
    setSessions(ss => ss.map(s => s.id === sess.id ? updated : s));
  }

  async function deleteSession(id) {
    await api.delete(`/ps/sessions/${id}`);
    setSessions(ss => ss.filter(s => s.id !== id));
  }

  const today    = new Date().toISOString().split('T')[0];
  const upcoming = sessions.filter(s => s.date >= today);
  const past     = sessions.filter(s => s.date <  today);

  if (loading) return <div style={{ padding: 32, color: 'var(--gray-400)' }}>Loading…</div>;

  return (
    <div>
      {/* Cohorts */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: 'var(--navy)' }}>Peer Supervision Cohorts</h2>
        <button className="btn btn-gold btn-sm" onClick={openAdd}>+ Add Cohort</button>
      </div>

      {showAdd && (
        <div style={{ background: '#f8fafc', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: '16px 20px', marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={lbl}>Name</label>
            <input className="form-input" style={{ width: 140 }} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Cohort A" autoFocus />
          </div>
          <div>
            <label style={lbl}>Day</label>
            <select className="form-input" style={{ width: 130 }} value={form.day_of_week} onChange={e => setForm(f => ({ ...f, day_of_week: e.target.value }))}>
              {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </div>
          <div>
            <label style={lbl}>Time</label>
            <input type="time" className="form-input" style={{ width: 120 }} value={form.time} onChange={e => setForm(f => ({ ...f, time: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-gold btn-sm" onClick={saveCohort} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            <button className="btn btn-outline btn-sm" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </div>
      )}

      {cohorts.length === 0 && !showAdd && (
        <p style={{ color: 'var(--gray-400)', fontSize: '0.88rem' }}>No cohorts yet. Add one above.</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 32 }}>
        {cohorts.map(c => (
          <div key={c.id} style={{ background: 'white', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: '14px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '0.95rem' }}>{c.name}</span>
                <span style={{ marginLeft: 12, fontSize: '0.82rem', color: 'var(--gray-500)' }}>
                  {DAYS[c.day_of_week]}s · {fmt12(c.time)} · 30 min · every other week
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-outline btn-xs" onClick={() => toggleGen(c.id)}>
                  {genOpen[c.id] ? 'Cancel' : 'Generate Sessions'}
                </button>
                <button className="btn btn-outline btn-xs" onClick={() => openEdit(c)}>Edit</button>
                <button className="btn btn-danger btn-xs" onClick={() => deleteCohort(c.id)}>Delete</button>
              </div>
            </div>
            {genOpen[c.id] && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--gray-100)', display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div>
                  <label style={lbl}>Start date</label>
                  <input type="date" className="form-input" style={{ width: 150 }}
                    value={genForm[c.id]?.start_date || ''}
                    onChange={e => setGenForm(f => ({ ...f, [c.id]: { ...f[c.id], start_date: e.target.value } }))} />
                </div>
                <div>
                  <label style={lbl}>Occurrences</label>
                  <input type="number" className="form-input" style={{ width: 80 }} min={1} max={52}
                    value={genForm[c.id]?.occurrences || '10'}
                    onChange={e => setGenForm(f => ({ ...f, [c.id]: { ...f[c.id], occurrences: e.target.value } }))} />
                </div>
                <button className="btn btn-gold btn-sm" onClick={() => generate(c.id)} disabled={genBusy[c.id]}>
                  {genBusy[c.id] ? 'Generating…' : 'Generate'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Sessions */}
      <h2 style={{ margin: '0 0 14px', fontSize: '1.15rem', fontWeight: 700, color: 'var(--navy)' }}>Schedule</h2>
      {sessions.length === 0 && (
        <p style={{ color: 'var(--gray-400)', fontSize: '0.88rem' }}>No sessions yet. Generate sessions from a cohort above.</p>
      )}
      {upcoming.length > 0 && <SessionTable label="Upcoming" rows={upcoming} onToggle={toggleStatus} onDelete={deleteSession} />}
      {past.length     > 0 && <SessionTable label="Past"     rows={past}     onToggle={toggleStatus} onDelete={deleteSession} dimmed />}
    </div>
  );
}

function SessionTable({ label, rows, onToggle, onDelete, dimmed }) {
  const [open, setOpen] = useState(label === 'Upcoming');
  return (
    <div style={{ marginBottom: 24 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 8,
        fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
        color: 'var(--gray-400)', display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {open ? '▾' : '▸'} {label} ({rows.length})
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map(s => {
            const done = s.status === 'completed';
            return (
              <div key={s.id} style={{
                background: 'white', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
                padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 14,
                opacity: dimmed && !done ? 0.6 : 1,
              }}>
                <div style={{ minWidth: 90, fontWeight: 600, fontSize: '0.85rem', color: done ? 'var(--gray-400)' : 'var(--navy)', textDecoration: done ? 'line-through' : 'none' }}>
                  {fmtDate(s.date)}
                </div>
                <div style={{ flex: 1, fontSize: '0.82rem', color: 'var(--gray-600)' }}>
                  {s.cohort?.name} · {DAYS[s.cohort?.day_of_week]} · {fmt12(s.cohort?.time)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.8rem', color: 'var(--gray-700)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={done} onChange={() => onToggle(s)}
                      style={{ width: 15, height: 15, accentColor: 'var(--navy)' }} />
                    Done
                  </label>
                  <button className="btn btn-danger btn-xs" onClick={() => onDelete(s.id)}>✕</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Co-Sign tab ───────────────────────────────────────────────────────────────

function CoSignTab() {
  const [scanning,     setScanning]     = useState(false);
  const [progressMsg,  setProgressMsg]  = useState('');
  const [progressPct,  setProgressPct]  = useState(0);
  const [scanResult,   setScanResult]   = useState(null);  // { flagged, clean, runId }
  const [signedEids,   setSignedEids]   = useState(new Set());
  const [selectedEids, setSelectedEids] = useState(new Set());
  const [signingEids,  setSigningEids]  = useState(new Set());
  const [viewNote,     setViewNote]     = useState(null);
  const [history,      setHistory]      = useState([]);
  const [histOpen,     setHistOpen]     = useState(false);
  const [histLoading,  setHistLoading]  = useState(false);
  const [settings,     setSettings]     = useState(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const esRef = useRef(null);

  useEffect(() => { loadSettings(); }, []);

  async function loadSettings() {
    try { setSettings(await api.get('/ps/cosign/settings')); }
    catch {}
  }

  async function saveSettings(e) {
    e.preventDefault();
    setSavingSettings(true);
    try {
      await api.post('/ps/cosign/settings', settings);
      alert('Settings saved.');
    } catch (ex) { alert(ex.message); }
    finally { setSavingSettings(false); }
  }

  async function runNow() {
    if (scanning) return;
    setScanning(true);
    setProgressMsg('Starting scan…');
    setProgressPct(0);
    setScanResult(null);
    setSignedEids(new Set());
    setSelectedEids(new Set());

    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token || '';
    const API = process.env.REACT_APP_API_URL || 'http://localhost:4000';
    const es = new EventSource(`${API}/api/ps/cosign/scan?token=${encodeURIComponent(token)}`);
    esRef.current = es;

    es.onmessage = e => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'progress') { setProgressMsg(data.msg); setProgressPct(data.pct); }
        else if (data.type === 'done') {
          setScanResult({ flagged: data.flagged, clean: data.clean, runId: data.runId });
          setScanning(false);
          es.close();
        } else if (data.type === 'error') {
          alert('Scan error: ' + data.message);
          setScanning(false);
          es.close();
        }
      } catch {}
    };
    es.onerror = () => {
      if (scanning) { alert('Scan connection lost.'); setScanning(false); }
      es.close();
    };
  }

  async function signNotes(notes, delta = 0) {
    if (!notes?.length || !scanResult) return { signed: 0, failed: 0 };
    const r = await api.post('/ps/cosign/sign', { notes, runId: scanResult.runId, delta });
    return r;
  }

  async function handleSignAll() {
    if (!scanResult?.clean?.length) return;
    const toSign = scanResult.clean.filter(n => !signedEids.has(n.eid));
    if (!toSign.length) return;
    const eids = new Set(toSign.map(n => n.eid));
    setSigningEids(prev => new Set([...prev, ...eids]));
    try {
      const { signed, failed } = await signNotes(toSign);
      if (signed > 0) setSignedEids(prev => new Set([...prev, ...eids]));
      if (failed > 0) alert(`${failed} note(s) failed to sign. Try again.`);
    } catch (ex) { alert(ex.message); }
    finally { setSigningEids(prev => { const n = new Set(prev); eids.forEach(e => n.delete(e)); return n; }); }
  }

  async function handleSignSelected() {
    if (!selectedEids.size || !scanResult) return;
    const toSign = scanResult.flagged.filter(n => selectedEids.has(n.eid) && !signedEids.has(n.eid));
    if (!toSign.length) return;
    const eids = new Set(toSign.map(n => n.eid));
    setSigningEids(prev => new Set([...prev, ...eids]));
    try {
      const alreadySigned = [...signedEids].filter(e => scanResult.clean.some(n => n.eid === e)).length;
      const { signed, failed } = await signNotes(toSign, alreadySigned);
      if (signed > 0) { setSignedEids(prev => new Set([...prev, ...eids])); setSelectedEids(new Set()); }
      if (failed > 0) alert(`${failed} note(s) failed. Try again.`);
    } catch (ex) { alert(ex.message); }
    finally { setSigningEids(prev => { const n = new Set(prev); eids.forEach(e => n.delete(e)); return n; }); }
  }

  async function handleSignOne(note) {
    const eids = new Set([note.eid]);
    setSigningEids(prev => new Set([...prev, ...eids]));
    try {
      const alreadySigned = signedEids.size;
      const { signed, failed } = await signNotes([note], alreadySigned);
      if (signed > 0) setSignedEids(prev => new Set([...prev, note.eid]));
      if (failed > 0) alert('Sign failed. Try again.');
    } catch (ex) { alert(ex.message); }
    finally { setSigningEids(prev => { const n = new Set(prev); n.delete(note.eid); return n; }); }
  }

  function toggleSelect(eid) {
    setSelectedEids(prev => {
      const n = new Set(prev);
      if (n.has(eid)) n.delete(eid); else n.add(eid);
      return n;
    });
  }

  function toggleSelectAll(flaggedVisible) {
    const unsignedEids = flaggedVisible.filter(n => !signedEids.has(n.eid)).map(n => n.eid);
    if (unsignedEids.every(e => selectedEids.has(e))) setSelectedEids(new Set());
    else setSelectedEids(new Set(unsignedEids));
  }

  async function loadHistory() {
    setHistLoading(true);
    try { setHistory(await api.get('/ps/cosign/history')); }
    catch {}
    finally { setHistLoading(false); }
  }

  function toggleHistory() {
    if (!histOpen && !history.length) loadHistory();
    setHistOpen(o => !o);
  }

  // Derived
  const cleanCount   = scanResult ? scanResult.clean.filter(n => !signedEids.has(n.eid)).length : 0;
  const flaggedVisible = scanResult ? scanResult.flagged.filter(n => !signedEids.has(n.eid)) : [];
  const signedCount  = signedEids.size;
  const totalCount   = scanResult ? scanResult.flagged.length + scanResult.clean.length : null;

  return (
    <div>
      {/* Settings strip */}
      {settings && (
        <form onSubmit={saveSettings} style={{ background: '#f8fafc', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: '14px 18px', marginBottom: 20, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={lbl}>No-School Start (MM/DD)</label>
            <input className="form-input" style={{ width: 100 }} value={settings.no_school_start}
              onChange={e => setSettings(s => ({ ...s, no_school_start: e.target.value }))} placeholder="07/01" />
          </div>
          <div>
            <label style={lbl}>No-School End (MM/DD)</label>
            <input className="form-input" style={{ width: 100 }} value={settings.no_school_end}
              onChange={e => setSettings(s => ({ ...s, no_school_end: e.target.value }))} placeholder="08/31" />
          </div>
          <div>
            <label style={lbl}>Provider ID</label>
            <input className="form-input" style={{ width: 80 }} value={settings.provider_id}
              onChange={e => setSettings(s => ({ ...s, provider_id: e.target.value }))} placeholder="2317" />
          </div>
          <button type="submit" className="btn btn-outline btn-sm" disabled={savingSettings}>
            {savingSettings ? 'Saving…' : 'Save Settings'}
          </button>
        </form>
      )}

      {/* Run Now button */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20 }}>
        <button className="btn btn-gold" onClick={runNow} disabled={scanning} style={{ minWidth: 120 }}>
          {scanning ? 'Scanning…' : '▶  Run Now'}
        </button>
        {scanResult && !scanning && (
          <span style={{ fontSize: '0.82rem', color: 'var(--gray-500)' }}>
            Scan complete — {scanResult.flagged.length + scanResult.clean.length} notes found
          </span>
        )}
      </div>

      {/* Progress */}
      {scanning && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--navy)', marginBottom: 6 }}>{progressMsg}</div>
          <div style={{ height: 8, background: 'var(--gray-200)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progressPct}%`, background: 'var(--navy)', borderRadius: 4, transition: 'width 0.4s' }} />
          </div>
        </div>
      )}

      {/* Stats */}
      {scanResult && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            ['Total',   totalCount,                       'var(--gray-700)', '#f4f2fa'],
            ['Clean',   scanResult.clean.length,           '#059669',         '#ecfdf5'],
            ['Flagged', scanResult.flagged.length,         '#ea580c',         '#fff7ed'],
            ['Signed',  signedCount,                       'var(--navy)',     '#f0f4ff'],
          ].map(([label, val, color, bg]) => (
            <div key={label} style={{ background: bg, borderRadius: 12, padding: '12px 22px', minWidth: 90, textAlign: 'center' }}>
              <div style={{ fontSize: '1.6rem', fontWeight: 800, color }}>{val ?? '—'}</div>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Sign All Clean */}
      {scanResult && cleanCount > 0 && (
        <div style={{ marginBottom: 20 }}>
          <button
            className="btn btn-gold"
            onClick={handleSignAll}
            disabled={[...scanResult.clean].filter(n => !signedEids.has(n.eid)).some(n => signingEids.has(n.eid))}
            style={{ background: '#059669', color: 'white', borderColor: '#059669' }}
          >
            ✓  Sign All Clean ({cleanCount})
          </button>
        </div>
      )}
      {scanResult && cleanCount === 0 && scanResult.clean.length > 0 && (
        <div style={{ marginBottom: 20, fontSize: '0.85rem', color: '#059669', fontWeight: 600 }}>
          ✓ All clean notes signed
        </div>
      )}

      {/* Flagged notes */}
      {flaggedVisible.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#ea580c' }}>
              ⚑  {flaggedVisible.length} Flagged — review before signing
            </span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.82rem', color: 'var(--gray-600)', cursor: 'pointer', marginLeft: 'auto' }}>
              <input type="checkbox"
                checked={flaggedVisible.filter(n => !signedEids.has(n.eid)).length > 0 &&
                         flaggedVisible.filter(n => !signedEids.has(n.eid)).every(n => selectedEids.has(n.eid))}
                onChange={() => toggleSelectAll(flaggedVisible)}
              />
              Select all
            </label>
            {selectedEids.size > 0 && (
              <button
                className="btn btn-sm"
                onClick={handleSignSelected}
                disabled={[...selectedEids].some(e => signingEids.has(e))}
                style={{ background: '#059669', color: 'white', border: 'none', borderRadius: 8, padding: '5px 14px', fontSize: '0.82rem', fontWeight: 700, cursor: 'pointer' }}
              >
                ✓ Sign Selected ({selectedEids.size})
              </button>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {flaggedVisible.map(note => (
              <FlaggedNoteCard
                key={note.eid}
                note={note}
                selected={selectedEids.has(note.eid)}
                signing={signingEids.has(note.eid)}
                signed={signedEids.has(note.eid)}
                onToggleSelect={() => toggleSelect(note.eid)}
                onSign={() => handleSignOne(note)}
                onRead={() => setViewNote(note)}
              />
            ))}
          </div>
        </div>
      )}

      {scanResult && flaggedVisible.length === 0 && scanResult.flagged.length > 0 && (
        <div style={{ fontSize: '0.85rem', color: '#059669', fontWeight: 600, marginBottom: 20 }}>
          ✓ All flagged notes signed
        </div>
      )}

      {scanResult && scanResult.flagged.length === 0 && scanResult.clean.length > 0 && (
        <div style={{ fontSize: '0.85rem', color: '#059669', fontWeight: 600, marginBottom: 20 }}>
          ✓ All notes are clean — no flags
        </div>
      )}

      {/* History */}
      <div style={{ marginTop: 12 }}>
        <button onClick={toggleHistory} style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 12,
          fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
          color: 'var(--gray-400)', display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {histOpen ? '▾' : '▸'} Run History
        </button>
        {histOpen && (
          histLoading ? <div style={{ color: 'var(--gray-400)', fontSize: '0.85rem' }}>Loading…</div> :
          history.length === 0 ? <div style={{ color: 'var(--gray-400)', fontSize: '0.85rem' }}>No runs yet.</div> :
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {history.map(run => <HistoryCard key={run.id} run={run} />)}
          </div>
        )}
      </div>

      {/* Read modal */}
      {viewNote && <NoteModal note={viewNote} onClose={() => setViewNote(null)} onSign={() => { handleSignOne(viewNote); setViewNote(null); }} />}
    </div>
  );
}

function FlaggedNoteCard({ note, selected, signing, signed, onToggleSelect, onSign, onRead }) {
  if (signed) return null;
  return (
    <div style={{
      background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10,
      padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start',
    }}>
      <input type="checkbox" checked={selected} onChange={onToggleSelect}
        style={{ marginTop: 3, cursor: 'pointer', width: 15, height: 15, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
          <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--navy)' }}>{note.patientName || '(unknown)'}</span>
          <span style={{ fontSize: '0.8rem', color: 'var(--gray-500)' }}>
            {[note.visitDate, note.startTimeStr && `${note.startTimeStr}–${note.endTimeStr}`, note.totalTime].filter(Boolean).join(' · ')}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(note.flags || []).map((f, i) => (
            <div key={i} style={{ fontSize: '0.8rem', color: '#ea580c', background: 'white', borderRadius: 6, padding: '4px 10px', fontWeight: 600 }}>
              ⚑ {f}
            </div>
          ))}
          {note.aiFlag && (
            <div style={{ fontSize: '0.8rem', color: '#7c3aed', background: 'white', borderRadius: 6, padding: '4px 10px', fontWeight: 600 }}>
              ✦ AI: {note.aiFlag}
            </div>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button onClick={onRead} style={{
          background: 'white', border: '1.5px solid var(--gray-300)', borderRadius: 8,
          padding: '4px 12px', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer',
          color: 'var(--navy)',
        }}>Read</button>
        <button onClick={onSign} disabled={signing} style={{
          background: signing ? '#9ca3af' : '#059669', color: 'white', border: 'none',
          borderRadius: 8, padding: '4px 14px', fontSize: '0.8rem', fontWeight: 700,
          cursor: signing ? 'default' : 'pointer',
        }}>
          {signing ? 'Signing…' : '✓ Sign'}
        </button>
      </div>
    </div>
  );
}

function NoteModal({ note, onClose, onSign }) {
  const text = note.fullNoteText || '';

  // Light formatting: bold known section headers
  const sectionHeaders = [
    'Patient Details', 'Visit Details', 'Encounter Details',
    'Note of Session', 'Diagnosis', 'Plan / Visit Codes', 'Treatment Plan',
  ];
  const fieldLabels = [
    'Visit Date', 'Start Time', 'End Time', 'Total Time', 'Encounter Type', 'POS',
    'Persons Present', 'Location of the Meeting', 'Focus of the meeting',
    'What activities took place, and for how long', 'Peer Support Interventions',
    "Patient's Response/Content", 'Patient Response/Content', 'Plan',
    'Long Term Goal(s) 1', 'Long Term Goal(s) 2', 'Short Term Goal(s) 1', 'Short Term Goal(s) 2',
    'Electronically Signed', 'Provider NPI', 'Name', 'DOB', 'Age', 'MRN',
  ];

  let formatted = text;
  // Escape for display then inject formatting
  const lines = formatted.split(/\. (?=[A-Z])/);
  formatted = formatted;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: 'white', borderRadius: 12, width: '720px', maxWidth: '95vw',
        maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ background: 'var(--navy)', color: 'white', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: '1rem' }}>{note.patientName || '(unknown)'}</div>
            <div style={{ fontSize: '0.8rem', opacity: 0.8, marginTop: 2 }}>
              {[note.visitDate, note.startTimeStr && `${note.startTimeStr}–${note.endTimeStr}`, note.totalTime].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'white', fontSize: '1.3rem', cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>

        {/* Flags recap */}
        {((note.flags?.length || 0) > 0 || note.aiFlag) && (
          <div style={{ background: '#fff7ed', borderBottom: '1px solid #fed7aa', padding: '10px 20px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(note.flags || []).map((f, i) => (
              <div key={i} style={{ fontSize: '0.82rem', color: '#ea580c', fontWeight: 600 }}>⚑ {f}</div>
            ))}
            {note.aiFlag && <div style={{ fontSize: '0.82rem', color: '#7c3aed', fontWeight: 600 }}>✦ AI: {note.aiFlag}</div>}
          </div>
        )}

        {/* Note body */}
        <div style={{ flex: 1, overflow: 'auto', padding: '20px', fontFamily: 'Georgia, serif', fontSize: '0.88rem', lineHeight: 1.65, color: '#1e1b2e' }}>
          <NoteText text={text} sectionHeaders={sectionHeaders} fieldLabels={fieldLabels} />
        </div>

        {/* Footer */}
        <div style={{ borderTop: '1px solid var(--gray-200)', padding: '12px 20px', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} className="btn btn-outline btn-sm">Close</button>
          <button onClick={onSign} style={{
            background: '#059669', color: 'white', border: 'none',
            borderRadius: 8, padding: '7px 20px', fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer',
          }}>✓ Sign This Note</button>
        </div>
      </div>
    </div>
  );
}

function NoteText({ text, sectionHeaders, fieldLabels }) {
  if (!text) return <em style={{ color: 'var(--gray-400)' }}>(note text not available — re-run scan)</em>;

  let remaining = text;
  const parts   = [];
  let key       = 0;

  // Sort longest first so we match specifically
  const allMarkers = [
    ...sectionHeaders.map(h => ({ text: h, type: 'section' })),
    ...fieldLabels.map(l => ({ text: l, type: 'field' })),
  ].sort((a, b) => b.text.length - a.text.length);

  while (remaining.length > 0) {
    let earliest = remaining.length, bestMarker = null;
    for (const m of allMarkers) {
      const i = remaining.indexOf(m.text);
      if (i !== -1 && i < earliest) { earliest = i; bestMarker = m; }
    }
    if (!bestMarker) { parts.push(<span key={key++}>{remaining}</span>); break; }
    if (earliest > 0) parts.push(<span key={key++}>{remaining.slice(0, earliest)}</span>);
    if (bestMarker.type === 'section') {
      parts.push(
        <div key={key++} style={{ marginTop: 16, marginBottom: 4 }}>
          <strong style={{ display: 'block', background: 'var(--navy)', color: 'white', padding: '4px 10px', borderRadius: 4, fontSize: '0.82rem', letterSpacing: '0.03em' }}>
            {bestMarker.text}
          </strong>
        </div>
      );
    } else {
      parts.push(<strong key={key++} style={{ color: 'var(--navy)' }}>{bestMarker.text}</strong>);
    }
    remaining = remaining.slice(earliest + bestMarker.text.length);
  }

  return <div style={{ whiteSpace: 'pre-wrap' }}>{parts}</div>;
}

function HistoryCard({ run }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: 'white', border: '1px solid var(--gray-200)', borderRadius: 10, overflow: 'hidden' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', background: 'none', border: 'none', cursor: 'pointer',
        padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left',
      }}>
        <span style={{ fontSize: '0.82rem', color: 'var(--gray-400)' }}>{open ? '▾' : '▸'}</span>
        <span style={{ flex: 1, fontWeight: 600, fontSize: '0.88rem', color: 'var(--navy)' }}>{fmtTs(run.created_at)}</span>
        <Chip label={`${run.clean_count} clean`}   color="#059669" bg="#ecfdf5" />
        <Chip label={`${run.flagged_count} flagged`} color="#ea580c" bg="#fff7ed" />
        {run.signed_count != null && <Chip label={`${run.signed_count} signed`} color="var(--navy)" bg="#f0f4ff" />}
      </button>
      {open && (
        <div style={{ padding: '0 16px 14px', borderTop: '1px solid var(--gray-100)' }}>
          {(!run.flagged_notes || run.flagged_notes.length === 0)
            ? <div style={{ color: '#059669', fontSize: '0.82rem', fontWeight: 600, paddingTop: 10 }}>✓ All clean — nothing flagged</div>
            : (run.flagged_notes || []).map((n, i) => (
              <div key={i} style={{ paddingTop: 10 }}>
                <div style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--navy)' }}>{n.patientName || '(unknown)'}</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--gray-500)', marginBottom: 4 }}>
                  {[n.visitDate, n.startTimeStr && `${n.startTimeStr}–${n.endTimeStr}`, n.totalTime].filter(Boolean).join(' · ')}
                </div>
                {(n.flags || []).map((f, j) => <div key={j} style={{ fontSize: '0.78rem', color: '#ea580c', fontWeight: 600 }}>⚑ {f}</div>)}
                {n.aiFlag && <div style={{ fontSize: '0.78rem', color: '#7c3aed', fontWeight: 600 }}>✦ AI: {n.aiFlag}</div>}
              </div>
            ))
          }
        </div>
      )}
    </div>
  );
}

function Chip({ label, color, bg }) {
  return (
    <span style={{ background: bg, color, borderRadius: 20, padding: '3px 10px', fontSize: '0.75rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────

export default function PeerSupervisionPage() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState('schedule');

  return (
    <div style={{ padding: '24px 32px', maxWidth: 860, margin: '0 auto' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: '1.25rem', fontWeight: 700, color: 'var(--navy)' }}>
        Peer Supervision
      </h2>
      <TabBar tab={tab} setTab={setTab} isAdmin={isAdmin} />

      {tab === 'schedule' && <ScheduleTab />}
      {tab === 'cosign'   && isAdmin && <CoSignTab />}
    </div>
  );
}

const lbl = { display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 };

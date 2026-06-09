import { useState, useEffect, useRef } from 'react';
import { api } from '../utils/api';
import supabase from '../supabaseClient';

const API = process.env.REACT_APP_API_URL || 'http://localhost:4000';

async function exportPaymentsExcel(supervisor_id, supervisorName, start_date, end_date) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const params = new URLSearchParams({ supervisor_id });
  if (start_date) params.set('start_date', start_date);
  if (end_date)   params.set('end_date', end_date);
  const res = await fetch(`${API}/api/payments/export?${params}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || 'Export failed');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `payments_${supervisorName.replace(/\s+/g, '_')}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

async function parsePayStub(file) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API}/api/billing/parse-stub`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Parse failed');
  return json;
}

async function uploadPayReport(file, supervisor_id, start_date, end_date) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const form = new FormData();
  form.append('file', file);
  form.append('supervisor_id', supervisor_id);
  if (start_date) form.append('start_date', start_date);
  if (end_date)   form.append('end_date',   end_date);
  const res = await fetch(`${API}/api/payments/upload`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Upload failed');
  return json;
}

function GroupCombobox({ groups, value, onChange }) {
  const [query, setQuery] = useState('');
  const [open, setOpen]   = useState(false);
  const selected = groups.find(g => g.id === value);

  const filtered = query.trim()
    ? groups.filter(g =>
        (g.internal_name || '').toLowerCase().includes(query.toLowerCase()) ||
        (g.group_name    || '').toLowerCase().includes(query.toLowerCase())
      )
    : groups;

  const displayLabel = g =>
    g.internal_name + (g.group_name && g.group_name !== g.internal_name ? ` — ${g.group_name}` : '');

  return (
    <div style={{ position: 'relative', maxWidth: 300 }}>
      <input
        className="form-input"
        style={{ fontSize: '0.82rem' }}
        placeholder="Search groups…"
        value={open ? query : (selected ? displayLabel(selected) : '')}
        onChange={e => { setQuery(e.target.value); setOpen(true); onChange(''); }}
        onFocus={() => { setQuery(''); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
          background: 'white', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.12)', maxHeight: 220, overflowY: 'auto',
        }}>
          {filtered.length === 0
            ? <div style={{ padding: '8px 12px', fontSize: '0.8rem', color: 'var(--gray-400)' }}>No matches</div>
            : filtered.map(g => (
              <div key={g.id}
                onMouseDown={() => { onChange(g.id); setOpen(false); setQuery(''); }}
                style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '0.82rem',
                  background: value === g.id ? 'var(--gray-50)' : 'white' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--gray-50)'}
                onMouseLeave={e => e.currentTarget.style.background = value === g.id ? 'var(--gray-50)' : 'white'}
              >
                <span style={{ fontWeight: 600, color: 'var(--navy)' }}>{g.internal_name}</span>
                {g.group_name && g.group_name !== g.internal_name && (
                  <span style={{ color: 'var(--gray-400)', marginLeft: 6 }}>— {g.group_name}</span>
                )}
              </div>
            ))
          }
        </div>
      )}
    </div>
  );
}

function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${parseInt(m)}/${parseInt(day)}/${y}`;
}

function fmt12(t) {
  if (!t) return '—';
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// ── Pay Periods Tab ──────────────────────────────────────────────────────────

function PayPeriodsTab() {
  const [periods, setPeriods]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [editingId, setEditingId]     = useState(null);
  const [editForm, setEditForm]       = useState({});
  const [showAdd, setShowAdd]         = useState(false);
  const [addForm, setAddForm]         = useState({ start_date: '', end_date: '', gross_amount: '' });
  const [generating, setGenerating]   = useState(false);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try { setPeriods(await api.getPayPeriods()); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function handleGenerate() {
    if (!window.confirm('Auto-generate biweekly pay periods (18 months back, 6 months forward from Jan 6 2026)?\n\nExisting periods will not be overwritten.')) return;
    setGenerating(true);
    try {
      const r = await api.generatePayPeriods('2026-01-06');
      await load();
      alert(r.inserted > 0 ? `Generated ${r.inserted} new pay periods.` : 'All periods already exist — nothing new to add.');
    } catch (e) { setError(e.message); }
    finally { setGenerating(false); }
  }

  async function handleAdd(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.createPayPeriod({ ...addForm, gross_amount: addForm.gross_amount ? parseFloat(addForm.gross_amount) : null });
      setShowAdd(false);
      setAddForm({ start_date: '', end_date: '', gross_amount: '' });
      await load();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function handleSaveEdit(id) {
    setSaving(true);
    try {
      await api.updatePayPeriod(id, {
        ...editForm,
        gross_amount: editForm.gross_amount ? parseFloat(editForm.gross_amount) : null,
      });
      setEditingId(null);
      await load();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function handleDelete(id, label) {
    if (!window.confirm(`Delete period "${label}"?`)) return;
    try { await api.deletePayPeriod(id); await load(); }
    catch (e) { setError(e.message); }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-gold btn-sm" onClick={handleGenerate} disabled={generating}>
            {generating ? 'Generating…' : '⚡ Auto-generate Biweekly'}
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => setShowAdd(v => !v)}>+ Add Period</button>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      {showAdd && (
        <form onSubmit={handleAdd} style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: 16 }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: 10, color: 'var(--navy)' }}>New Pay Period</div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Start Date</label>
              <input className="form-input" type="date" required value={addForm.start_date} onChange={e => setAddForm(f => ({ ...f, start_date: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">End Date</label>
              <input className="form-input" type="date" required value={addForm.end_date} onChange={e => setAddForm(f => ({ ...f, end_date: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Gross Amount ($)</label>
              <input className="form-input" type="number" step="0.01" placeholder="e.g. 1650.00" value={addForm.gross_amount} onChange={e => setAddForm(f => ({ ...f, gross_amount: e.target.value }))} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-gold btn-sm" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Add'}</button>
            <button className="btn btn-outline btn-sm" type="button" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </form>
      )}

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--gray-200)', textAlign: 'left' }}>
                <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>Period</th>
                <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>Start</th>
                <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>End</th>
                <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>Gross Paid</th>
                <th style={{ padding: '8px 12px' }}></th>
              </tr>
            </thead>
            <tbody>
              {periods.map(p => editingId === p.id ? (
                <tr key={p.id} style={{ background: 'var(--gray-50)', borderBottom: '1px solid var(--gray-100)' }}>
                  <td style={{ padding: '6px 12px' }} colSpan={2}>
                    <input className="form-input" type="date" value={editForm.start_date || ''} onChange={e => setEditForm(f => ({ ...f, start_date: e.target.value }))} style={{ marginBottom: 4 }} />
                  </td>
                  <td style={{ padding: '6px 12px' }}>
                    <input className="form-input" type="date" value={editForm.end_date || ''} onChange={e => setEditForm(f => ({ ...f, end_date: e.target.value }))} />
                  </td>
                  <td style={{ padding: '6px 12px' }}>
                    <input className="form-input" type="number" step="0.01" value={editForm.gross_amount || ''} onChange={e => setEditForm(f => ({ ...f, gross_amount: e.target.value }))} placeholder="0.00" />
                  </td>
                  <td style={{ padding: '6px 12px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-gold btn-sm" onClick={() => handleSaveEdit(p.id)} disabled={saving}>{saving ? '…' : 'Save'}</button>
                      <button className="btn btn-outline btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--gray-100)' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 500, color: 'var(--navy)' }}>{p.label || `${fmtDate(p.start_date)} – ${fmtDate(p.end_date)}`}</td>
                  <td style={{ padding: '10px 12px', color: 'var(--gray-600)' }}>{fmtDate(p.start_date)}</td>
                  <td style={{ padding: '10px 12px', color: 'var(--gray-600)' }}>{fmtDate(p.end_date)}</td>
                  <td style={{ padding: '10px 12px', color: p.gross_amount ? 'var(--navy)' : 'var(--gray-400)', fontWeight: p.gross_amount ? 600 : 400 }}>
                    {p.gross_amount ? `$${parseFloat(p.gross_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-outline btn-sm" onClick={() => { setEditingId(p.id); setEditForm({ start_date: p.start_date, end_date: p.end_date, gross_amount: p.gross_amount || '' }); }}>Edit</button>
                      <button className="btn btn-danger btn-sm" onClick={() => handleDelete(p.id, p.label)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!periods.length && <p style={{ textAlign: 'center', color: 'var(--gray-400)', padding: 32 }}>No pay periods yet. Click "Auto-generate Biweekly" to get started.</p>}
        </div>
      )}
    </div>
  );
}

// ── Reconcile Tab ────────────────────────────────────────────────────────────

const CONFIDENCE_STYLE = {
  high:   { background: '#d1fae5', color: '#065f46', border: '1px solid #6ee7b7' },
  medium: { background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' },
  low:    { background: '#ffedd5', color: '#9a3412', border: '1px solid #fdba74' },
};

function PayPeriodRow({ period, supervisorId }) {
  const [open, setOpen]               = useState(false);
  const [sessions, setSessions]       = useState([]);
  const [loading, setLoading]         = useState(false);
  const [stubResult, setStubResult]   = useState(null); // { matched, unmatched }
  const [pendingMappings, setPendingMappings] = useState({}); // { billingName: group_id }
  const [allGroups, setAllGroups]     = useState([]);
  const [checkedIds, setCheckedIds]   = useState(new Set());
  const [uploading, setUploading]     = useState(false);
  const [savingMappings, setSavingMappings] = useState(false);
  const [confirming, setConfirming]   = useState(false);
  const [error, setError]             = useState('');
  const [editingBilling, setEditingBilling] = useState(null); // { groupId, value }
  const fileRef = useRef();

  async function saveBillingName(groupId, value) {
    const trimmed = value.trim();
    try {
      await api.updateGroup(groupId, { billing_name: trimmed || null });
      setSessions(prev => prev.map(s =>
        s.group?.id === groupId ? { ...s, group: { ...s.group, billing_name: trimmed || null } } : s
      ));
    } catch (e) { setError(e.message); }
    setEditingBilling(null);
  }

  useEffect(() => {
    if (!open || !supervisorId) { setSessions([]); setStubResult(null); setCheckedIds(new Set()); return; }
    setLoading(true);
    api.getPaymentSessions(supervisorId, period.start_date, period.end_date)
      .then(setSessions)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [open, supervisorId]);

  useEffect(() => {
    if (open && stubResult?.unmatched?.length && !allGroups.length) {
      api.getGroups().then(setAllGroups).catch(() => {});
    }
  }, [open, stubResult]);

  async function handleStubUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setError(''); setStubResult(null); setPendingMappings({});
    try {
      const result = await parsePayStub(file);
      setStubResult(result);
      const preChecked = new Set(
        result.matched.filter(m => m.session && !m.session.paid).map(m => m.session.id)
      );
      setCheckedIds(preChecked);
    } catch (e) { setError(e.message); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  }

  async function handleSaveMappings() {
    const mappings = Object.entries(pendingMappings)
      .filter(([, gid]) => gid)
      .map(([billingName, group_id]) => ({ billing_name: billingName, group_id }));
    if (!mappings.length) return;
    setSavingMappings(true); setError('');
    try {
      const pendingEntries = stubResult.unmatched.flatMap(u => u.dates.map(date => ({ billingName: u.billingName, date })));
      const result = await api.saveBillingMappings(mappings, pendingEntries);
      setStubResult(prev => ({
        matched: [...prev.matched, ...result.matched],
        unmatched: result.unmatched,
      }));
      const preChecked = new Set(
        result.matched.filter(m => m.session && !m.session.paid).map(m => m.session.id)
      );
      setCheckedIds(prev => new Set([...prev, ...preChecked]));
      setPendingMappings({});
    } catch (e) { setError(e.message); }
    finally { setSavingMappings(false); }
  }

  async function handleConfirm() {
    if (!checkedIds.size) return;
    setConfirming(true);
    try {
      await api.confirmPayment([...checkedIds]);
      const updated = await api.getPaymentSessions(supervisorId, period.start_date, period.end_date);
      setSessions(updated);
      if (stubResult) {
        setStubResult(prev => ({
          ...prev,
          matched: prev.matched.map(m =>
            m.session && checkedIds.has(m.session.id) ? { ...m, session: { ...m.session, paid: true } } : m
          ),
        }));
      }
      setCheckedIds(new Set());
      alert(`Marked ${checkedIds.size} session(s) as paid.`);
    } catch (e) { setError(e.message); }
    finally { setConfirming(false); }
  }

  const paidCount   = sessions.filter(s => s.paid).length;
  const unpaidCount = sessions.length - paidCount;

  return (
    <div style={{ border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', marginBottom: 6, overflow: 'hidden' }}>
      {/* Accordion header */}
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', background: open ? 'var(--navy)' : 'var(--gray-50)',
          border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: open ? 'rgba(255,255,255,0.6)' : 'var(--gray-400)', fontSize: '0.7rem' }}>{open ? '▼' : '▶'}</span>
          <span style={{ fontWeight: 600, color: open ? 'white' : 'var(--navy)', fontSize: '0.9rem' }}>
            {period.label || `${fmtDate(period.start_date)} – ${fmtDate(period.end_date)}`}
          </span>
          {period.gross_amount && (
            <span style={{ fontSize: '0.78rem', color: open ? 'rgba(255,255,255,0.6)' : 'var(--gray-400)' }}>
              ${parseFloat(period.gross_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </span>
          )}
        </div>
        {open && sessions.length > 0 && (
          <div style={{ display: 'flex', gap: 16, fontSize: '0.78rem' }}>
            <span style={{ color: '#86efac' }}>{paidCount} paid</span>
            <span style={{ color: unpaidCount > 0 ? '#fca5a5' : '#86efac' }}>{unpaidCount} unpaid</span>
          </div>
        )}
      </button>

      {/* Accordion body */}
      {open && (
        <div style={{ padding: 16 }}>
          {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

          {!supervisorId ? (
            <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', margin: 0 }}>Select a supervisor above to view sessions.</p>
          ) : loading ? (
            <div className="loading-screen"><div className="spinner" /></div>
          ) : (
            <>
              {/* Stats */}
              <div className="stats-row" style={{ marginBottom: 16 }}>
                <div className="stat-card">
                  <div className="stat-value">{sessions.length}</div>
                  <div className="stat-label">Completed Sessions</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: '#059669' }}>{paidCount}</div>
                  <div className="stat-label">Paid</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: unpaidCount > 0 ? '#dc2626' : 'var(--navy)' }}>{unpaidCount}</div>
                  <div className="stat-label">Unpaid</div>
                </div>
                {period.gross_amount && (
                  <div className="stat-card">
                    <div className="stat-value">${parseFloat(period.gross_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
                    <div className="stat-label">Gross Paid</div>
                  </div>
                )}
              </div>

              {/* Sessions table */}
              <div style={{ overflowX: 'auto', marginBottom: 16 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--gray-200)', textAlign: 'left' }}>
                      <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>Group</th>
                      <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>Billing Name</th>
                      <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>Date</th>
                      <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>ECW Time</th>
                      <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map(s => (
                      <tr key={s.id} style={{ borderBottom: '1px solid var(--gray-100)' }}>
                        <td style={{ padding: '10px 12px', fontWeight: 500 }}>{s.group?.internal_name || s.group?.group_name || '—'}</td>
                        <td style={{ padding: '6px 12px' }}>
                          {editingBilling?.groupId === s.group?.id ? (
                            <input
                              autoFocus
                              className="form-input"
                              style={{ fontSize: '0.8rem', padding: '3px 7px', minWidth: 200 }}
                              value={editingBilling.value}
                              onChange={e => setEditingBilling(prev => ({ ...prev, value: e.target.value }))}
                              onBlur={() => saveBillingName(s.group.id, editingBilling.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveBillingName(s.group.id, editingBilling.value);
                                if (e.key === 'Escape') setEditingBilling(null);
                              }}
                            />
                          ) : (
                            <span
                              onClick={() => setEditingBilling({ groupId: s.group?.id, value: s.group?.billing_name || '' })}
                              title="Click to edit billing name"
                              style={{ color: s.group?.billing_name ? 'var(--gray-500)' : 'var(--gray-300)', fontSize: '0.8rem', cursor: 'pointer', borderBottom: '1px dashed var(--gray-300)' }}>
                              {s.group?.billing_name || 'Set billing name…'}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '10px 12px', color: 'var(--gray-600)' }}>{fmtDate(s.session_date)}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--gray-600)' }}>{fmt12(s.ecw_time)}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                            background: s.paid ? '#d1fae5' : '#fee2e2', color: s.paid ? '#065f46' : '#991b1b' }}>
                            {s.paid ? 'Paid' : 'Unpaid'}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {!sessions.length && (
                      <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: 'var(--gray-400)' }}>No completed sessions in this period.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Upload stub */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: stubResult ? 20 : 0 }}>
                <button className="btn btn-gold btn-sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
                  {uploading ? 'Parsing…' : '📄 Upload Pay Stub (PDF or Excel)'}
                </button>
                <input ref={fileRef} type="file" accept=".pdf,.xlsx,.xls" style={{ display: 'none' }} onChange={handleStubUpload} />
                {stubResult && (
                  <span style={{ fontSize: '0.8rem', color: 'var(--gray-500)' }}>
                    {stubResult.matched.length} matched · {stubResult.unmatched.length} unrecognized
                  </span>
                )}
                {stubResult && (
                  <button className="btn btn-outline btn-sm" onClick={() => { setStubResult(null); setCheckedIds(new Set()); setPendingMappings({}); }}>Clear</button>
                )}
              </div>

              {/* Unrecognized billing names — need mapping */}
              {stubResult?.unmatched?.length > 0 && (
                <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 'var(--radius)', padding: '14px 16px', marginBottom: 16 }}>
                  <div style={{ fontWeight: 700, color: '#92400e', marginBottom: 12, fontSize: '0.85rem' }}>
                    {stubResult.unmatched.length} unrecognized billing name{stubResult.unmatched.length !== 1 ? 's' : ''} — assign each to a group to save for future stubs:
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {stubResult.unmatched.map(u => (
                      <div key={u.billingName} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <div style={{ minWidth: 260, fontSize: '0.82rem', fontFamily: 'monospace', color: 'var(--navy)', fontWeight: 600 }}>
                          {u.billingName}
                          <span style={{ fontWeight: 400, color: 'var(--gray-400)', marginLeft: 8 }}>
                            ({u.dates.map(fmtDate).join(', ')})
                          </span>
                        </div>
                        <GroupCombobox
                          groups={allGroups}
                          value={pendingMappings[u.billingName] || ''}
                          onChange={gid => setPendingMappings(prev => ({ ...prev, [u.billingName]: gid }))}
                        />
                      </div>
                    ))}
                  </div>
                  <button
                    className="btn btn-gold btn-sm"
                    style={{ marginTop: 14 }}
                    onClick={handleSaveMappings}
                    disabled={savingMappings || !Object.values(pendingMappings).some(v => v)}>
                    {savingMappings ? 'Saving…' : 'Save & Match'}
                  </button>
                </div>
              )}

              {/* Matched stub sessions */}
              {stubResult?.matched?.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--navy)', marginBottom: 10 }}>
                    Pay stub sessions ({stubResult.matched.length}):
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', marginBottom: 16 }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid var(--gray-200)', textAlign: 'left' }}>
                        <th style={{ padding: '6px 10px', color: 'var(--gray-500)' }}>Mark Paid</th>
                        <th style={{ padding: '6px 10px', color: 'var(--gray-500)' }}>Billing Name</th>
                        <th style={{ padding: '6px 10px', color: 'var(--gray-500)' }}>Date</th>
                        <th style={{ padding: '6px 10px', color: 'var(--gray-500)' }}>Group</th>
                        <th style={{ padding: '6px 10px', color: 'var(--gray-500)' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stubResult.matched.map((m, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--gray-100)', background: !m.session ? '#fff7ed' : undefined }}>
                          <td style={{ padding: '8px 10px' }}>
                            {m.session && !m.session.paid ? (
                              <input type="checkbox" checked={checkedIds.has(m.session.id)}
                                onChange={e => {
                                  const next = new Set(checkedIds);
                                  e.target.checked ? next.add(m.session.id) : next.delete(m.session.id);
                                  setCheckedIds(next);
                                }} />
                            ) : <span style={{ color: 'var(--gray-300)' }}>—</span>}
                          </td>
                          <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--gray-700)' }}>{m.billingName}</td>
                          <td style={{ padding: '8px 10px', color: 'var(--gray-600)', whiteSpace: 'nowrap' }}>{fmtDate(m.date)}</td>
                          <td style={{ padding: '8px 10px', fontWeight: 500, color: m.session ? 'var(--navy)' : '#c2410c' }}>
                            {m.session ? (m.group?.internal_name || m.group?.group_name || '—') : '⚠ No session found for this date'}
                          </td>
                          <td style={{ padding: '8px 10px' }}>
                            {m.session ? (
                              <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                                background: m.session.paid ? '#d1fae5' : '#fee2e2',
                                color: m.session.paid ? '#065f46' : '#991b1b' }}>
                                {m.session.paid ? 'Paid' : 'Unpaid'}
                              </span>
                            ) : <span style={{ fontSize: '0.75rem', color: '#c2410c' }}>Missing</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {checkedIds.size > 0 && (
                    <button className="btn btn-gold" onClick={handleConfirm} disabled={confirming}>
                      {confirming ? 'Marking paid…' : `Mark ${checkedIds.size} Session(s) as Paid`}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}


function ReconcileTab() {
  const [supervisors, setSupervisors]   = useState([]);
  const [periods, setPeriods]           = useState([]);
  const [supervisorId, setSupervisorId] = useState('');
  const [exportStart, setExportStart]   = useState('');
  const [exportEnd, setExportEnd]       = useState('');
  const [exporting, setExporting]       = useState(false);
  const [exportError, setExportError]   = useState('');

  useEffect(() => {
    api.getUsers().then(u => setSupervisors(u.filter(x => x.role === 'supervisor' || x.role === 'admin')));
    api.getPayPeriods().then(setPeriods);
  }, []);

  async function handleExport() {
    if (!supervisorId) return;
    setExporting(true); setExportError('');
    try {
      const sup = supervisors.find(s => s.id === supervisorId);
      const name = sup ? `${sup.first_name} ${sup.last_name}` : 'export';
      await exportPaymentsExcel(supervisorId, name, exportStart, exportEnd);
    } catch (e) { setExportError(e.message); }
    finally { setExporting(false); }
  }

  return (
    <div>
      <div className="form-row" style={{ marginBottom: 20 }}>
        <div className="form-group" style={{ maxWidth: 280 }}>
          <label className="form-label">Supervisor</label>
          <select className="form-select" value={supervisorId} onChange={e => setSupervisorId(e.target.value)}>
            <option value="">— Select supervisor —</option>
            {supervisors.map(s => <option key={s.id} value={s.id}>{s.first_name} {s.last_name}</option>)}
          </select>
        </div>
      </div>

      {/* Export */}
      <div style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: '14px 16px', marginBottom: 24 }}>
        <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--navy)', marginBottom: 12 }}>Export to Excel</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">From</label>
            <input className="form-input" type="date" value={exportStart} onChange={e => setExportStart(e.target.value)} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">To</label>
            <input className="form-input" type="date" value={exportEnd} onChange={e => setExportEnd(e.target.value)} />
          </div>
          <button
            className="btn btn-gold btn-sm"
            onClick={handleExport}
            disabled={exporting || !supervisorId}
            style={{ marginBottom: 1 }}>
            {exporting ? 'Exporting…' : '⬇ Export Excel'}
          </button>
        </div>
        <div style={{ marginTop: 6, fontSize: '0.78rem', color: 'var(--gray-400)' }}>
          Leave dates blank to export all periods.
        </div>
        {exportError && <div style={{ marginTop: 6, fontSize: '0.8rem', color: '#dc2626' }}>{exportError}</div>}
      </div>

      <div>
        {periods.map(p => <PayPeriodRow key={p.id} period={p} supervisorId={supervisorId} />)}
        {!periods.length && (
          <p style={{ textAlign: 'center', color: 'var(--gray-400)', padding: 32 }}>No pay periods yet.</p>
        )}
      </div>
    </div>
  );
}

// ── Unpaid Tab ───────────────────────────────────────────────────────────────

function daysAgo(dateStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  const [y,m,d] = dateStr.split('-').map(Number);
  const sess = new Date(y, m-1, d);
  return Math.floor((today - sess) / (1000*60*60*24));
}

function ageBadge(days) {
  if (days >= 30) return { background: '#fee2e2', color: '#991b1b', label: `${days}d` };
  if (days >= 14) return { background: '#fef3c7', color: '#92400e', label: `${days}d` };
  return { background: 'var(--gray-100)', color: 'var(--gray-600)', label: `${days}d` };
}

function UnpaidTab() {
  const [supervisors,   setSupervisors]   = useState([]);
  const [supervisorId,  setSupervisorId]  = useState('');
  const [sessions,      setSessions]      = useState([]);
  const [loading,       setLoading]       = useState(false);
  const [marking,       setMarking]       = useState(new Set());
  const [error,         setError]         = useState('');

  useEffect(() => {
    api.getUsers().then(u => setSupervisors(u.filter(x => x.role === 'supervisor' || x.role === 'admin')));
  }, []);

  useEffect(() => {
    if (!supervisorId) { setSessions([]); return; }
    setLoading(true); setError('');
    api.getUnpaidSessions(supervisorId)
      .then(setSessions)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [supervisorId]);

  async function markPaid(sessionId) {
    setMarking(prev => new Set([...prev, sessionId]));
    try {
      await api.confirmPayment([sessionId]);
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    } catch (e) { setError(e.message); }
    finally { setMarking(prev => { const n = new Set(prev); n.delete(sessionId); return n; }); }
  }

  return (
    <div>
      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="form-row" style={{ marginBottom: 20 }}>
        <div className="form-group" style={{ maxWidth: 280 }}>
          <label className="form-label">Supervisor</label>
          <select className="form-select" value={supervisorId} onChange={e => setSupervisorId(e.target.value)}>
            <option value="">— Select supervisor —</option>
            {supervisors.map(s => <option key={s.id} value={s.id}>{s.first_name} {s.last_name}</option>)}
          </select>
        </div>
      </div>

      {!supervisorId ? null : loading ? (
        <div className="loading-screen"><div className="spinner" /></div>
      ) : (
        <>
          {sessions.length > 0 && (
            <div style={{ marginBottom: 12, fontSize: '0.85rem', color: 'var(--gray-500)' }}>
              <strong style={{ color: '#dc2626' }}>{sessions.length}</strong> unpaid session{sessions.length !== 1 ? 's' : ''}
              {' · '}{sessions.filter(s => daysAgo(s.session_date) >= 30).length > 0 && (
                <span style={{ color: '#991b1b', fontWeight: 600 }}>
                  {sessions.filter(s => daysAgo(s.session_date) >= 30).length} overdue 30+ days
                </span>
              )}
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--gray-200)', textAlign: 'left' }}>
                  <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>Group</th>
                  <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>Date</th>
                  <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>ECW Time</th>
                  <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>Waiting</th>
                  <th style={{ padding: '8px 12px' }}></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map(s => {
                  const days = daysAgo(s.session_date);
                  const badge = ageBadge(days);
                  return (
                    <tr key={s.id} style={{ borderBottom: '1px solid var(--gray-100)', background: days >= 30 ? '#fff5f5' : days >= 14 ? '#fffbeb' : 'white' }}>
                      <td style={{ padding: '10px 12px', fontWeight: 500, color: 'var(--navy)' }}>
                        {s.group?.internal_name || s.group?.group_name || '—'}
                      </td>
                      <td style={{ padding: '10px 12px', color: 'var(--gray-600)' }}>{fmtDate(s.session_date)}</td>
                      <td style={{ padding: '10px 12px', color: 'var(--gray-600)' }}>{fmt12(s.ecw_time)}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: 12, ...badge }}>
                          {badge.label}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <button
                          className="btn btn-outline btn-sm"
                          style={{ fontSize: '0.75rem' }}
                          disabled={marking.has(s.id)}
                          onClick={() => markPaid(s.id)}>
                          {marking.has(s.id) ? '…' : 'Mark Paid'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!sessions.length && (
                  <tr><td colSpan={5} style={{ padding: 40, textAlign: 'center', color: 'var(--gray-400)' }}>
                    All sessions paid.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PaymentsPage() {
  const [tab, setTab] = useState('periods');

  return (
    <div className="page">
      <div className="page-header">
        <h2 className="page-title">Payments</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className={`btn btn-sm ${tab === 'periods' ? 'btn-gold' : 'btn-outline'}`} onClick={() => setTab('periods')}>Pay Periods</button>
          <button className={`btn btn-sm ${tab === 'reconcile' ? 'btn-gold' : 'btn-outline'}`} onClick={() => setTab('reconcile')}>Reconcile</button>
          <button className={`btn btn-sm ${tab === 'unpaid' ? 'btn-gold' : 'btn-outline'}`} onClick={() => setTab('unpaid')}>Unpaid</button>
        </div>
      </div>

      {tab === 'periods'   && <PayPeriodsTab />}
      {tab === 'reconcile' && <ReconcileTab />}
      {tab === 'unpaid'    && <UnpaidTab />}
    </div>
  );
}

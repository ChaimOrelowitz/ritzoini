import { useState, useEffect, useRef } from 'react';
import { api } from '../utils/api';
import supabase from '../supabaseClient';

const API = process.env.REACT_APP_API_URL || 'http://localhost:4000';

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

function ReconcileTab() {
  const [supervisors, setSupervisors]   = useState([]);
  const [periods, setPeriods]           = useState([]);
  const [supervisorId, setSupervisorId] = useState('');
  const [periodId, setPeriodId]         = useState('');
  const [sessions, setSessions]         = useState([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [checkedIds, setCheckedIds]     = useState(new Set());
  const [uploading, setUploading]       = useState(false);
  const [confirming, setConfirming]     = useState(false);
  const [error, setError]               = useState('');
  const fileRef = useRef();

  const selectedPeriod = periods.find(p => p.id === periodId) || null;

  useEffect(() => {
    api.getUsers().then(u => setSupervisors(u.filter(x => x.role === 'supervisor' || x.role === 'admin')));
    api.getPayPeriods().then(setPeriods);
  }, []);

  useEffect(() => {
    if (!supervisorId || !selectedPeriod) { setSessions([]); setUploadResult(null); return; }
    setLoadingSessions(true);
    api.getPaymentSessions(supervisorId, selectedPeriod.start_date, selectedPeriod.end_date)
      .then(setSessions)
      .catch(e => setError(e.message))
      .finally(() => setLoadingSessions(false));
    setUploadResult(null);
  }, [supervisorId, periodId]);

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file || !supervisorId || !selectedPeriod) return;
    setUploading(true); setError(''); setUploadResult(null);
    try {
      const result = await uploadPayReport(file, supervisorId, selectedPeriod.start_date, selectedPeriod.end_date);
      setUploadResult(result);
      // Pre-check high + medium confidence matches
      const preChecked = new Set(
        result.matches
          .filter(m => m.session && (m.confidence === 'high' || m.confidence === 'medium'))
          .map(m => m.session.id)
      );
      setCheckedIds(preChecked);
    } catch (e) { setError(e.message); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  }

  async function handleConfirm() {
    if (!checkedIds.size) return;
    setConfirming(true);
    try {
      await api.confirmPayment([...checkedIds]);
      // Refresh sessions
      if (supervisorId && selectedPeriod) {
        const updated = await api.getPaymentSessions(supervisorId, selectedPeriod.start_date, selectedPeriod.end_date);
        setSessions(updated);
      }
      setUploadResult(null);
      setCheckedIds(new Set());
      alert(`Marked ${checkedIds.size} session(s) as paid.`);
    } catch (e) { setError(e.message); }
    finally { setConfirming(false); }
  }

  const paidCount   = sessions.filter(s => s.paid).length;
  const unpaidCount = sessions.length - paidCount;

  return (
    <div>
      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      {/* Selectors */}
      <div className="form-row" style={{ marginBottom: 16 }}>
        <div className="form-group">
          <label className="form-label">Supervisor</label>
          <select className="form-select" value={supervisorId} onChange={e => setSupervisorId(e.target.value)}>
            <option value="">— Select supervisor —</option>
            {supervisors.map(s => <option key={s.id} value={s.id}>{s.first_name} {s.last_name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Pay Period</label>
          <select className="form-select" value={periodId} onChange={e => setPeriodId(e.target.value)}>
            <option value="">— Select period —</option>
            {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
      </div>

      {/* Summary cards */}
      {supervisorId && selectedPeriod && (
        <div className="stats-row" style={{ marginBottom: 20 }}>
          <div className="stat-card">
            <div className="stat-value">{sessions.length}</div>
            <div className="stat-label">Completed Sessions</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: '#059669' }}>{paidCount}</div>
            <div className="stat-label">Paid</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: paidCount < sessions.length ? '#dc2626' : 'var(--navy)' }}>{unpaidCount}</div>
            <div className="stat-label">Unpaid</div>
          </div>
          {selectedPeriod.gross_amount && (
            <div className="stat-card">
              <div className="stat-value">${parseFloat(selectedPeriod.gross_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
              <div className="stat-label">Gross Paid</div>
            </div>
          )}
        </div>
      )}

      {/* Sessions table */}
      {supervisorId && selectedPeriod && (
        <>
          {loadingSessions ? <div className="loading-screen"><div className="spinner" /></div> : (
            <>
              <div style={{ overflowX: 'auto', marginBottom: 16 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--gray-200)', textAlign: 'left' }}>
                      <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>Group</th>
                      <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>Date</th>
                      <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>ECW Time</th>
                      <th style={{ padding: '8px 12px', color: 'var(--gray-500)', fontWeight: 600 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map(s => (
                      <tr key={s.id} style={{ borderBottom: '1px solid var(--gray-100)' }}>
                        <td style={{ padding: '10px 12px', fontWeight: 500 }}>{s.group?.internal_name || s.group?.group_name || '—'}</td>
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
                      <tr><td colSpan={4} style={{ padding: 24, textAlign: 'center', color: 'var(--gray-400)' }}>No completed sessions in this period.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Upload section */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
                <button className="btn btn-gold btn-sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
                  {uploading ? 'Processing…' : '📂 Upload Pay Report (Excel)'}
                </button>
                <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={handleUpload} />
                {uploadResult && <span style={{ fontSize: '0.8rem', color: 'var(--gray-500)' }}>
                  {uploadResult.matches.length} Excel rows parsed · {uploadResult.matches.filter(m => m.session).length} matched
                </span>}
              </div>

              {/* Match results */}
              {uploadResult && (
                <div>
                  <h4 style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: 12, color: 'var(--navy)' }}>Match Results</h4>

                  {/* Matched rows */}
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', marginBottom: 20 }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid var(--gray-200)', textAlign: 'left' }}>
                        <th style={{ padding: '6px 10px', color: 'var(--gray-500)' }}>Confirm</th>
                        <th style={{ padding: '6px 10px', color: 'var(--gray-500)' }}>Excel Row</th>
                        <th style={{ padding: '6px 10px', color: 'var(--gray-500)' }}>Date</th>
                        <th style={{ padding: '6px 10px', color: 'var(--gray-500)' }}>Matched Session</th>
                        <th style={{ padding: '6px 10px', color: 'var(--gray-500)' }}>Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {uploadResult.matches.map((m, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--gray-100)', background: !m.session ? '#fff7ed' : undefined }}>
                          <td style={{ padding: '8px 10px' }}>
                            {m.session ? (
                              <input type="checkbox" checked={checkedIds.has(m.session.id)}
                                onChange={e => {
                                  const next = new Set(checkedIds);
                                  e.target.checked ? next.add(m.session.id) : next.delete(m.session.id);
                                  setCheckedIds(next);
                                }} />
                            ) : <span style={{ color: 'var(--gray-300)' }}>—</span>}
                          </td>
                          <td style={{ padding: '8px 10px', color: 'var(--gray-700)' }}>{m.excelEntry.rawName}</td>
                          <td style={{ padding: '8px 10px', color: 'var(--gray-600)' }}>{fmtDate(m.excelEntry.date)}</td>
                          <td style={{ padding: '8px 10px', fontWeight: m.session ? 500 : 400, color: m.session ? 'var(--navy)' : '#c2410c' }}>
                            {m.session
                              ? `${m.session.group?.internal_name || '—'} @ ${fmt12(m.session.ecw_time)}`
                              : '⚠ No match found'}
                          </td>
                          <td style={{ padding: '8px 10px' }}>
                            {m.confidence ? (
                              <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '2px 8px', borderRadius: 10, ...CONFIDENCE_STYLE[m.confidence] }}>
                                {m.confidence.toUpperCase()}
                              </span>
                            ) : <span style={{ color: '#c2410c', fontSize: '0.8rem' }}>Unmatched</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Unmatched DB sessions — warning */}
                  {uploadResult.unmatchedSessions.length > 0 && (
                    <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 'var(--radius)', padding: '12px 16px', marginBottom: 16 }}>
                      <div style={{ fontWeight: 700, color: '#991b1b', marginBottom: 8, fontSize: '0.85rem' }}>
                        ⚠ {uploadResult.unmatchedSessions.length} session(s) in app NOT found in pay report — you may not have been paid for these:
                      </div>
                      {uploadResult.unmatchedSessions.map(s => (
                        <div key={s.id} style={{ fontSize: '0.8rem', color: '#7f1d1d', padding: '2px 0' }}>
                          {s.group?.internal_name || '—'} · {fmtDate(s.session_date)} · ECW {fmt12(s.ecw_time)}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Confirm button */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button className="btn btn-gold" onClick={handleConfirm} disabled={confirming || !checkedIds.size}>
                      {confirming ? 'Marking paid…' : `Mark ${checkedIds.size} Session(s) as Paid`}
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={() => { setUploadResult(null); setCheckedIds(new Set()); }}>Clear</button>
                  </div>
                </div>
              )}
            </>
          )}
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
        </div>
      </div>

      {tab === 'periods'   && <PayPeriodsTab />}
      {tab === 'reconcile' && <ReconcileTab />}
    </div>
  );
}

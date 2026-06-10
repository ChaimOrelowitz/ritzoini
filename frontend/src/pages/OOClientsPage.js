import { useState, useEffect, useRef } from 'react';
import { api } from '../utils/api';

function fmtDob(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y}`;
}

const EMPTY_FORM = {
  first_name: '', last_name: '', dob: '', sex: '', phone: '', mobile: '',
  email: '', mrn: '', referral_source_id: '', program: '', status: 'active',
};

export default function OOClientsPage() {
  const [clients, setClients] = useState([]);
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editClient, setEditClient] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef();

  // Assign referral source
  const [showAssign, setShowAssign] = useState(false);
  const [assignSourceId, setAssignSourceId] = useState('');
  const [assignPaste, setAssignPaste] = useState('');
  const [assignPreview, setAssignPreview] = useState(null); // { matched, unmatched }
  const [assignLoading, setAssignLoading] = useState(false);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [c, s] = await Promise.all([
        api.get('/oo/clients'),
        api.get('/oo/clients/referral-sources'),
      ]);
      setClients(c);
      setSources(s);
    } finally {
      setLoading(false);
    }
  }

  function openAdd() {
    setEditClient(null);
    setForm(EMPTY_FORM);
    setShowModal(true);
  }

  function openEdit(client) {
    setEditClient(client);
    setForm({
      first_name: client.first_name || '',
      last_name:  client.last_name  || '',
      dob:        client.dob        || '',
      sex:        client.sex        || '',
      phone:      client.phone      || '',
      mobile:     client.mobile     || '',
      email:      client.email      || '',
      mrn:        client.mrn        || '',
      referral_source_id: client.referral_source_id || '',
      program:    client.program    || '',
      status:     client.status     || 'active',
    });
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

  async function handleAssignPreview() {
    if (!assignSourceId || !assignPaste.trim()) return;
    setAssignLoading(true);
    setAssignPreview(null);
    try {
      const result = await api.post('/oo/clients/assign-referral', {
        referral_source_id: assignSourceId,
        paste_text: assignPaste,
      });
      setAssignPreview(result);
    } catch (err) {
      setAssignPreview({ error: err.message });
    } finally {
      setAssignLoading(false);
    }
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
      setShowAssign(false);
      setAssignPaste('');
      setAssignPreview(null);
      setAssignSourceId('');
    } finally {
      setAssignLoading(false);
    }
  }

  async function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const result = await api.postForm('/oo/clients/import/insync', formData);
      setImportResult(result);
      await loadAll();
    } catch (err) {
      setImportResult({ error: err.message });
    } finally {
      setImporting(false);
      fileRef.current.value = '';
    }
  }

  const filtered = clients.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (c.first_name || '').toLowerCase().includes(q) ||
      (c.last_name  || '').toLowerCase().includes(q) ||
      (c.mrn        || '').toLowerCase().includes(q) ||
      (c.oo_referral_sources?.name || '').toLowerCase().includes(q)
    );
  });

  return (
    <div style={{ padding: '24px 32px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--navy)', margin: 0, flex: 1 }}>Clients</h2>
        <input
          className="input"
          placeholder="Search name, MRN, referral source…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: 240, fontSize: '0.85rem' }}
        />
        <button className="btn btn-outline btn-sm" onClick={() => setShowImport(s => !s)}>Import from InSync</button>
        <button className="btn btn-outline btn-sm" onClick={() => { setShowAssign(s => !s); setAssignPreview(null); }}>Assign Referral Source</button>
        <button className="btn btn-primary btn-sm" onClick={openAdd}>+ Add Client</button>
      </div>

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
          {importResult?.error && (
            <span style={{ fontSize: '0.8rem', color: '#dc2626' }}>{importResult.error}</span>
          )}
        </div>
      )}

      {/* Assign Referral Source panel */}
      {showAssign && (
        <div style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 8, padding: '16px 20px', marginBottom: 20 }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--gray-600)', marginBottom: 12 }}>Assign Referral Source</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
              <label style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Referral Source</label>
              <select className="input" value={assignSourceId} onChange={e => { setAssignSourceId(e.target.value); setAssignPreview(null); }} style={{ fontSize: '0.85rem' }}>
                <option value="">— Select —</option>
                {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 300px' }}>
              <label style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Paste Client List</label>
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
            <div style={{ marginTop: 14, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
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
                    Not found ({assignPreview.unmatched.length}) — add them manually
                  </div>
                  {assignPreview.unmatched.map((c, i) => (
                    <div key={i} style={{ fontSize: '0.8rem', color: '#92400e', padding: '2px 0' }}>
                      ✗ {c.first_name} {c.last_name} {c.dob ? `· ${fmtDob(c.dob)}` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {assignPreview?.error && (
            <div style={{ marginTop: 10, fontSize: '0.8rem', color: '#dc2626' }}>{assignPreview.error}</div>
          )}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div style={{ color: 'var(--gray-400)', fontSize: '0.85rem' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ color: 'var(--gray-400)', fontSize: '0.85rem' }}>{search ? 'No matches.' : 'No clients yet. Add one or import from InSync.'}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--gray-200)' }}>
                {['Last', 'First', 'DOB', 'Sex', 'Phone', 'Mobile', 'Email', 'MRN', 'Referral Source', 'Status', ''].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 10px', fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--gray-100)' }}>
                  <td style={{ padding: '7px 10px', fontWeight: 600, color: 'var(--navy)', whiteSpace: 'nowrap' }}>{c.last_name || '—'}</td>
                  <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>{c.first_name || '—'}</td>
                  <td style={{ padding: '7px 10px', whiteSpace: 'nowrap', color: 'var(--gray-600)' }}>{fmtDob(c.dob) || '—'}</td>
                  <td style={{ padding: '7px 10px', color: 'var(--gray-600)' }}>{c.sex || '—'}</td>
                  <td style={{ padding: '7px 10px', color: 'var(--gray-600)', whiteSpace: 'nowrap' }}>{c.phone || '—'}</td>
                  <td style={{ padding: '7px 10px', color: 'var(--gray-600)', whiteSpace: 'nowrap' }}>{c.mobile || '—'}</td>
                  <td style={{ padding: '7px 10px', color: 'var(--gray-600)' }}>{c.email || '—'}</td>
                  <td style={{ padding: '7px 10px', color: 'var(--gray-600)' }}>{c.mrn || '—'}</td>
                  <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                    {c.oo_referral_sources ? (
                      <span style={{ background: '#dbeafe', color: '#1e40af', borderRadius: 4, padding: '2px 7px', fontSize: '0.72rem', fontWeight: 600 }}>{c.oo_referral_sources.name}</span>
                    ) : <span style={{ color: 'var(--gray-300)' }}>—</span>}
                  </td>
                  <td style={{ padding: '7px 10px' }}>
                    <span style={{
                      background: c.status === 'active' ? '#dcfce7' : '#f3f4f6',
                      color: c.status === 'active' ? '#166534' : '#6b7280',
                      borderRadius: 4, padding: '2px 7px', fontSize: '0.72rem', fontWeight: 600,
                    }}>{c.status || 'active'}</span>
                  </td>
                  <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-outline btn-xs" onClick={() => openEdit(c)} style={{ marginRight: 6 }}>Edit</button>
                    <button className="btn btn-outline btn-xs" onClick={() => handleDelete(c.id)} style={{ color: '#dc2626', borderColor: '#fca5a5' }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: '28px 32px', width: 560, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 20px', fontSize: '1rem', fontWeight: 700, color: 'var(--navy)' }}>
              {editClient ? 'Edit Client' : 'Add Client'}
            </h3>
            <form onSubmit={handleSave}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' }}>
                {[
                  { key: 'first_name', label: 'First Name' },
                  { key: 'last_name',  label: 'Last Name'  },
                  { key: 'dob',        label: 'Date of Birth', type: 'date' },
                  { key: 'mrn',        label: 'MRN'        },
                  { key: 'phone',      label: 'Phone',      type: 'tel' },
                  { key: 'mobile',     label: 'Mobile',     type: 'tel' },
                  { key: 'email',      label: 'Email',      type: 'email', span: 2 },
                ].map(({ key, label, type = 'text', span }) => (
                  <div key={key} style={{ gridColumn: span ? `span ${span}` : undefined, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</label>
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
                  <label style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sex</label>
                  <select className="input" value={form.sex} onChange={e => setForm(f => ({ ...f, sex: e.target.value }))} style={{ fontSize: '0.85rem' }}>
                    <option value="">—</option>
                    <option value="M">Male</option>
                    <option value="F">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</label>
                  <select className="input" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} style={{ fontSize: '0.85rem' }}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>

                <div style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Referral Source</label>
                  <select className="input" value={form.referral_source_id} onChange={e => setForm(f => ({ ...f, referral_source_id: e.target.value }))} style={{ fontSize: '0.85rem' }}>
                    <option value="">— None —</option>
                    {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

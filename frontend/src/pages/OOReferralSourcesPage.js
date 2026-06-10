import { useState, useEffect } from 'react';
import { api } from '../utils/api';

export default function OOReferralSourcesPage() {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null); // { id, name, notes_email }

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await api.get('/oo/clients/referral-sources');
      setSources(data);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const created = await api.post('/oo/clients/referral-sources', { name: newName, notes_email: newEmail });
      setSources(s => [...s, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewName(''); setNewEmail(''); setShowAdd(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEdit() {
    if (!editing.name.trim()) return;
    setSaving(true);
    try {
      const updated = await api.put(`/oo/clients/referral-sources/${editing.id}`, {
        name: editing.name, notes_email: editing.notes_email,
      });
      setSources(s => s.map(x => x.id === updated.id ? updated : x));
      setEditing(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this referral source? Clients assigned to it will be unassigned.')) return;
    await api.delete(`/oo/clients/referral-sources/${id}`);
    setSources(s => s.filter(x => x.id !== id));
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 700 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--navy)', margin: 0 }}>Referral Sources</h2>
        <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}>+ Add</button>
      </div>

      {showAdd && (
        <form onSubmit={handleAdd} style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 8, padding: '16px 20px', marginBottom: 20, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 180px' }}>
            <label style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Name</label>
            <input autoFocus className="input" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Yad LaNoar" style={{ fontSize: '0.85rem' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 220px' }}>
            <label style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Notes Email</label>
            <input className="input" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="secretary@yadlanoar.org" type="email" style={{ fontSize: '0.85rem' }} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>Save</button>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => { setShowAdd(false); setNewName(''); setNewEmail(''); }}>Cancel</button>
          </div>
        </form>
      )}

      {loading ? (
        <div style={{ color: 'var(--gray-400)', fontSize: '0.85rem' }}>Loading…</div>
      ) : sources.length === 0 ? (
        <div style={{ color: 'var(--gray-400)', fontSize: '0.85rem' }}>No referral sources yet.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--gray-200)' }}>
              {['Name', 'Notes Email', ''].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '6px 10px', fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sources.map(s => (
              <tr key={s.id} style={{ borderBottom: '1px solid var(--gray-100)' }}>
                {editing?.id === s.id ? (
                  <>
                    <td style={{ padding: '6px 10px' }}>
                      <input className="input" value={editing.name} onChange={e => setEditing(ed => ({ ...ed, name: e.target.value }))} style={{ fontSize: '0.85rem', width: '100%' }} />
                    </td>
                    <td style={{ padding: '6px 10px' }}>
                      <input className="input" value={editing.notes_email || ''} onChange={e => setEditing(ed => ({ ...ed, notes_email: e.target.value }))} style={{ fontSize: '0.85rem', width: '100%' }} type="email" />
                    </td>
                    <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-primary btn-xs" onClick={handleSaveEdit} disabled={saving} style={{ marginRight: 6 }}>Save</button>
                      <button className="btn btn-outline btn-xs" onClick={() => setEditing(null)}>Cancel</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td style={{ padding: '6px 10px', fontWeight: 600, color: 'var(--navy)' }}>{s.name}</td>
                    <td style={{ padding: '6px 10px', color: 'var(--gray-500)' }}>{s.notes_email || <span style={{ color: 'var(--gray-300)' }}>—</span>}</td>
                    <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-outline btn-xs" onClick={() => setEditing({ id: s.id, name: s.name, notes_email: s.notes_email || '' })} style={{ marginRight: 6 }}>Edit</button>
                      <button className="btn btn-outline btn-xs" onClick={() => handleDelete(s.id)} style={{ color: '#dc2626', borderColor: '#fca5a5' }}>Delete</button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

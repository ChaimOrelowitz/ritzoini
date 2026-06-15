import { useState, useEffect } from 'react';
import { api } from '../utils/api';

const labelSt = {
  fontSize: '0.72rem', fontWeight: 600, color: 'var(--gray-500)',
  textTransform: 'uppercase', letterSpacing: '0.05em',
};

const thSt = {
  textAlign: 'left', padding: '6px 10px',
  fontSize: '0.72rem', fontWeight: 700, color: 'var(--gray-400)',
  textTransform: 'uppercase', letterSpacing: '0.05em',
};

function SectionHeader({ title, onAdd }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
      <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: 'var(--navy)' }}>{title}</h3>
      <button className="btn btn-primary btn-sm" onClick={onAdd}>+ Add</button>
    </div>
  );
}

// Defined OUTSIDE the main component so React doesn't treat it as a new type on every render
function AddForm({ type, name, setName, email, setEmail, ehrUser, setEhrUser, ehrPass, setEhrPass, showPass, setShowPass, saving, onSubmit, onCancel }) {
  const isEhr = type === 'ehr';
  return (
    <form onSubmit={onSubmit} style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 8, padding: '14px 18px', marginBottom: 18, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 180px' }}>
        <label style={labelSt}>Name</label>
        <input autoFocus className="input" value={name} onChange={e => setName(e.target.value)}
          placeholder={isEhr ? 'InSync DSC' : 'Yad LaNoar'} style={{ fontSize: '0.85rem' }} />
      </div>
      {isEhr ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 160px' }}>
            <label style={labelSt}>Username</label>
            <input className="input" value={ehrUser} onChange={e => setEhrUser(e.target.value)}
              placeholder="username" style={{ fontSize: '0.85rem' }} autoComplete="off" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 160px' }}>
            <label style={labelSt}>Password</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input className="input" type={showPass ? 'text' : 'password'} value={ehrPass}
                onChange={e => setEhrPass(e.target.value)}
                style={{ fontSize: '0.85rem', flex: 1 }} autoComplete="new-password" />
              <button type="button" onClick={() => setShowPass(v => !v)}
                style={{ border: '1px solid var(--gray-200)', borderRadius: 5, padding: '0 7px', background: 'white', cursor: 'pointer', fontSize: '0.72rem', color: 'var(--gray-500)' }}>
                {showPass ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 220px' }}>
          <label style={labelSt}>Notes Email</label>
          <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="secretary@org.org" style={{ fontSize: '0.85rem' }} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>Save</button>
        <button type="button" className="btn btn-outline btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function OOReferralSourcesPage() {
  const [sources,      setSources]      = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [editing,      setEditing]      = useState(null);
  const [saving,       setSaving]       = useState(false);
  const [editShowPass, setEditShowPass] = useState(false);

  const [addType,    setAddType]    = useState(null);
  const [addName,    setAddName]    = useState('');
  const [addEmail,   setAddEmail]   = useState('');
  const [addEhrUser, setAddEhrUser] = useState('');
  const [addEhrPass, setAddEhrPass] = useState('');
  const [showPass,   setShowPass]   = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await api.get('/oo/clients/referral-sources');
      setSources(Array.isArray(data) ? data : []);
    } finally { setLoading(false); }
  }

  function openAdd(type) {
    setAddType(type);
    setAddName(''); setAddEmail(''); setAddEhrUser(''); setAddEhrPass('');
    setShowPass(false);
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!addName.trim()) return;
    setSaving(true);
    try {
      const body = { name: addName, type: addType };
      if (addType === 'referral') body.notes_email  = addEmail;
      if (addType === 'ehr')      { body.ehr_username = addEhrUser; body.ehr_password = addEhrPass; }
      const created = await api.post('/oo/clients/referral-sources', body);
      setSources(s => [...s, created].sort((a, b) => a.name.localeCompare(b.name)));
      setAddType(null);
    } finally { setSaving(false); }
  }

  async function handleSaveEdit() {
    if (!editing.name.trim()) return;
    setSaving(true);
    try {
      const body = { name: editing.name, type: editing.type };
      if (editing.type === 'referral') body.notes_email  = editing.notes_email  || '';
      if (editing.type === 'ehr')      { body.ehr_username = editing.ehr_username || ''; body.ehr_password = editing.ehr_password || ''; }
      const updated = await api.put(`/oo/clients/referral-sources/${editing.id}`, body);
      setSources(s => s.map(x => x.id === updated.id ? updated : x));
      setEditing(null);
    } finally { setSaving(false); }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this record? Clients assigned to it will be unassigned.')) return;
    await api.delete(`/oo/clients/referral-sources/${id}`);
    setSources(s => s.filter(x => x.id !== id));
  }

  const referrals = sources.filter(s => s.type !== 'ehr');
  const ehrs      = sources.filter(s => s.type === 'ehr');

  function renderTable(rows, type) {
    const isEhr = type === 'ehr';
    return (
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', marginBottom: 32 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--gray-200)' }}>
            <th style={thSt}>Name</th>
            <th style={thSt}>{isEhr ? 'Username' : 'Notes Email'}</th>
            {isEhr && <th style={thSt}>Password</th>}
            <th style={{ ...thSt, width: 140 }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={isEhr ? 4 : 3} style={{ padding: '12px 10px', color: 'var(--gray-300)', fontSize: '0.82rem' }}>
                None yet.
              </td>
            </tr>
          )}
          {rows.map(s => (
            <tr key={s.id} style={{ borderBottom: '1px solid var(--gray-100)' }}>
              {editing?.id === s.id ? (
                <>
                  <td style={{ padding: '6px 10px' }}>
                    <input className="input" value={editing.name}
                      onChange={e => setEditing(ed => ({ ...ed, name: e.target.value }))}
                      style={{ fontSize: '0.85rem', width: '100%' }} />
                  </td>
                  {isEhr ? (
                    <>
                      <td style={{ padding: '6px 10px' }}>
                        <input className="input" value={editing.ehr_username || ''}
                          onChange={e => setEditing(ed => ({ ...ed, ehr_username: e.target.value }))}
                          style={{ fontSize: '0.85rem', width: '100%' }} autoComplete="off" />
                      </td>
                      <td style={{ padding: '6px 10px' }}>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <input className="input" type={editShowPass ? 'text' : 'password'}
                            value={editing.ehr_password || ''}
                            onChange={e => setEditing(ed => ({ ...ed, ehr_password: e.target.value }))}
                            style={{ fontSize: '0.85rem', flex: 1 }} autoComplete="new-password" />
                          <button type="button" onClick={() => setEditShowPass(v => !v)}
                            style={{ border: '1px solid var(--gray-200)', borderRadius: 5, padding: '0 7px', background: 'white', cursor: 'pointer', fontSize: '0.72rem', color: 'var(--gray-500)' }}>
                            {editShowPass ? 'Hide' : 'Show'}
                          </button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <td style={{ padding: '6px 10px' }}>
                      <input className="input" type="email" value={editing.notes_email || ''}
                        onChange={e => setEditing(ed => ({ ...ed, notes_email: e.target.value }))}
                        style={{ fontSize: '0.85rem', width: '100%' }} />
                    </td>
                  )}
                  <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-primary btn-xs" onClick={handleSaveEdit} disabled={saving} style={{ marginRight: 6 }}>Save</button>
                    <button className="btn btn-outline btn-xs" onClick={() => setEditing(null)}>Cancel</button>
                  </td>
                </>
              ) : (
                <>
                  <td style={{ padding: '6px 10px', fontWeight: 600, color: 'var(--navy)' }}>{s.name}</td>
                  {isEhr ? (
                    <>
                      <td style={{ padding: '6px 10px', color: 'var(--gray-500)', fontFamily: 'monospace', fontSize: '0.82rem' }}>
                        {s.ehr_username || <span style={{ color: 'var(--gray-300)' }}>—</span>}
                      </td>
                      <td style={{ padding: '6px 10px', color: 'var(--gray-500)', fontFamily: 'monospace', fontSize: '0.82rem' }}>
                        {s.ehr_password ? '••••••••' : <span style={{ color: 'var(--gray-300)' }}>—</span>}
                      </td>
                    </>
                  ) : (
                    <td style={{ padding: '6px 10px', color: 'var(--gray-500)' }}>
                      {s.notes_email || <span style={{ color: 'var(--gray-300)' }}>—</span>}
                    </td>
                  )}
                  <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-outline btn-xs"
                      onClick={() => { setEditing({ ...s }); setEditShowPass(false); }}
                      style={{ marginRight: 6 }}>Edit</button>
                    <button className="btn btn-outline btn-xs"
                      onClick={() => handleDelete(s.id)}
                      style={{ color: '#dc2626', borderColor: '#fca5a5' }}>Delete</button>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 800 }}>
      <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--navy)', margin: '0 0 28px' }}>
        Referral Sources / EHR
      </h2>

      {loading ? (
        <div style={{ color: 'var(--gray-400)', fontSize: '0.85rem' }}>Loading…</div>
      ) : (
        <>
          <SectionHeader title="Referral Sources" onAdd={() => openAdd('referral')} />
          {addType === 'referral' && (
            <AddForm type="referral"
              name={addName} setName={setAddName}
              email={addEmail} setEmail={setAddEmail}
              ehrUser={addEhrUser} setEhrUser={setAddEhrUser}
              ehrPass={addEhrPass} setEhrPass={setAddEhrPass}
              showPass={showPass} setShowPass={setShowPass}
              saving={saving} onSubmit={handleAdd} onCancel={() => setAddType(null)}
            />
          )}
          {renderTable(referrals, 'referral')}

          <SectionHeader title="EHR Systems" onAdd={() => openAdd('ehr')} />
          {addType === 'ehr' && (
            <AddForm type="ehr"
              name={addName} setName={setAddName}
              email={addEmail} setEmail={setAddEmail}
              ehrUser={addEhrUser} setEhrUser={setAddEhrUser}
              ehrPass={addEhrPass} setEhrPass={setAddEhrPass}
              showPass={showPass} setShowPass={setShowPass}
              saving={saving} onSubmit={handleAdd} onCancel={() => setAddType(null)}
            />
          )}
          {renderTable(ehrs, 'ehr')}
        </>
      )}
    </div>
  );
}

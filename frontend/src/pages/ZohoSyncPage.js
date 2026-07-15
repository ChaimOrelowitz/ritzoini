import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';

const STATUS_FILTERS = ['active', 'completed', 'archived', 'all'];

function ZohoOption(z) {
  return `${z.session_name}${z.session_code ? ` · ${z.session_code}` : ''}${z.class_day ? ` · ${z.class_day}` : ''}`;
}

// One Ritzoini group row with its Zoho link dropdown.
function GroupRow({ group, zohoGroups, onLink }) {
  const [saving, setSaving] = useState(false);
  const linked = !!group.zoho_session_id;

  async function change(e) {
    const id = e.target.value || null;
    setSaving(true);
    try {
      await api.updateGroup(group.id, { zoho_session_id: id });
      onLink(group.id, id);
    } catch (err) {
      alert('Failed to save link: ' + err.message);
    } finally { setSaving(false); }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px', borderBottom: '1px solid var(--gray-100)' }}>
      <span style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: linked ? '#12855C' : '#C99A2E' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.9rem', fontWeight: 500 }}>{group.group_name || '(unnamed)'}</div>
        {group.internal_name && group.internal_name !== group.group_name && (
          <div style={{ fontSize: '0.74rem', color: 'var(--gray-400)' }}>{group.internal_name}</div>
        )}
      </div>
      <span className={`badge badge-${group.status}`} style={{ flexShrink: 0 }}>{group.status}</span>
      <select
        value={group.zoho_session_id || ''}
        onChange={change}
        disabled={saving}
        style={{ flexShrink: 0, width: 300, maxWidth: '42vw', fontSize: '0.8rem', padding: '5px 7px', borderRadius: 6, border: '1px solid var(--gray-300)' }}
      >
        <option value="">— not linked —</option>
        {zohoGroups.map(z => <option key={z.id} value={z.id}>{ZohoOption(z)}</option>)}
      </select>
    </div>
  );
}

export default function ZohoSyncPage() {
  const [data, setData]     = useState(null); // { groups, zohoGroups }
  const [status, setStatus] = useState('active');
  const [syncing, setSyncing] = useState(false);
  const [error, setError]   = useState('');
  const [msg, setMsg]       = useState('');

  const load = useCallback(async () => {
    try { setData(await api.getZohoAlignment()); }
    catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function sync() {
    setSyncing(true); setMsg(''); setError('');
    try {
      const r = await api.syncZohoGroups();
      setMsg(`Fetched ${r.fetched} Zoho groups · linked ${r.aligned} new · ${r.alreadyLinked} already · ${r.unmatched.length} still unmatched`);
      await load();
    } catch (err) { setError(err.message); }
    finally { setSyncing(false); }
  }

  function onLink(groupId, zohoId) {
    setData(d => ({ ...d, groups: d.groups.map(g => g.id === groupId ? { ...g, zoho_session_id: zohoId } : g) }));
  }

  if (!data) return <div className="loading-screen"><div className="spinner" /></div>;

  const filtered = data.groups.filter(g => status === 'all' || g.status === status);
  const linked = filtered.filter(g => g.zoho_session_id);
  const unlinked = filtered.filter(g => !g.zoho_session_id);
  const usedZoho = new Set(data.groups.filter(g => g.zoho_session_id).map(g => g.zoho_session_id));
  const unusedZoho = data.zohoGroups.filter(z => !usedZoho.has(z.id));

  return (
    <div>
      <div className="page-header" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ margin: 0 }}>Zoho Group Sync</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--gray-500)', fontSize: '0.88rem' }}>
            Link each Ritzoini group to its Zoho group. Notes post by the stored link — names are only the auto-guess.
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={sync} disabled={syncing}>
          {syncing ? 'Syncing…' : '↻ Sync Zoho Groups'}
        </button>
      </div>

      {error && <div className="alert alert-error" style={{ margin: '0 0 14px' }}>{error}</div>}
      {msg && <div className="alert alert-success" style={{ margin: '0 0 14px' }}>{msg}</div>}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16, fontSize: '0.82rem', color: 'var(--gray-600)' }}>
        <span><strong>{data.zohoGroups.length}</strong> Zoho groups</span>
        <span><strong>{data.groups.length}</strong> Ritzoini groups</span>
        <span style={{ color: '#12855C' }}><strong>{data.groups.filter(g => g.zoho_session_id).length}</strong> linked</span>
        <span style={{ color: '#B4820E' }}><strong>{unusedZoho.length}</strong> Zoho groups not used by any Ritzoini group</span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        {STATUS_FILTERS.map(s => (
          <button key={s} onClick={() => setStatus(s)}
            className={`btn btn-sm ${status === s ? 'btn-primary' : 'btn-outline'}`}
            style={{ textTransform: 'capitalize' }}>
            {s}{s !== 'all' ? ` (${data.groups.filter(g => g.status === s).length})` : ''}
          </button>
        ))}
      </div>

      <section style={{ marginBottom: 26 }}>
        <h3 style={{ fontSize: '0.9rem', margin: '0 0 8px', color: '#B4820E' }}>
          Not linked — {unlinked.length}
        </h3>
        <div style={{ background: 'var(--white)', border: '1px solid var(--gray-200)', borderRadius: 10, overflow: 'hidden' }}>
          {unlinked.length === 0
            ? <div style={{ padding: 14, color: 'var(--gray-400)', fontSize: '0.85rem' }}>Nothing to link in this filter. 🎉</div>
            : unlinked.map(g => <GroupRow key={g.id} group={g} zohoGroups={data.zohoGroups} onLink={onLink} />)}
        </div>
      </section>

      <section>
        <h3 style={{ fontSize: '0.9rem', margin: '0 0 8px', color: '#12855C' }}>
          Linked — {linked.length}
        </h3>
        <div style={{ background: 'var(--white)', border: '1px solid var(--gray-200)', borderRadius: 10, overflow: 'hidden' }}>
          {linked.length === 0
            ? <div style={{ padding: 14, color: 'var(--gray-400)', fontSize: '0.85rem' }}>No linked groups in this filter yet.</div>
            : linked.map(g => <GroupRow key={g.id} group={g} zohoGroups={data.zohoGroups} onLink={onLink} />)}
        </div>
      </section>
    </div>
  );
}

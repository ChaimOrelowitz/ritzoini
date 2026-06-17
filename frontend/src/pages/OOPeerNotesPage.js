import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function NoteRow({ note }) {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();

  return (
    <div style={{
      borderBottom: '1px solid var(--gray-100)',
      padding: '10px 16px',
    }}>
      <div
        style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}
      >
        {/* Date */}
        <div style={{ minWidth: 100, fontSize: '0.8rem', color: 'var(--gray-600)', paddingTop: 1 }}>
          {fmtDate(note.service_date)}
        </div>

        {/* Client */}
        <div style={{ minWidth: 160, fontSize: '0.85rem', fontWeight: 600 }}>
          {note.oo_client_id ? (
            <span
              style={{ color: 'var(--navy)', cursor: 'pointer', textDecoration: 'underline' }}
              onClick={e => { e.stopPropagation(); navigate(`/oo/clients/${note.oo_client_id}`); }}
            >
              {note.client_name || '—'}
            </span>
          ) : (
            <span style={{ color: 'var(--gray-500)' }}>{note.client_name || '—'}</span>
          )}
        </div>

        {/* Type */}
        <div style={{ minWidth: 140, fontSize: '0.75rem' }}>
          <span style={{
            background: '#eff6ff', color: '#1d4ed8',
            borderRadius: 4, padding: '2px 7px',
            fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em',
          }}>
            {note.encounter_type || 'Peer Support'}
          </span>
        </div>

        {/* Provider */}
        <div style={{ minWidth: 140, fontSize: '0.8rem', color: 'var(--gray-600)' }}>
          {note.provider_name || '—'}
        </div>

        {/* Note preview */}
        <div style={{ flex: 1, fontSize: '0.8rem', color: 'var(--gray-500)', overflow: 'hidden' }}>
          {!expanded
            ? <span style={{ whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', display: 'block' }}>
                {note.raw_note_text ? note.raw_note_text.slice(0, 120) + (note.raw_note_text.length > 120 ? '…' : '') : '(no text)'}
              </span>
            : null}
        </div>

        {/* Chevron */}
        <div style={{ fontSize: '0.7rem', color: 'var(--gray-400)', paddingTop: 2 }}>
          {expanded ? '▲' : '▼'}
        </div>
      </div>

      {expanded && (
        <div style={{
          marginTop: 8,
          marginLeft: 112,
          background: 'var(--gray-50)',
          border: '1px solid var(--gray-200)',
          borderRadius: 6,
          padding: '10px 14px',
          fontSize: '0.8rem',
          lineHeight: 1.6,
          color: '#222',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {note.raw_note_text || '(no note text retrieved)'}
        </div>
      )}
    </div>
  );
}

export default function OOPeerNotesPage() {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importDays, setImportDays] = useState(7);
  const [lastImport, setLastImport] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get('/oo/insync-notes');
      setNotes(data);
    } catch (ex) {
      setError(ex.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleImport() {
    setImporting(true);
    setLastImport(null);
    try {
      const result = await api.post(`/oo/insync-notes/import?days=${importDays}`);
      setLastImport(result);
      await load();
    } catch (ex) {
      setLastImport({ error: ex.message });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 700, color: 'var(--navy)' }}>Peer Notes</h2>
          <p style={{ margin: '3px 0 0', fontSize: '0.8rem', color: 'var(--gray-500)' }}>
            Imported from InSync · {notes.length} note{notes.length !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Import controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--gray-600)' }}>Last</span>
          <input
            type="number"
            value={importDays}
            min={1}
            max={90}
            onChange={e => setImportDays(Number(e.target.value))}
            style={{
              width: 52, padding: '5px 8px', border: '1px solid var(--gray-300)',
              borderRadius: 6, fontSize: '0.85rem', textAlign: 'center',
            }}
          />
          <span style={{ fontSize: '0.8rem', color: 'var(--gray-600)' }}>days</span>
          <button
            onClick={handleImport}
            disabled={importing}
            style={{
              background: importing ? 'var(--gray-300)' : 'var(--navy)',
              color: '#fff', border: 'none', borderRadius: 6,
              padding: '6px 14px', fontSize: '0.8rem', fontWeight: 600,
              cursor: importing ? 'not-allowed' : 'pointer',
            }}
          >
            {importing ? 'Importing…' : 'Import from InSync'}
          </button>
        </div>
      </div>

      {/* Import result banner */}
      {lastImport && (
        <div style={{
          marginBottom: 16,
          padding: '10px 14px',
          borderRadius: 6,
          background: lastImport.error ? '#fee2e2' : '#dcfce7',
          color: lastImport.error ? '#b91c1c' : '#15803d',
          fontSize: '0.8rem',
          border: `1px solid ${lastImport.error ? '#fca5a5' : '#86efac'}`,
        }}>
          {lastImport.error ? (
            <span>Import failed: {lastImport.error}</span>
          ) : (
            <div>
              <div>
                Import complete · {lastImport.clients_checked} clients ·{' '}
                {lastImport.total_encounters ?? '?'} total encounters found ·{' '}
                {lastImport.peer_notes_found} peer notes ·{' '}
                {lastImport.upserted} upserted
                {lastImport.errors?.length > 0 && (
                  <span style={{ marginLeft: 8, color: '#b45309' }}>
                    · {lastImport.errors.length} error{lastImport.errors.length !== 1 ? 's' : ''}: {lastImport.errors.join('; ')}
                  </span>
                )}
              </div>
              {lastImport.client_detail?.length > 0 && (
                <div style={{ marginTop: 8, fontSize: '0.75rem', color: 'inherit', opacity: 0.85 }}>
                  {lastImport.client_detail.map((c, i) => (
                    <div key={i}>
                      [{c.pid}] {c.client}: {c.encounters} enc · {c.peer_total ?? 0} peer total · {c.peer_in_window ?? 0} in window
                      {c.peer_dates?.length > 0 ? ` · dates: ${c.peer_dates.join(', ')}` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 6, background: '#fee2e2', color: '#b91c1c', fontSize: '0.8rem' }}>
          {error}
        </div>
      )}

      {/* Table */}
      <div style={{ background: '#fff', border: '1px solid var(--gray-200)', borderRadius: 8, overflow: 'hidden' }}>
        {/* Column headers */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '8px 16px',
          background: 'var(--gray-50)',
          borderBottom: '1px solid var(--gray-200)',
          fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.05em', color: 'var(--gray-500)',
        }}>
          <div style={{ minWidth: 100 }}>Date</div>
          <div style={{ minWidth: 160 }}>Client</div>
          <div style={{ minWidth: 140 }}>Type</div>
          <div style={{ minWidth: 140 }}>Provider</div>
          <div style={{ flex: 1 }}>Note</div>
          <div style={{ width: 16 }} />
        </div>

        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--gray-400)', fontSize: '0.85rem' }}>
            Loading…
          </div>
        ) : notes.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--gray-400)', fontSize: '0.85rem' }}>
            No peer notes yet. Click "Import from InSync" to pull notes.
          </div>
        ) : (
          notes.map(n => <NoteRow key={n.id} note={n} />)
        )}
      </div>
    </div>
  );
}

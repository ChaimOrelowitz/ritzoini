import { useState, useRef } from 'react';
import { api } from '../../utils/api';

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.slice(0,5).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtDate(d) {
  if (!d) return '—';
  const [y, mo, day] = d.split('-');
  return `${parseInt(mo)}/${parseInt(day)}/${y}`;
}

export default function BulkImportModal({ onClose, onImported }) {
  const fileInputRef = useRef(null);
  const [dragging,  setDragging]  = useState(false);
  const [stage,     setStage]     = useState('upload'); // upload | parsing | preview | done
  const [error,     setError]     = useState('');
  const [groups,    setGroups]    = useState([]);
  const [results,   setResults]   = useState(null);
  const [confirming, setConfirming] = useState(false);

  async function handleFile(file) {
    if (!file) return;
    setError('');
    setStage('parsing');
    try {
      const { groups: parsed } = await api.parseBulkImport(file);
      setGroups(parsed.map(g => ({ ...g, include: true })));
      setStage('preview');
    } catch (err) {
      setError(err.message);
      setStage('upload');
    }
  }

  function updateGroup(i, field, value) {
    setGroups(prev => prev.map((g, idx) => idx === i ? { ...g, [field]: value } : g));
  }

  async function handleConfirm() {
    const toImport = groups.filter(g => g.include);
    if (!toImport.length) { setError('Select at least one group to import.'); return; }
    setConfirming(true); setError('');
    try {
      const { results } = await api.confirmBulkImport(toImport);
      setResults(results);
      setStage('done');
    } catch (err) { setError(err.message); }
    finally { setConfirming(false); }
  }

  const includedCount = groups.filter(g => g.include).length;

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 980, width: '95vw' }}>
        <div className="modal-header">
          <h3>Bulk Import Groups</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

          {/* ── Stage: Upload ── */}
          {stage === 'upload' && (
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); }}
              onClick={() => fileInputRef.current.click()}
              style={{
                border: `2px dashed ${dragging ? 'var(--navy)' : 'var(--gray-300)'}`,
                borderRadius: 'var(--radius)', padding: '60px 40px',
                textAlign: 'center', cursor: 'pointer',
                background: dragging ? 'var(--gray-50)' : 'white',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ fontSize: '2.5rem', marginBottom: 10 }}>📊</div>
              <div style={{ fontWeight: 700, color: 'var(--navy)', fontSize: '1rem', marginBottom: 4 }}>
                Drop your Excel file here
              </div>
              <div style={{ fontSize: '0.82rem', color: 'var(--gray-400)' }}>
                or click to browse · Export from Google Sheets as .xlsx
              </div>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls"
                style={{ display: 'none' }}
                onChange={e => handleFile(e.target.files[0])} />
            </div>
          )}

          {/* ── Stage: Parsing ── */}
          {stage === 'parsing' && (
            <div style={{ textAlign: 'center', padding: '60px 40px' }}>
              <div className="spinner" style={{ margin: '0 auto 16px' }} />
              <div style={{ color: 'var(--navy)', fontWeight: 600 }}>Parsing sheet and generating names…</div>
              <div style={{ color: 'var(--gray-400)', fontSize: '0.82rem', marginTop: 6 }}>Claude is naming your groups</div>
            </div>
          )}

          {/* ── Stage: Preview ── */}
          {stage === 'preview' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: '0.85rem', color: 'var(--gray-600)' }}>
                  Found <strong>{groups.length}</strong> groups to import · <strong>{includedCount}</strong> selected
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-outline btn-xs"
                    onClick={() => setGroups(g => g.map(x => ({ ...x, include: true })))}>
                    Select All
                  </button>
                  <button className="btn btn-outline btn-xs"
                    onClick={() => setGroups(g => g.map(x => ({ ...x, include: false })))}>
                    Deselect All
                  </button>
                </div>
              </div>

              <div style={{ overflowX: 'auto', maxHeight: '55vh', overflowY: 'auto', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--gray-50)', position: 'sticky', top: 0, zIndex: 1 }}>
                      <th style={th}>✓</th>
                      <th style={th}>Day / Time</th>
                      <th style={th}>Instructor</th>
                      <th style={th}>Dates</th>
                      <th style={th}>Sessions</th>
                      <th style={th}>Internal Name</th>
                      <th style={th}>Group Name</th>
                      <th style={th}>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g, i) => (
                      <tr key={i} style={{ background: g.include ? 'white' : 'var(--gray-50)', opacity: g.include ? 1 : 0.5 }}>
                        <td style={td}>
                          <input type="checkbox" checked={g.include}
                            onChange={e => updateGroup(i, 'include', e.target.checked)}
                            style={{ width: 14, height: 14, accentColor: 'var(--navy)' }} />
                        </td>
                        <td style={td}>
                          <div style={{ fontWeight: 600, color: 'var(--navy)', whiteSpace: 'nowrap' }}>{g.dayName}</div>
                          <div style={{ color: 'var(--gray-500)' }}>{fmt12(g.time)}</div>
                        </td>
                        <td style={td}>
                          {g.instructor ? (
                            <>
                              <div style={{ whiteSpace: 'nowrap' }}>{g.instructor.first_name} {g.instructor.last_name}</div>
                              <div style={{ color: 'var(--gray-400)' }}>{g.instructor.phone}</div>
                            </>
                          ) : '—'}
                        </td>
                        <td style={td}>
                          <div style={{ whiteSpace: 'nowrap' }}>{fmtDate(g.startDate)}</div>
                          <div style={{ color: 'var(--gray-400)' }}>{fmtDate(g.endDate)}</div>
                        </td>
                        <td style={{ ...td, textAlign: 'center' }}>
                          {g.sessions ?? '—'}
                        </td>
                        <td style={td}>
                          <input
                            className="form-input"
                            style={{ padding: '3px 6px', fontSize: '0.78rem', minWidth: 180 }}
                            value={g.internalName}
                            onChange={e => updateGroup(i, 'internalName', e.target.value)}
                          />
                        </td>
                        <td style={td}>
                          <input
                            className="form-input"
                            style={{ padding: '3px 6px', fontSize: '0.78rem', minWidth: 160 }}
                            value={g.suggestedName}
                            onChange={e => updateGroup(i, 'suggestedName', e.target.value)}
                          />
                        </td>
                        <td style={{ ...td, color: 'var(--gray-400)', fontSize: '0.75rem', maxWidth: 160 }}>
                          {g.cancellations || ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: 12, fontSize: '0.78rem', color: 'var(--gray-400)' }}>
                All groups import with 45 min duration and no supervisor assigned. Edit individually after import.
                Cancellations must be added as skip dates manually.
              </div>
            </>
          )}

          {/* ── Stage: Done ── */}
          {stage === 'done' && results && (
            <div>
              <div style={{ marginBottom: 16, fontWeight: 600, color: 'var(--navy)' }}>
                {results.filter(r => r.success).length} of {results.length} groups imported successfully.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {results.map((r, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 12px', borderRadius: 'var(--radius)',
                    background: r.success ? '#dcfce7' : '#fee2e2',
                    fontSize: '0.85rem',
                  }}>
                    <span>{r.success ? '✅' : '❌'}</span>
                    <span style={{ fontWeight: 600 }}>{r.name}</span>
                    {!r.success && <span style={{ color: '#b91c1c', fontSize: '0.78rem' }}>{r.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          {stage === 'done' ? (
            <button className="btn btn-gold" onClick={() => { onImported(); onClose(); }}>Done</button>
          ) : stage === 'preview' ? (
            <>
              <button className="btn btn-outline" onClick={onClose}>Cancel</button>
              <button className="btn btn-gold" onClick={handleConfirm} disabled={confirming || includedCount === 0}>
                {confirming ? 'Importing…' : `Import ${includedCount} Group${includedCount !== 1 ? 's' : ''}`}
              </button>
            </>
          ) : (
            <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          )}
        </div>
      </div>
    </div>
  );
}

const th = {
  padding: '8px 12px', textAlign: 'left', fontWeight: 700,
  fontSize: '0.72rem', color: 'var(--gray-500)', textTransform: 'uppercase',
  letterSpacing: '0.04em', borderBottom: '1px solid var(--gray-200)',
  whiteSpace: 'nowrap',
};
const td = {
  padding: '8px 12px', borderBottom: '1px solid var(--gray-100)', verticalAlign: 'top',
};

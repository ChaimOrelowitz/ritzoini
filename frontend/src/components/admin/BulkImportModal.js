import { useState } from 'react';
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
  const [pasteText,   setPasteText]   = useState('');
  const [stage,       setStage]       = useState('paste'); // paste | parsing | preview | done
  const [error,       setError]       = useState('');
  const [groups,      setGroups]      = useState([]);
  const [results,     setResults]     = useState(null);
  const [confirming,  setConfirming]  = useState(false);

  async function handleParse() {
    if (!pasteText.trim()) { setError('Paste some rows first.'); return; }
    setError('');
    setStage('parsing');
    try {
      const { groups: parsed } = await api.parseBulkImport(pasteText);
      if (!parsed.length) {
        setError('No importable rows found. Make sure CO Added is FALSE (or empty) for the rows you want to import.');
        setStage('paste');
        return;
      }
      setGroups(parsed.map(g => ({ ...g, include: true })));
      setStage('preview');
    } catch (err) {
      setError(err.message);
      setStage('paste');
    }
  }

  function updateGroup(i, field, value) {
    setGroups(prev => prev.map((g, idx) => idx === i ? { ...g, [field]: value } : g));
  }

  function updateInstructor(i, field, value) {
    setGroups(prev => prev.map((g, idx) => idx === i
      ? { ...g, instructor: { ...(g.instructor || {}), [field]: value } }
      : g
    ));
  }

  async function handleConfirm() {
    const toImport = groups.filter(g => g.include);
    if (!toImport.length) { setError('Select at least one group.'); return; }
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
      <div className="modal" style={{ maxWidth: 1060, width: '96vw' }}>
        <div className="modal-header">
          <h3>Import Groups from Sheet</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

          {/* ── Paste ── */}
          {stage === 'paste' && (
            <div>
              <div style={{ fontSize: '0.85rem', color: 'var(--gray-600)', marginBottom: 10 }}>
                Copy rows from your Google Sheet (including the day header row) and paste below.
                Rows with <strong>CO Added = TRUE</strong> are skipped automatically.
              </div>
              <textarea
                className="form-textarea"
                style={{ minHeight: 220, fontFamily: 'monospace', fontSize: '0.78rem' }}
                placeholder="Paste rows here…"
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
              />
            </div>
          )}

          {/* ── Parsing ── */}
          {stage === 'parsing' && (
            <div style={{ textAlign: 'center', padding: '60px 40px' }}>
              <div className="spinner" style={{ margin: '0 auto 16px' }} />
              <div style={{ color: 'var(--navy)', fontWeight: 600 }}>Parsing and generating group names…</div>
              <div style={{ color: 'var(--gray-400)', fontSize: '0.82rem', marginTop: 6 }}>Claude is naming your groups</div>
            </div>
          )}

          {/* ── Preview ── */}
          {stage === 'preview' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ fontSize: '0.85rem', color: 'var(--gray-600)' }}>
                  <strong>{groups.length}</strong> groups found · <strong>{includedCount}</strong> selected
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-outline btn-xs" onClick={() => setGroups(g => g.map(x => ({ ...x, include: true })))}>All</button>
                  <button className="btn btn-outline btn-xs" onClick={() => setGroups(g => g.map(x => ({ ...x, include: false })))}>None</button>
                </div>
              </div>

              <div style={{ overflowX: 'auto', maxHeight: '60vh', overflowY: 'auto', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--gray-50)', position: 'sticky', top: 0, zIndex: 1 }}>
                      {['✓','Day / Time','Instructor','Dates','Sess.','Internal Name','Group Name','Description','Notes'].map(h => (
                        <th key={h} style={th}>{h}</th>
                      ))}
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
                        <td style={{ ...td, minWidth: 140 }}>
                          <input className="form-input" style={inp}
                            placeholder="First" value={g.instructor?.first_name || ''}
                            onChange={e => updateInstructor(i, 'first_name', e.target.value)} />
                          <input className="form-input" style={{ ...inp, marginTop: 3 }}
                            placeholder="Last" value={g.instructor?.last_name || ''}
                            onChange={e => updateInstructor(i, 'last_name', e.target.value)} />
                          <input className="form-input" style={{ ...inp, marginTop: 3, color: 'var(--gray-400)' }}
                            placeholder="Phone" value={g.instructor?.phone || ''}
                            onChange={e => updateInstructor(i, 'phone', e.target.value)} />
                        </td>
                        <td style={{ ...td, whiteSpace: 'nowrap' }}>
                          <div>{fmtDate(g.startDate)}</div>
                          <div style={{ color: 'var(--gray-400)' }}>{fmtDate(g.endDate)}</div>
                        </td>
                        <td style={{ ...td, textAlign: 'center' }}>{g.sessions ?? '—'}</td>
                        <td style={{ ...td, minWidth: 190 }}>
                          <input className="form-input" style={inp}
                            value={g.internalName}
                            onChange={e => updateGroup(i, 'internalName', e.target.value)} />
                        </td>
                        <td style={{ ...td, minWidth: 150 }}>
                          <input className="form-input" style={inp}
                            value={g.suggestedName}
                            onChange={e => updateGroup(i, 'suggestedName', e.target.value)} />
                        </td>
                        <td style={{ ...td, minWidth: 180 }}>
                          <textarea className="form-textarea" style={{ ...inp, minHeight: 68, resize: 'vertical' }}
                            value={g.description}
                            onChange={e => updateGroup(i, 'description', e.target.value)} />
                        </td>
                        <td style={{ ...td, color: 'var(--gray-400)', fontSize: '0.75rem', maxWidth: 140 }}>
                          {g.cancellations || ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 10, fontSize: '0.78rem', color: 'var(--gray-400)' }}>
                All groups import with 45 min duration, no supervisor. Edit individually after import. Skip dates must be added manually.
              </div>
            </>
          )}

          {/* ── Done ── */}
          {stage === 'done' && results && (
            <div>
              <div style={{ marginBottom: 14, fontWeight: 600, color: 'var(--navy)' }}>
                {results.filter(r => r.success).length} of {results.length} groups imported.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {results.map((r, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 12px', borderRadius: 'var(--radius)',
                    background: r.success ? '#dcfce7' : '#fee2e2', fontSize: '0.85rem',
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
              <button className="btn btn-outline" onClick={() => setStage('paste')}>← Back</button>
              <button className="btn btn-gold" onClick={handleConfirm} disabled={confirming || includedCount === 0}>
                {confirming ? 'Importing…' : `Import ${includedCount} Group${includedCount !== 1 ? 's' : ''}`}
              </button>
            </>
          ) : stage === 'paste' ? (
            <>
              <button className="btn btn-outline" onClick={onClose}>Cancel</button>
              <button className="btn btn-gold" onClick={handleParse} disabled={!pasteText.trim()}>
                Parse →
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
  letterSpacing: '0.04em', borderBottom: '1px solid var(--gray-200)', whiteSpace: 'nowrap',
};
const td = { padding: '8px 12px', borderBottom: '1px solid var(--gray-100)', verticalAlign: 'top' };
const inp = { padding: '3px 6px', fontSize: '0.78rem', width: '100%' };

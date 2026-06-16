import { useState, useEffect } from 'react';
import { api } from '../utils/api';

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

const STATUS_STYLE = {
  pending_match:       { label: 'Processing…',          bg: 'var(--gray-100)', color: 'var(--gray-500)' },
  pending_appointment: { label: 'Waiting for session',  bg: '#fef3c7',         color: '#92400e' },
  attached:            { label: 'Attached',             bg: '#dcfce7',         color: '#15803d' },
  unmatched:           { label: 'Unmatched',            bg: '#fee2e2',         color: '#b91c1c' },
  download_failed:     { label: 'Download failed',      bg: '#fee2e2',         color: '#b91c1c' },
};

function StatusBadge({ status }) {
  const s = STATUS_STYLE[status] || { label: status, bg: 'var(--gray-100)', color: 'var(--gray-500)' };
  return (
    <span style={{
      fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
      background: s.bg, color: s.color, borderRadius: 4, padding: '2px 7px', whiteSpace: 'nowrap',
    }}>
      {s.label}
    </span>
  );
}

function TranscriptRow({ t }) {
  const [expanded, setExpanded] = useState(false);
  const clientName = t.matched_client
    ? `${t.matched_client.last_name}, ${t.matched_client.first_name}`
    : t.candidate_clients?.length
      ? `Could be: ${t.candidate_clients.map(c => `${c.first_name} ${c.last_name}`).join(' or ')}`
      : '—';
  const apptLabel = t.matched_appointment
    ? `${t.matched_appointment.date} ${(t.matched_appointment.time || '').slice(0, 5)}`
    : '—';

  return (
    <>
      <tr
        onClick={() => setExpanded(e => !e)}
        style={{ cursor: 'pointer', borderBottom: '1px solid var(--gray-100)' }}
      >
        <td style={{ padding: '8px 10px', width: 20, color: 'var(--gray-300)', fontSize: '0.7rem' }}>
          {expanded ? '▾' : '▸'}
        </td>
        <td style={{ padding: '8px 10px', fontSize: '0.82rem', whiteSpace: 'nowrap' }}>{fmtDateTime(t.call_date_time)}</td>
        <td style={{ padding: '8px 10px', fontSize: '0.82rem' }}>{t.other_party_number || '—'}</td>
        <td style={{ padding: '8px 10px' }}><StatusBadge status={t.status} /></td>
        <td style={{ padding: '8px 10px', fontSize: '0.82rem' }}>{clientName}</td>
        <td style={{ padding: '8px 10px', fontSize: '0.82rem', color: 'var(--gray-500)' }}>{apptLabel}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} style={{ padding: '0 10px 14px 34px', background: 'var(--gray-50)' }}>
            {t.status === 'download_failed' && t.error_detail && (
              <div style={{ fontSize: '0.78rem', color: '#b91c1c', marginBottom: 6 }}>Error: {t.error_detail}</div>
            )}
            <pre style={{
              whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: '0.82rem',
              color: 'var(--gray-700)', margin: 0, padding: '8px 10px',
              background: 'white', border: '1px solid var(--gray-200)', borderRadius: 6,
              maxHeight: 300, overflowY: 'auto',
            }}>
              {t.transcript_text || '(no transcript text)'}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

export default function OOTranscriptsPage() {
  const [transcripts, setTranscripts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/zoom/transcripts')
      .then(d => setTranscripts(d.transcripts || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const attachedCount = transcripts.filter(t => t.status === 'attached').length;
  const needsAttentionCount = transcripts.filter(t => ['unmatched', 'download_failed'].includes(t.status)).length;

  return (
    <div style={{ padding: '28px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Call Transcripts</h2>
        {!loading && (
          <span style={{ fontSize: '0.8rem', color: 'var(--gray-500)' }}>
            {transcripts.length} logged · {attachedCount} attached
            {needsAttentionCount > 0 && <span style={{ color: '#b91c1c' }}> · {needsAttentionCount} need attention</span>}
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--gray-400)' }}>Loading…</div>
      ) : transcripts.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📞</div>
          <p>No Zoom Phone transcripts logged yet.</p>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--gray-50)', borderBottom: '1px solid var(--gray-100)' }}>
                <th></th>
                {['Call Time', 'Phone', 'Status', 'Client', 'Appointment'].map(h => (
                  <th key={h} style={{
                    padding: '8px 10px', textAlign: 'left', fontSize: '0.68rem', fontWeight: 700,
                    color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {transcripts.map(t => <TranscriptRow key={t.id} t={t} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

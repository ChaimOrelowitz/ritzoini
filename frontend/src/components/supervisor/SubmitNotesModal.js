import { useState } from 'react';
import { api } from '../../utils/api';

export default function SubmitNotesModal({ session, onClose, onSubmitted }) {
  const [notes, setNotes] = useState(session.notes || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!notes.trim()) return setError('Please enter notes before submitting.');
    setLoading(true);
    setError('');
    try {
      await api.submitNotes(session.id, notes);
      onSubmitted();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h3>Session #{session.session_number} Notes</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="alert alert-error">{error}</div>}

            <div style={{ background: 'var(--gray-50)', borderRadius: 'var(--radius)', padding: '12px 16px', marginBottom: '18px', fontSize: '0.85rem', color: 'var(--gray-600)' }}>
              📅 {new Date(session.scheduled_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              {' '} at {session.scheduled_time?.slice(0, 5)}
            </div>

            <div className="form-group">
              <label className="form-label">Session Notes</label>
              <textarea
                className="form-textarea"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Describe what happened during this session…"
                rows={6}
                required
              />
            </div>

            <div style={{ background: '#fef3c7', borderRadius: 'var(--radius)', padding: '10px 14px', fontSize: '0.8rem', color: '#92400e' }}>
              ✉️ Submitting will mark this session as complete and send the notes to the designated email address.
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-gold" disabled={loading}>
              {loading ? 'Submitting…' : 'Submit & Send Email'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import supabase from '../supabaseClient';

export default function SetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [ready, setReady]       = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    // Supabase JS automatically exchanges the token hash on page load.
    // We listen for the session to be established before showing the form.
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if ((event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY') && session?.user) {
        setReady(true);
      }
    });

    // In case the session is already established before the listener fires
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setReady(true);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords do not match'); return; }
    if (password.length < 6)  { setError('Password must be at least 6 characters'); return; }
    setLoading(true); setError('');
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { setError(error.message); setLoading(false); return; }
    navigate('/');
  }

  if (!ready) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-logo"><h1>Ritzoini</h1></div>
          <p style={{ textAlign: 'center', color: 'var(--gray-500)', marginTop: 12 }}>Verifying your link…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <h1>Ritzoini</h1>
          <p>Set your password</p>
        </div>

        {error && <div className="login-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">New Password</label>
            <input
              className="form-input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label">Confirm Password</label>
            <input
              className="form-input"
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center', padding: '13px', marginTop: '8px' }}
            disabled={loading}
          >
            {loading ? 'Setting password…' : 'Set Password'}
          </button>
        </form>
      </div>
    </div>
  );
}

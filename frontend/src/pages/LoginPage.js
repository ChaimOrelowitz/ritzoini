import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import supabase from '../supabaseClient';

export default function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [forgotMode, setForgotMode] = useState(false);
  const [resetSent, setResetSent]   = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error } = await signIn(email, password);
    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      navigate('/');
    }
  }

  async function handleForgot(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://ritzoini.vercel.app/set-password',
    });
    setLoading(false);
    if (error) { setError(error.message); return; }
    setResetSent(true);
  }

  if (forgotMode) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-logo">
            <h1>Ritzoini</h1>
            <p>Reset your password</p>
          </div>

          {error && <div className="login-error">{error}</div>}

          {resetSent ? (
            <div style={{ textAlign: 'center' }}>
              <p style={{ color: 'var(--gray-600)', marginBottom: 20 }}>
                Check your email for a reset link.
              </p>
              <button className="btn btn-outline" onClick={() => { setForgotMode(false); setResetSent(false); }}>
                Back to Sign In
              </button>
            </div>
          ) : (
            <form onSubmit={handleForgot}>
              <div className="form-group">
                <label className="form-label">Email</label>
                <input
                  className="form-input"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                />
              </div>
              <button
                type="submit"
                className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center', padding: '13px', marginTop: '8px' }}
                disabled={loading}
              >
                {loading ? 'Sending…' : 'Send Reset Link'}
              </button>
              <button
                type="button"
                className="btn btn-outline"
                style={{ width: '100%', justifyContent: 'center', marginTop: '8px' }}
                onClick={() => { setForgotMode(false); setError(''); }}
              >
                Back to Sign In
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <h1>Ritzoini</h1>
          <p>Group Management Platform</p>
        </div>

        {error && <div className="login-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input
              className="form-input"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              className="form-input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
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
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <button
          type="button"
          className="btn btn-outline"
          style={{ width: '100%', justifyContent: 'center', marginTop: '8px' }}
          onClick={() => { setForgotMode(true); setError(''); }}
        >
          Forgot password?
        </button>
      </div>
    </div>
  );
}

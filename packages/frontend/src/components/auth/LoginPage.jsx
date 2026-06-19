import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';

/* Login screen (BRD §7.8). Renders standalone when there's no session. */
export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    const res = await login(email.trim(), password);
    setBusy(false);
    if (!res.ok) setError(res.error);
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-main)' }}>
      <form onSubmit={submit} className="card" style={{ width: 360, padding: 32 }}>
        <div style={{ fontSize: '1.4rem', fontWeight: 800, marginBottom: 4 }}>Synapse</div>
        <div style={{ fontSize: '.85rem', color: 'var(--text-dim)', marginBottom: 20 }}>Sign in to continue</div>

        <label style={{ fontSize: '.78rem', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Email</label>
        <input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@synapse.local"
          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', marginBottom: 14 }} />

        <label style={{ fontSize: '.78rem', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', marginBottom: 16 }} />

        {error && <div style={{ color: 'var(--error)', fontSize: '.82rem', marginBottom: 12 }}>{error}</div>}

        <button type="submit" className="btn btn-primary" disabled={busy || !email || !password} style={{ width: '100%' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

import { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useTheme } from '../../hooks/useTheme';
import Button from '../ui/Button';
import Icon from '../ui/Icon';
import nalashaaLogo from '../../assets/nalashaa-logo1.png';

/* Login screen (BRD §7.8). Renders standalone when there's no session — it is the
   first thing anyone sees, so it uses the real design system rather than the
   hand-rolled inline boxes it started as.

   Deliberately NOT here: "Forgot password" and SSO. Neither has a backend, and a
   link that does nothing is exactly the fake-surface problem the credibility pass
   removed everywhere else. They belong here the day the endpoints exist. */
export default function LoginPage() {
  const { login } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  // Bumped on each failure so the shake re-triggers even for the same error text.
  const [failCount, setFailCount] = useState(0);

  const submit = async (e) => {
    e.preventDefault();
    /* Submit stays ENABLED when the fields are empty and says what is missing.
       It used to be disabled, which reads as a broken button: no focus, no
       hover, and nothing explaining what would make it work. */
    if (!email.trim() || !password) {
      setError(!email.trim() && !password
        ? 'Enter your email and password.'
        : !email.trim() ? 'Enter your email.' : 'Enter your password.');
      setFailCount((n) => n + 1);
      return;
    }
    setBusy(true); setError('');
    const res = await login(email.trim(), password);
    setBusy(false);
    if (!res.ok) { setError(res.error); setFailCount((n) => n + 1); }
  };

  // getModifierState is only meaningful on a real key event, so it is read on both
  // key phases — pressing or releasing Caps Lock itself must update the hint.
  const trackCaps = (e) => {
    if (typeof e.getModifierState === 'function') setCapsLock(e.getModifierState('CapsLock'));
  };

  return (
    <div className="login-page">
      {/* Without this the user is locked into whatever theme happens to load,
          on the one screen where they cannot reach the topbar's toggle. */}
      <button type="button" className="theme-toggle login-theme" onClick={toggleTheme}
        title="Toggle theme" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}>
        <Icon name={theme === 'light' ? 'sun' : 'moon'} size={17} />
      </button>

      <form key={failCount} onSubmit={submit} className={`card login-card${failCount ? ' shake' : ''}`} noValidate>
        <div className="login-brand">
          <img src={nalashaaLogo} alt="Nalashaa — Think Simple. Build Powerful."
            className="login-logo" width="360" height="115" />
        </div>
        <h1 className="login-title">Synapse</h1>
        <p className="login-sub">Sign in to continue</p>

        <label className="login-label" htmlFor="loginpage-email">Email</label>
        <input id="loginpage-email" className="login-input" type="email" autoComplete="username"
          autoFocus value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="admin@synapse.local" />

        <label className="login-label" htmlFor="loginpage-password">Password</label>
        <div className="password-wrap login-pw">
          <input id="loginpage-password" className="login-input" type={showPw ? 'text' : 'password'}
            autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={trackCaps} onKeyUp={trackCaps} onBlur={() => setCapsLock(false)} />
          <button type="button" className="eye-btn" onClick={() => setShowPw((v) => !v)}
            aria-pressed={showPw} aria-label={showPw ? 'Hide password' : 'Show password'}
            title={showPw ? 'Hide password' : 'Show password'}>&#128065;</button>
        </div>
        {/* A wrong password because Caps Lock is on is the single most common
            self-inflicted sign-in failure, and the field hides the evidence. */}
        {capsLock && <p className="login-hint" role="status">Caps Lock is on.</p>}

        {/* role=alert so a failed sign-in is announced, not just shown. */}
        {error && <p className="login-error" role="alert">{error}</p>}

        <Button type="submit" className="btn btn-primary login-submit"
          loading={busy} loadingLabel="Signing in">
          Sign in
        </Button>
      </form>
    </div>
  );
}

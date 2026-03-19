import React, { useState } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:8008';

export default function LoginPage({ onLogin }) {
  const [view,     setView]     = useState('login'); // login | forgot | otp | ask-trial | activate
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [name,     setName]     = useState('');
  const [company,  setCompany]  = useState('');
  const [message,  setMessage]  = useState('');
  const [otp,      setOtp]      = useState('');
  const [newPass,  setNewPass]  = useState('');
  const [newPass2, setNewPass2] = useState('');
  const [activationToken, setActivationToken] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState('');

  // Check for activation token in URL hash on mount
  React.useEffect(() => {
    const hash = window.location.hash;
    const m = hash.match(/[#&]?activate\?token=([a-f0-9]+)/i) ||
              hash.match(/activate%3Ftoken%3D([a-f0-9]+)/i);
    if (m) {
      setActivationToken(m[1]);
      setView('activate');
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const clearMessages = () => { setError(''); setSuccess(''); };

  // ── Login ─────────────────────────────────────────────────────────────────
  const handleLogin = async (e) => {
    e.preventDefault();
    clearMessages();
    setLoading(true);
    try {
      const r = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || 'Login failed');
      localStorage.setItem('sf2d_token', d.access_token);
      localStorage.setItem('sf2d_user', JSON.stringify(d.user));
      onLogin(d.user, d.access_token);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  // ── Forgot Password ───────────────────────────────────────────────────────
  const handleForgot = async (e) => {
    e.preventDefault();
    clearMessages();
    setLoading(true);
    try {
      const r = await fetch(`${API}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || 'Request failed');
      setSuccess(d.message);
      setView('otp');
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  // ── Reset Password (OTP) ──────────────────────────────────────────────────
  const handleReset = async (e) => {
    e.preventDefault();
    clearMessages();
    if (newPass !== newPass2) { setError('Passwords do not match.'); return; }
    if (newPass.length < 8)   { setError('Password must be at least 8 characters.'); return; }
    setLoading(true);
    try {
      const r = await fetch(`${API}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), otp, new_password: newPass }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || 'Reset failed');
      setSuccess('Password reset! You can now log in.');
      setTimeout(() => { setView('login'); setSuccess(''); }, 2000);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  // ── Ask Trial ─────────────────────────────────────────────────────────────
  const handleTrial = async (e) => {
    e.preventDefault();
    clearMessages();
    if (!name.trim()) { setError('Name is required.'); return; }
    setLoading(true);
    try {
      const r = await fetch(`${API}/auth/ask-trial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim().toLowerCase(), company, message }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || 'Request failed');
      setSuccess(d.message);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  // ── Activate Account ──────────────────────────────────────────────────────
  const handleActivate = async (e) => {
    e.preventDefault();
    clearMessages();
    if (newPass !== newPass2) { setError('Passwords do not match.'); return; }
    if (newPass.length < 8)   { setError('Password must be at least 8 characters.'); return; }
    setLoading(true);
    try {
      const r = await fetch(`${API}/auth/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: activationToken, password: newPass }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || 'Activation failed');
      localStorage.setItem('sf2d_token', d.access_token);
      localStorage.setItem('sf2d_user', JSON.stringify(d.user));
      onLogin(d.user, d.access_token);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  // ── Resend OTP ────────────────────────────────────────────────────────────
  const handleResendOtp = async () => {
    clearMessages();
    await fetch(`${API}/auth/resend-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim().toLowerCase(), purpose: 'reset-password' }),
    });
    setSuccess('OTP resent to your email.');
  };

  return (
    <div className="auth-bg">
      {/* Background grid decoration */}
      <div className="auth-grid-overlay" />

      <div className="auth-card-wrap">
        {/* Logo */}
        <div className="auth-logo">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="#23a55a"/>
            <path d="M8 16 L16 8 L24 16 L16 24 Z" fill="none" stroke="white" strokeWidth="2"/>
            <circle cx="16" cy="16" r="3" fill="white"/>
          </svg>
          <span className="auth-logo-text">SF → D365</span>
        </div>
        <div className="auth-logo-sub">Migration Wizard · by Gruve AI</div>

        <div className="auth-card">

          {/* ── LOGIN ── */}
          {view === 'login' && (
            <>
              <div className="auth-card-header">
                <h1 className="auth-card-title">Welcome back</h1>
                <p className="auth-card-sub">Sign in to your account</p>
              </div>
              <form onSubmit={handleLogin} className="auth-form">
                <div className="auth-field">
                  <label className="auth-label">Email</label>
                  <input className="auth-input" type="email" placeholder="you@company.com"
                    value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
                </div>
                <div className="auth-field">
                  <label className="auth-label">
                    Password
                    <button type="button" className="auth-link-btn" onClick={() => { clearMessages(); setView('forgot'); }}>
                      Forgot password?
                    </button>
                  </label>
                  <input className="auth-input" type="password" placeholder="••••••••"
                    value={password} onChange={e => setPassword(e.target.value)} required />
                </div>
                {error   && <div className="auth-error">{error}</div>}
                {success && <div className="auth-success">{success}</div>}
                <button className="auth-btn-primary" type="submit" disabled={loading}>
                  {loading ? <span className="auth-spinner"/> : 'Sign In'}
                </button>
              </form>
              <div className="auth-divider"><span>Don't have access?</span></div>
              <button className="auth-btn-secondary" onClick={() => { clearMessages(); setView('ask-trial'); }}>
                Request a Trial
              </button>
            </>
          )}

          {/* ── FORGOT PASSWORD ── */}
          {view === 'forgot' && (
            <>
              <div className="auth-card-header">
                <h1 className="auth-card-title">Reset password</h1>
                <p className="auth-card-sub">Enter your email to receive a reset code</p>
              </div>
              <form onSubmit={handleForgot} className="auth-form">
                <div className="auth-field">
                  <label className="auth-label">Email</label>
                  <input className="auth-input" type="email" placeholder="you@company.com"
                    value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
                </div>
                {error   && <div className="auth-error">{error}</div>}
                {success && <div className="auth-success">{success}</div>}
                <button className="auth-btn-primary" type="submit" disabled={loading}>
                  {loading ? <span className="auth-spinner"/> : 'Send Reset Code'}
                </button>
              </form>
              <button className="auth-back-btn" onClick={() => { clearMessages(); setView('login'); }}>
                ← Back to login
              </button>
            </>
          )}

          {/* ── OTP + NEW PASSWORD ── */}
          {view === 'otp' && (
            <>
              <div className="auth-card-header">
                <h1 className="auth-card-title">Enter reset code</h1>
                <p className="auth-card-sub">Check your email for a 6-digit code sent to <strong>{email}</strong></p>
              </div>
              <form onSubmit={handleReset} className="auth-form">
                <div className="auth-field">
                  <label className="auth-label">6-digit OTP</label>
                  <input className="auth-input auth-otp-input" type="text" placeholder="000000"
                    maxLength={6} value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                    required autoFocus />
                </div>
                <div className="auth-field">
                  <label className="auth-label">New Password</label>
                  <input className="auth-input" type="password" placeholder="Min 8 characters"
                    value={newPass} onChange={e => setNewPass(e.target.value)} required />
                </div>
                <div className="auth-field">
                  <label className="auth-label">Confirm Password</label>
                  <input className="auth-input" type="password" placeholder="Repeat password"
                    value={newPass2} onChange={e => setNewPass2(e.target.value)} required />
                </div>
                {error   && <div className="auth-error">{error}</div>}
                {success && <div className="auth-success">{success}</div>}
                <button className="auth-btn-primary" type="submit" disabled={loading}>
                  {loading ? <span className="auth-spinner"/> : 'Reset Password'}
                </button>
              </form>
              <div className="auth-otp-footer">
                Didn't get the code?{' '}
                <button type="button" className="auth-link-btn" onClick={handleResendOtp}>Resend</button>
              </div>
              <button className="auth-back-btn" onClick={() => { clearMessages(); setView('login'); }}>
                ← Back to login
              </button>
            </>
          )}

          {/* ── ASK TRIAL ── */}
          {view === 'ask-trial' && (
            <>
              <div className="auth-card-header">
                <h1 className="auth-card-title">Request Trial Access</h1>
                <p className="auth-card-sub">Tell us about yourself and we'll get back to you shortly</p>
              </div>
              {success ? (
                <div className="auth-trial-success">
                  <div className="auth-trial-success-icon">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#23a55a" strokeWidth="2">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                      <polyline points="22 4 12 14.01 9 11.01"/>
                    </svg>
                  </div>
                  <h3>Request Submitted!</h3>
                  <p>{success}</p>
                  <button className="auth-btn-secondary" onClick={() => { clearMessages(); setView('login'); }}>
                    Back to Login
                  </button>
                </div>
              ) : (
                <form onSubmit={handleTrial} className="auth-form">
                  <div className="auth-field">
                    <label className="auth-label">Full Name *</label>
                    <input className="auth-input" type="text" placeholder="John Smith"
                      value={name} onChange={e => setName(e.target.value)} required autoFocus />
                  </div>
                  <div className="auth-field">
                    <label className="auth-label">Work Email *</label>
                    <input className="auth-input" type="email" placeholder="john@company.com"
                      value={email} onChange={e => setEmail(e.target.value)} required />
                  </div>
                  <div className="auth-field">
                    <label className="auth-label">Company</label>
                    <input className="auth-input" type="text" placeholder="Acme Corp"
                      value={company} onChange={e => setCompany(e.target.value)} />
                  </div>
                  <div className="auth-field">
                    <label className="auth-label">Why are you interested?</label>
                    <textarea className="auth-input auth-textarea" rows={3}
                      placeholder="Tell us about your migration project..."
                      value={message} onChange={e => setMessage(e.target.value)} />
                  </div>
                  {error && <div className="auth-error">{error}</div>}
                  <button className="auth-btn-primary" type="submit" disabled={loading}>
                    {loading ? <span className="auth-spinner"/> : 'Submit Request'}
                  </button>
                </form>
              )}
              {!success && (
                <button className="auth-back-btn" onClick={() => { clearMessages(); setView('login'); }}>
                  ← Back to login
                </button>
              )}
            </>
          )}

          {/* ── ACTIVATE ACCOUNT ── */}
          {view === 'activate' && (
            <>
              <div className="auth-card-header">
                <div className="auth-activate-badge">Trial Approved ✓</div>
                <h1 className="auth-card-title">Set Your Password</h1>
                <p className="auth-card-sub">Create a password to activate your account</p>
              </div>
              <form onSubmit={handleActivate} className="auth-form">
                <div className="auth-field">
                  <label className="auth-label">New Password</label>
                  <input className="auth-input" type="password" placeholder="Min 8 characters"
                    value={newPass} onChange={e => setNewPass(e.target.value)} required autoFocus />
                </div>
                <div className="auth-field">
                  <label className="auth-label">Confirm Password</label>
                  <input className="auth-input" type="password" placeholder="Repeat password"
                    value={newPass2} onChange={e => setNewPass2(e.target.value)} required />
                </div>
                {error   && <div className="auth-error">{error}</div>}
                {success && <div className="auth-success">{success}</div>}
                <button className="auth-btn-primary" type="submit" disabled={loading}>
                  {loading ? <span className="auth-spinner"/> : 'Activate & Sign In'}
                </button>
              </form>
            </>
          )}

        </div>

        <div className="auth-footer">
          SF→D365 Migration Wizard &copy; {new Date().getFullYear()} Gruve AI
        </div>
      </div>
    </div>
  );
}

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:8008';

function authHeaders() {
  const token = localStorage.getItem('sf2d_token');
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/* ── Stat Card ─────────────────────────────────────────────────────── */
function StatCard({ label, value, color = '#23a55a' }) {
  return (
    <div className="adm-stat-card">
      <div className="adm-stat-value" style={{ color }}>{value ?? '—'}</div>
      <div className="adm-stat-label">{label}</div>
    </div>
  );
}

/* ── Badge ─────────────────────────────────────────────────────────── */
function Badge({ label, color }) {
  const colors = {
    green:  { bg: 'rgba(35,165,90,.12)',   text: '#23a55a',   border: 'rgba(35,165,90,.3)' },
    red:    { bg: 'rgba(239,68,68,.12)',   text: '#f85149',   border: 'rgba(239,68,68,.3)' },
    yellow: { bg: 'rgba(245,158,11,.12)', text: '#f59e0b',   border: 'rgba(245,158,11,.3)' },
    blue:   { bg: 'rgba(99,102,241,.12)', text: '#818cf8',   border: 'rgba(99,102,241,.3)' },
    gray:   { bg: 'rgba(139,148,158,.12)', text: '#8b949e',  border: 'rgba(139,148,158,.3)' },
  };
  const c = colors[color] || colors.gray;
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 6,
      background: c.bg, color: c.text, border: `1px solid ${c.border}`, whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

function roleBadge(role)   { return <Badge label={role?.toUpperCase() || '?'} color={role === 'admin' ? 'blue' : 'gray'} />; }
function planBadge(plan)   {
  const c = { enterprise: 'blue', pro: 'green', starter: 'yellow', trial: 'yellow', free: 'gray' };
  return <Badge label={plan?.toUpperCase() || '?'} color={c[plan] || 'gray'} />;
}
function statusBadge(s) {
  const c = { approved: 'green', pending: 'yellow', rejected: 'red' };
  return <Badge label={s || 'unknown'} color={c[s] || 'gray'} />;
}

/* ── Main Admin Users Page ──────────────────────────────────────────── */
export default function AdminUsersPage({ currentUser }) {
  const [tab,          setTab]          = useState('users'); // users | trials | tenants
  const [users,        setUsers]        = useState([]);
  const [trials,       setTrials]       = useState([]);
  const [tenants,      setTenants]      = useState([]);
  const [stats,        setStats]        = useState({});
  const [search,       setSearch]       = useState('');
  const [filterPlan,   setFilterPlan]   = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [modal,        setModal]        = useState(null); // { type, data }
  const [actionMsg,    setActionMsg]    = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [uRes, tRes, teRes, sRes] = await Promise.all([
        fetch(`${API}/admin/users?search=${search}&plan=${filterPlan}&status=${filterStatus}`, { headers: authHeaders() }),
        fetch(`${API}/admin/trial-requests`, { headers: authHeaders() }),
        fetch(`${API}/admin/tenants`,        { headers: authHeaders() }),
        fetch(`${API}/admin/stats`,          { headers: authHeaders() }),
      ]);
      if (!uRes.ok)  throw new Error('Failed to load users');
      setUsers(await uRes.json());
      setTrials(tRes.ok  ? await tRes.json()  : []);
      setTenants(teRes.ok ? await teRes.json() : []);
      setStats(sRes.ok  ? await sRes.json()  : {});
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, [search, filterPlan, filterStatus]);

  useEffect(() => { load(); }, [load]);

  const flashMsg = (msg) => { setActionMsg(msg); setTimeout(() => setActionMsg(''), 4000); };

  /* ── User actions ─────────────────────────────────────────────────── */
  const toggleActive = async (user) => {
    await fetch(`${API}/admin/users/${user.id}`, {
      method: 'PATCH', headers: authHeaders(),
      body: JSON.stringify({ is_active: !user.is_active }),
    });
    flashMsg(`User ${user.is_active ? 'deactivated' : 'activated'}`);
    load();
  };

  const updateUser = async (userId, patch) => {
    const r = await fetch(`${API}/admin/users/${userId}`, {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify(patch),
    });
    if (r.ok) { flashMsg('User updated'); load(); setModal(null); }
    else { const d = await r.json(); setError(d.detail || 'Update failed'); }
  };

  /* ── Trial actions ────────────────────────────────────────────────── */
  const approveTrial = async (tr, days) => {
    const r = await fetch(`${API}/admin/trial-requests/${tr.id}/approve`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ trial_days: days }),
    });
    const d = await r.json();
    flashMsg(r.ok ? d.message : d.detail || 'Failed');
    setModal(null);
    load();
  };

  const rejectTrial = async (tr, reason) => {
    const r = await fetch(`${API}/admin/trial-requests/${tr.id}/reject`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ reason }),
    });
    const d = await r.json();
    flashMsg(r.ok ? d.message : d.detail || 'Failed');
    setModal(null);
    load();
  };

  /* ── Resend Invite ────────────────────────────────────────────────── */
  const resendInvite = async (user) => {
    const r = await fetch(`${API}/admin/users/${user.id}/resend-invite`, {
      method: 'POST', headers: authHeaders(),
    });
    const d = await r.json();
    flashMsg(r.ok ? d.message : d.detail || 'Failed to resend invite');
  };

  /* ── Create User Modal ────────────────────────────────────────────── */
  const CreateUserModal = () => {
    const [form, setForm] = useState({ email: '', name: '', password: '', role: 'user', plan: 'trial', trial_days: 30, tenant_id: '', send_invite: true });
    const [busy, setBusy] = useState(false);
    const [err,  setErr]  = useState('');
    const submit = async (e) => {
      e.preventDefault(); setBusy(true); setErr('');
      const payload = {
        email: form.email, name: form.name, role: form.role,
        plan: form.plan, trial_days: form.trial_days,
        tenant_id: form.tenant_id || null,
        send_invite: form.send_invite,
        password: form.send_invite ? undefined : form.password,
      };
      const r = await fetch(`${API}/admin/users`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (r.ok) { flashMsg(form.send_invite ? `Invite sent to ${form.email}` : 'User created'); setModal(null); load(); }
      else setErr(d.detail || 'Failed');
      setBusy(false);
    };
    return (
      <div className="adm-modal-overlay" onClick={() => setModal(null)}>
        <div className="adm-modal" onClick={e => e.stopPropagation()}>
          <div className="adm-modal-header">
            <span>Create User</span>
            <button className="adm-modal-close" onClick={() => setModal(null)}>✕</button>
          </div>
          <form onSubmit={submit} className="adm-modal-form">
            <div className="adm-form-row">
              <div className="adm-form-field">
                <label>Full Name *</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required placeholder="John Smith" />
              </div>
              <div className="adm-form-field">
                <label>Email *</label>
                <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required placeholder="john@company.com" />
              </div>
            </div>

            {/* Send invite toggle */}
            <label className="adm-toggle-row">
              <input type="checkbox" checked={form.send_invite} onChange={e => setForm(f => ({ ...f, send_invite: e.target.checked }))} />
              <span className="adm-toggle-label">
                <strong>Send activation email</strong>
                <span className="adm-toggle-hint">User sets their own password via email link (recommended)</span>
              </span>
            </label>

            {!form.send_invite && (
              <div className="adm-form-field">
                <label>Password *</label>
                <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required={!form.send_invite} placeholder="Min 8 chars" />
              </div>
            )}

            <div className="adm-form-row">
              <div className="adm-form-field">
                <label>Tenant</label>
                <select value={form.tenant_id} onChange={e => setForm(f => ({ ...f, tenant_id: e.target.value }))}>
                  <option value="">No Tenant</option>
                  {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div className="adm-form-field">
                <label>Role</label>
                <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>
            <div className="adm-form-row">
              <div className="adm-form-field">
                <label>Plan</label>
                <select value={form.plan} onChange={e => setForm(f => ({ ...f, plan: e.target.value }))}>
                  <option value="trial">Trial</option>
                  <option value="starter">Starter</option>
                  <option value="pro">Pro</option>
                  <option value="enterprise">Enterprise</option>
                </select>
              </div>
              {form.plan === 'trial' && (
                <div className="adm-form-field">
                  <label>Trial Days</label>
                  <input type="number" min={1} max={365} value={form.trial_days} onChange={e => setForm(f => ({ ...f, trial_days: +e.target.value }))} />
                </div>
              )}
            </div>
            {err && <div className="auth-error">{err}</div>}
            <div className="adm-modal-actions">
              <button type="button" className="adm-btn adm-btn-ghost" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="adm-btn adm-btn-primary" disabled={busy}>
                {busy ? '…' : form.send_invite ? '✉ Create & Send Invite' : 'Create User'}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  };

  /* ── Edit User Modal ──────────────────────────────────────────────── */
  const EditUserModal = ({ user }) => {
    const [form, setForm] = useState({ name: user.name, role: user.role, plan: user.plan, tenant_id: user.tenant_id || '', trial_days: 30 });
    const submit = (e) => { e.preventDefault(); updateUser(user.id, { ...form, tenant_id: form.tenant_id || null }); };
    return (
      <div className="adm-modal-overlay" onClick={() => setModal(null)}>
        <div className="adm-modal" onClick={e => e.stopPropagation()}>
          <div className="adm-modal-header">
            <span>Edit User — {user.email}</span>
            <button className="adm-modal-close" onClick={() => setModal(null)}>✕</button>
          </div>
          <form onSubmit={submit} className="adm-modal-form">
            <div className="adm-form-row">
              <div className="adm-form-field">
                <label>Name</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="adm-form-field">
                <label>Tenant</label>
                <select value={form.tenant_id} onChange={e => setForm(f => ({ ...f, tenant_id: e.target.value }))}>
                  <option value="">No Tenant</option>
                  {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            </div>
            <div className="adm-form-row">
              <div className="adm-form-field">
                <label>Role</label>
                <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div className="adm-form-field">
                <label>Plan</label>
                <select value={form.plan} onChange={e => setForm(f => ({ ...f, plan: e.target.value }))}>
                  <option value="trial">Trial</option>
                  <option value="starter">Starter</option>
                  <option value="pro">Pro</option>
                  <option value="enterprise">Enterprise</option>
                </select>
              </div>
              {form.plan === 'trial' && (
                <div className="adm-form-field">
                  <label>Extend Trial (days)</label>
                  <input type="number" min={1} max={365} value={form.trial_days} onChange={e => setForm(f => ({ ...f, trial_days: +e.target.value }))} />
                </div>
              )}
            </div>
            <div className="adm-modal-actions">
              <button type="button" className="adm-btn adm-btn-ghost" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="adm-btn adm-btn-primary">Save Changes</button>
            </div>
          </form>
        </div>
      </div>
    );
  };

  /* ── Approve Trial Modal ──────────────────────────────────────────── */
  const ApproveModal = ({ tr }) => {
    const [days, setDays] = useState(30);
    return (
      <div className="adm-modal-overlay" onClick={() => setModal(null)}>
        <div className="adm-modal adm-modal--sm" onClick={e => e.stopPropagation()}>
          <div className="adm-modal-header">
            <span>Approve Trial</span>
            <button className="adm-modal-close" onClick={() => setModal(null)}>✕</button>
          </div>
          <div className="adm-modal-form">
            <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-muted)' }}>
              Approving trial for <strong style={{ color: 'var(--text-primary)' }}>{tr.name}</strong> ({tr.email})
              {tr.company && ` — ${tr.company}`}
            </div>
            <div className="adm-form-field">
              <label>Trial Duration (days)</label>
              <input type="number" min={1} max={365} value={days} onChange={e => setDays(+e.target.value)} />
            </div>
            <div className="adm-modal-actions">
              <button className="adm-btn adm-btn-ghost" onClick={() => setModal(null)}>Cancel</button>
              <button className="adm-btn adm-btn-primary" onClick={() => approveTrial(tr, days)}>
                Approve & Send Email
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  /* ── Reject Trial Modal ───────────────────────────────────────────── */
  const RejectModal = ({ tr }) => {
    const [reason, setReason] = useState('');
    return (
      <div className="adm-modal-overlay" onClick={() => setModal(null)}>
        <div className="adm-modal adm-modal--sm" onClick={e => e.stopPropagation()}>
          <div className="adm-modal-header">
            <span>Reject Trial Request</span>
            <button className="adm-modal-close" onClick={() => setModal(null)}>✕</button>
          </div>
          <div className="adm-modal-form">
            <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-muted)' }}>
              Rejecting request from <strong style={{ color: 'var(--text-primary)' }}>{tr.name}</strong> ({tr.email})
            </div>
            <div className="adm-form-field">
              <label>Reason (optional — sent to user)</label>
              <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="We'll include this in the rejection email..." />
            </div>
            <div className="adm-modal-actions">
              <button className="adm-btn adm-btn-ghost" onClick={() => setModal(null)}>Cancel</button>
              <button className="adm-btn adm-btn-danger" onClick={() => rejectTrial(tr, reason)}>
                Reject & Notify
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  /* ── Create Tenant Modal ──────────────────────────────────────────── */
  const CreateTenantModal = () => {
    const [form, setForm] = useState({ name: '', slug: '', plan: 'trial' });
    const [busy, setBusy] = useState(false);
    const [err, setErr]   = useState('');
    const submit = async (e) => {
      e.preventDefault(); setBusy(true); setErr('');
      const r = await fetch(`${API}/admin/tenants`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ ...form, slug: form.slug.toLowerCase().replace(/\s+/g, '-') }),
      });
      const d = await r.json();
      if (r.ok) { flashMsg('Tenant created'); setModal(null); load(); }
      else setErr(d.detail || 'Failed');
      setBusy(false);
    };
    return (
      <div className="adm-modal-overlay" onClick={() => setModal(null)}>
        <div className="adm-modal adm-modal--sm" onClick={e => e.stopPropagation()}>
          <div className="adm-modal-header">
            <span>New Tenant (Company)</span>
            <button className="adm-modal-close" onClick={() => setModal(null)}>✕</button>
          </div>
          <form onSubmit={submit} className="adm-modal-form">
            <div className="adm-form-field">
              <label>Company Name *</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value, slug: e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') }))} required placeholder="SecureCafe" />
            </div>
            <div className="adm-form-field">
              <label>Slug * (URL-friendly ID)</label>
              <input value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))} required placeholder="securecafe" />
            </div>
            <div className="adm-form-field">
              <label>Plan</label>
              <select value={form.plan} onChange={e => setForm(f => ({ ...f, plan: e.target.value }))}>
                <option value="trial">Trial</option>
                <option value="starter">Starter</option>
                <option value="pro">Pro</option>
                <option value="enterprise">Enterprise</option>
              </select>
            </div>
            {err && <div className="auth-error">{err}</div>}
            <div className="adm-modal-actions">
              <button type="button" className="adm-btn adm-btn-ghost" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="adm-btn adm-btn-primary" disabled={busy}>{busy ? '...' : 'Create Tenant'}</button>
            </div>
          </form>
        </div>
      </div>
    );
  };

  const pendingTrials = trials.filter(t => t.status === 'pending');

  return (
    <div className="adm-page">
      {/* Stats Row */}
      <div className="adm-stats-row">
        <StatCard label="Total Users"    value={stats.total_users}    />
        <StatCard label="Active Users"   value={stats.active_users}   color="#23a55a" />
        <StatCard label="Pending Trials" value={stats.pending_trials} color="#f59e0b" />
        <StatCard label="Tenants"        value={stats.total_tenants}  color="#818cf8" />
        <StatCard label="Trial Users"    value={stats.trial_users}    color="#64b5f6" />
      </div>

      {/* Action message */}
      {actionMsg && (
        <div className="adm-action-msg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
          {actionMsg}
        </div>
      )}
      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

      {/* Tabs */}
      <div className="adm-tabs">
        <button className={`adm-tab${tab === 'users'   ? ' adm-tab--active' : ''}`} onClick={() => setTab('users')}>
          Users ({users.length})
        </button>
        <button className={`adm-tab${tab === 'trials'  ? ' adm-tab--active' : ''}`} onClick={() => setTab('trials')}>
          Trial Requests
          {pendingTrials.length > 0 && <span className="adm-badge-dot">{pendingTrials.length}</span>}
        </button>
        <button className={`adm-tab${tab === 'tenants' ? ' adm-tab--active' : ''}`} onClick={() => setTab('tenants')}>
          Tenants ({tenants.length})
        </button>
      </div>

      {/* ── USERS TAB ── */}
      {tab === 'users' && (
        <>
          <div className="adm-toolbar">
            <input className="adm-search" placeholder="Search name or email…" value={search}
              onChange={e => setSearch(e.target.value)} />
            <select className="adm-filter" value={filterPlan} onChange={e => setFilterPlan(e.target.value)}>
              <option value="">All Plans</option>
              <option value="trial">Trial</option>
              <option value="starter">Starter</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
            <select className="adm-filter" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="">All Status</option>
              <option value="approved">Approved</option>
              <option value="pending">Pending</option>
              <option value="rejected">Rejected</option>
            </select>
            <button className="adm-btn adm-btn-primary" onClick={() => setModal({ type: 'create-user' })}>
              + Create User
            </button>
          </div>

          {loading ? (
            <div className="adm-loading">Loading…</div>
          ) : (
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Name / Email</th>
                    <th>Tenant</th>
                    <th>Role</th>
                    <th>Plan</th>
                    <th>Status</th>
                    <th>Trial Ends</th>
                    <th>Last Login</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.id} className={!u.is_active ? 'adm-row--inactive' : ''}>
                      <td>
                        <div className="adm-user-name">{u.name}</div>
                        <div className="adm-user-email">{u.email}</div>
                      </td>
                      <td>{u.tenant_name || <span className="adm-muted">—</span>}</td>
                      <td>{roleBadge(u.role)}</td>
                      <td>{planBadge(u.plan)}</td>
                      <td>
                        {statusBadge(u.approval_status)}
                        {!u.is_active && <Badge label="INACTIVE" color="red" />}
                      </td>
                      <td className="adm-muted" style={{ fontSize: 11 }}>
                        {u.trial_ends_at ? new Date(u.trial_ends_at).toLocaleDateString() : '—'}
                      </td>
                      <td className="adm-muted" style={{ fontSize: 11 }}>
                        {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never'}
                      </td>
                      <td>
                        <div className="adm-actions">
                          <button className="adm-btn adm-btn-xs" onClick={() => setModal({ type: 'edit-user', data: u })}>Edit</button>
                          {!u.last_login_at && u.is_active && (
                            <button
                              className="adm-btn adm-btn-xs adm-btn-invite"
                              onClick={() => resendInvite(u)}
                              title="Send activation email so user can set their password"
                            >
                              ✉ Send Invite
                            </button>
                          )}
                          {u.id !== currentUser?.id && (
                            <button
                              className={`adm-btn adm-btn-xs ${u.is_active ? 'adm-btn-danger' : 'adm-btn-success'}`}
                              onClick={() => toggleActive(u)}
                            >
                              {u.is_active ? 'Deactivate' : 'Activate'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {users.length === 0 && (
                    <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>No users found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── TRIAL REQUESTS TAB ── */}
      {tab === 'trials' && (
        <>
          <div className="adm-toolbar">
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {pendingTrials.length} pending · {trials.length} total
            </div>
          </div>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Name / Email</th>
                  <th>Company</th>
                  <th>Message</th>
                  <th>Status</th>
                  <th>Submitted</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {trials.map(tr => (
                  <tr key={tr.id}>
                    <td>
                      <div className="adm-user-name">{tr.name}</div>
                      <div className="adm-user-email">{tr.email}</div>
                    </td>
                    <td>{tr.company || <span className="adm-muted">—</span>}</td>
                    <td style={{ maxWidth: 200, fontSize: 12, color: 'var(--text-muted)' }}>
                      {tr.message ? tr.message.slice(0, 80) + (tr.message.length > 80 ? '…' : '') : '—'}
                    </td>
                    <td>
                      {tr.status === 'pending'  && <Badge label="PENDING"  color="yellow" />}
                      {tr.status === 'approved' && <Badge label="APPROVED" color="green"  />}
                      {tr.status === 'rejected' && <Badge label="REJECTED" color="red"    />}
                    </td>
                    <td className="adm-muted" style={{ fontSize: 11 }}>
                      {new Date(tr.created_at).toLocaleString()}
                    </td>
                    <td>
                      {tr.status === 'pending' && (
                        <div className="adm-actions">
                          <button className="adm-btn adm-btn-xs adm-btn-success" onClick={() => setModal({ type: 'approve', data: tr })}>
                            Approve
                          </button>
                          <button className="adm-btn adm-btn-xs adm-btn-danger" onClick={() => setModal({ type: 'reject', data: tr })}>
                            Reject
                          </button>
                        </div>
                      )}
                      {tr.status === 'approved' && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          by {tr.approved_by_name || 'admin'}<br/>
                          {tr.approved_at ? new Date(tr.approved_at).toLocaleDateString() : ''}
                        </span>
                      )}
                      {tr.status === 'rejected' && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {tr.rejected_reason ? `"${tr.rejected_reason.slice(0, 40)}"` : 'No reason given'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {trials.length === 0 && (
                  <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>No trial requests</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── TENANTS TAB ── */}
      {tab === 'tenants' && (
        <>
          <div className="adm-toolbar">
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{tenants.length} tenant{tenants.length !== 1 ? 's' : ''}</div>
            <button className="adm-btn adm-btn-primary" onClick={() => setModal({ type: 'create-tenant' })}>
              + New Tenant
            </button>
          </div>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr><th>Name</th><th>Slug</th><th>Plan</th><th>Users</th><th>Status</th><th>Created</th></tr>
              </thead>
              <tbody>
                {tenants.map(t => (
                  <tr key={t.id}>
                    <td className="adm-user-name">{t.name}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)' }}>{t.slug}</td>
                    <td>{planBadge(t.plan)}</td>
                    <td>{t.user_count}</td>
                    <td>{t.is_active ? <Badge label="ACTIVE" color="green" /> : <Badge label="INACTIVE" color="red" />}</td>
                    <td className="adm-muted" style={{ fontSize: 11 }}>{new Date(t.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
                {tenants.length === 0 && (
                  <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>No tenants</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Modals */}
      {modal?.type === 'create-user'   && <CreateUserModal />}
      {modal?.type === 'edit-user'     && <EditUserModal user={modal.data} />}
      {modal?.type === 'approve'       && <ApproveModal tr={modal.data} />}
      {modal?.type === 'reject'        && <RejectModal  tr={modal.data} />}
      {modal?.type === 'create-tenant' && <CreateTenantModal />}
    </div>
  );
}

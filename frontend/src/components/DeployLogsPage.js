import React, { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../utils/authFetch';

const API = process.env.REACT_APP_API_URL || 'http://localhost:8000';

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const DEPLOY_STATUS_STYLE = {
  success: { color: '#10b981', label: 'Success', icon: '✓' },
  failed:  { color: '#ef4444', label: 'Failed',  icon: '✕' },
  running: { color: '#3b82f6', label: 'Running', icon: '⟳' },
  manual:  { color: '#f59e0b', label: 'Manual',  icon: '✎' },
};

function DeployStatusChip({ status }) {
  const s = DEPLOY_STATUS_STYLE[status] || { color: '#6b7280', label: status, icon: '?' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 10px', borderRadius: 12,
      fontSize: 11, fontWeight: 600,
      background: s.color + '22', color: s.color,
      border: `1px solid ${s.color}44`,
    }}>
      {s.icon} {s.label}
    </span>
  );
}

const LIMIT = 50;

export default function DeployLogsPage({ currentUser }) {
  const isAdmin = currentUser?.role === 'admin';
  const [connections,   setConnections]   = useState([]);
  const [selectedConn,  setSelectedConn]  = useState('');
  const [filterUser,    setFilterUser]    = useState('all');  // admin only
  const [userList,      setUserList]      = useState([]);     // admin only
  const [logs,          setLogs]          = useState([]);
  const [total,         setTotal]         = useState(0);
  const [offset,        setOffset]        = useState(0);
  const [loading,       setLoading]       = useState(false);
  const [statusFilter,  setStatusFilter]  = useState('all');
  const [downloading,   setDownloading]   = useState(null);

  // Separate unfiltered stats
  const [stats, setStats] = useState({ total: 0, success: 0, failed: 0, manual: 0 });

  // Load connections + user list for admin
  useEffect(() => {
    authFetch(`${API}/shift/connections`)
      .then(r => r.json())
      .then(data => {
        const list = data.connections || data || [];
        setConnections(list);
        if (list.length > 0) setSelectedConn(String(list[0].id));
      })
      .catch(() => {});
    if (isAdmin) {
      authFetch(`${API}/d365-deploy/log-users`)
        .then(r => r.json())
        .then(d => setUserList(d.users || []))
        .catch(() => {});
    }
  }, [isAdmin]);

  // Build URL for logs based on mode
  const buildUrl = useCallback((off, statusF, userF) => {
    if (isAdmin) {
      // Admin uses cross-org endpoint
      const params = new URLSearchParams({ limit: LIMIT, offset: off });
      if (statusF && statusF !== 'all') params.set('status', statusF);
      if (userF && userF !== 'all') params.set('user_id', userF);
      return `${API}/d365-deploy/all-logs?${params}`;
    }
    // Regular user — per connection endpoint
    const statusParam = statusF && statusF !== 'all' ? `&status=${statusF}` : '';
    return `${API}/d365-deploy/logs/${selectedConn}?limit=${LIMIT}&offset=${off}${statusParam}`;
  }, [isAdmin, selectedConn]);

  // Fetch overall stats
  const loadStats = useCallback(async (userF) => {
    try {
      let url;
      if (isAdmin) {
        const params = new URLSearchParams({ limit: 200, offset: 0 });
        if (userF && userF !== 'all') params.set('user_id', userF);
        url = `${API}/d365-deploy/all-logs?${params}`;
      } else {
        if (!selectedConn) return;
        url = `${API}/d365-deploy/logs/${selectedConn}?limit=200&offset=0`;
      }
      const res = await authFetch(url);
      const data = await res.json();
      const all = data.logs || [];
      setStats({
        total:   data.total   || 0,
        success: all.filter(l => l.status === 'success').length,
        failed:  all.filter(l => l.status === 'failed').length,
        manual:  all.filter(l => l.status === 'manual').length,
      });
    } catch { /* ignore */ }
  }, [isAdmin, selectedConn]);

  const loadLogs = useCallback(async (off, statusF, userF) => {
    if (!isAdmin && !selectedConn) return;
    setLoading(true);
    try {
      const res = await authFetch(buildUrl(off, statusF, userF));
      const data = await res.json();
      setLogs(data.logs || []);
      setTotal(data.total || 0);
    } catch { /* ignore */ }
    setLoading(false);
  }, [isAdmin, selectedConn, buildUrl]);

  useEffect(() => {
    loadStats(filterUser);
  }, [selectedConn, filterUser, loadStats]);

  useEffect(() => {
    setOffset(0);
    loadLogs(0, statusFilter, filterUser);
  }, [selectedConn, statusFilter, filterUser, loadLogs]);

  const handlePage = (dir) => {
    const next = offset + dir * LIMIT;
    if (next < 0 || next >= total) return;
    setOffset(next);
    loadLogs(next, statusFilter, filterUser);
  };

  const handleRefresh = () => {
    loadStats(filterUser);
    loadLogs(offset, statusFilter, filterUser);
  };

  const handleDownload = async (logId, componentName) => {
    setDownloading(logId);
    try {
      const res = await authFetch(`${API}/d365-deploy/log-download/${logId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const blob = new Blob([text], { type: 'text/plain' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `deploy_${componentName || 'component'}_${logId}.log`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Download failed: ${e.message}`);
    } finally {
      setDownloading(null);
    }
  };

  const selectedUserName = userList.find(u => String(u.id) === String(filterUser))?.name;

  return (
    <div className="lu-page">

      {/* ── Header ── */}
      <div className="lu-header">
        <div>
          <h1 className="lu-title">
            <span className="lu-title-icon">🚀</span>
            Deployment Logs
          </h1>
          <p className="lu-subtitle">
            {isAdmin
              ? filterUser === 'all' ? 'All users — select a user to filter' : `Showing: ${selectedUserName || 'Unknown'}`
              : 'Your D365 deployment history — download full build & registration logs'}
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Admin: user filter */}
          {isAdmin && userList.length > 0 && (
            <>
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>User:</span>
              <select
                value={filterUser}
                onChange={e => setFilterUser(e.target.value)}
                className="lu-model-select lu-user-select"
              >
                <option value="all">All Users</option>
                {userList.map(u => (
                  <option key={u.id} value={String(u.id)}>{u.name} ({u.email})</option>
                ))}
              </select>
            </>
          )}

          {/* Non-admin or admin viewing by org: show org selector */}
          {!isAdmin && connections.length > 0 && (
            <>
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Org:</span>
              <select
                value={selectedConn}
                onChange={e => setSelectedConn(e.target.value)}
                style={{
                  padding: '6px 10px', borderRadius: 6, fontSize: 13,
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  color: 'var(--text-primary)', cursor: 'pointer',
                }}
              >
                {connections.map(c => (
                  <option key={c.id} value={String(c.id)}>{c.name}</option>
                ))}
              </select>
            </>
          )}

          <button
            onClick={handleRefresh}
            title="Refresh"
            style={{
              padding: '6px 10px', borderRadius: 6, fontSize: 14,
              background: 'var(--surface)', border: '1px solid var(--border)',
              color: 'var(--text-primary)', cursor: 'pointer',
            }}
          >
            ↺
          </button>
          </div>
        )}
      </div>

      {/* ── Summary tiles — always visible ── */}
      <div className="lu-stats-row">
        <div className="lu-stat-card">
          <div className="lu-stat-value">{stats.total}</div>
          <div className="lu-stat-label">Total Deployments</div>
        </div>
        <div className="lu-stat-card">
          <div className="lu-stat-value" style={{ color: '#10b981' }}>{stats.success}</div>
          <div className="lu-stat-label">Succeeded</div>
        </div>
        <div className="lu-stat-card">
          <div className="lu-stat-value" style={{ color: '#f59e0b' }}>{stats.manual}</div>
          <div className="lu-stat-label">Manual</div>
        </div>
        <div className="lu-stat-card">
          <div className="lu-stat-value" style={{ color: '#ef4444' }}>{stats.failed}</div>
          <div className="lu-stat-label">Failed</div>
        </div>
      </div>

      {/* ── Filter pills ── */}
      <div className="lu-filter-row">
        <span className="lu-filter-label">Status:</span>
        {['all', 'success', 'manual', 'failed', 'running'].map(s => (
          <button
            key={s}
            className={`lu-pill${statusFilter === s ? ' active' : ''}`}
            onClick={() => setStatusFilter(s)}
          >
            {s === 'all'     ? '⊞ All'
              : s === 'success' ? '✓ Success'
              : s === 'manual'  ? '✎ Manual'
              : s === 'failed'  ? '✕ Failed'
              : '⟳ Running'}
          </button>
        ))}
      </div>

      {/* ── Table ── */}
      <div className="lu-table-wrap">
        {loading ? (
          <div className="lu-empty">Loading…</div>
        ) : (!isAdmin && !selectedConn) ? (
          <div className="lu-empty">No org connections found. Add one in the Metadata Migration tab.</div>
        ) : logs.length === 0 ? (
          <div className="lu-empty">
            {statusFilter !== 'all'
              ? `No ${statusFilter} deployments found.`
              : 'No deployment logs yet. Deploy a component to see history here.'}
          </div>
        ) : (
          <>
            <table className="lu-table">
              <thead>
                <tr>
                  <th>Time</th>
                  {isAdmin && filterUser === 'all' && <th>User</th>}
                  <th>Component</th>
                  <th>Type</th>
                  <th>Source</th>
                  <th>Steps</th>
                  <th>Assembly / Resource ID</th>
                  <th className="lu-th--center">Status</th>
                  <th className="lu-th--center">Download</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => {
                  const userName = userList.find(u => u.id === log.user_id)?.name;
                  return (
                  <tr key={log.id} className={log.status === 'failed' ? 'lu-row--error' : ''}>
                    <td className="lu-td--time">{fmtTime(log.created_at)}</td>
                    {isAdmin && filterUser === 'all' && (
                      <td className="lu-td--user">
                        {userName
                          ? <span className="lu-user-chip">{userName}</span>
                          : <span className="lu-muted">—</span>}
                      </td>
                    )}
                    <td className="lu-td--comp">
                      <span title={log.component_name}>{log.component_name || '—'}</span>
                    </td>
                    <td>
                      <span style={{
                        fontSize: 11, padding: '2px 7px', borderRadius: 10,
                        background: '#3b82f622', color: '#3b82f6',
                        border: '1px solid #3b82f644', fontWeight: 600,
                      }}>
                        {log.component_type || '—'}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {log.source === 'converter' ? 'Code Converter'
                        : log.source === 'plan' ? 'Deploy Plan'
                        : log.source || '—'}
                    </td>
                    <td style={{ fontSize: 12, textAlign: 'center' }}>
                      {log.step_ids && log.step_ids.length > 0
                        ? <span style={{ color: '#10b981', fontWeight: 600 }}>{log.step_ids.length}</span>
                        : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                    </td>
                    <td style={{
                      fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)',
                      maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {log.assembly_id
                        ? <span title={log.assembly_id}>{log.assembly_id.slice(0, 8)}…</span>
                        : log.web_resource_id
                          ? <span title={log.web_resource_id}>{log.web_resource_id.slice(0, 8)}…</span>
                          : log.error_message
                            ? <span title={log.error_message} style={{ color: '#ef4444' }}>{log.error_message.slice(0, 30)}…</span>
                            : <span style={{ color: 'var(--text-muted)' }}>—</span>
                      }
                    </td>
                    <td className="lu-td--center">
                      <DeployStatusChip status={log.status} />
                    </td>
                    <td className="lu-td--center">
                      <button
                        onClick={() => handleDownload(log.id, log.component_name)}
                        disabled={downloading === log.id}
                        title="Download full log"
                        style={{
                          background: 'none', border: '1px solid var(--border)',
                          borderRadius: 4, padding: '3px 10px', cursor: downloading === log.id ? 'wait' : 'pointer',
                          fontSize: 14, color: 'var(--text-primary)', opacity: downloading === log.id ? 0.5 : 1,
                        }}
                      >
                        {downloading === log.id ? '…' : '⬇'}
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Pagination */}
            {total > LIMIT && (
              <div className="lu-pagination">
                <span className="lu-page-info">
                  {offset + 1}–{Math.min(offset + LIMIT, total)} of {total.toLocaleString()}
                </span>
                <button
                  className="lu-page-btn"
                  onClick={() => handlePage(-1)}
                  disabled={offset === 0}
                >
                  ‹ Prev
                </button>
                <button
                  className="lu-page-btn"
                  onClick={() => handlePage(1)}
                  disabled={offset + LIMIT >= total}
                >
                  Next ›
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

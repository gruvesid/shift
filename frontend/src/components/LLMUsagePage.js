import React, { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../utils/authFetch';

const API = process.env.REACT_APP_API_URL || 'http://localhost:8000';

/* ── Call type config ─────────────────────────────────────────────────── */
const CALL_TYPES = [
  { id: 'all',          label: 'All',          icon: '⊞' },
  { id: 'code_convert', label: 'Code Convert', icon: '⟨/⟩' },
  { id: 'agent_chat',   label: 'Agent Chat',   icon: '💬' },
];

const TYPE_STYLE = {
  code_convert: { label: 'Code Convert', color: '#10b981', icon: '⟨/⟩' },
  agent_chat:   { label: 'Agent Chat',   color: '#3b82f6', icon: '💬' },
  indexing:     { label: 'Indexing',     color: '#8b5cf6', icon: '⬡' },
  sense:        { label: 'Sense',        color: '#f59e0b', icon: '✦' },
};

/* ── Helpers ──────────────────────────────────────────────────────────── */
function fmtTokens(n) {
  if (!n && n !== 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000)      return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(usd) {
  if (!usd && usd !== 0) return '$0.0000';
  return `$${usd.toFixed(4)}`;
}

function fmtMs(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function StatusDot({ status }) {
  const color = status === 'success' ? 'var(--success)' : 'var(--danger)';
  return (
    <span
      title={status}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 20, height: 20,
        borderRadius: '50%',
        border: `1.5px solid ${color}`,
        color,
        fontSize: 13,
        flexShrink: 0,
      }}
    >
      {status === 'success' ? '✓' : '✕'}
    </span>
  );
}

/* ── Stat Card ────────────────────────────────────────────────────────── */
function StatCard({ label, value, sub, color }) {
  return (
    <div className="lu-stat-card">
      <div className="lu-stat-value" style={color ? { color } : {}}>
        {value}
      </div>
      {sub && <div className="lu-stat-sub">{sub}</div>}
      <div className="lu-stat-label">{label}</div>
    </div>
  );
}

/* ── Main ─────────────────────────────────────────────────────────────── */
export default function LLMUsagePage({ currentUser }) {
  const isAdmin = currentUser?.role === 'admin';
  const [stats,        setStats]        = useState(null);
  const [history,      setHistory]      = useState([]);
  const [total,        setTotal]        = useState(0);
  const [loading,      setLoading]      = useState(true);
  const [filterType,   setFilterType]   = useState('all');
  const [filterModel,  setFilterModel]  = useState('all');
  const [filterUser,   setFilterUser]   = useState('all');  // admin only
  const [models,       setModels]       = useState([]);
  const [userList,     setUserList]     = useState([]);     // admin only
  const [offset,       setOffset]       = useState(0);
  const LIMIT = 50;

  // Load users list for admin filter + distinct models
  useEffect(() => {
    authFetch(`${API}/llm-usage/models`)
      .then(r => r.json())
      .then(d => setModels(d.models || []))
      .catch(() => {});
    if (isAdmin) {
      authFetch(`${API}/llm-usage/users`)
        .then(r => r.json())
        .then(d => setUserList(d.users || []))
        .catch(() => {});
    }
  }, [isAdmin]);

  const load = useCallback(async (ft, fm, fu, off) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: LIMIT, offset: off });
      if (ft !== 'all') params.set('call_type', ft);
      if (fm !== 'all') params.set('model', fm);
      if (isAdmin && fu !== 'all') params.set('user_id', fu);
      const [sRes, hRes] = await Promise.all([
        authFetch(`${API}/llm-usage/stats?${params}`),
        authFetch(`${API}/llm-usage/history?${params}`),
      ]);
      const sData = await sRes.json();
      const hData = await hRes.json();
      setStats(sData);
      setHistory(hData.history || []);
      setTotal(hData.total   || 0);
    } catch { /* ignore */ }
    setLoading(false);
  }, [isAdmin]);

  useEffect(() => {
    setOffset(0);
    load(filterType, filterModel, filterUser, 0);
  }, [filterType, filterModel, filterUser, load]);

  const handlePage = (dir) => {
    const next = offset + dir * LIMIT;
    if (next < 0 || next >= total) return;
    setOffset(next);
    load(filterType, filterModel, filterUser, next);
  };

  const selectedUserName = userList.find(u => String(u.id) === String(filterUser))?.name;

  return (
    <div className="lu-page">

      {/* ── Header ── */}
      <div className="lu-header">
        <div>
          <h1 className="lu-title">
            <span className="lu-title-icon">📊</span>
            LLM Usage History
          </h1>
          <p className="lu-subtitle">
            {isAdmin
              ? filterUser === 'all' ? 'All users — select a user to filter' : `Showing: ${selectedUserName || 'Unknown'}`
              : 'Your AI/LLM call history with token usage and costs'}
          </p>
        </div>
      </div>

      {/* ── Stat cards ── */}
      <div className="lu-stats-row">
        <StatCard
          label="Total Calls"
          value={stats ? stats.total_calls.toLocaleString() : '—'}
        />
        <StatCard
          label="Input Tokens"
          value={stats ? fmtTokens(stats.input_tokens) : '—'}
          color="#3b82f6"
        />
        <StatCard
          label="Output Tokens"
          value={stats ? fmtTokens(stats.output_tokens) : '—'}
          color="#10b981"
        />
        <StatCard
          label="Total Tokens"
          value={stats ? fmtTokens(stats.total_tokens) : '—'}
        />
        <StatCard
          label="Total Cost"
          value={stats ? fmtCost(stats.total_cost_usd) : '—'}
          color="#f59e0b"
        />
      </div>

      {/* ── Filter row ── */}
      <div className="lu-filter-row">
        {isAdmin && userList.length > 0 && (
          <>
            <span className="lu-filter-label">User:</span>
            <select
              value={filterUser}
              onChange={e => setFilterUser(e.target.value)}
              className="lu-model-select lu-user-select"
            >
              <option value="all">All Users</option>
              {userList.map(u => (
                <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
              ))}
            </select>
            <span className="lu-filter-divider" />
          </>
        )}

        <span className="lu-filter-label">Type:</span>
        {CALL_TYPES.map(ct => (
          <button
            key={ct.id}
            className={`lu-pill${filterType === ct.id ? ' active' : ''}`}
            onClick={() => setFilterType(ct.id)}
          >
            <span className="lu-pill-icon">{ct.icon}</span>
            {ct.label}
          </button>
        ))}

        {models.length > 0 && (
          <>
            <span className="lu-filter-label" style={{ marginLeft: 12 }}>Model:</span>
            <select
              value={filterModel}
              onChange={e => setFilterModel(e.target.value)}
              className="lu-model-select"
            >
              <option value="all">All Models</option>
              {models.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </>
        )}
      </div>

      {/* ── Table ── */}
      <div className="lu-table-wrap">
        {loading ? (
          <div className="lu-empty">Loading…</div>
        ) : history.length === 0 ? (
          <div className="lu-empty">
            No LLM usage recorded yet. Convert a component to see history here.
          </div>
        ) : (
          <>
            <table className="lu-table">
              <thead>
                <tr>
                  <th>Time</th>
                  {isAdmin && filterUser === 'all' && <th>User</th>}
                  <th>Type</th>
                  <th>Model</th>
                  <th>Org</th>
                  <th>Component</th>
                  <th className="lu-th--num">Input</th>
                  <th className="lu-th--num">Output</th>
                  <th className="lu-th--num">Cost</th>
                  <th className="lu-th--num">Duration</th>
                  <th className="lu-th--center">Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map(row => {
                  const ts = TYPE_STYLE[row.call_type] || { label: row.call_type, color: '#6b7280', icon: '?' };
                  const userName = userList.find(u => u.id === row.user_id)?.name;
                  return (
                    <tr key={row.id} className={row.status === 'error' ? 'lu-row--error' : ''}>
                      <td className="lu-td--time">{fmtTime(row.created_at)}</td>
                      {isAdmin && filterUser === 'all' && (
                        <td className="lu-td--user">
                          {userName
                            ? <span className="lu-user-chip">{userName}</span>
                            : <span className="lu-muted">—</span>}
                        </td>
                      )}
                      <td>
                        <span className="lu-type-chip" style={{ '--chip-color': ts.color }}>
                          <span className="lu-type-icon">{ts.icon}</span>
                          {ts.label}
                        </span>
                      </td>
                      <td className="lu-td--model">{row.model || '—'}</td>
                      <td className="lu-td--org">
                        {row.org_name
                          ? <span className="lu-org-link">{row.org_name}</span>
                          : <span className="lu-muted">—</span>}
                      </td>
                      <td className="lu-td--comp">
                        {row.component_name
                          ? <span title={row.component_name}>{row.component_name}</span>
                          : <span className="lu-muted">—</span>}
                      </td>
                      <td className="lu-td--num lu-td--in">{fmtTokens(row.input_tokens)}</td>
                      <td className="lu-td--num lu-td--out">{fmtTokens(row.output_tokens)}</td>
                      <td className="lu-td--num lu-td--cost">{fmtCost(row.cost_usd)}</td>
                      <td className="lu-td--num">{fmtMs(row.duration_ms)}</td>
                      <td className="lu-td--center">
                        <StatusDot status={row.status} />
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

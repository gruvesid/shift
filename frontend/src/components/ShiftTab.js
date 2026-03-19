import React, { useState, useEffect, useCallback } from 'react';
import ConnectOrgModal from './ConnectOrgModal';
import OrgDetailPage from './OrgDetailPage';
import { authFetch } from '../utils/authFetch';

const API = process.env.REACT_APP_API_URL || 'http://localhost:8000';

/* ── Status helpers ─────────────────────────────────────────────── */
function StatusDot({ status }) {
  const color =
    status === 'connected' ? '#22c55e' :
    status === 'error'     ? '#f87171' :
    status === 'pending'   ? '#f59e0b' : '#6b7280';
  return (
    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
  );
}

function OrgBadge({ label, variant }) {
  const map = {
    connected:    { bg: 'rgba(34,197,94,0.15)',  color: '#22c55e',  border: 'rgba(34,197,94,0.3)' },
    completed:    { bg: 'rgba(34,197,94,0.15)',  color: '#22c55e',  border: 'rgba(34,197,94,0.3)' },
    needs_reauth: { bg: 'rgba(248,113,113,0.12)', color: '#f87171', border: 'rgba(248,113,113,0.3)' },
    pending:      { bg: 'rgba(156,163,175,0.12)', color: '#9ca3af', border: 'rgba(156,163,175,0.25)' },
    partial:      { bg: 'rgba(245,158,11,0.12)',  color: '#f59e0b',  border: 'rgba(245,158,11,0.3)' },
    error:        { bg: 'rgba(248,113,113,0.12)', color: '#f87171', border: 'rgba(248,113,113,0.3)' },
  };
  const s = map[variant] || map.pending;
  return (
    <span style={{
      padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 500,
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
    }}>
      {label}
    </span>
  );
}

function relativeTime(iso) {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/* ── Stat Card ───────────────────────────────────────────────────── */
function StatCard({ icon, label, value, sublabel }) {
  return (
    <div className="shift-stat-card">
      <div className="shift-stat-top">
        <span className="shift-stat-label">{label}</span>
        <span className="shift-stat-icon">{icon}</span>
      </div>
      <div className="shift-stat-value">{value}</div>
      <div className="shift-stat-sub">{sublabel}</div>
    </div>
  );
}

/* ── Org Row ──────────────────────────────────────────────────────── */
function OrgCard({ org, onDelete, onViewDetail, onEdit }) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (e) => {
    e.stopPropagation();
    if (!window.confirm(`Delete connection "${org.name}"?`)) return;
    setDeleting(true);
    try {
      await authFetch(`${API}/shift/connections/${org.id}`, { method: 'DELETE' });
      onDelete(org.id);
    } catch {
      setDeleting(false);
    }
  };

  const handleEdit = (e) => {
    e.stopPropagation();
    onEdit(org.id);
  };

  const sfOk   = org.sf_status   === 'connected';
  const d365Ok = org.d365_status === 'connected';

  return (
    <div
      className={`shift-org-card shift-org-card--clickable ${org.overall_status === 'needs_reauth' ? 'shift-org-card--warn' : ''}`}
      onClick={() => onViewDetail(org.id)}
    >
      {org.overall_status === 'needs_reauth' && (
        <div className="shift-org-warn-bar">
          ⚠ Salesforce connection not established — click to configure
        </div>
      )}

      <div className="shift-org-body">
        {/* Left info */}
        <div className="shift-org-info">
          <div className="shift-org-name">{org.name}</div>
          <div className="shift-org-systems">
            <StatusDot status={org.sf_status} />
            <span className="shift-org-sys-label">Salesforce</span>
            <span className="shift-org-arrow">→</span>
            <span className="shift-org-sys-label">Dynamics 365</span>
            <StatusDot status={org.d365_status} />
          </div>
          {org.sf_instance_url && (
            <div className="shift-org-url">🔗 {org.sf_instance_url}</div>
          )}
          <div className="shift-org-sync">
            <span>🗄 Metadata sync: {relativeTime(org.metadata_sync_at)}</span>
          </div>
        </div>

        {/* Right actions */}
        <div className="shift-org-actions">
          <div className="shift-org-badges">
            {sfOk  && <OrgBadge label="connected" variant="connected" />}
            {d365Ok && <OrgBadge label="completed" variant="completed" />}
            {!sfOk && org.overall_status === 'needs_reauth' && <OrgBadge label="needs_reauth" variant="needs_reauth" />}
            {!sfOk && org.overall_status !== 'needs_reauth' && <OrgBadge label="pending" variant="pending" />}
            {!d365Ok && <OrgBadge label="pending" variant="pending" />}
          </div>
          <div className="shift-org-btns">
            <span className="shift-view-link">View details ›</span>
            <button className="shift-edit-btn" onClick={handleEdit} aria-label="Edit connection" title="Edit connection">✏️</button>
            <button className="shift-delete-btn" onClick={handleDelete} disabled={deleting} aria-label="Delete">
              {deleting ? '…' : '🗑'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── ShiftTab ─────────────────────────────────────────────────────── */
export default function ShiftTab({ onNavigateToConverter, onNavigateToDeployment, onNavigateToAgentChat, initialDetailOrgId, onDetailOrgChange }) {
  const [orgs,         setOrgs]         = useState([]);
  const [stats,        setStats]        = useState({ connected_orgs: 0, metadata_extracted: 0, agent_chat_sessions: 0 });
  const [loading,      setLoading]      = useState(true);
  const [showModal,    setShowModal]    = useState(false);
  const [detailOrgId,  setDetailOrgId]  = useState(initialDetailOrgId || null);
  const [editOrgId,    setEditOrgId]    = useState(null);
  const [editOrgData,  setEditOrgData]  = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [orgsRes, statsRes] = await Promise.all([
        authFetch(`${API}/shift/connections`),
        authFetch(`${API}/shift/stats`),
      ]);
      if (orgsRes.ok)  setOrgs(await orgsRes.json());
      if (statsRes.ok) setStats(await statsRes.json());
    } catch { /* silently ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleOrgSaved   = () => { setShowModal(false); setEditOrgId(null); setEditOrgData(null); load(); };
  const handleDelete     = (id) => setOrgs(prev => prev.filter(o => o.id !== id));
  const handleViewDetail = (id) => { setDetailOrgId(id); onDetailOrgChange && onDetailOrgChange(id); };
  const handleBackToList = () => { setDetailOrgId(null); onDetailOrgChange && onDetailOrgChange(null); load(); };

  const handleEditOrg = async (id) => {
    let data = null;
    try {
      const r = await authFetch(`${API}/shift/connections/${id}/config`);
      if (r.ok) data = await r.json();
    } catch { /* silently ignore */ }
    setEditOrgData(data);
    setEditOrgId(id); // always open the modal, even if config fetch failed
  };

  // Show detail page
  if (detailOrgId) {
    return (
      <OrgDetailPage
        orgId={detailOrgId}
        onBack={handleBackToList}
        onNavigateToConverter={onNavigateToConverter}
        onNavigateToDeployment={onNavigateToDeployment}
        onNavigateToAgentChat={onNavigateToAgentChat}
      />
    );
  }

  return (
    <div className="shift-page">
      {/* ── Header ── */}
      <div className="shift-header">
        <button className="shift-connect-btn" onClick={() => setShowModal(true)}>
          + Connect Org
        </button>
      </div>

      {/* ── Stats ── */}
      <div className="shift-stats-grid">
        <StatCard
          icon="☁"
          label="Connected Orgs"
          value={loading ? '—' : stats.connected_orgs}
          sublabel="Salesforce organizations"
        />
        <StatCard
          icon="🗄"
          label="Metadata Extracted"
          value={loading ? '—' : stats.metadata_extracted}
          sublabel="Orgs with extracted metadata"
        />
        <StatCard
          icon="💬"
          label="Agent Chat Sessions"
          value={loading ? '—' : stats.agent_chat_sessions}
          sublabel="Agent Chat conversations"
        />
      </div>

      {/* ── Orgs list ── */}
      <div className="shift-orgs-section">
        <div className="shift-orgs-header">
          <h2 className="shift-orgs-title">Your Salesforce Orgs</h2>
          <p className="shift-orgs-sub">Manage your connected Salesforce organizations</p>
        </div>

        {loading && (
          <div className="shift-empty">Loading connections…</div>
        )}

        {!loading && orgs.length === 0 && (
          <div className="shift-empty">
            <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.3 }}>☁</div>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>No orgs connected yet</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              Click "+ Connect Org" to add your first Salesforce organization.
            </div>
            <button className="shift-connect-btn" onClick={() => setShowModal(true)}>
              + Connect Org
            </button>
          </div>
        )}

        {!loading && orgs.map(org => (
          <OrgCard key={org.id} org={org} onDelete={handleDelete} onViewDetail={handleViewDetail} onEdit={handleEditOrg} />
        ))}
      </div>

      {/* ── Modal ── */}
      {(showModal || editOrgId) && (
        <ConnectOrgModal
          onClose={() => { setShowModal(false); setEditOrgId(null); setEditOrgData(null); }}
          onSaved={handleOrgSaved}
          initialData={editOrgData}
          editOrgId={editOrgId}
        />
      )}
    </div>
  );
}

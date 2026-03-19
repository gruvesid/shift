import React, { useState, useEffect } from 'react';
const API = process.env.REACT_APP_API_URL || 'http://localhost:8000';

/* ─── Brand logos (from /public) ────────────────────────────── */
const logoStyle = { width: '100%', height: '100%', objectFit: 'contain' };
const Logo = {
  dynamics: <img src="/dynamics_icon_magnusminds.png" alt="Dynamics 365" style={logoStyle} />,
  fabric: <img src="/Fabric_final_x256.png" alt="Fabric" style={logoStyle} />,
  salesforce: <img src="/salesforce-transparent-logo.png" alt="Salesforce" style={logoStyle} />,
  sharepoint: <img src="/sharepoint-logo-.png" alt="SharePoint" style={logoStyle} />,
};

/* ─── Connector type definitions ──────────────────────────── */
const CONNECTOR_TYPES = [
  {
    id: 'dynamics',
    name: 'Dynamics 365 / Azure',
    icon: Logo.dynamics,
    color: '#0078d4',
    desc: 'Azure AD service principal for Dataverse',
    fields: [
      { key: 'TENANT_ID', label: 'Tenant ID', placeholder: 'Azure AD Tenant GUID', type: 'text', secret: false },
      { key: 'CLIENT_ID', label: 'Client ID', placeholder: 'App Registration Client ID', type: 'text', secret: false },
      { key: 'CLIENT_SECRET', label: 'Client Secret', placeholder: 'App Registration Secret', type: 'password', secret: true },
      { key: 'DATAVERSE_URL', label: 'Dataverse URL', placeholder: 'https://yourorg.crm.dynamics.com', type: 'text', secret: false },
    ],
  },
  {
    id: 'fabric',
    name: 'Fabric Lakehouse',
    icon: Logo.fabric,
    color: '#E3008C',
    desc: 'SQL endpoint + Data Pipeline for Microsoft Fabric',
    fields: [
      { key: 'TENANT_ID', label: 'Tenant ID', placeholder: 'Azure AD Tenant GUID', type: 'text', secret: false },
      { key: 'SQL_ENDPOINT', label: 'SQL Endpoint', placeholder: 'abc123.datawarehouse.fabric.microsoft.com', type: 'text', secret: false },
      { key: 'DATABASE_NAME', label: 'Database Name', placeholder: 'lkh_sf2dynamics', type: 'text', secret: false },
      { key: 'FABRIC_CLIENT_ID', label: 'Fabric Client ID', placeholder: 'Fabric SP Client ID', type: 'text', secret: false },
      { key: 'FABRIC_CLIENT_SECRET', label: 'Fabric Client Secret', placeholder: 'Fabric SP Client Secret', type: 'password', secret: true },
      { key: 'FABRIC_WORKSPACE_ID', label: 'Workspace ID', placeholder: 'Fabric workspace GUID', type: 'text', secret: false },
      { key: 'SCHEMA_PIPELINE_ID', label: 'Schema Pipeline ID', placeholder: 'Data Pipeline GUID for Schema', type: 'text', secret: false },
      { key: 'DATA_PIPELINE_ID', label: 'Data Migration Pipeline ID', placeholder: 'Data Pipeline GUID for Migration', type: 'text', secret: false },
    ],
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    icon: Logo.salesforce,
    color: '#00A1E0',
    desc: 'Connected App credentials',
    fields: [
      { key: 'SF_INSTANCE_URL', label: 'Instance URL', placeholder: 'https://yourorg.salesforce.com', type: 'text', secret: false },
      { key: 'SF_CONSUMER_KEY', label: 'Consumer Key', placeholder: 'Connected App Consumer Key', type: 'text', secret: false },
      { key: 'SF_CONSUMER_SECRET', label: 'Consumer Secret', placeholder: 'Connected App Secret', type: 'password', secret: true },
    ],
  },
  {
    id: 'sharepoint',
    name: 'SharePoint',
    icon: Logo.sharepoint,
    color: '#038387',
    desc: 'SharePoint site for document migration',
    fields: [
      { key: 'SITE_HOSTNAME', label: 'Site Hostname', placeholder: 'yourcompany.sharepoint.com', type: 'text', secret: false },
      { key: 'SITE_PATH', label: 'Site Path', placeholder: '/sites/YourSiteName', type: 'text', secret: false },
    ],
  },
];


/* ─── Connection Modal (Add + Edit) ───────────────────────── */
const ConnectionModal = ({ editConn, onSave, onClose, existingTypes = [] }) => {
  const isEdit = !!editConn;

  const [selectedType, setSelectedType] = useState(editConn?.type || null);
  const [form, setForm] = useState(() => {
    if (editConn) {
      const type = CONNECTOR_TYPES.find(t => t.id === editConn.type);
      return type ? type.fields.reduce((acc, f) => {
        acc[f.key] = editConn.fields?.[f.key] || '';
        return acc;
      }, {}) : {};
    }
    return {};
  });
  const [saving, setSaving] = useState(false);

  const typeInfo = CONNECTOR_TYPES.find(t => t.id === selectedType);

  // Auto-generate name from type (use display name, not lowercase ID)
  const name = editConn?.name || (typeInfo ? typeInfo.name : '') || '';

  const selectType = (id) => {
    setSelectedType(id);
    if (!isEdit) {
      const type = CONNECTOR_TYPES.find(t => t.id === id);
      setForm(type.fields.reduce((acc, f) => { acc[f.key] = ''; return acc; }, {}));
    }
  };

  const handleSave = async () => {
    if (!selectedType) return; // Removed !name check
    setSaving(true);
    try {
      await fetch(`${API}/config?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, _type: selectedType }),
      });
      onSave({ name, type: selectedType, fields: { ...form } });
    } finally {
      setSaving(false);
    }
  };

  const allFilled = typeInfo && typeInfo.fields.every(f => form[f.key]?.trim());

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 620 }}>
        <div className="modal-header">
          <div className="modal-title">{isEdit ? 'Edit Connection' : 'New Connection'}</div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Type selector — locked in edit mode */}
        <div style={{ marginBottom: 20 }}>
          <div className="form-label" style={{ marginBottom: 10 }}>Connection Type</div>
          <div className="connector-type-grid">
            {CONNECTOR_TYPES.map(t => {
              const alreadyExists = !isEdit && existingTypes.includes(t.id);
              const isFaded = (isEdit && selectedType !== t.id) || alreadyExists;

              return (
                <button
                  key={t.id}
                  className={`connector-type-btn${selectedType === t.id ? ' selected' : ''}`}
                  onClick={() => !alreadyExists && !isEdit && selectType(t.id)}
                  disabled={alreadyExists || (isEdit && selectedType !== t.id)}
                  title={alreadyExists ? 'Connection type already configured' : ''}
                  style={{
                    cursor: isFaded ? 'not-allowed' : 'pointer',
                    opacity: isFaded ? 0.4 : 1,
                    filter: alreadyExists ? 'grayscale(100%)' : 'none'
                  }}
                >
                  <div style={{ width: 32, height: 32, borderRadius: 8, overflow: 'hidden', marginBottom: 4, flexShrink: 0 }}>{t.icon}</div>
                  <div className="connector-type-name">{t.name}</div>
                  <div className="connector-type-desc">{t.desc}</div>
                </button>
              )
            })}
          </div>
        </div>

        {typeInfo && (
          <>
            {/* Fields grid — each field in its own box */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 14,
              marginBottom: 22,
            }}>
              {typeInfo.fields.map(f => (
                <div
                  key={f.key}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    background: 'var(--bg-secondary)',
                    border: `1.5px solid ${form[f.key] ? typeInfo.color + '55' : 'var(--border)'}`,
                    borderRadius: 'var(--radius-sm)',
                    padding: '12px 14px',
                    transition: 'border-color 0.15s',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label className="form-label" style={{ marginBottom: 0 }}>{f.label}</label>
                    {form[f.key] && (
                      <span style={{
                        width: 7, height: 7, borderRadius: '50%',
                        background: typeInfo.color, flexShrink: 0,
                      }} />
                    )}
                  </div>
                  <code style={{
                    fontSize: 9, padding: '1px 5px', borderRadius: 4,
                    background: form[f.key] ? typeInfo.color + '15' : 'transparent',
                    color: form[f.key] ? typeInfo.color : 'var(--text-muted)',
                    border: `1px solid ${form[f.key] ? typeInfo.color + '30' : 'transparent'}`,
                    transition: 'all 0.12s', alignSelf: 'flex-start',
                  }}>{f.key}</code>
                  <input
                    className="form-input"
                    type={f.type}
                    placeholder={f.placeholder}
                    value={form[f.key] || ''}
                    onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                    autoComplete="new-password"
                    style={{
                      background: 'var(--bg-card)',
                      borderColor: form[f.key] ? typeInfo.color + '66' : undefined,
                    }}
                  />
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={!name || !allFilled || saving}
              >
                {saving ? '⏳ Saving…' : isEdit ? '✓ Save Changes' : '+ Add Connection'}
              </button>
            </div>
          </>
        )}

        {!typeInfo && (
          <div style={{ textAlign: 'right' }}>
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
};

/* ─── Connection Card (grid tile) ─────────────────────────── */
const ConnectionCard = ({ conn, onEdit, onRemove }) => {
  const typeInfo = CONNECTOR_TYPES.find(t => t.id === conn.type) || { color: '#888', icon: '🔗', name: conn.type, fields: [] };
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  const filledCount = typeInfo.fields.filter(f => conn.fields?.[f.key]?.trim()).length;
  const totalCount = typeInfo.fields.length;
  const pct = totalCount ? Math.round((filledCount / totalCount) * 100) : 100;

  const doTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(
        `${API}/config/test-named?name=${encodeURIComponent(conn.name)}`,
        { method: 'POST' }
      );
      const data = await res.json();
      setTestResult({ ok: res.ok, msg: res.ok ? data.message : (data.detail || 'Failed') });
    } catch (_) {
      setTestResult({ ok: false, msg: 'Cannot reach backend' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: `1.5px solid ${typeInfo.color}44`,
      borderRadius: 'var(--radius-md)',
      padding: '20px',
      boxShadow: 'var(--shadow-card)',
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      transition: 'transform 0.15s, box-shadow 0.15s',
      position: 'relative',
    }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = `0 8px 28px ${typeInfo.color}22`; }}
      onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = 'var(--shadow-card)'; }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12, flexShrink: 0,
          overflow: 'hidden',
          border: `1.5px solid ${typeInfo.color}44`,
        }}>
          {typeInfo.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {conn.name}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{typeInfo.name}</div>
        </div>
      </div>

      {/* Progress bar */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 11, color: 'var(--text-muted)' }}>
          <span>Fields configured</span>
          <span style={{ color: pct === 100 ? 'var(--success)' : 'var(--warning)', fontWeight: 600 }}>
            {filledCount}/{totalCount}
          </span>
        </div>
        <div style={{ height: 4, borderRadius: 99, background: 'var(--border)', overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${pct}%`,
            borderRadius: 99,
            background: pct === 100 ? 'var(--success)' : typeInfo.color,
            transition: 'width 0.4s ease',
          }} />
        </div>
      </div>

      {/* Fields preview */}
      {typeInfo.fields.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '6px 10px',
        }}>
          {typeInfo.fields.map(f => {
            const filled = !!conn.fields?.[f.key]?.trim();
            return (
              <div key={f.key} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '5px 8px',
                background: filled ? typeInfo.color + '0e' : 'var(--bg-secondary)',
                borderRadius: 6,
                border: `1px solid ${filled ? typeInfo.color + '33' : 'var(--border)'}`,
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                  background: filled ? typeInfo.color : 'var(--text-muted)',
                  opacity: filled ? 1 : 0.35,
                }} />
                <span style={{ fontSize: 10, color: filled ? 'var(--text-secondary)' : 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                  {f.label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Test result */}
      {testResult && (
        <div style={{ fontSize: 11, color: testResult.ok ? 'var(--success)' : 'var(--danger)', padding: '6px 10px', background: testResult.ok ? 'var(--success-bg)' : 'var(--danger-bg)', borderRadius: 6 }}>
          {testResult.ok ? '✅' : '❌'} {testResult.msg}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
        <button className="btn btn-secondary btn-sm" onClick={doTest} disabled={testing} style={{ flex: 1 }}>
          {testing ? '⏳ Testing…' : '🔌 Test'}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => onEdit(conn)}
          style={{ flex: 1 }}
        >
          ✏️ Edit
        </button>
        <button
          className="btn btn-danger btn-sm"
          onClick={() => onRemove(conn.name)}
          style={{ padding: '6px 10px' }}
        >
          ✕
        </button>
      </div>
    </div>
  );
};

const CONN_CACHE_KEY = 'sf2d_connections';

function readConnCache() {
  try {
    const raw = localStorage.getItem(CONN_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeConnCache(conns) {
  try {
    // Strip field values before caching — we only need names and types
    // to repopulate the UI; full values are re-fetched from the backend.
    const safe = conns.map(({ name, type }) => ({ name, type, fields: {} }));
    localStorage.setItem(CONN_CACHE_KEY, JSON.stringify(safe));
  } catch { /* ignore */ }
}

/* ─── Main ConnectionTab ──────────────────────────────────── */
const ConnectionTab = ({ onConfirm, onUnconfirm, isConfirmed }) => {
  // Seed from cache so cards appear instantly on refresh before the backend responds
  const [connections, setConnections] = useState(() => readConnCache());
  const [fetchError, setFetchError] = useState(null);
  const [modal, setModal] = useState(null); // null | { mode: 'add' } | { mode: 'edit', conn }

  const fetchConfigs = async () => {
    setFetchError(null);
    try {
      const namesRes = await fetch(`${API}/configs`);
      if (!namesRes.ok) throw new Error(`Server returned ${namesRes.status}`);
      const names = await namesRes.json();

      // Fetch the full config for every name so we recover _type and all fields
      const fullConfigs = await Promise.all(
        names.map(async (n) => {
          try {
            const r = await fetch(`${API}/config?name=${encodeURIComponent(n)}`);
            if (!r.ok) return null;
            const data = await r.json();
            const { _type, ...fields } = data;
            return { name: n, type: _type || 'fabric', fields };
          } catch {
            return null;
          }
        })
      );

      const loaded = fullConfigs.filter(Boolean);
      setConnections(loaded);
      writeConnCache(loaded);
    } catch (e) {
      setFetchError(e.message);
      // Keep showing whatever is in state (the cache-seeded list)
    }
  };

  useEffect(() => { fetchConfigs(); }, []); // eslint-disable-line

  const handleSave = (conn) => {
    setConnections(prev => {
      const updated = [...prev.filter(c => c.name !== conn.name), conn];
      writeConnCache(updated);
      return updated;
    });
    setModal(null);
    if (onUnconfirm) onUnconfirm();
  };

  const handleRemove = async (name) => {
    try {
      await fetch(`${API}/config?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
    } catch (_) { /* best-effort */ }
    setConnections(prev => {
      const updated = prev.filter(c => c.name !== name);
      writeConnCache(updated);
      return updated;
    });
    if (onUnconfirm) onUnconfirm();
  };

  const handleEdit = (conn) => {
    setModal({ mode: 'edit', conn });
  };

  const hasFabric = connections.some(c => c.type === 'fabric');
  const hasSalesforce = connections.some(c => c.type === 'salesforce');
  const hasDynamics = connections.some(c => c.type === 'dynamics');
  const hasSharePoint = connections.some(c => c.type === 'sharepoint');

  const canProceed = hasFabric && hasSalesforce && hasDynamics && hasSharePoint;
  const isMaxedOut = connections.length >= 4;

  return (
    <div>
      <div className="section-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="section-title">Connections</div>
            <div className="section-desc">
              Manage credentials for Fabric, Dynamics 365, Salesforce, and SharePoint.
            </div>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => setModal({ mode: 'add' })}
            disabled={isMaxedOut}
            title={isMaxedOut ? 'All connection types configured' : 'Add new connection'}
          >
            + Add Connection
          </button>
        </div>
      </div>

      {/* Backend unreachable banner */}
      {fetchError && (
        <div style={{
          marginBottom: 16, padding: '12px 16px',
          background: 'rgba(220,38,38,0.05)',
          border: '1px solid rgba(220,38,38,0.25)',
          borderRadius: 'var(--radius-sm)',
          display: 'flex', alignItems: 'center', gap: 12, fontSize: 13,
        }}>
          <span style={{ color: 'var(--danger)', fontWeight: 600 }}>⚠️ Could not reach backend</span>
          <span style={{ color: 'var(--text-muted)', flex: 1 }}>{fetchError} — showing cached connections</span>
          <button className="btn btn-secondary btn-sm" onClick={fetchConfigs}>↺ Retry</button>
        </div>
      )}

      {/* Connection cards grid */}
      {connections.length === 0 ? (
        <div className="card" style={{ marginBottom: 20, textAlign: 'center' }}>
          <div className="empty-state">
            <div className="empty-state-icon">🔌</div>
            No connections configured. Click <strong>Add Connection</strong> to get started.
          </div>
        </div>
      ) : (
        <div className="connection-cards-grid">
          {connections.map(conn => (
            <ConnectionCard
              key={conn.name}
              conn={conn}
              onEdit={handleEdit}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}


      {/* ── Confirm & Proceed ── */}
      {isConfirmed ? (
        <div className="wizard-confirm-bar confirmed">
          <div style={{ flex: 1, fontWeight: 600 }}>✅ Connections confirmed</div>
          <button className="btn btn-primary" onClick={onConfirm}>
            Proceed to Objects →
          </button>
        </div>
      ) : (
        <div className="wizard-confirm-bar">
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
              {canProceed ? '✅ Required connections ready' : '⚠️ Missing required connections to proceed'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {canProceed
                ? 'All required connections configured. Confirm to proceed to object selection.'
                : 'Fabric Lakehouse, Salesforce, Dynamics 365, and SharePoint connections are required.'}
            </div>
          </div>
          <button
            className="btn btn-primary"
            disabled={!canProceed}
            onClick={onConfirm}
          >
            Confirm & Proceed →
          </button>
        </div>
      )}

      {/* Modal */}
      {modal?.mode === 'add' && (
        <ConnectionModal
          onSave={handleSave}
          onClose={() => setModal(null)}
          existingTypes={connections.map(c => c.type)}
        />
      )}
      {modal?.mode === 'edit' && (
        <ConnectionModal
          editConn={modal.conn}
          onSave={handleSave}
          onClose={() => setModal(null)}
          existingTypes={connections.map(c => c.type).filter(t => t !== modal.conn.type)}
        />
      )}
    </div>
  );
};


export default ConnectionTab;
import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:8000';

/* ── Vector provider logos ─────────────────────────────────────────── */
function QdrantLogo({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="6" fill="#DC244C" />
      <path d="M16 4L28 10.5V21.5L16 28L4 21.5V10.5L16 4Z" fill="none" stroke="white" strokeWidth="1.8"/>
      <path d="M16 4L16 16M16 16L28 10.5M16 16L4 10.5M16 16L28 21.5M16 16L4 21.5M16 16L16 28" stroke="white" strokeWidth="1.4" strokeOpacity="0.7"/>
    </svg>
  );
}

function PineconeLogo({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="6" fill="#1C1C1C" />
      <path d="M16 5L22 9V15L16 19L10 15V9L16 5Z" fill="#00D4AA" />
      <path d="M10 15L16 19V27L10 23V15Z" fill="#00B894" />
      <path d="M22 15L16 19V27L22 23V15Z" fill="#00977A" />
    </svg>
  );
}

function VectorIcon({ provider, size = 20 }) {
  const wrap = { flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' };
  return (
    <div style={wrap}>
      {provider === 'qdrant'   && <QdrantLogo size={size} />}
      {provider === 'pinecone' && <PineconeLogo size={size} />}
      {!['qdrant', 'pinecone'].includes(provider) && (
        <div style={{ width: size, height: size, borderRadius: 5, background: '#374151', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.55, color: '#fff' }}>V</div>
      )}
    </div>
  );
}

const PROVIDERS = [
  { id: 'qdrant',   label: 'Qdrant',   description: 'Self-hosted or Qdrant Cloud' },
  { id: 'pinecone', label: 'Pinecone', description: 'Managed vector database' },
];

const EMBEDDING_OPTIONS = [
  { id: '',                       label: 'Use app default',          size: null },
  { id: 'text-embedding-3-small', label: 'OpenAI small (1536 dims)', size: 1536 },
  { id: 'text-embedding-3-large', label: 'OpenAI large (3072 dims)', size: 3072 },
];

export default function VectorConnectorPage() {
  const [configs,     setConfigs]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [showModal,   setShowModal]   = useState(false);
  const [editCfg,     setEditCfg]     = useState(null);
  const [deleting,    setDeleting]    = useState(null);
  const [settingDef,  setSettingDef]  = useState(null);
  const [testing,     setTesting]     = useState(null);
  const [testResults, setTestResults] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/connectors/vector`);
      const d = await r.json();
      setConfigs(d.configs || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id) => {
    setDeleting(id);
    try {
      await fetch(`${API}/connectors/vector/${id}`, { method: 'DELETE' });
      await load();
    } finally { setDeleting(null); }
  };

  const handleSetDefault = async (id) => {
    setSettingDef(id);
    try {
      await fetch(`${API}/connectors/vector/${id}/set-default`, { method: 'POST' });
      await load();
    } finally { setSettingDef(null); }
  };

  const handleTest = async (id) => {
    setTesting(id);
    try {
      const r = await fetch(`${API}/connectors/vector/${id}/test`, { method: 'POST' });
      const d = await r.json();
      setTestResults(prev => ({ ...prev, [id]: d }));
    } catch (e) {
      setTestResults(prev => ({ ...prev, [id]: { success: false, error: String(e) } }));
    }
    setTesting(null);
  };

  const truncateUrl = (url) => {
    if (!url) return '';
    return url.length > 40 ? url.slice(0, 38) + '…' : url;
  };

  return (
    <div className="connector-page">
      {/* Header */}
      <div className="connector-header">
        <div>
          <h1 className="connector-title">Connect Vector</h1>
          <p className="connector-subtitle">
            Use Qdrant or Pinecone for RAG, Agent Chat, and Sense. Keys are encrypted and never logged.
          </p>
        </div>
        <button className="connector-add-btn" onClick={() => setShowModal(true)}>
          + Add Vector DB
        </button>
      </div>

      {/* Configs Card */}
      <div className="connector-card">
        <div className="connector-card-header">
          <div className="connector-card-title">Vector configurations</div>
          <div className="connector-card-subtitle">
            Default is used for Agent Chat, Index to Qdrant, and Sense. You can have one of each provider.
          </div>
        </div>

        {loading ? (
          <div className="connector-empty">Loading…</div>
        ) : configs.length === 0 ? (
          <div className="connector-empty">
            No vector databases configured yet. Click <strong>+ Add Vector DB</strong> to get started.
          </div>
        ) : (
          <div className="connector-list">
            {configs.map(cfg => {
              const tr = testResults[cfg.id];
              return (
                <div
                  key={cfg.id}
                  className={`connector-item${cfg.is_default ? ' connector-item--default' : ''}`}
                >
                  <div className="connector-item-left">
                    <VectorIcon provider={cfg.provider} size={30} />
                    <div>
                      <div className="connector-item-name">
                        {cfg.display_name}
                        <span className={`connector-badge connector-badge--provider connector-badge--${cfg.provider}`}>
                          {cfg.provider}
                        </span>
                        {cfg.is_default && (
                          <span className="connector-badge connector-badge--default">Default</span>
                        )}
                      </div>
                      <div className="connector-item-meta vec-meta">
                        {cfg.embedding_model && <span>{cfg.embedding_model}</span>}
                        {cfg.url
                          ? <span className="vec-url" title={cfg.url}>{truncateUrl(cfg.url)}</span>
                          : <span className="vec-url">Local file storage</span>
                        }
                      </div>
                      {tr && (
                        <div className={`conn-test-result ${tr.success ? 'success' : 'error'} vec-inline-result`}>
                          {tr.success ? `✓ ${tr.message}` : `✗ ${tr.error}`}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="connector-item-actions">
                    <button
                      className="connector-btn connector-btn--outline"
                      onClick={() => handleTest(cfg.id)}
                      disabled={testing === cfg.id}
                      title="Test connection"
                    >
                      {testing === cfg.id ? '…' : '⊙ Test'}
                    </button>
                    <button
                      className="connector-btn connector-btn--ghost"
                      onClick={() => setEditCfg(cfg)}
                      title="Edit"
                    >
                      ✎ Edit
                    </button>
                    {!cfg.is_default && (
                      <button
                        className="connector-btn connector-btn--ghost"
                        onClick={() => handleSetDefault(cfg.id)}
                        disabled={settingDef === cfg.id}
                        title="Set as default"
                      >
                        {settingDef === cfg.id ? '…' : '☆'}
                      </button>
                    )}
                    <button
                      className="connector-btn connector-btn--danger"
                      onClick={() => handleDelete(cfg.id)}
                      disabled={deleting === cfg.id}
                      title="Delete"
                    >
                      {deleting === cfg.id ? '…' : '🗑'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="connector-card connector-card--info">
        <div className="connector-card-title">How it works</div>
        <p>
          The <strong>default</strong> vector config is used when indexing Salesforce metadata,
          running Agent Chat semantic search, and powering Sense analytics.
        </p>
        <p>
          <strong>Qdrant:</strong> Local file storage is used automatically if no URL is configured —
          no Docker required for development. Provide a Qdrant Cloud URL + API key for production.
        </p>
        <p>
          <strong>Pinecone:</strong> Requires an index URL and API key from your Pinecone console.
        </p>
      </div>

      {showModal && (
        <AddVectorModal
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); load(); }}
        />
      )}
      {editCfg && (
        <EditVectorModal
          cfg={editCfg}
          onClose={() => setEditCfg(null)}
          onSaved={() => { setEditCfg(null); load(); }}
        />
      )}
    </div>
  );
}


/* ── Add Vector DB Modal ────────────────────────────────────────────────────── */
function AddVectorModal({ onClose, onSaved }) {
  const [provider,       setProvider]       = useState('qdrant');
  const [url,            setUrl]            = useState('');
  const [apiKey,         setApiKey]         = useState('');
  const [displayName,    setDisplayName]    = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [isDefault,      setIsDefault]      = useState(false);
  const [testing,        setTesting]        = useState(false);
  const [testResult,     setTestResult]     = useState(null);
  const [saving,         setSaving]         = useState(false);
  const [error,          setError]          = useState('');

  const embOpt = EMBEDDING_OPTIONS.find(e => e.id === embeddingModel);

  const handleTest = async () => {
    setTesting(true); setTestResult(null); setError('');
    try {
      const r = await fetch(`${API}/connectors/vector/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKey, url: url || null }),
      });
      setTestResult(await r.json());
    } catch (e) { setTestResult({ success: false, error: String(e) }); }
    setTesting(false);
  };

  const handleSave = async () => {
    setSaving(true); setError('');
    try {
      const r = await fetch(`${API}/connectors/vector`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider, api_key: apiKey || '', url: url || null,
          display_name: displayName || undefined,
          embedding_model: embeddingModel || null,
          vector_size: embOpt?.size || null,
          is_default: isDefault,
        }),
      });
      if (!r.ok) { const d = await r.json(); setError(d.detail || 'Save failed.'); return; }
      onSaved();
    } catch (e) { setError(String(e)); }
    setSaving(false);
  };

  return (
    <VectorModal
      title="Add Vector Database"
      provider={provider} setProvider={(p) => { setProvider(p); setTestResult(null); setError(''); }}
      url={url} setUrl={(v) => { setUrl(v); setTestResult(null); }}
      apiKey={apiKey} setApiKey={(v) => { setApiKey(v); setTestResult(null); setError(''); }}
      apiKeyPlaceholder={`Enter your ${PROVIDERS.find(p => p.id === provider)?.label || ''} API key`}
      displayName={displayName} setDisplayName={setDisplayName}
      embeddingModel={embeddingModel} setEmbeddingModel={setEmbeddingModel}
      isDefault={isDefault} setIsDefault={setIsDefault} showDefault
      testResult={testResult} error={error}
      testing={testing} saving={saving}
      onClose={onClose} onTest={handleTest} onSave={handleSave}
      saveBtnLabel="Save Config"
    />
  );
}


/* ── Edit Vector DB Modal ───────────────────────────────────────────────────── */
function EditVectorModal({ cfg, onClose, onSaved }) {
  const [provider,       setProvider]       = useState(cfg.provider);
  const [url,            setUrl]            = useState(cfg.url || '');
  const [apiKey,         setApiKey]         = useState('');
  const [displayName,    setDisplayName]    = useState(cfg.display_name || '');
  const [embeddingModel, setEmbeddingModel] = useState(cfg.embedding_model || '');
  const [testing,        setTesting]        = useState(false);
  const [testResult,     setTestResult]     = useState(null);
  const [saving,         setSaving]         = useState(false);
  const [error,          setError]          = useState('');

  const embOpt = EMBEDDING_OPTIONS.find(e => e.id === embeddingModel);

  const handleTest = async () => {
    setTesting(true); setTestResult(null); setError('');
    try {
      const r = await fetch(`${API}/connectors/vector/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKey, url: url || null }),
      });
      setTestResult(await r.json());
    } catch (e) { setTestResult({ success: false, error: String(e) }); }
    setTesting(false);
  };

  const handleSave = async () => {
    setSaving(true); setError('');
    try {
      const body = {
        provider, url: url || null,
        display_name: displayName || undefined,
        embedding_model: embeddingModel || null,
        vector_size: embOpt?.size || null,
      };
      if (apiKey.trim()) body.api_key = apiKey;
      const r = await fetch(`${API}/connectors/vector/${cfg.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const d = await r.json(); setError(d.detail || 'Update failed.'); return; }
      onSaved();
    } catch (e) { setError(String(e)); }
    setSaving(false);
  };

  return (
    <VectorModal
      title="Edit Vector Database"
      provider={provider} setProvider={(p) => { setProvider(p); setTestResult(null); setError(''); }}
      url={url} setUrl={(v) => { setUrl(v); setTestResult(null); }}
      currentUrl={cfg.url}
      apiKey={apiKey} setApiKey={(v) => { setApiKey(v); setTestResult(null); setError(''); }}
      apiKeyPlaceholder="Enter new key to change (leave blank to keep existing)"
      hasExistingKey={cfg.has_api_key}
      displayName={displayName} setDisplayName={setDisplayName}
      embeddingModel={embeddingModel} setEmbeddingModel={setEmbeddingModel}
      showDefault={false}
      testResult={testResult} error={error}
      testing={testing} saving={saving}
      onClose={onClose} onTest={handleTest} onSave={handleSave}
      saveBtnLabel="Update Config"
    />
  );
}


/* ── Shared Vector Modal Shell ──────────────────────────────────────────────── */
function VectorModal({
  title, provider, setProvider, url, setUrl, currentUrl, apiKey, setApiKey, apiKeyPlaceholder,
  hasExistingKey, displayName, setDisplayName, embeddingModel, setEmbeddingModel,
  isDefault, setIsDefault, showDefault,
  testResult, error, testing, saving,
  onClose, onTest, onSave, saveBtnLabel,
}) {
  const providerDef = PROVIDERS.find(p => p.id === provider);

  return (
    <div className="conn-modal-overlay" onClick={onClose}>
      <div className="conn-modal" onClick={e => e.stopPropagation()}>
        <div className="conn-modal-header">
          <span className="conn-modal-title">{title}</span>
          <button className="conn-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="conn-modal-body">
          {/* Provider */}
          <div className="conn-field">
            <label className="conn-label">Provider</label>
            <div className="conn-provider-grid">
              {PROVIDERS.map(p => (
                <button
                  key={p.id}
                  className={`conn-provider-btn${provider === p.id ? ' active' : ''}`}
                  onClick={() => setProvider(p.id)}
                >
                  <VectorIcon provider={p.id} size={22} />
                  <span>{p.label}</span>
                  <span className="conn-provider-desc">{p.description}</span>
                </button>
              ))}
            </div>
          </div>

          {/* URL */}
          <div className="conn-field">
            <label className="conn-label">
              {provider === 'qdrant' ? 'Qdrant URL' : 'Pinecone Index URL'}
              <span className="conn-optional"> (leave blank to use local file storage)</span>
            </label>
            <input
              type="text"
              className="conn-input"
              placeholder={provider === 'qdrant' ? 'https://xxxx.cloud.qdrant.io' : 'https://your-index-xxxx.svc.aped-xxxx.pinecone.io'}
              value={url}
              onChange={e => setUrl(e.target.value)}
            />
            {currentUrl !== undefined && (
              <div className="conn-current-value">
                <span className="conn-current-label">Current:</span>{' '}
                {currentUrl ? <span className="conn-current-data">{currentUrl}</span> : <span className="conn-current-local">Local file storage (no URL)</span>}
              </div>
            )}
          </div>

          {/* API Key */}
          <div className="conn-field">
            <label className="conn-label">
              API Key
              {provider === 'qdrant' && <span className="conn-optional"> (required for Qdrant Cloud)</span>}
            </label>
            <input
              type="password"
              className="conn-input"
              placeholder={apiKeyPlaceholder}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
            />
            {hasExistingKey !== undefined && (
              <div className="conn-current-value">
                <span className="conn-current-label">Current:</span>{' '}
                <span className="conn-current-local">Encrypted key stored securely — enter a new key above to replace it</span>
              </div>
            )}
          </div>

          {/* Embedding Model */}
          <div className="conn-field">
            <label className="conn-label">Embedding Model <span className="conn-optional">(optional)</span></label>
            <select className="conn-input" value={embeddingModel} onChange={e => setEmbeddingModel(e.target.value)}>
              {EMBEDDING_OPTIONS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
            </select>
          </div>

          {/* Display Name */}
          <div className="conn-field">
            <label className="conn-label">Display Name <span className="conn-optional">(optional)</span></label>
            <input
              type="text"
              className="conn-input"
              placeholder={`e.g. ${providerDef?.label || ''} Production`}
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
            />
          </div>

          {/* Default (add only) */}
          {showDefault && (
            <div className="conn-field conn-field--row">
              <label className="conn-checkbox-label">
                <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} />
                Set as default vector config
              </label>
            </div>
          )}

          {testResult && (
            <div className={`conn-test-result ${testResult.success ? 'success' : 'error'}`}>
              {testResult.success ? `✓ ${testResult.message}` : `✗ ${testResult.error}`}
            </div>
          )}
          {error && <div className="conn-test-result error">✗ {error}</div>}
        </div>

        <div className="conn-modal-footer">
          <button className="conn-btn-secondary" onClick={onClose}>Cancel</button>
          <button className="conn-btn-ghost" onClick={onTest} disabled={testing}>
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
          <button className="conn-btn-primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : saveBtnLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

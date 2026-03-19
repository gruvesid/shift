import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:8000';

/* ── Real SVG logos ────────────────────────────────────────────────── */
function OpenAILogo({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

function AnthropicLogo({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.304 3.541h-3.672l6.696 16.918h3.672zm-10.608 0L0 20.459h3.744l1.38-3.588h7.044l1.38 3.588h3.744L10.596 3.541zm-.372 10.398l2.076-5.4 2.076 5.4z" />
    </svg>
  );
}

function CohereLogo({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="12" fill="#39594D" />
      <path d="M8.55 15.89c1.94 0 4.63-.63 6.7-2.17.27-.2.56-.45.56-.83 0-.54-.5-.85-.97-.85-.23 0-.45.08-.64.21-1.6 1.14-3.59 1.7-5.58 1.7-3.1 0-5.06-1.47-5.06-3.56 0-2.21 2.1-3.75 5.3-3.75 1.53 0 3.02.27 4.52.81a8.84 8.84 0 0 0 3.2.6c2.52 0 4.42-1.5 4.42-3.94 0-1.92-1.26-3.33-3.84-3.33H8.4C3.84.78 0 4.53 0 9.15c0 4.1 3.07 6.74 8.55 6.74z" fill="#D4E8D1" transform="translate(3,4) scale(0.75)" />
    </svg>
  );
}

/* ── Provider logo wrapper ─────────────────────────────────────────── */
function ProviderIcon({ provider, size = 22 }) {
  const wrapStyle = {
    width: size + 8, height: size + 8,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 8, flexShrink: 0,
    background: provider === 'openai'    ? '#000'
               : provider === 'anthropic' ? '#c96442'
               : provider === 'cohere'    ? '#39594D'
               : '#374151',
    color: '#fff',
  };
  return (
    <div style={wrapStyle}>
      {provider === 'openai'    && <OpenAILogo size={size} />}
      {provider === 'anthropic' && <AnthropicLogo size={size} />}
      {provider === 'cohere'    && <CohereLogo size={size} />}
      {!['openai','anthropic','cohere'].includes(provider) && <span style={{ fontSize: size * 0.7 }}>🤖</span>}
    </div>
  );
}

const PROVIDERS = [
  {
    id: 'openai', label: 'OpenAI',
    models: [
      // Latest flagship
      { id: 'gpt-5',                    label: 'GPT-5' },
      { id: 'gpt-4.5-preview',          label: 'GPT-4.5 Preview' },
      // GPT-4o family
      { id: 'gpt-4o',                  label: 'GPT-4o' },
      { id: 'gpt-4o-2024-11-20',       label: 'GPT-4o (Nov 2024)' },
      { id: 'gpt-4o-mini',             label: 'GPT-4o Mini' },
      { id: 'gpt-4o-mini-2024-07-18',  label: 'GPT-4o Mini (Jul 2024)' },
      // o-series reasoning models
      { id: 'o3',                       label: 'o3' },
      { id: 'o3-mini',                  label: 'o3 Mini' },
      { id: 'o4-mini',                  label: 'o4 Mini' },
      { id: 'o1',                       label: 'o1' },
      { id: 'o1-mini',                  label: 'o1 Mini' },
      { id: 'o1-preview',               label: 'o1 Preview' },
      // GPT-4.1 family
      { id: 'gpt-4.1',                  label: 'GPT-4.1' },
      { id: 'gpt-4.1-mini',             label: 'GPT-4.1 Mini' },
      { id: 'gpt-4.1-nano',             label: 'GPT-4.1 Nano' },
      // GPT-4 Turbo
      { id: 'gpt-4-turbo',              label: 'GPT-4 Turbo' },
      { id: 'gpt-4-turbo-2024-04-09',   label: 'GPT-4 Turbo (Apr 2024)' },
      // Legacy
      { id: 'gpt-3.5-turbo',            label: 'GPT-3.5 Turbo' },
    ],
  },
  {
    id: 'anthropic', label: 'Anthropic',
    models: [
      { id: 'claude-opus-4-6',           label: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ],
  },
  {
    id: 'cohere', label: 'Cohere',
    models: [
      { id: 'command-r-plus',    label: 'Command R+' },
      { id: 'command-r-08-2024', label: 'Command R (Aug 2024)' },
      { id: 'command-r',         label: 'Command R' },
    ],
  },
];

const TASK_DEFS = [
  { key: 'code_convert_llm_id', label: 'Code Conversion',  desc: 'Apex → C# / D365 conversion' },
  { key: 'validate_llm_id',     label: 'Validation & Fix', desc: 'Code review + fix loop'       },
  { key: 'agent_chat_llm_id',   label: 'Agent Chat',       desc: 'AI assistant / metadata chat' },
  { key: 'indexing_llm_id',     label: 'Indexing',         desc: 'Vector embedding & search'    },
];

export default function LLMConnectorPage() {
  const [configs, setConfigs]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [showModal, setShowModal]   = useState(false);
  const [editCfg, setEditCfg]       = useState(null);
  const [deleting, setDeleting]     = useState(null);
  const [settingDef, setSettingDef] = useState(null);

  // routing & fix loop
  const [routing,       setRouting]       = useState(null);
  const [routingDirty,  setRoutingDirty]  = useState(false);
  const [routingSaving, setRoutingSaving] = useState(false);
  const [routingSaved,  setRoutingSaved]  = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [llmRes, routingRes] = await Promise.all([
        fetch(`${API}/connectors/llm`),
        fetch(`${API}/connectors/llm-routing`),
      ]);
      const llmData     = await llmRes.json();
      const routingData = await routingRes.json();
      setConfigs(llmData.configs || []);
      setRouting(routingData);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRoutingChange = (key, value) => {
    setRouting(r => ({ ...r, [key]: value }));
    setRoutingDirty(true);
    setRoutingSaved(false);
  };

  const handleRoutingSave = async () => {
    setRoutingSaving(true);
    try {
      await fetch(`${API}/connectors/llm-routing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(routing),
      });
      setRoutingDirty(false);
      setRoutingSaved(true);
      setTimeout(() => setRoutingSaved(false), 2500);
    } catch { /* ignore */ }
    setRoutingSaving(false);
  };

  const handleDelete = async (id) => {
    setDeleting(id);
    try {
      await fetch(`${API}/connectors/llm/${id}`, { method: 'DELETE' });
      await load();
    } finally { setDeleting(null); }
  };

  const handleSetDefault = async (id) => {
    setSettingDef(id);
    try {
      await fetch(`${API}/connectors/llm/${id}/set-default`, { method: 'POST' });
      await load();
    } finally { setSettingDef(null); }
  };

  return (
    <div className="connector-page">
      {/* Header */}
      <div className="connector-header">
        <div>
          <h1 className="connector-title">Connect LLM</h1>
          <p className="connector-subtitle">
            Configure AI providers for chat, code conversion, and migration assistance
          </p>
        </div>
        <button className="connector-add-btn" onClick={() => setShowModal(true)}>
          + Add Provider
        </button>
      </div>

      {/* Providers Card */}
      <div className="connector-card">
        <div className="connector-card-header">
          <div className="connector-card-title">Your LLM Providers</div>
          <div className="connector-card-subtitle">
            The default provider is used for all chat, migration, and code conversion operations.
          </div>
        </div>

        {loading ? (
          <div className="connector-empty">Loading…</div>
        ) : configs.length === 0 ? (
          <div className="connector-empty">
            No providers configured yet. Click <strong>+ Add Provider</strong> to get started.
          </div>
        ) : (
          <div className="connector-list">
            {configs.map(cfg => (
              <div
                key={cfg.id}
                className={`connector-item${cfg.is_default ? ' connector-item--default' : ''}`}
              >
                <div className="connector-item-left">
                  <ProviderIcon provider={cfg.provider} />
                  <div>
                    <div className="connector-item-name">
                      {cfg.display_name}
                      {cfg.is_default && <span className="connector-badge connector-badge--default">★ Default</span>}
                    </div>
                    <div className="connector-item-meta">
                      {cfg.provider.charAt(0).toUpperCase() + cfg.provider.slice(1)} / {cfg.model}
                    </div>
                  </div>
                </div>
                <div className="connector-item-actions">
                  {!cfg.is_default && (
                    <button
                      className="connector-btn connector-btn--outline"
                      onClick={() => handleSetDefault(cfg.id)}
                      disabled={settingDef === cfg.id}
                    >
                      {settingDef === cfg.id ? '…' : '✓ Set Default'}
                    </button>
                  )}
                  <button
                    className="connector-btn connector-btn--ghost"
                    onClick={() => setEditCfg(cfg)}
                    title="Edit"
                  >
                    ✎ Edit
                  </button>
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
            ))}
          </div>
        )}
      </div>

      {/* Task Routing + Fix Loop */}
      {routing && configs.length > 0 && (
        <div className="connector-card">
          <div className="connector-card-header">
            <div className="connector-card-title">Task Routing</div>
            <div className="connector-card-subtitle">
              Assign a specific model to each operation. Leave as "Default" to use the starred provider.
            </div>
          </div>

          <div style={{ padding: '0 20px 4px' }}>
            {TASK_DEFS.map(task => (
              <div key={task.key} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ width: 160, flexShrink: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{task.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{task.desc}</div>
                </div>
                <select
                  style={{ flex: 1, background: 'var(--surface-secondary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, padding: '6px 10px' }}
                  value={routing[task.key] || ''}
                  onChange={e => handleRoutingChange(task.key, e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">⭐ Default provider</option>
                  {configs.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.display_name} — {c.provider}/{c.model}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {/* Fix Loop */}
          <div style={{ padding: '16px 20px 4px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Fix Loop</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
              When validation fails, automatically retry with the LLM up to N times.
              Escalate to a more powerful model on later attempts to reduce cost.
            </div>

            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>MAX RETRIES</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[1,2,3,4,5].map(n => (
                    <button
                      key={n}
                      onClick={() => handleRoutingChange('fix_loop_max_retries', n)}
                      style={{
                        width: 32, height: 32, borderRadius: 6, border: '1px solid var(--border)',
                        background: routing.fix_loop_max_retries === n ? 'var(--accent-primary)' : 'var(--surface-secondary)',
                        color: routing.fix_loop_max_retries === n ? '#fff' : 'var(--text-secondary)',
                        fontWeight: 600, fontSize: 13, cursor: 'pointer',
                      }}
                    >{n}</button>
                  ))}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>ESCALATE AFTER</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[1,2,3,4].map(n => (
                    <button
                      key={n}
                      onClick={() => handleRoutingChange('fix_loop_escalate_after', n)}
                      style={{
                        width: 32, height: 32, borderRadius: 6, border: '1px solid var(--border)',
                        background: routing.fix_loop_escalate_after === n ? '#f59e0b' : 'var(--surface-secondary)',
                        color: routing.fix_loop_escalate_after === n ? '#fff' : 'var(--text-secondary)',
                        fontWeight: 600, fontSize: 13, cursor: 'pointer',
                      }}
                    >{n}</button>
                  ))}
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center', marginLeft: 4 }}>retries, switch to →</span>
                </div>
              </div>

              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>ESCALATION MODEL</div>
                <select
                  style={{ width: '100%', background: 'var(--surface-secondary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, padding: '6px 10px' }}
                  value={routing.fix_loop_escalate_llm_id || ''}
                  onChange={e => handleRoutingChange('fix_loop_escalate_llm_id', e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">Same model (no escalation)</option>
                  {configs.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.display_name} — {c.provider}/{c.model}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Visual summary */}
            <div style={{ marginTop: 14, padding: '10px 14px', background: 'var(--surface-tertiary, var(--surface-secondary))', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {Array.from({ length: routing.fix_loop_max_retries || 3 }, (_, i) => {
                const attempt = i + 1;
                const isEsc = attempt > (routing.fix_loop_escalate_after || 2) && routing.fix_loop_escalate_llm_id;
                const llmName = isEsc
                  ? configs.find(c => c.id === routing.fix_loop_escalate_llm_id)?.display_name
                  : (configs.find(c => c.id === routing.validate_llm_id)?.display_name || 'Default');
                return (
                  <span key={attempt} style={{
                    padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                    background: isEsc ? 'rgba(245,158,11,.15)' : 'rgba(99,102,241,.15)',
                    color: isEsc ? '#f59e0b' : 'var(--accent-primary)',
                    border: `1px solid ${isEsc ? 'rgba(245,158,11,.3)' : 'rgba(99,102,241,.3)'}`,
                  }}>
                    Try {attempt}: {llmName}
                  </span>
                );
              })}
            </div>
          </div>

          <div style={{ padding: '16px 20px', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            {routingSaved && <span style={{ fontSize: 12, color: '#23a55a', alignSelf: 'center' }}>✓ Saved</span>}
            <button
              className="connector-btn connector-btn--primary"
              onClick={handleRoutingSave}
              disabled={routingSaving || !routingDirty}
            >
              {routingSaving ? 'Saving…' : 'Save Settings'}
            </button>
          </div>
        </div>
      )}

      {/* How it works */}
      <div className="connector-card connector-card--info">
        <div className="connector-card-title">How it works</div>
        <p>
          The <strong>default</strong> provider is used for all AI-powered features: chat conversations,
          code conversion (Apex to C#/Deluge), and migration guidance.
        </p>
        <p>
          Your API keys are encrypted using AES-256 and are never exposed in the UI after saving.
          You can add multiple providers and switch the default at any time.
        </p>
      </div>

      {showModal && (
        <AddLLMModal
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); load(); }}
        />
      )}
      {editCfg && (
        <EditLLMModal
          cfg={editCfg}
          onClose={() => setEditCfg(null)}
          onSaved={() => { setEditCfg(null); load(); }}
        />
      )}
    </div>
  );
}


/* ── Add Provider Modal ─────────────────────────────────────────────────────── */
function AddLLMModal({ onClose, onSaved }) {
  const [provider,     setProvider]     = useState('openai');
  const [model,        setModel]        = useState('gpt-4o-mini');
  const [apiKey,       setApiKey]       = useState('');
  const [displayName,  setDisplayName]  = useState('');
  const [isDefault,    setIsDefault]    = useState(false);
  const [testing,      setTesting]      = useState(false);
  const [testResult,   setTestResult]   = useState(null);
  const [saving,       setSaving]       = useState(false);
  const [error,        setError]        = useState('');

  const providerDef = PROVIDERS.find(p => p.id === provider);
  const models      = providerDef?.models || [];

  const handleProviderChange = (p) => {
    setProvider(p);
    const pDef = PROVIDERS.find(x => x.id === p);
    setModel(pDef?.models[0]?.id || '');
    setTestResult(null);
    setError('');
  };

  const handleTest = async () => {
    if (!apiKey.trim()) { setError('Enter an API key first.'); return; }
    setTesting(true); setTestResult(null); setError('');
    try {
      const r = await fetch(`${API}/connectors/llm/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKey, model }),
      });
      setTestResult(await r.json());
    } catch (e) { setTestResult({ success: false, error: String(e) }); }
    setTesting(false);
  };

  const handleSave = async () => {
    if (!apiKey.trim()) { setError('API key is required.'); return; }
    setSaving(true); setError('');
    try {
      const r = await fetch(`${API}/connectors/llm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKey, model, display_name: displayName || undefined, is_default: isDefault }),
      });
      if (!r.ok) { const d = await r.json(); setError(d.detail || 'Save failed.'); return; }
      onSaved();
    } catch (e) { setError(String(e)); }
    setSaving(false);
  };

  return (
    <LLMModal
      title="Add LLM Provider"
      provider={provider} setProvider={handleProviderChange}
      model={model} setModel={setModel}
      apiKey={apiKey} setApiKey={(v) => { setApiKey(v); setTestResult(null); setError(''); }}
      apiKeyPlaceholder={`Enter your ${providerDef?.label || ''} API key`}
      displayName={displayName} setDisplayName={setDisplayName}
      isDefault={isDefault} setIsDefault={setIsDefault} showDefault
      testResult={testResult} error={error}
      testing={testing} saving={saving}
      onClose={onClose}
      onTest={handleTest}
      onSave={handleSave}
      saveBtnLabel="Save Provider"
    />
  );
}


/* ── Edit Provider Modal ────────────────────────────────────────────────────── */
function EditLLMModal({ cfg, onClose, onSaved }) {
  const [provider,     setProvider]     = useState(cfg.provider);
  const [model,        setModel]        = useState(cfg.model);
  const [apiKey,       setApiKey]       = useState('');
  const [displayName,  setDisplayName]  = useState(cfg.display_name || '');
  const [testing,      setTesting]      = useState(false);
  const [testResult,   setTestResult]   = useState(null);
  const [saving,       setSaving]       = useState(false);
  const [error,        setError]        = useState('');

  const providerDef = PROVIDERS.find(p => p.id === provider);

  const handleProviderChange = (p) => {
    setProvider(p);
    const pDef = PROVIDERS.find(x => x.id === p);
    setModel(pDef?.models[0]?.id || '');
    setTestResult(null); setError('');
  };

  const handleTest = async () => {
    setTesting(true); setTestResult(null); setError('');
    try {
      let r;
      if (apiKey.trim()) {
        r = await fetch(`${API}/connectors/llm/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, api_key: apiKey, model }),
        });
      } else {
        r = await fetch(`${API}/connectors/llm/${cfg.id}/test`, { method: 'POST' });
      }
      setTestResult(await r.json());
    } catch (e) { setTestResult({ success: false, error: String(e) }); }
    setTesting(false);
  };

  const handleSave = async () => {
    setSaving(true); setError('');
    try {
      const body = { provider, model, display_name: displayName || undefined };
      if (apiKey.trim()) body.api_key = apiKey;
      const r = await fetch(`${API}/connectors/llm/${cfg.id}`, {
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
    <LLMModal
      title="Edit LLM Provider"
      provider={provider} setProvider={handleProviderChange}
      model={model} setModel={setModel}
      apiKey={apiKey} setApiKey={(v) => { setApiKey(v); setTestResult(null); setError(''); }}
      apiKeyPlaceholder="Enter new key to change (leave blank to keep existing)"
      showKeyHint keyPreview={cfg.api_key_preview}
      displayName={displayName} setDisplayName={setDisplayName}
      showDefault={false}
      testResult={testResult} error={error}
      testing={testing} saving={saving}
      onClose={onClose}
      onTest={handleTest}
      onSave={handleSave}
      saveBtnLabel="Update Provider"
    />
  );
}


/* ── Shared LLM Modal Shell ─────────────────────────────────────────────────── */
function LLMModal({
  title, provider, setProvider, model, setModel,
  apiKey, setApiKey, apiKeyPlaceholder, showKeyHint, keyPreview,
  displayName, setDisplayName,
  isDefault, setIsDefault, showDefault,
  testResult, error, testing, saving,
  onClose, onTest, onSave, saveBtnLabel,
}) {
  const providerDef = PROVIDERS.find(p => p.id === provider);
  const models = providerDef?.models || [];

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
                  <ProviderIcon provider={p.id} size={18} />
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Model */}
          <div className="conn-field">
            <label className="conn-label">Model</label>
            <select className="conn-input" value={model} onChange={e => setModel(e.target.value)}>
              {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>

          {/* API Key */}
          <div className="conn-field">
            <label className="conn-label">API Key</label>
            <input
              type="password"
              className="conn-input"
              placeholder={apiKeyPlaceholder}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
            />
            {showKeyHint && (
              <div className="conn-current-value">
                <span className="conn-current-label">Current:</span>{' '}
                <span className="conn-current-local" style={{ fontFamily: 'monospace', letterSpacing: '0.05em' }}>
                  {keyPreview || '••••••••••••••••'}
                </span>
              </div>
            )}
          </div>

          {/* Display Name */}
          <div className="conn-field">
            <label className="conn-label">Display Name <span className="conn-optional">(optional)</span></label>
            <input
              type="text"
              className="conn-input"
              placeholder={`e.g. ${providerDef?.label || ''} - ${model}`}
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
            />
          </div>

          {/* Set as default (add only) */}
          {showDefault && (
            <div className="conn-field conn-field--row">
              <label className="conn-checkbox-label">
                <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} />
                Set as default provider
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

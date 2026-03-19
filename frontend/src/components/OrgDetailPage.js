import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { authFetch } from '../utils/authFetch';

const API = process.env.REACT_APP_API_URL || 'http://localhost:8000';

const METADATA_TYPES = [
  { id: 'apex_classes',    label: 'Apex Classes',    icon: '◈', desc: 'Server-side Apex code classes used for business logic and...' },
  { id: 'apex_triggers',   label: 'Apex Triggers',   icon: '⚡', desc: 'Triggers that execute automatically on record create,...' },
  { id: 'flows',           label: 'Flows',           icon: '⥅', desc: 'Automation flows — Screen, Record-Triggered, Scheduled,...' },
  { id: 'lwc_components',  label: 'LWC Components',  icon: '◱', desc: 'Lightning Web Components — modern standards-based...' },
  { id: 'aura_components', label: 'Aura Components', icon: '◫', desc: 'Aura components — older Salesforce UI framework still...' },
];

function formatDate(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function StatusPill({ status }) {
  const map = {
    connected:   { label: 'Connected',   cls: 'odp-pill odp-pill--green' },
    completed:   { label: 'Completed',   cls: 'odp-pill odp-pill--green' },
    pending:     { label: 'Pending',     cls: 'odp-pill odp-pill--gray'  },
    indexed:     { label: 'Indexed',     cls: 'odp-pill odp-pill--green' },
    not_indexed: { label: 'Not Indexed', cls: 'odp-pill odp-pill--gray'  },
    error:       { label: 'Error',       cls: 'odp-pill odp-pill--red'   },
  };
  const s = map[status] || map.pending;
  return <span className={s.cls}>{s.label}</span>;
}

/* ── Toast system ──────────────────────────────────────────────────── */
let _toastId = 0;

function ToastContainer({ toasts, onRemove }) {
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast--${t.type}`}>
          <span className="toast-icon">
            {t.type === 'success' ? '✓' : t.type === 'error' ? '✗' : t.type === 'loading' ? '' : 'ℹ'}
          </span>
          {t.type === 'loading' && <span className="toast-spinner" />}
          <span className="toast-msg">{t.message}</span>
          <button className="toast-close" onClick={() => onRemove(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

/* ── Full-screen loading overlay ───────────────────────────────────── */
function LoadingOverlay({ message }) {
  return (
    <div className="odp-overlay">
      <div className="odp-overlay-card">
        <div className="odp-overlay-spinner" />
        <div className="odp-overlay-msg">{message}</div>
      </div>
    </div>
  );
}

/* ── Page loading skeleton ─────────────────────────────────────────── */
function PageLoader() {
  return (
    <div className="odp-page-loader">
      <div className="odp-page-loader-spinner" />
      <div className="odp-page-loader-text">Loading org details…</div>
    </div>
  );
}

/* ── Agent Chat Modal ──────────────────────────────────────────────── */
const CHAT_SUGGESTIONS = [
  'How many Apex classes are there?',
  'Which triggers should I migrate first?',
  'How do I convert LWC to PCF?',
  'Summarize the migration complexity',
];

function ChatBotIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="10" rx="2"/>
      <circle cx="12" cy="5" r="2"/>
      <path d="M12 7v4"/>
      <path d="M8 15h.01M12 15h.01M16 15h.01" strokeWidth="2.5"/>
    </svg>
  );
}

function ChatUserIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4"/>
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
    </svg>
  );
}

function ChatSendIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4 20-7z"/>
    </svg>
  );
}

function ChatStopIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>;
}

function SimpleMarkdown({ text }) {
  if (!text) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {text.split('\n').map((line, i) => {
        if (/^#{1,3} /.test(line)) return <p key={i} style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>{line.replace(/^#+\s/, '')}</p>;
        if (/^[-*] /.test(line)) return <p key={i} style={{ margin: 0, paddingLeft: 4 }}>• {line.slice(2)}</p>;
        if (line.trim() === '') return <br key={i} />;
        return <p key={i} style={{ margin: 0 }}>{line}</p>;
      })}
    </div>
  );
}

function AgentChatModal({ orgId, orgName, onClose }) {
  const [messages,   setMessages]   = useState([]);
  const [input,      setInput]      = useState('');
  const [loading,    setLoading]    = useState(false);
  const [streaming,  setStreaming]  = useState(false);
  const [sessionId,  setSessionId]  = useState(null);
  const bottomRef  = useRef(null);
  const inputRef   = useRef(null);
  const abortRef   = useRef(null);

  useLayoutEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 100); }, []);

  const stopStream = () => {
    abortRef.current?.abort();
    setStreaming(false); setLoading(false);
  };

  const sendMessage = async (text) => {
    const msg = (text || input).trim();
    if (!msg || loading) return;
    const asstId = `a-${Date.now()}`;
    setMessages(prev => [...prev, { id: `u-${Date.now()}`, role: 'user', content: msg }, { id: asstId, role: 'assistant', content: '' }]);
    setInput('');
    setLoading(true); setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(`${API}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, session_id: sessionId, org_name: orgName || null }),
        signal: ctrl.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'session' && evt.session_id && !sessionId) setSessionId(evt.session_id);
            else if (evt.type === 'chunk') setMessages(prev => prev.map(m => m.id === asstId ? { ...m, content: m.content + evt.content } : m));
            else if (evt.type === 'done' && evt.full_content) setMessages(prev => prev.map(m => m.id === asstId ? { ...m, content: evt.full_content } : m));
            else if (evt.type === 'error') setMessages(prev => prev.map(m => m.id === asstId ? { ...m, content: `⚠ ${evt.message}`, isError: true } : m));
          } catch { /* ignore */ }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') setMessages(prev => prev.map(m => m.id === asstId ? { ...m, content: `⚠ ${e.message || 'Connection failed.'}`, isError: true } : m));
    } finally { abortRef.current = null; setStreaming(false); setLoading(false); }
  };

  const handleKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };

  return (
    <div className="ai-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ai-modal ai-chat-modal-v2">

        {/* Header */}
        <div className="acm-header">
          <div className="acm-header-icon"><ChatBotIcon /></div>
          <div className="acm-header-info">
            <span className="acm-header-title">Agent Chat</span>
            {orgName && <span className="acm-header-org">· {orgName}</span>}
            <span className="acm-badge">● Ready</span>
          </div>
          <button className="acm-close-btn" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        {/* Messages */}
        <div className="acm-body">
          {messages.length === 0 ? (
            <div className="acm-empty">
              <div className="acm-empty-icon"><ChatBotIcon /></div>
              <div className="acm-empty-title">Migration AI Assistant</div>
              <div className="acm-empty-sub">Ask about Apex classes, triggers, flows, components, or migration strategies.</div>
              <div className="acm-suggestions">
                {CHAT_SUGGESTIONS.map(s => (
                  <button key={s} className="acm-suggestion" onClick={() => sendMessage(s)}>{s}</button>
                ))}
              </div>
            </div>
          ) : messages.map(m => (
            <div key={m.id} className={`acm-row acm-row--${m.role}`}>
              {m.role === 'assistant' && <div className="acm-avatar acm-avatar--bot"><ChatBotIcon /></div>}
              <div className={`acm-bubble acm-bubble--${m.role}${m.isError ? ' acm-bubble--error' : ''}`}>
                {m.role === 'assistant'
                  ? (m.content ? <SimpleMarkdown text={m.content} /> : <div className="acm-typing"><span/><span/><span/></div>)
                  : <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{m.content}</p>
                }
              </div>
              {m.role === 'user' && <div className="acm-avatar acm-avatar--user"><ChatUserIcon /></div>}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="acm-footer">
          <textarea
            ref={inputRef}
            className="acm-textarea"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask about your Salesforce migration..."
            rows={1}
            disabled={!streaming && loading}
          />
          {streaming ? (
            <button className="acm-send-btn acm-send-btn--stop" onClick={stopStream}><ChatStopIcon /></button>
          ) : (
            <button className="acm-send-btn" onClick={() => sendMessage()} disabled={!input.trim() || loading}><ChatSendIcon /></button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Field Mapping Modal ────────────────────────────────────────────── */
function FieldMappingModal({ orgId, onClose }) {
  const [loading,    setLoading]    = useState(false);
  const [fetching,   setFetching]   = useState(false);
  const [data,       setData]       = useState(null);
  const [error,      setError]      = useState('');
  const [search,     setSearch]     = useState('');
  const [expanded,   setExpanded]   = useState({});

  // Load stored mapping on open
  useEffect(() => {
    setLoading(true);
    authFetch(`${API}/shift/connections/${orgId}/field-mapping`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setData(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [orgId]);

  const handleFetch = async () => {
    setFetching(true); setError('');
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/fetch-field-mapping`, { method: 'POST' });
      const d = await r.json();
      if (r.ok) { setData({ fetched_at: d.fetched_at, mapping: d.mapping }); }
      else       { setError(d.detail || 'Fetch failed.'); }
    } catch (e) { setError(e.message); }
    finally     { setFetching(false); }
  };

  const handleDownload = () => {
    if (!data?.mapping) return;
    const blob = new Blob([JSON.stringify(data.mapping, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url; a.download = '00_field_mapping.json'; a.click();
    URL.revokeObjectURL(url);
  };

  const objects    = data?.mapping?.objects || {};
  const objKeys    = Object.keys(objects).filter(k =>
    !search.trim() || k.toLowerCase().includes(search.toLowerCase())
  );
  const totalObjs  = data?.mapping?._total_objects  || 0;
  const totalFlds  = data?.mapping?._total_fields   || 0;

  const toggleObj = (key) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="ai-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ai-modal fm-modal">
        {/* Header */}
        <div className="ai-modal-header">
          <span className="ai-modal-icon">⬡</span>
          <span className="ai-modal-title">Field Mapping</span>
          <span className="ai-modal-sub">Fabric SQL → sf_to_dv_column_mapping</span>
          <button className="ai-modal-close" onClick={onClose}>×</button>
        </div>

        {/* Toolbar */}
        <div className="fm-toolbar">
          <button className="fm-fetch-btn" onClick={handleFetch} disabled={fetching}>
            {fetching ? <><span className="odp-btn-spinner" /> Fetching from Fabric…</> : '↻ Fetch from Fabric SQL'}
          </button>
          {data && (
            <>
              <div className="fm-stats">
                <span className="fm-stat">{totalObjs} objects</span>
                <span className="fm-stat">{totalFlds.toLocaleString()} fields</span>
                <span className="fm-stat-date">Last fetched: {new Date(data.fetched_at).toLocaleString()}</span>
              </div>
              <button className="fm-dl-btn" onClick={handleDownload} title="Download as JSON">⬇ Download JSON</button>
            </>
          )}
        </div>

        {error && <div className="ai-chat-error fm-error">⚠ {error}</div>}

        {/* Body */}
        <div className="fm-body">
          {loading ? (
            <div className="fm-empty"><span className="odp-overlay-spinner" style={{ width: 32, height: 32 }} /></div>
          ) : !data ? (
            <div className="fm-empty">
              <div className="fm-empty-icon">⬡</div>
              <div className="fm-empty-title">No field mapping stored yet</div>
              <div className="fm-empty-sub">Click "Fetch from Fabric SQL" to pull the latest mapping.</div>
            </div>
          ) : (
            <>
              <input
                className="fm-search"
                placeholder="Search Salesforce objects…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <div className="fm-obj-list">
                {objKeys.length === 0 && <div className="fm-empty-sub">No objects match "{search}"</div>}
                {objKeys.map(key => {
                  const obj    = objects[key];
                  const isOpen = expanded[key];
                  return (
                    <div key={key} className="fm-obj-card">
                      <button className="fm-obj-header" onClick={() => toggleObj(key)}>
                        <span className="fm-obj-arrow">{isOpen ? '▾' : '▸'}</span>
                        <span className="fm-obj-name">{key}</span>
                        {obj.Dynamics_Object && <span className="fm-obj-dv">→ {obj.Dynamics_Object}</span>}
                        <span className="fm-obj-count">{obj.fields.length} fields</span>
                      </button>
                      {isOpen && (
                        <div className="fm-fields-table-wrap">
                          <table className="fm-fields-table">
                            <thead>
                              <tr>
                                <th>Salesforce Field</th>
                                <th>D365 Field</th>
                                <th>Type</th>
                                <th>Display Name</th>
                                <th>Options</th>
                              </tr>
                            </thead>
                            <tbody>
                              {obj.fields.map((f, i) => (
                                <tr key={i}>
                                  <td className="fm-cell-mono">{f.Salesforce_Column}</td>
                                  <td className="fm-cell-mono">{f.Dataverse_Column}</td>
                                  <td><span className={`fm-type-badge fm-type-${(f.Dataverse_Data_Type || '').toLowerCase().replace(/\s+/g, '_')}`}>{f.Dataverse_Data_Type}</span></td>
                                  <td>{f.Dataverse_Display_Name}</td>
                                  <td>
                                    {f.options
                                      ? <span className="fm-opts-count" title={f.options.map(o => o.label).join(', ')}>{f.options.length} options</span>
                                      : <span className="fm-opts-none">—</span>
                                    }
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Code Converter Modal ───────────────────────────────────────────── */
function CodeConverterModal({ orgId, onClose }) {
  const [sourceType,   setSourceType]   = useState('apex_class');
  const [sourceCode,   setSourceCode]   = useState('');
  const [userNotes,    setUserNotes]    = useState('');
  const [converting,   setConverting]   = useState(false);
  const [result,       setResult]       = useState(null);
  const [error,        setError]        = useState('');

  const handleConvert = async () => {
    if (!sourceCode.trim() || converting) return;
    setConverting(true);
    setResult(null);
    setError('');
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/convert-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_code: sourceCode, source_type: sourceType, notes: userNotes }),
      });
      const d = await r.json();
      if (r.ok) {
        setResult(d);
      } else {
        setError(d.detail || 'Conversion failed.');
      }
    } catch (e) {
      setError(e.message);
    } finally { setConverting(false); }
  };

  const handleCopy = () => {
    if (result?.converted_code) {
      navigator.clipboard.writeText(result.converted_code).catch(() => {});
    }
  };

  const handleDownload = () => {
    if (!result?.converted_code) return;
    const ext  = result.file_ext || '.txt';
    const blob = new Blob([result.converted_code], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `converted${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="ai-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ai-modal ai-converter-modal">
        <div className="ai-modal-header">
          <span className="ai-modal-icon">⇄</span>
          <span className="ai-modal-title">Code Converter</span>
          <span className="ai-modal-sub">Convert Salesforce code to Dynamics 365 equivalent</span>
          <button className="ai-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="ai-converter-body">
          <div className="ai-converter-left">
            <div className="ai-converter-label">SOURCE TYPE</div>
            <select
              className="ai-converter-select"
              value={sourceType}
              onChange={e => { setSourceType(e.target.value); setResult(null); setError(''); }}
            >
              {CHAT_SOURCE_TYPES.map(t => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>

            <div className="ai-converter-label" style={{ marginTop: 12 }}>SOURCE CODE</div>
            <textarea
              className="ai-converter-code"
              value={sourceCode}
              onChange={e => setSourceCode(e.target.value)}
              placeholder="Paste your Salesforce code here…"
              spellCheck={false}
            />

            <div className="ai-converter-label" style={{ marginTop: 8 }}>NOTES (optional)</div>
            <input
              className="ai-converter-notes"
              value={userNotes}
              onChange={e => setUserNotes(e.target.value)}
              placeholder="e.g. target D365 version, special requirements…"
            />

            <button
              className="ai-converter-btn"
              onClick={handleConvert}
              disabled={!sourceCode.trim() || converting}
            >
              {converting ? <><span className="odp-btn-spinner" /> Converting…</> : '⇄ Convert to D365'}
            </button>
            {error && <div className="ai-chat-error">⚠ {error}</div>}
          </div>

          <div className="ai-converter-right">
            <div className="ai-converter-label">
              CONVERTED OUTPUT
              {result && <span className="ai-converter-target-badge">{result.target_type}</span>}
            </div>

            {result ? (
              <>
                <div className="ai-converter-output-toolbar">
                  <button className="ai-converter-tool-btn" onClick={handleCopy} title="Copy to clipboard">⎘ Copy</button>
                  <button className="ai-converter-tool-btn" onClick={handleDownload} title="Download file">⬇ Download{result.file_ext}</button>
                </div>
                <textarea
                  className="ai-converter-code ai-converter-output"
                  value={result.converted_code}
                  readOnly
                  spellCheck={false}
                />
                {result.migration_notes && (
                  <div className="ai-converter-notes-box">
                    <pre className="ai-converter-notes-text">{result.migration_notes}</pre>
                  </div>
                )}
              </>
            ) : (
              <div className="ai-converter-empty">
                {converting
                  ? <><div className="odp-overlay-spinner" style={{ width: 32, height: 32, marginBottom: 12 }} />Converting…</>
                  : 'Converted code will appear here'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Rulebook Modal ─────────────────────────────────────────────────── */
const DEFAULT_RB_TYPES = new Set(['apex_class', 'apex_trigger', 'lwc', 'aura', 'flow']);

const EMPTY_NEW_RB = { title: '', component_type: '', system_prompt: '', rules: '' };

function RulebookModal({ onClose }) {
  const [entries,    setEntries]    = useState([]);
  const [active,     setActive]     = useState('apex_class');
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [saved,      setSaved]      = useState(false);
  const [edits,      setEdits]      = useState({});   // {component_type: {rules, system_prompt}}
  const [error,      setError]      = useState('');
  const [showAdd,    setShowAdd]    = useState(false);
  const [newRb,      setNewRb]      = useState(EMPTY_NEW_RB);
  const [addError,   setAddError]   = useState('');
  const [adding,     setAdding]     = useState(false);
  const [deleting,   setDeleting]   = useState(false);

  const loadEntries = () => {
    setLoading(true);
    authFetch(`${API}/shift/rulebook`)
      .then(r => r.json())
      .then(d => {
        const list = d.rulebook || [];
        setEntries(list);
        if (list.length && !list.find(e => e.component_type === active)) {
          setActive(list[0].component_type);
        }
      })
      .catch(() => setError('Failed to load rulebook.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadEntries(); }, []); // eslint-disable-line

  const current = entries.find(e => e.component_type === active) || null;
  const draft = edits[active] || {};

  const handleChange = (field, value) => {
    setEdits(prev => ({ ...prev, [active]: { ...prev[active], [field]: value } }));
    setSaved(false);
  };

  const handleSave = async () => {
    if (!current) return;
    setSaving(true); setError('');
    try {
      const payload = {
        rules:         draft.rules         ?? current.rules,
        system_prompt: draft.system_prompt ?? current.system_prompt,
        title:         draft.title         ?? current.title,
      };
      const r = await authFetch(`${API}/shift/rulebook/${active}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        setEntries(prev => prev.map(e => e.component_type === active ? { ...e, ...payload } : e));
        setEdits(prev => { const n = { ...prev }; delete n[active]; return n; });
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      } else {
        const d = await r.json();
        setError(d.detail || 'Save failed.');
      }
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const handleAdd = async () => {
    setAddError('');
    if (!newRb.title.trim()) { setAddError('Title is required.'); return; }
    if (!newRb.component_type.trim()) { setAddError('Type slug is required.'); return; }
    setAdding(true);
    try {
      const r = await authFetch(`${API}/shift/rulebook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newRb),
      });
      const d = await r.json();
      if (r.ok) {
        setEntries(prev => [...prev, d.rulebook]);
        setActive(d.rulebook.component_type);
        setShowAdd(false);
        setNewRb(EMPTY_NEW_RB);
      } else {
        setAddError(d.detail || 'Create failed.');
      }
    } catch (e) { setAddError(e.message); }
    setAdding(false);
  };

  const handleDelete = async () => {
    if (!current || DEFAULT_RB_TYPES.has(active)) return;
    if (!window.confirm(`Delete rulebook "${current.title}"? This cannot be undone.`)) return;
    setDeleting(true); setError('');
    try {
      const r = await authFetch(`${API}/shift/rulebook/${active}`, { method: 'DELETE' });
      if (r.ok) {
        const remaining = entries.filter(e => e.component_type !== active);
        setEntries(remaining);
        setActive(remaining.length ? remaining[0].component_type : '');
      } else {
        const d = await r.json();
        setError(d.detail || 'Delete failed.');
      }
    } catch (e) { setError(e.message); }
    setDeleting(false);
  };

  const rulesVal        = draft.rules         ?? current?.rules         ?? '';
  const systemPromptVal = draft.system_prompt  ?? current?.system_prompt ?? '';
  const titleVal        = draft.title          ?? current?.title         ?? '';
  const isDirty         = Object.keys(draft).length > 0;
  const isCustom        = active && !DEFAULT_RB_TYPES.has(active);

  return (
    <div className="ai-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ai-modal rb-modal">
        <div className="ai-modal-header">
          <span className="ai-modal-icon">📋</span>
          <span className="ai-modal-title">Conversion Rulebook</span>
          <span className="ai-modal-sub">Type-specific rules used by the LLM during code conversion</span>
          <button className="ai-modal-close" onClick={onClose}>×</button>
        </div>

        {loading ? (
          <div className="fm-empty"><span className="odp-overlay-spinner" style={{ width: 32, height: 32 }} /></div>
        ) : (
          <div className="rb-body">
            {/* Tabs sidebar */}
            <div className="rb-tabs">
              {entries.map(e => (
                <button
                  key={e.component_type}
                  type="button"
                  className={`rb-tab${active === e.component_type ? ' active' : ''}${edits[e.component_type] ? ' dirty' : ''}`}
                  onClick={() => { setActive(e.component_type); setShowAdd(false); }}
                >
                  {e.title || e.component_type}
                  {edits[e.component_type] && <span className="rb-dot" />}
                </button>
              ))}
              <button
                type="button"
                className={`rb-tab rb-tab--add${showAdd ? ' active' : ''}`}
                onClick={() => { setShowAdd(s => !s); setAddError(''); }}
              >
                + Add Rulebook
              </button>
            </div>

            {/* Add new form */}
            {showAdd ? (
              <div className="rb-content rb-add-form">
                <div className="rb-add-title">New Rulebook Entry</div>
                <div className="rb-field">
                  <label className="rb-label">DISPLAY TITLE</label>
                  <input
                    className="rb-input"
                    value={newRb.title}
                    onChange={e => setNewRb(p => ({ ...p, title: e.target.value }))}
                    placeholder="e.g. Custom Trigger → C# IPlugin"
                  />
                </div>
                <div className="rb-field">
                  <label className="rb-label">TYPE SLUG <span style={{ opacity: 0.5, fontWeight: 400 }}>(lowercase, used internally)</span></label>
                  <input
                    className="rb-input"
                    value={newRb.component_type}
                    onChange={e => setNewRb(p => ({ ...p, component_type: e.target.value.toLowerCase().replace(/\s+/g, '_') }))}
                    placeholder="e.g. custom_trigger"
                  />
                </div>
                <div className="rb-field">
                  <label className="rb-label">SYSTEM PROMPT</label>
                  <textarea
                    className="rb-textarea rb-textarea--sm"
                    value={newRb.system_prompt}
                    onChange={e => setNewRb(p => ({ ...p, system_prompt: e.target.value }))}
                    rows={3}
                    placeholder="You are an expert migration engineer…"
                    spellCheck={false}
                  />
                </div>
                <div className="rb-field">
                  <label className="rb-label">CONVERSION RULES</label>
                  <textarea
                    className="rb-textarea"
                    value={newRb.rules}
                    onChange={e => setNewRb(p => ({ ...p, rules: e.target.value }))}
                    rows={8}
                    placeholder="MANDATORY CONVERSION RULES…"
                    spellCheck={false}
                  />
                </div>
                {addError && <div className="ai-chat-error">⚠ {addError}</div>}
                <div className="rb-footer">
                  <button type="button" className="rb-cancel-btn" onClick={() => { setShowAdd(false); setNewRb(EMPTY_NEW_RB); }}>Cancel</button>
                  <button type="button" className="odp-save-config-btn" onClick={handleAdd} disabled={adding}>
                    {adding ? 'Creating…' : '+ Create Rulebook'}
                  </button>
                </div>
              </div>
            ) : current && (
              <div className="rb-content">
                {/* Title editable for custom entries */}
                {isCustom && (
                  <div className="rb-field">
                    <label className="rb-label">TITLE</label>
                    <input
                      className="rb-input"
                      value={titleVal}
                      onChange={e => handleChange('title', e.target.value)}
                    />
                  </div>
                )}
                <div className="rb-field">
                  <label className="rb-label">SYSTEM PROMPT</label>
                  <textarea
                    className="rb-textarea rb-textarea--sm"
                    value={systemPromptVal}
                    onChange={e => handleChange('system_prompt', e.target.value)}
                    rows={4}
                    spellCheck={false}
                  />
                </div>
                <div className="rb-field">
                  <label className="rb-label">CONVERSION RULES</label>
                  <textarea
                    className="rb-textarea"
                    value={rulesVal}
                    onChange={e => handleChange('rules', e.target.value)}
                    rows={18}
                    spellCheck={false}
                  />
                </div>
                {error && <div className="ai-chat-error">⚠ {error}</div>}
                <div className="rb-footer">
                  {current.updated_at && (
                    <span className="rb-updated">Last saved: {new Date(current.updated_at).toLocaleString()}</span>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
                    {isCustom && (
                      <button
                        type="button"
                        className="rb-delete-btn"
                        onClick={handleDelete}
                        disabled={deleting}
                        title="Delete this custom rulebook"
                      >
                        {deleting ? 'Deleting…' : '🗑 Delete'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="odp-save-config-btn"
                      onClick={handleSave}
                      disabled={saving || !isDirty}
                    >
                      {saving ? 'Saving…' : saved ? '✓ Saved' : '💾 Save rules'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function OrgDetailPage({ orgId, onBack, onNavigateToConverter, onNavigateToDeployment, onNavigateToAgentChat }) {
  const [detail,        setDetail]        = useState(null);
  const [loading,       setLoading]       = useState(true);
  const [selectedTypes, setSelectedTypes] = useState(null);
  const [configDirty,   setConfigDirty]   = useState(false);
  const [savingConfig,  setSavingConfig]  = useState(false);
  const [configSaved,   setConfigSaved]   = useState(false);
  const [extracting,    setExtracting]    = useState(false);
  const [reconnecting,  setReconnecting]  = useState(false);
  const [indexing,      setIndexing]      = useState(false);
  const [vectorStatus,  setVectorStatus]  = useState(null);
  const [clearing,      setClearing]      = useState(false);
  const [confirmClear,  setConfirmClear]  = useState(false);
  const [showFieldMapping, setShowFieldMapping] = useState(false);
  const [showRulebook,     setShowRulebook]     = useState(false);
  const [toasts,           setToasts]           = useState([]);
  const timerRefs = useRef({});

  const addToast = useCallback((message, type = 'success', duration = 4500) => {
    const id = ++_toastId;
    setToasts(prev => [...prev, { id, message, type }]);
    if (type !== 'loading') {
      timerRefs.current[id] = setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
        delete timerRefs.current[id];
      }, duration);
    }
    return id;
  }, []);

  const removeToast = useCallback((id) => {
    clearTimeout(timerRefs.current[id]);
    delete timerRefs.current[id];
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/detail`);
      if (r.ok) {
        const d = await r.json();
        setDetail(d);
        if (selectedTypes === null) setSelectedTypes(d.extract_config || []);
        setVectorStatus(d.vector_status || 'not_indexed');
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [orgId]); // eslint-disable-line

  useEffect(() => { load(); }, [load]);

  /* ── Reconnect Salesforce ── */
  const handleReconnectSF = async () => {
    if (reconnecting) return;
    setReconnecting(true);
    const loadingId = addToast('Reconnecting Salesforce…', 'loading', 0);
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/reconnect-sf`, { method: 'POST' });
      const d = await r.json();
      removeToast(loadingId);
      if (r.ok) {
        addToast(`Salesforce reconnected${d.username ? ` as ${d.username}` : ''}.`, 'success');
        await load();
      } else {
        addToast(d.detail || 'Reconnection failed.', 'error', 9000);
      }
    } catch (e) {
      removeToast(loadingId);
      addToast(e.message, 'error');
    } finally { setReconnecting(false); }
  };

  /* ── Config ── */
  const toggleType = (id) => {
    setSelectedTypes(prev => {
      const next = prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id];
      setConfigDirty(true);
      setConfigSaved(false);
      return next;
    });
  };

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/extract-config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata_types: selectedTypes }),
      });
      if (r.ok) {
        setConfigDirty(false);
        setConfigSaved(true);
        addToast('Configuration saved successfully.', 'success');
      } else {
        addToast('Failed to save configuration.', 'error');
      }
    } catch (e) {
      addToast(e.message, 'error');
    } finally { setSavingConfig(false); }
  };

  /* ── Extract ── */
  const handleExtract = async () => {
    if (extracting) return;
    setExtracting(true);
    const loadingId = addToast('Extracting Salesforce metadata… this may take a moment.', 'loading', 0);
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/extract`, { method: 'POST' });
      const d = await r.json();
      removeToast(loadingId);
      if (r.ok) {
        const total = Object.values(d.summary || {}).reduce((a, b) => a + b, 0);
        if (d.status === 'partial' && d.errors?.length) {
          addToast(`Partial extraction — ${total.toLocaleString()} items. Some types failed: ${d.errors[0]}`, 'error', 9000);
        } else {
          addToast(`Extraction complete — ${total.toLocaleString()} items extracted.`, 'success', 6000);
        }
        await load();
      } else {
        const msg = d.detail || 'Extraction failed.';
        const isAuth = r.status === 401 || msg.toLowerCase().includes('session') || msg.toLowerCase().includes('re-authoriz');
        addToast(isAuth ? '⚠ Salesforce session expired. Please re-authorize the connection.' : msg, 'error', 9000);
      }
    } catch (e) {
      removeToast(loadingId);
      addToast(e.message, 'error');
    } finally { setExtracting(false); }
  };

  /* ── Index to Vector ── */
  const handleIndexVector = async () => {
    if (indexing) return;
    setIndexing(true);
    const loadingId = addToast('Indexing metadata to vector store…', 'loading', 0);
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/index-vector`, { method: 'POST' });
      const d = await r.json();
      removeToast(loadingId);
      if (r.ok) {
        addToast(`Indexed ${d.document_count} documents to Qdrant.`, 'success');
        setVectorStatus('indexed');
        await load();
      } else {
        addToast(d.detail || 'Indexing failed.', 'error');
        setVectorStatus('error');
      }
    } catch (e) {
      removeToast(loadingId);
      addToast(e.message, 'error');
      setVectorStatus('error');
    } finally { setIndexing(false); }
  };

  /* ── Vector Status ── */
  const handleVectorStatus = async () => {
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/vector-status`);
      const d = await r.json();
      setVectorStatus(d.status);
      addToast(`Vector status: ${d.status}${d.document_count ? ` (${d.document_count} docs)` : ''}`, 'info');
    } catch (e) {
      addToast(e.message, 'error');
    }
  };

  /* ── Clear Metadata ── */
  const handleClear = async () => {
    setConfirmClear(false);
    setClearing(true);
    const loadingId = addToast('Clearing metadata…', 'loading', 0);
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/metadata`, { method: 'DELETE' });
      removeToast(loadingId);
      if (r.ok) {
        addToast('Metadata cleared successfully.', 'success');
        setVectorStatus('not_indexed');
        await load();
      } else {
        const d = await r.json();
        addToast(d.detail || 'Failed to clear metadata.', 'error');
      }
    } catch (e) {
      removeToast(loadingId);
      addToast(e.message, 'error');
    } finally { setClearing(false); }
  };

  if (loading) return <PageLoader />;

  if (!detail) {
    return (
      <div className="odp-loading">
        <div>Org not found.</div>
        <button className="odp-back-btn" onClick={onBack} style={{ marginTop: 16 }}>← Back to Home</button>
      </div>
    );
  }

  const summary = detail.summary || {};
  const hasMetadata = !!detail.extracted_at;

  return (
    <div className="odp-page">
      <ToastContainer toasts={toasts} onRemove={removeToast} />

      {showFieldMapping && <FieldMappingModal orgId={orgId} onClose={() => setShowFieldMapping(false)} />}
      {showRulebook     && <RulebookModal     onClose={() => setShowRulebook(false)} />}
      {(extracting || clearing) && (
        <LoadingOverlay message={extracting ? 'Extracting Salesforce metadata…' : 'Clearing metadata…'} />
      )}

      {/* ── Back ── */}
      <button className="odp-back-btn" onClick={onBack}>← Back to Home</button>

      {/* ── Header — single line ── */}
      <div className="odp-header-row">
        <span className="odp-title-inline">{detail.name}</span>
        {detail.sf_org_id && <span className="odp-meta-chip">{detail.sf_org_id}</span>}
        {detail.sf_instance_url && (
          <a className="odp-meta-link" href={detail.sf_instance_url} target="_blank" rel="noreferrer">
            ↗ {detail.sf_instance_url.replace('https://', '')}
          </a>
        )}
        <span className="odp-meta-sep">·</span>
        <span className="odp-crm-badge odp-crm-badge--sf">Salesforce</span>
        <span className="odp-arrow">→</span>
        <span className="odp-crm-badge odp-crm-badge--d365">Microsoft Dynamics 365</span>
        <button className="odp-delete-btn" title="Delete org" style={{ marginLeft: 'auto' }} onClick={() => {
          if (window.confirm(`Delete org "${detail.name}"?`)) {
            authFetch(`${API}/shift/connections/${orgId}`, { method: 'DELETE' }).then(() => onBack());
          }
        }}>🗑</button>
      </div>

      {/* ── Session expired warning banner ── */}
      {detail.sf_status !== 'connected' && (
        <div className="odp-reauth-banner">
          <span className="odp-reauth-icon">⚠</span>
          <span className="odp-reauth-msg">
            {detail.sf_status === 'needs_reauth'
              ? 'Salesforce session expired. Reconnect to extract metadata.'
              : 'Salesforce not connected. Authorize to continue.'}
          </span>
          <button
            className="odp-reauth-btn"
            onClick={handleReconnectSF}
            disabled={reconnecting}
          >
            {reconnecting ? <><span className="odp-btn-spinner" /> Reconnecting…</> : '↺ Reconnect Salesforce'}
          </button>
        </div>
      )}

      {/* ── Stat Cards ── */}
      <div className="odp-stat-grid">
        {[
          { label: 'CONNECTION', value: detail.sf_status === 'connected' ? 'Connected' : detail.sf_status === 'needs_reauth' ? 'Session Expired' : 'Pending', status: detail.sf_status === 'needs_reauth' ? 'error' : detail.sf_status },
          { label: 'METADATA',   value: hasMetadata ? 'Completed' : 'Pending',                      status: hasMetadata ? 'completed' : 'pending' },
          { label: 'TARGET CRM', value: 'Microsoft Dynamics 365', status: null },
          { label: 'LAST SYNC',  value: formatDate(detail.extracted_at), status: null },
        ].map(({ label, value, status }) => (
          <div key={label} className="odp-stat-card">
            <div className="odp-stat-label">{label}</div>
            <div className="odp-stat-value">{value}</div>
            {status && <StatusPill status={status} />}
          </div>
        ))}
      </div>

      {/* ── Extract Configuration ── */}
      <div className="odp-section">
        <div className="odp-step-banner"><span className="odp-step-num">Step 1</span> Configure the Extract Settings</div>
        <div className="odp-section-header">
          <div className="odp-section-title-row">
            <span className="odp-section-icon">⇄</span>
            <span className="odp-section-title">Extract Configuration</span>
            {!configDirty && !configSaved && <span className="odp-setup-badge">Setup required</span>}
            {configSaved && <span className="odp-saved-badge">✓ Saved</span>}
          </div>
          <p className="odp-section-hint">
            Choose which metadata types to extract before running extraction. You can update this anytime to add or remove components.
          </p>
        </div>

        <div className="odp-types-label">METADATA TYPES</div>
        <p className="odp-types-sublabel">Select which components to extract from Salesforce</p>

        <div className="odp-types-grid">
          {METADATA_TYPES.map(t => (
            <label key={t.id} className={`odp-type-card${selectedTypes?.includes(t.id) ? ' selected' : ''}`}>
              <input
                type="checkbox"
                checked={selectedTypes?.includes(t.id) || false}
                onChange={() => toggleType(t.id)}
                className="odp-type-check"
              />
              <span className="odp-type-icon">{t.icon}</span>
              <div>
                <div className="odp-type-name">{t.label}</div>
                <div className="odp-type-desc">{t.desc}</div>
              </div>
            </label>
          ))}
        </div>

        <div className="odp-config-footer">
          <span className="odp-config-status">{configDirty ? 'Unsaved changes' : configSaved ? '✓ Configuration saved' : ''}</span>
          <button
            className="odp-save-config-btn"
            onClick={handleSaveConfig}
            disabled={savingConfig || !configDirty}
          >
            {savingConfig ? 'Saving…' : '💾 Save configuration'}
          </button>
        </div>
      </div>

      {/* ── Actions ── */}
      <div className="odp-section">
        <h3 className="odp-actions-title">Actions <span className="odp-actions-hint">ⓘ</span></h3>

        <div className="odp-actions-group">
          <div className="odp-step-banner"><span className="odp-step-num">Step 2</span> Extract the Metadata</div>
          <div className="odp-actions-group-label">EXTRACT</div>
          <p className="odp-actions-group-desc">Pull selected Salesforce metadata into the local database. Uses the configuration set in Step 1.</p>
          <div className="odp-actions-row">
            <button
              className="odp-action-btn odp-action-btn--primary"
              onClick={handleExtract}
              disabled={extracting}
              title="Extract Salesforce metadata and store in SQLite"
            >
              {extracting
                ? <><span className="odp-btn-spinner" /> Extracting…</>
                : hasMetadata ? '↻ Re-Extract' : '▶ Extract'}
            </button>
            {confirmClear ? (
              <div className="odp-confirm-inline">
                <span className="odp-confirm-inline-icon">⚠</span>
                <span className="odp-confirm-inline-msg">Cannot be undone. Confirm clear?</span>
                <button className="odp-confirm-btn odp-confirm-btn--cancel" onClick={() => setConfirmClear(false)}>Cancel</button>
                <button className="odp-confirm-btn odp-confirm-btn--danger" onClick={handleClear}>Yes, Clear</button>
              </div>
            ) : (
              <button
                className="odp-action-btn odp-action-btn--danger"
                onClick={() => setConfirmClear(true)}
                disabled={clearing || !hasMetadata}
                title="Clear all extracted metadata"
              >
                {clearing ? 'Clearing…' : '⊘ Clear Metadata'}
              </button>
            )}
          </div>
        </div>

        <div className="odp-actions-group">
          <div className="odp-step-banner"><span className="odp-step-num">Step 3</span> Index the Metadata</div>
          <div className="odp-actions-group-label">VECTOR INDEX</div>
          <p className="odp-actions-group-desc">Index extracted metadata into the Qdrant vector store to enable semantic AI search and Agent Chat.</p>
          <div className="odp-actions-row">
            <button
              className="odp-action-btn odp-action-btn--primary"
              onClick={handleIndexVector}
              disabled={indexing || !hasMetadata}
              title={hasMetadata ? 'Index metadata to Qdrant vector store for AI chat' : 'Extract metadata first'}
            >
              {indexing ? <><span className="odp-btn-spinner" /> Indexing…</> : '⊗ Index to Vector'}
            </button>
            <button
              className="odp-action-btn"
              onClick={handleVectorStatus}
              title="Check Qdrant index status"
            >
              Vector status {vectorStatus ? <StatusPill status={vectorStatus} /> : null}
            </button>
          </div>
        </div>

        <div className="odp-actions-group">
          <div className="odp-step-banner"><span className="odp-step-num">Step 4</span> Extract the Field Mapping from Fabric</div>
          <div className="odp-actions-group-label">FABRIC FIELD MAPPING & RULEBOOK</div>
          <p className="odp-actions-group-desc">Fetch the Salesforce → Dynamics 365 field mapping from Fabric SQL. View and edit the conversion rulebook used by the LLM during code conversion.</p>
          <div className="odp-actions-row">
            <button
              className="odp-action-btn odp-action-btn--fabric"
              onClick={() => setShowFieldMapping(true)}
              title="View Fabric SQL field mapping (sf_to_dv_column_mapping)"
            >
              ⬡ Field Mapping
            </button>
            <button
              className="odp-action-btn odp-action-btn--primary"
              onClick={() => setShowRulebook(true)}
              title="View and edit the LLM conversion rulebook"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
              {' '}Rulebook
            </button>
          </div>
        </div>

        <div className="odp-actions-group">
          <div className="odp-step-banner"><span className="odp-step-num">Step 5</span> Use Agent &amp; Code Converter to Migrate Individual Components</div>
          <div className="odp-actions-group-label">AI & TOOLS</div>
          <p className="odp-actions-group-desc">Use Agent Chat to analyse and plan each component, then use the Code Converter to translate Apex, triggers, flows, and components to Dynamics 365.</p>
          <div className="odp-actions-row">
            <button
              className="odp-action-btn odp-action-btn--primary"
              onClick={() => onNavigateToAgentChat && onNavigateToAgentChat(orgId, detail?.name)}
              disabled={!hasMetadata}
              title={hasMetadata ? 'Open Agent Chat' : 'Extract metadata first'}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              {' '}Agent Chat
            </button>
            <button
              className="odp-action-btn odp-action-btn--primary"
              onClick={() => onNavigateToConverter && onNavigateToConverter(orgId)}
              title="Open Code Converter"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
              {' '}Code Converter
            </button>
          </div>
        </div>

        <div className="odp-actions-group">
          <div className="odp-step-banner"><span className="odp-step-num">Step 6</span> Plan the Deployment for Bulk Migration</div>
          <div className="odp-actions-group-label">DEPLOYMENT</div>
          <p className="odp-actions-group-desc">Schedule and execute bulk migration of all converted components to your Dynamics 365 environment.</p>
          <div className="odp-actions-row">
            <button
              className="odp-action-btn odp-action-btn--primary"
              onClick={() => onNavigateToDeployment && onNavigateToDeployment(orgId, detail.name)}
              title="Open Deployment Plans"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
              {' '}Deployment Plans
            </button>
          </div>
        </div>
      </div>

      {/* ── Metadata Summary ── */}
      <div className="odp-section">
        <div className="odp-section-header">
          <div className="odp-section-title-row">
            <span className="odp-section-icon">≡</span>
            <span className="odp-section-title">Metadata Summary</span>
            <span className="odp-actions-hint">ⓘ</span>
          </div>
        </div>

        {!hasMetadata ? (
          <div className="odp-no-metadata">
            No metadata extracted yet. Click <strong>Extract</strong> to extract Salesforce metadata.
          </div>
        ) : (
          <div className="odp-summary-grid">
            {[
              { label: 'Apex Classes',     value: summary.apex_classes     || 0, icon: '◈' },
              { label: 'Triggers',         value: summary.triggers         || 0, icon: '⚡' },
              { label: 'Flows',            value: summary.flows            || 0, icon: '⥅' },
              { label: 'Validation Rules', value: summary.validation_rules || 0, icon: '✓' },
              { label: 'LWC',              value: summary.lwc              || 0, icon: '◱' },
              { label: 'Aura',             value: summary.aura             || 0, icon: '◫' },
            ].map(({ label, value, icon }) => (
              <div key={label} className="odp-summary-card">
                <div className="odp-summary-icon">{icon}</div>
                <div className="odp-summary-value">{value.toLocaleString()}</div>
                <div className="odp-summary-label">{label}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

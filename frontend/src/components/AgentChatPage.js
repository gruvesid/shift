import React, { useState, useEffect, useRef, useCallback } from 'react';
import { authFetch } from '../utils/authFetch';

const API = process.env.REACT_APP_API_URL || 'http://localhost:8000';

const SUGGESTIONS = [
  'How many custom objects do I have?',
  'List my Apex triggers',
  'Generate a migration plan',
];

/* ── Icons ──────────────────────────────────────────────────────────────── */
function BotIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v4" />
      <path d="M8 15h.01M12 15h.01M16 15h.01" strokeWidth="2.5" />
    </svg>
  );
}

function UserIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}

function SendIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2L11 13" />
      <path d="M22 2L15 22l-4-9-9-4 20-7z" />
    </svg>
  );
}

function PlusIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ClockIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

function ChevronLeftIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function LinkIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function TrashIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4h6v2" />
    </svg>
  );
}

function StopIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

/* ── Simple markdown renderer (bold, code, bullets) ───────────────────── */
function SimpleMarkdown({ text }) {
  if (!text) return null;
  const lines = text.split('\n');
  return (
    <div className="ac-md">
      {lines.map((line, i) => {
        if (/^#{1,3} /.test(line)) {
          const content = line.replace(/^#+\s/, '');
          return <p key={i} className="ac-md-h">{content}</p>;
        }
        if (/^[-*] /.test(line)) {
          return <p key={i} className="ac-md-li">• {renderInline(line.slice(2))}</p>;
        }
        if (line.trim() === '') return <br key={i} />;
        return <p key={i} className="ac-md-p">{renderInline(line)}</p>;
      })}
    </div>
  );
}

/* ── Tool step icons & labels ─────────────────────────────────────────────── */
const TOOL_META = {
  get_metadata_summary: { icon: '📊', label: 'Getting metadata summary' },
  search_metadata:      { icon: '🔍', label: 'Searching metadata' },
  get_component_source: { icon: '📄', label: 'Fetching source code' },
  convert_component:    { icon: '⚡', label: 'Converting to C#' },
  deploy_component:     { icon: '🚀', label: 'Deploying to D365' },
};

function ToolSteps({ steps }) {
  if (!steps || steps.length === 0) return null;
  return (
    <div className="ac-tool-steps">
      {steps.map((step, i) => {
        const meta = TOOL_META[step.name] || { icon: '🔧', label: step.name };
        const argsLabel = step.args
          ? (step.args.query || step.args.component_name || step.args.component_type || '')
          : '';
        const isDone = step.done;
        return (
          <div key={i} className={`ac-tool-step${isDone ? ' ac-tool-step--done' : ' ac-tool-step--running'}`}>
            <div className="ac-tool-step-dot">
              {isDone
                ? <svg width="9" height="9" viewBox="0 0 12 12"><polyline points="2,6 5,9 10,3" stroke="#23a55a" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
                : <span className="ac-tool-step-spinner" />}
            </div>
            <span className="ac-tool-step-label">
              {meta.icon} {meta.label}{argsLabel ? `: ${argsLabel}` : ''}
            </span>
            {isDone && step.display && (
              <span className="ac-tool-step-result">{step.display}</span>
            )}
            {isDone && step.duration_ms && (
              <span className="ac-tool-step-ms">{step.duration_ms}ms</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function renderInline(text) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="ac-md-code">{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

/* ── Thinking indicator ───────────────────────────────────────────────── */
const THINKING_PHASES = [
  'Thinking…',
  'Reading your question…',
  'Searching metadata…',
  'Planning response…',
  'Generating answer…',
];

function TypingDots() {
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const tick = setInterval(() => {
      setElapsed(s => s + 1);
      setPhaseIdx(i => (i + 1 < THINKING_PHASES.length ? i + 1 : i));
    }, 2200);
    return () => clearInterval(tick);
  }, []);

  return (
    <div className="ac-thinking">
      <div className="ac-thinking-pulse">
        <span /><span /><span />
      </div>
      <span className="ac-thinking-label">{THINKING_PHASES[phaseIdx]}</span>
      {elapsed > 0 && (
        <span className="ac-thinking-elapsed">{elapsed * 2.2 | 0}s</span>
      )}
    </div>
  );
}

/* ── Time formatter ───────────────────────────────────────────────────── */
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ── Main Component ───────────────────────────────────────────────────── */
export default function AgentChatPage({ onBack }) {
  const [sessions,        setSessions]        = useState([]);
  const [currentSession,  setCurrentSession]  = useState(null);
  const [messages,        setMessages]        = useState([]);
  const [input,           setInput]           = useState('');
  const [loading,         setLoading]         = useState(false);
  const [streaming,       setStreaming]        = useState(false);
  const [showSessions,    setShowSessions]    = useState(() => {
    try { return localStorage.getItem('ac_sidebar') !== 'closed'; } catch { return true; }
  });
  const [hasLLM,          setHasLLM]          = useState(true);
  const [orgInfo,         setOrgInfo]         = useState(null);

  const messagesEndRef = useRef(null);
  const textareaRef    = useRef(null);
  const abortRef       = useRef(null);
  const readerRef      = useRef(null);

  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  useEffect(() => { scrollToBottom(); }, [messages]);

  // Load sessions + check LLM + load org info
  useEffect(() => {
    fetch(`${API}/chat/sessions`).then(r => r.json()).then(d => setSessions(d.sessions || [])).catch(() => {});
    fetch(`${API}/connectors/llm`).then(r => r.json()).then(d => setHasLLM((d.configs || []).length > 0)).catch(() => {});
    authFetch(`${API}/shift/stats`).then(r => r.json()).then(d => {
      if (d.orgs && d.orgs.length > 0) {
        const org = d.orgs[0];
        const cfg = org.config || {};
        setOrgInfo({ name: org.name, url: cfg.sf_instance_url || cfg.instanceUrl || '' });
      }
    }).catch(() => {});
  }, []);

  const loadMessages = useCallback(async (sessionId) => {
    try {
      const r = await fetch(`${API}/chat/sessions/${sessionId}/messages`);
      const d = await r.json();
      setMessages(d.messages || []);
    } catch { /* ignore */ }
  }, []);

  const switchSession = async (session) => {
    setCurrentSession(session);
    setMessages([]);
    setShowSessions(false);
    await loadMessages(session.id);
  };

  const startNewChat = () => {
    setCurrentSession(null);
    setMessages([]);
    setShowSessions(false);
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const deleteSession = async (e, sessionId) => {
    e.stopPropagation();
    await fetch(`${API}/chat/sessions/${sessionId}`, { method: 'DELETE' });
    const updated = sessions.filter(s => s.id !== sessionId);
    setSessions(updated);
    if (currentSession?.id === sessionId) startNewChat();
  };

  const stopStreaming = () => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    if (readerRef.current) { readerRef.current.cancel(); readerRef.current = null; }
    setStreaming(false);
    setLoading(false);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsgId  = `u-${Date.now()}`;
    const asstMsgId  = `a-${Date.now()}`;

    setMessages(prev => [
      ...prev,
      { id: userMsgId, role: 'user',      content: text },
      { id: asstMsgId, role: 'assistant', content: '' },
    ]);
    setInput('');
    setLoading(true);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${API}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          session_id: currentSession?.id || null,
          org_name: orgInfo?.name || null,
        }),
        signal: controller.signal,
      });

      const reader = res.body.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'session' && evt.session_id) {
              // Refresh sessions list
              fetch(`${API}/chat/sessions`).then(r => r.json()).then(d => {
                setSessions(d.sessions || []);
                const newSession = (d.sessions || []).find(s => s.id === evt.session_id);
                if (newSession && !currentSession) setCurrentSession(newSession);
              }).catch(() => {});
            } else if (evt.type === 'chunk') {
              setMessages(prev => prev.map(m =>
                m.id === asstMsgId ? { ...m, content: m.content + evt.content } : m
              ));
            } else if (evt.type === 'tool_call') {
              setMessages(prev => prev.map(m => {
                if (m.id !== asstMsgId) return m;
                const steps = [...(m.steps || [])];
                steps.push({ call_id: evt.call_id, name: evt.name, args: evt.args, done: false });
                return { ...m, steps };
              }));
            } else if (evt.type === 'tool_result') {
              setMessages(prev => prev.map(m => {
                if (m.id !== asstMsgId) return m;
                const steps = (m.steps || []).map(s =>
                  s.call_id === evt.call_id
                    ? { ...s, display: evt.display, duration_ms: evt.duration_ms, done: true }
                    : s
                );
                return { ...m, steps };
              }));
            } else if (evt.type === 'done' && evt.full_content) {
              setMessages(prev => prev.map(m =>
                m.id === asstMsgId ? { ...m, content: evt.full_content } : m
              ));
            } else if (evt.type === 'error') {
              setMessages(prev => prev.map(m =>
                m.id === asstMsgId ? { ...m, content: `⚠ ${evt.message}`, isError: true } : m
              ));
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setMessages(prev => prev.map(m =>
          m.id === asstMsgId ? { ...m, content: `⚠ ${err.message || 'Connection failed.'}`, isError: true } : m
        ));
      }
    } finally {
      abortRef.current = null;
      readerRef.current = null;
      setStreaming(false);
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleTextareaInput = (e) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 130) + 'px';
  };

  return (
    <div className="ac-root">

      {/* ── Sessions Sidebar ── */}
      <div className={`ac-sidebar${showSessions ? ' ac-sidebar--open' : ''}`}>
        <div className="ac-sidebar-header">
          <span className="ac-sidebar-title">Conversation History</span>
          <button className="ac-icon-btn" onClick={startNewChat} title="New conversation">
            <PlusIcon size={14} />
          </button>
        </div>
        <div className="ac-sidebar-list">
          {sessions.length === 0 ? (
            <p className="ac-sidebar-empty">No previous conversations</p>
          ) : sessions.map(s => (
            <button
              key={s.id}
              className={`ac-session-item${currentSession?.id === s.id ? ' active' : ''}`}
              onClick={() => switchSession(s)}
            >
              <div className="ac-session-title">{s.title}</div>
              <div className="ac-session-meta">
                <ClockIcon />{fmtTime(s.updated_at || s.created_at)}
              </div>
              <button
                className="ac-session-delete"
                onClick={(e) => deleteSession(e, s.id)}
                title="Delete"
              >
                <TrashIcon />
              </button>
            </button>
          ))}
        </div>
      </div>

      {/* ── Main Panel ── */}
      <div className="ac-main">

        {/* Header */}
        <div className="ac-header">
          {onBack && (
            <button className="ac-icon-btn" onClick={onBack} title="Back to Metadata Migration" style={{ marginRight: 4 }}>
              <ChevronLeftIcon size={18} />
            </button>
          )}
          <button className="ac-icon-btn" onClick={() => setShowSessions(v => !v)} title="Toggle history">
            {showSessions ? <ChevronLeftIcon /> : <BotIcon size={18} />}
          </button>

          <div className="ac-header-info">
            <div className="ac-header-title">
              Agent Chat
              <span className="ac-badge ac-badge--ready">● Ready</span>
            </div>
            {orgInfo && (
              <div className="ac-header-org">
                <span>{orgInfo.name}</span>
                {orgInfo.url && (
                  <>
                    <span className="ac-header-sep">–</span>
                    <LinkIcon />
                    <span className="ac-header-url">{orgInfo.url}</span>
                  </>
                )}
              </div>
            )}
          </div>

          <button className="ac-new-btn" onClick={startNewChat}>
            <PlusIcon /> New conversation
          </button>
        </div>

        {/* LLM warning */}
        {!hasLLM && (
          <div className="ac-llm-warn">
            ⚠ Agent Chat requires an LLM. Go to <strong>LLM Connector</strong> to configure one.
          </div>
        )}

        {/* Messages */}
        <div className="ac-messages">
          {messages.length === 0 ? (
            <div className="ac-empty">
              <div className="ac-empty-icon"><BotIcon size={40} /></div>
              <h3 className="ac-empty-title">Start a conversation</h3>
              <p className="ac-empty-sub">
                Ask about your Salesforce metadata, get migration advice,<br />or explore your org components.
              </p>
              <div className="ac-suggestions">
                {SUGGESTIONS.map(s => (
                  <button
                    key={s}
                    className="ac-suggestion-btn"
                    onClick={() => { setInput(s); setTimeout(() => textareaRef.current?.focus(), 50); }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map(msg => (
              <div key={msg.id} className={`ac-msg-row ac-msg-row--${msg.role}`}>
                {msg.role === 'assistant' && (
                  <div className="ac-avatar ac-avatar--bot"><BotIcon size={16} /></div>
                )}
                <div className={`ac-bubble ac-bubble--${msg.role}${msg.isError ? ' ac-bubble--error' : ''}`}>
                  {msg.role === 'assistant' ? (
                    <>
                      <ToolSteps steps={msg.steps} />
                      {msg.content
                        ? <SimpleMarkdown text={msg.content} />
                        : (!msg.steps || msg.steps.length === 0) && <TypingDots />
                      }
                    </>
                  ) : (
                    <p className="ac-user-text">{msg.content}</p>
                  )}
                </div>
                {msg.role === 'user' && (
                  <div className="ac-avatar ac-avatar--user"><UserIcon size={14} /></div>
                )}
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="ac-input-bar">
          <div className="ac-input-wrap">
            <textarea
              ref={textareaRef}
              className="ac-textarea"
              value={input}
              onChange={handleTextareaInput}
              onKeyDown={handleKeyDown}
              placeholder="Ask about your Salesforce migration..."
              rows={1}
              disabled={!hasLLM}
            />
            {streaming ? (
              <button className="ac-send-btn ac-send-btn--stop" onClick={stopStreaming} title="Stop">
                <StopIcon />
              </button>
            ) : (
              <button
                className="ac-send-btn"
                onClick={handleSend}
                disabled={!input.trim() || loading || !hasLLM}
                title="Send"
              >
                <SendIcon />
              </button>
            )}
          </div>
          <p className="ac-input-hint">Press Enter to send · Shift+Enter for new line</p>
        </div>
      </div>
    </div>
  );
}

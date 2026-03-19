import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:8000';

/* ── Component type config ──────────────────────────────────────────── */
const COMP_TYPES = [
  { id: 'all',          label: 'All',          badge: null,  color: '#6b7280' },
  { id: 'apex_class',   label: 'Apex Classes', badge: 'APX', color: '#3b82f6' },
  { id: 'apex_trigger', label: 'Triggers',     badge: 'TRG', color: '#f59e0b' },
  { id: 'flow',         label: 'Flows',        badge: 'FLW', color: '#10b981' },
  { id: 'lwc',          label: 'LWC',          badge: 'LWC', color: '#8b5cf6' },
  { id: 'aura',         label: 'Aura',         badge: 'AUR', color: '#ec4899' },
];

const TYPE_LABELS = {
  apex_class:   { badge: 'APX', color: '#3b82f6', ext: '.cls' },
  apex_trigger: { badge: 'TRG', color: '#f59e0b', ext: '.trigger' },
  flow:         { badge: 'FLW', color: '#10b981', ext: '' },
  lwc:          { badge: 'LWC', color: '#8b5cf6', ext: '.js' },
  aura:         { badge: 'AUR', color: '#ec4899', ext: '.cmp' },
};

/* ── Helpers ─────────────────────────────────────────────────────────── */
function fmtTokens(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(usd) {
  if (usd === undefined || usd === null) return '—';
  if (usd === 0) return '$0.0000';
  return `$${usd.toFixed(4)}`;
}

function fmtMs(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/* ── Code with line numbers ─────────────────────────────────────────── */
function CodeBlock({ code, dim }) {
  const lines = (code || '').split('\n');
  return (
    <div className={`cc-code-block${dim ? ' cc-code-block--dim' : ''}`}>
      <div className="cc-line-nums" aria-hidden="true">
        {lines.map((_, i) => <div key={i} className="cc-line-num">{i + 1}</div>)}
      </div>
      <pre className="cc-code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────────────────────── */
function TypeBadge({ type, size = 'sm' }) {
  const cfg = TYPE_LABELS[type] || { badge: '?', color: '#6b7280' };
  return (
    <span
      className={`cc-badge cc-badge--${size}`}
      style={{ '--badge-color': cfg.color }}
    >
      {cfg.badge}
    </span>
  );
}

function UsageBar({ usage }) {
  if (!usage) return null;
  return (
    <div className="cc-usage-bar">
      <div className="cc-usage-stat">
        <span className="cc-usage-label">In</span>
        <span className="cc-usage-val cc-usage-val--in">{fmtTokens(usage.input_tokens)}</span>
      </div>
      <div className="cc-usage-sep" />
      <div className="cc-usage-stat">
        <span className="cc-usage-label">Out</span>
        <span className="cc-usage-val cc-usage-val--out">{fmtTokens(usage.output_tokens)}</span>
      </div>
      <div className="cc-usage-sep" />
      <div className="cc-usage-stat">
        <span className="cc-usage-label">Cost</span>
        <span className="cc-usage-val cc-usage-val--cost">{fmtCost(usage.cost_usd)}</span>
      </div>
      <div className="cc-usage-sep" />
      <div className="cc-usage-stat">
        <span className="cc-usage-label">Time</span>
        <span className="cc-usage-val">{fmtMs(usage.duration_ms)}</span>
      </div>
      <div className="cc-usage-sep" />
      <div className="cc-usage-stat">
        <span className="cc-usage-label">Model</span>
        <span className="cc-usage-val cc-usage-val--model">{usage.model}</span>
      </div>
    </div>
  );
}

/* ── Flow Viewer ─────────────────────────────────────────────────────── */
const FLOW_SECTION_CONFIG = [
  { key: 'variables',    label: 'Variables',        icon: '📦', color: '#8b5cf6' },
  { key: 'decisions',    label: 'Decisions',        icon: '🔀', color: '#f59e0b' },
  { key: 'recordLookups',label: 'Get Records',      icon: '🔍', color: '#3b82f6' },
  { key: 'recordCreates',label: 'Create Records',   icon: '➕', color: '#10b981' },
  { key: 'recordUpdates',label: 'Update Records',   icon: '✏️', color: '#06b6d4' },
  { key: 'recordDeletes',label: 'Delete Records',   icon: '🗑',  color: '#ef4444' },
  { key: 'assignments',  label: 'Assignments',      icon: '🔧', color: '#6b7280' },
  { key: 'actionCalls',  label: 'Action Calls',     icon: '⚡', color: '#f97316' },
  { key: 'loops',        label: 'Loops',            icon: '🔄', color: '#a855f7' },
  { key: 'screens',      label: 'Screens',          icon: '🖥',  color: '#ec4899' },
  { key: 'subflows',     label: 'Subflows',         icon: '🔗', color: '#14b8a6' },
  { key: 'formulas',     label: 'Formulas',         icon: '∑',   color: '#64748b' },
];

function fmtCondition(cond) {
  const left  = cond.leftValueReference || cond.leftValue?.elementReference || '?';
  const op    = cond.operator || '==';
  const right = cond.rightValue?.stringValue
    ?? cond.rightValue?.numberValue
    ?? cond.rightValue?.booleanValue
    ?? cond.rightValue?.elementReference
    ?? '?';
  const opMap = { EqualTo:'=', NotEqualTo:'≠', GreaterThan:'>', LessThan:'<', GreaterThanOrEqualTo:'≥', LessThanOrEqualTo:'≤', IsNull:'is null', IsChanged:'changed', Contains:'contains', StartsWith:'starts with', EndsWith:'ends with' };
  return `${left} ${opMap[op] || op} ${right}`;
}

function FlowSection({ cfg, items, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen || false);
  if (!items || items.length === 0) return null;
  return (
    <div className="fv-section">
      <button className="fv-section-header" onClick={() => setOpen(v => !v)}>
        <span className="fv-section-icon" style={{ background: cfg.color + '22', color: cfg.color }}>{cfg.icon}</span>
        <span className="fv-section-label">{cfg.label}</span>
        <span className="fv-section-count">{items.length}</span>
        <span className="fv-section-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="fv-section-body">
          {items.map((item, i) => (
            <FlowItem key={i} item={item} type={cfg.key} color={cfg.color} />
          ))}
        </div>
      )}
    </div>
  );
}

function FlowItem({ item, type, color }) {
  const name  = item.name || item.label || '(unnamed)';
  const label = item.label !== item.name ? item.label : null;

  let detail = null;
  if (type === 'variables') {
    const dtype = item.dataType || '';
    const flags = [item.isInput && 'Input', item.isOutput && 'Output', item.isCollection && 'Collection'].filter(Boolean);
    detail = <span className="fv-item-tag">{dtype}{flags.length ? ` · ${flags.join(', ')}` : ''}</span>;
  } else if (type === 'decisions') {
    const rules = item.rules || [];
    detail = (
      <div className="fv-decision-rules">
        {rules.map((rule, ri) => (
          <div key={ri} className="fv-decision-rule">
            <span className="fv-rule-name">{rule.name || `Rule ${ri+1}`}</span>
            {(rule.conditions || []).map((c, ci) => (
              <span key={ci} className="fv-rule-cond">{fmtCondition(c)}</span>
            ))}
            {rule.connector?.targetReference && (
              <span className="fv-rule-arrow">→ {rule.connector.targetReference}</span>
            )}
          </div>
        ))}
        {item.defaultConnector?.targetReference && (
          <div className="fv-decision-else">ELSE → {item.defaultConnector.targetReference}</div>
        )}
      </div>
    );
  } else if (type === 'recordLookups') {
    const obj = item.object || '';
    const filters = (item.filters || []).map(f => fmtCondition(f));
    const outputs = (item.outputAssignments || []).map(o => `${o.assignToReference} ← ${o.field}`);
    detail = (
      <div className="fv-record-detail">
        <span className="fv-item-tag">Object: {obj}</span>
        {filters.length > 0 && <div className="fv-filters">{filters.map((f,i) => <span key={i} className="fv-filter-chip">WHERE {f}</span>)}</div>}
        {outputs.length > 0 && <div className="fv-filters">{outputs.map((o,i) => <span key={i} className="fv-output-chip">{o}</span>)}</div>}
      </div>
    );
  } else if (type === 'recordCreates' || type === 'recordUpdates') {
    const obj = item.object || '';
    const fields = (item.inputAssignments || []).map(a => `${a.field} = ${a.value?.stringValue ?? a.value?.elementReference ?? '?'}`);
    detail = (
      <div className="fv-record-detail">
        <span className="fv-item-tag">Object: {obj}</span>
        {fields.length > 0 && <div className="fv-filters">{fields.map((f,i) => <span key={i} className="fv-filter-chip">{f}</span>)}</div>}
      </div>
    );
  } else if (type === 'recordDeletes') {
    const obj = item.object || '';
    const filters = (item.filters || []).map(f => fmtCondition(f));
    detail = (
      <div className="fv-record-detail">
        <span className="fv-item-tag">Object: {obj}</span>
        {filters.length > 0 && <div className="fv-filters">{filters.map((f,i) => <span key={i} className="fv-filter-chip">WHERE {f}</span>)}</div>}
      </div>
    );
  } else if (type === 'assignments') {
    const items2 = (item.assignmentItems || []).map(a => `${a.assignToReference} ${a.operator || '='} ${a.value?.stringValue ?? a.value?.elementReference ?? a.value?.numberValue ?? '?'}`);
    detail = items2.length > 0 && <div className="fv-filters">{items2.map((a,i) => <span key={i} className="fv-filter-chip">{a}</span>)}</div>;
  } else if (type === 'actionCalls') {
    detail = <span className="fv-item-tag">{item.actionType || ''}: {item.actionName || ''}</span>;
  } else if (type === 'loops') {
    detail = <span className="fv-item-tag">Iterate: {item.collectionReference || ''} ({item.iterationOrder || 'Asc'})</span>;
  }

  return (
    <div className="fv-item">
      <div className="fv-item-name-row">
        <span className="fv-item-dot" style={{ background: color }} />
        <span className="fv-item-name">{name}</span>
        {label && label !== name && <span className="fv-item-label">({label})</span>}
        {item.connector?.targetReference && (
          <span className="fv-item-next">→ {item.connector.targetReference}</span>
        )}
      </div>
      {detail && <div className="fv-item-detail">{detail}</div>}
    </div>
  );
}

/* ── Mermaid flowchart builder ───────────────────────────────────────── */
function sanitizeMmd(str) {
  return (str || '').replace(/["]/g, "'").replace(/[<>{}|[\]]/g, ' ').trim().slice(0, 55);
}

function buildMermaidFlowchart(flowMeta) {
  const m = flowMeta?.metadata || {};
  const lines = ['flowchart TD'];
  const nodeMap = {};
  let nc = 0;
  function nid(name) {
    if (!nodeMap[name]) nodeMap[name] = `N${nc++}`;
    return nodeMap[name];
  }

  // Start node
  const start = m.start || {};
  const startLabel = start.object ? `Start\\n${start.object}` : 'Start';
  lines.push(`    START(["🚀 ${sanitizeMmd(startLabel)}"])`);

  const allEls = {};
  const typeConf = [
    { key: 'decisions',     shape: 'diamond', icon: '🔀' },
    { key: 'recordLookups', shape: 'rect',    icon: '🔍' },
    { key: 'recordCreates', shape: 'rect',    icon: '➕' },
    { key: 'recordUpdates', shape: 'rect',    icon: '✏️' },
    { key: 'recordDeletes', shape: 'rect',    icon: '🗑️' },
    { key: 'assignments',   shape: 'rect',    icon: '📋' },
    { key: 'actionCalls',   shape: 'rounded', icon: '⚡' },
    { key: 'screens',       shape: 'rounded', icon: '🖥️' },
    { key: 'subflows',      shape: 'rounded', icon: '🔄' },
    { key: 'loops',         shape: 'hex',     icon: '🔁' },
  ];

  for (const { key, shape, icon } of typeConf) {
    for (const el of (m[key] || [])) {
      if (!el.name) continue;
      allEls[el.name] = { ...el, _key: key };
      const id = nid(el.name);
      const label = sanitizeMmd(`${icon} ${el.label || el.name}`);
      if (shape === 'diamond') lines.push(`    ${id}{"${label}"}`);
      else if (shape === 'hex')     lines.push(`    ${id}{{"${label}"}}`);
      else if (shape === 'rounded') lines.push(`    ${id}("${label}")`);
      else                          lines.push(`    ${id}["${label}"]`);
    }
  }

  lines.push('    END(["🏁 End"])');

  // Edges — start
  const s0 = start.connector?.targetReference;
  if (s0) lines.push(`    START --> ${allEls[s0] ? nid(s0) : 'END'}`);

  // Edges — elements
  for (const [name, el] of Object.entries(allEls)) {
    const id = nid(name);
    if (el._key === 'decisions') {
      for (const rule of (el.rules || [])) {
        const t = rule.connector?.targetReference;
        if (!t) continue;
        const lbl = sanitizeMmd(rule.label || rule.name || '');
        lines.push(`    ${id} -->|"${lbl}"| ${allEls[t] ? nid(t) : 'END'}`);
      }
      const dt = el.defaultConnector?.targetReference;
      if (dt) {
        const dlbl = sanitizeMmd(el.defaultConnectorLabel || 'Default');
        lines.push(`    ${id} -->|"${dlbl}"| ${allEls[dt] ? nid(dt) : 'END'}`);
      }
    } else if (el._key === 'loops') {
      const nv = el.nextValueConnector?.targetReference;
      const nm = el.noMoreValuesConnector?.targetReference;
      if (nv) lines.push(`    ${id} -->|"Each item"| ${allEls[nv] ? nid(nv) : 'END'}`);
      if (nm) lines.push(`    ${id} -->|"No more"| ${allEls[nm] ? nid(nm) : 'END'}`);
    } else {
      const t = el.connector?.targetReference;
      lines.push(`    ${id} --> ${t && allEls[t] ? nid(t) : 'END'}`);
    }
  }

  // Styles
  lines.push('');
  lines.push('    classDef decision fill:#f59e0b,stroke:#d97706,color:#1c1917,font-weight:bold');
  lines.push('    classDef record   fill:#3b82f6,stroke:#2563eb,color:#fff');
  lines.push('    classDef action   fill:#8b5cf6,stroke:#7c3aed,color:#fff');
  lines.push('    classDef loop     fill:#ec4899,stroke:#db2777,color:#fff');
  lines.push('    classDef terminal fill:#10b981,stroke:#059669,color:#fff,font-weight:bold');

  const decIds = (m.decisions || []).filter(e => e.name).map(e => nid(e.name));
  const recIds = [...(m.recordLookups||[]),...(m.recordCreates||[]),...(m.recordUpdates||[]),...(m.recordDeletes||[])].filter(e=>e.name).map(e=>nid(e.name));
  const actIds = [...(m.actionCalls||[]),...(m.subflows||[]),...(m.screens||[])].filter(e=>e.name).map(e=>nid(e.name));
  const loopIds = (m.loops||[]).filter(e=>e.name).map(e=>nid(e.name));

  if (decIds.length)  lines.push(`    class ${decIds.join(',')} decision`);
  if (recIds.length)  lines.push(`    class ${recIds.join(',')} record`);
  if (actIds.length)  lines.push(`    class ${actIds.join(',')} action`);
  if (loopIds.length) lines.push(`    class ${loopIds.join(',')} loop`);
  lines.push('    class START,END terminal');

  return lines.join('\n');
}

let _mermaidPromise = null;
function loadMermaid() {
  if (window.mermaid) return Promise.resolve();
  if (!_mermaidPromise) {
    _mermaidPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load Mermaid.js from CDN'));
      document.head.appendChild(s);
    });
  }
  return _mermaidPromise;
}

function FlowChart({ meta }) {
  const containerRef = useRef(null);
  const [phase, setPhase] = useState('loading');
  const [errMsg, setErrMsg] = useState('');
  const [zoom, setZoom] = useState(0.5);

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setZoom(0.5);

    async function render() {
      try {
        await loadMermaid();
        if (cancelled) return;

        window.mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          flowchart: { curve: 'basis', useMaxWidth: false, htmlLabels: false },
          securityLevel: 'loose',
          themeVariables: {
            darkMode: true,
            background: '#1a1a2e',
            primaryColor: '#3b82f6',
            primaryTextColor: '#f1f5f9',
            edgeLabelBackground: '#1e293b',
            lineColor: '#64748b',
          },
        });

        const chartDef = buildMermaidFlowchart(meta);
        const id = 'fc' + Math.random().toString(36).slice(2);
        const { svg } = await window.mermaid.render(id, chartDef);

        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = svg;
        const svgEl = containerRef.current.querySelector('svg');
        if (svgEl) {
          svgEl.style.width = '100%';
          svgEl.style.height = 'auto';
          svgEl.removeAttribute('width');
          svgEl.removeAttribute('height');
        }
        setPhase('ready');
      } catch (err) {
        if (!cancelled) { setErrMsg(err.message || 'Render failed'); setPhase('error'); }
      }
    }

    render();
    return () => { cancelled = true; };
  }, [meta]);

  return (
    <div className="fc-root">
      {phase === 'loading' && (
        <div className="fc-center">
          <div className="cc-converting-spinner" />
          <div className="fc-hint">Rendering flowchart…</div>
        </div>
      )}
      {phase === 'error' && (
        <div className="fc-center">
          <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Could not render flowchart</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', maxWidth: 300, textAlign: 'center' }}>{errMsg}</div>
        </div>
      )}
      {phase === 'ready' && (
        <div className="fc-toolbar">
          <span className="fc-legend"><span className="fc-dot fc-dot--decision" />Decision</span>
          <span className="fc-legend"><span className="fc-dot fc-dot--record" />Record Op</span>
          <span className="fc-legend"><span className="fc-dot fc-dot--action" />Action / Screen</span>
          <span className="fc-legend"><span className="fc-dot fc-dot--loop" />Loop</span>
          <div style={{ flex: 1 }} />
          <button className="fc-zoom-btn" onClick={() => setZoom(z => Math.max(0.4, z - 0.15))}>−</button>
          <span className="fc-zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="fc-zoom-btn" onClick={() => setZoom(z => Math.min(2, z + 0.15))}>+</button>
          <button className="fc-zoom-btn" onClick={() => setZoom(0.5)} title="Reset zoom">↺</button>
        </div>
      )}
      <div
        className="fc-diagram-wrap"
        style={{ display: phase === 'ready' ? 'block' : 'none' }}
      >
        <div
          ref={containerRef}
          className="fc-diagram"
          style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
        />
      </div>
    </div>
  );
}

function FlowViewer({ meta, onViewXml, onViewRaw }) {
  const m = meta?.metadata || {};
  const start = m.start || {};
  const totalElements = FLOW_SECTION_CONFIG.reduce((s, c) => s + (m[c.key]?.length || 0), 0);

  return (
    <div className="fv-root">
      {/* Header info card */}
      <div className="fv-info-card">
        <div className="fv-info-title">
          <span className="fv-info-icon">🌊</span>
          {meta.label || meta.name}
        </div>
        <div className="fv-info-pills">
          <span className="fv-pill fv-pill--type">{meta.process_type || 'Flow'}</span>
          <span className={`fv-pill fv-pill--status fv-pill--status-${(meta.status || 'unknown').toLowerCase()}`}>{meta.status || 'Unknown'}</span>
          <span className="fv-pill fv-pill--count">{totalElements} elements</span>
        </div>
        {start.object && (
          <div className="fv-info-trigger">
            <span className="fv-trigger-label">Trigger Object:</span>
            <span className="fv-trigger-val">{start.object}</span>
            {start.triggerType && <span className="fv-trigger-type">{start.triggerType}</span>}
            {start.recordTriggerType && <span className="fv-trigger-type">{start.recordTriggerType}</span>}
          </div>
        )}
        <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 4 }}>
          {meta.raw_json && (
            <button className="fv-raw-btn" onClick={onViewXml} title="View metadata JSON">
              {'{ }'} XML/JSON
            </button>
          )}
          <button className="fv-raw-btn" onClick={onViewRaw} title="View raw source text">
            {'</>'} Raw
          </button>
        </div>
      </div>

      {/* Sections */}
      <div className="fv-sections">
        {FLOW_SECTION_CONFIG.map(cfg => (
          <FlowSection
            key={cfg.key}
            cfg={cfg}
            items={m[cfg.key]}
            defaultOpen={['decisions', 'recordLookups', 'variables'].includes(cfg.key)}
          />
        ))}
        {totalElements === 0 && (
          <div className="fv-empty">
            <div style={{ fontSize: 22, marginBottom: 8 }}>🌊</div>
            <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--text-secondary)' }}>No flow elements found</div>
            <div style={{ fontSize: 11, lineHeight: 1.6 }}>
              {meta.raw_json
                ? <>The flow metadata was fetched but contains no parseable elements.<br />Switch to the <strong>XML</strong> tab to inspect the raw metadata.</>
                : <>Salesforce session may have expired.<br />Go to <strong>Metadata Migration</strong> → reconnect Salesforce, then click this flow again.</>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Conversion progress steps ──────────────────────────────────────── */
const CONV_STEPS = [
  { id: 'rulebook', label: 'Reading rulebook',        sub: 'Loading conversion rules & patterns',        icon: '📖', delay: 0 },
  { id: 'source',   label: 'Analysing source code',   sub: 'Parsing component structure & dependencies', icon: '🔍', delay: 500 },
  { id: 'mapping',  label: 'Loading field mappings',  sub: 'Preparing Salesforce → D365 context',        icon: '🗺',  delay: 1100 },
  { id: 'llm',      label: 'Calling AI model',        sub: 'Sending to LLM for conversion…',             icon: '⚡', delay: 1800 },
];

function ConversionProgress({ converting, compName, compType }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const timersRef = useRef([]);

  useEffect(() => {
    if (!converting) { setActiveIdx(0); return; }
    setActiveIdx(0);
    timersRef.current.forEach(clearTimeout);
    timersRef.current = CONV_STEPS.slice(1).map((step, i) =>
      setTimeout(() => setActiveIdx(i + 1), step.delay)
    );
    return () => timersRef.current.forEach(clearTimeout);
  }, [converting]);

  if (!converting) return null;

  const badge = TYPE_LABELS[compType] || {};

  return (
    <div className="cc-conv-progress">
      <div className="cc-conv-progress-header">
        <div className="cc-conv-progress-icon-wrap">
          <span className="cc-conv-progress-pulse" />
          <span className="cc-conv-progress-center-icon">⚡</span>
        </div>
        <div>
          <div className="cc-conv-progress-title">Converting to C#</div>
          {compName && (
            <div className="cc-conv-progress-name">
              <span style={{ fontSize: 10, background: `${badge.color}22`, color: badge.color, border: `1px solid ${badge.color}44`, borderRadius: 4, padding: '1px 5px', marginRight: 5 }}>{badge.badge}</span>
              {compName}
            </div>
          )}
        </div>
      </div>

      <div className="cc-conv-steps-list">
        {CONV_STEPS.map((step, i) => {
          const state = i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'pending';
          return (
            <div key={step.id} className={`cc-conv-step cc-conv-step--${state}`}>
              <div className="cc-conv-step-dot">
                {state === 'done'
                  ? <svg width="10" height="10" viewBox="0 0 12 12"><polyline points="2,6 5,9 10,3" stroke="#23a55a" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  : state === 'active'
                    ? <span className="cc-conv-step-spinner-dot" />
                    : null}
              </div>
              <div className="cc-conv-step-body">
                <span className="cc-conv-step-label">{step.label}</span>
                <span className="cc-conv-step-sub">{state === 'active' ? step.sub : state === 'done' ? 'Done' : ''}</span>
              </div>
              {state === 'active' && <span className="cc-conv-step-spinner" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Main Component ──────────────────────────────────────────────────── */
export default function CodeConverterPage({ initialOrgId = null, onBack = null, onGoToMetadata = null }) {
  const [orgs,         setOrgs]         = useState([]);
  const [selectedOrg,  setSelectedOrg]  = useState(null);
  const [components,   setComponents]   = useState({});   // {apex_class:[], ...}
  const [counts,       setCounts]       = useState({});
  const [orgName,      setOrgName]      = useState('');
  const [loadingOrgs,  setLoadingOrgs]  = useState(true);
  const [loadingComps, setLoadingComps] = useState(false);

  const [filterType,   setFilterType]   = useState('all');
  const [search,       setSearch]       = useState('');
  const [selectedComp, setSelectedComp] = useState(null);  // {name, type, code}

  const [loadingSource, setLoadingSource] = useState(false);
  const [sourceCode,    setSourceCode]    = useState('');
  const [sourceError,   setSourceError]   = useState('');
  const [flowMeta,      setFlowMeta]      = useState(null);  // parsed flow metadata for visual view
  const [flowView,      setFlowView]      = useState('visual'); // 'visual' | 'xml' | 'raw'

  const [converting,    setConverting]    = useState(false);
  const [convertedCode, setConvertedCode] = useState('');
  const [convNotes,     setConvNotes]     = useState([]);
  const [convUsage,     setConvUsage]     = useState(null);
  const [convError,     setConvError]     = useState('');
  const [copied,        setCopied]        = useState(false);
  const [showNotes,     setShowNotes]     = useState(false);

  // Save / Edit / Validate / Deploy state
  const [savedItemId,   setSavedItemId]   = useState(null);
  const [saving,        setSaving]        = useState(false);
  const [editMode,      setEditMode]      = useState(false);
  const [editedCode,    setEditedCode]    = useState('');
  const [editSaving,    setEditSaving]    = useState(false);
  const [validating,    setValidating]    = useState(false);
  const [validateResult,setValidateResult]= useState(null);
  const [fixing,        setFixing]        = useState(false);
  const [fixResult,     setFixResult]     = useState(null);
  const [deploying,     setDeploying]     = useState(false);
  const [deployResult,  setDeployResult]  = useState(null);
  const [showDeployLog, setShowDeployLog] = useState(false);
  const [deployLogText, setDeployLogText] = useState('');
  // Power Automate deploy
  const [paEnvs,        setPaEnvs]        = useState([]);
  const [paEnvId,       setPaEnvId]       = useState('');
  const [paDeploying,   setPaDeploying]   = useState(false);
  const [paResult,      setPaResult]      = useState(null);
  const [paEnvsLoading, setPaEnvsLoading] = useState(false);
  const [dotnetOk,      setDotnetOk]     = useState(null);
  const [savedAt,       setSavedAt]      = useState(null);  // ISO string of last save

  // Deployment history modal
  const [showHistory,    setShowHistory]    = useState(false);
  const [historyLogs,    setHistoryLogs]    = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [expandedLogId,  setExpandedLogId]  = useState(null);
  const [logDetail,      setLogDetail]      = useState({});   // logId → {log_text}

  // Manual Deploy Guide
  const [showManualGuide, setShowManualGuide] = useState(false);
  const [guideTab,        setGuideTab]        = useState(null); // set to comp type when opened
  const [guideCopied,     setGuideCopied]     = useState({});

  // Check dotnet on mount
  useEffect(() => {
    fetch(`${API}/d365-deploy/dotnet-status`)
      .then(r => r.json())
      .then(d => setDotnetOk(d.available))
      .catch(() => setDotnetOk(false));
  }, []);

  const handleSave = useCallback(async () => {
    if (!convertedCode || !selectedComp || !selectedOrg) return;
    setSaving(true);
    try {
      const r = await fetch(`${API}/d365-deploy/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connection_id:  selectedOrg,
          component_type: selectedComp.type,
          component_name: selectedComp.name,
          component_id:   selectedComp.id || null,
          sf_source:      sourceCode || '',
          d365_output:    convertedCode,
          llm_model:      convUsage?.model || null,
          input_tokens:   convUsage?.input_tokens || 0,
          output_tokens:  convUsage?.output_tokens || 0,
          cost_usd:       convUsage?.cost_usd || 0,
        }),
      });
      const d = await r.json();
      if (r.ok) {
        setSavedItemId(d.id);
        setSavedAt(new Date().toISOString());
        setDeployResult(null);
        setValidateResult(null);
      }
    } catch (e) { /* silent */ }
    setSaving(false);
  }, [convertedCode, selectedComp, selectedOrg, sourceCode, convUsage]);

  const handleEditSave = useCallback(async () => {
    if (!savedItemId) return;
    setEditSaving(true);
    try {
      const r = await fetch(`${API}/d365-deploy/saved/${savedItemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ d365_output: editedCode }),
      });
      if (r.ok) {
        setConvertedCode(editedCode);
        setEditMode(false);
        setValidateResult(null);
      }
    } catch (e) { /* silent */ }
    setEditSaving(false);
  }, [savedItemId, editedCode]);

  const handleValidate = useCallback(async () => {
    if (!savedItemId) return;
    setValidating(true);
    setValidateResult(null);
    try {
      const r = await fetch(`${API}/d365-deploy/saved/${savedItemId}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await r.json();
      setValidateResult(d);
      if (d.auto_fixed && d.fixed_code) setConvertedCode(d.fixed_code);
    } catch (e) { setValidateResult({ verdict: 'ERROR', issues: [e.message] }); }
    setValidating(false);
  }, [savedItemId]);

  // Collect the most recent deploy error for context
  const _getLastError = useCallback(() => {
    if (deployResult?.errors?.length) return deployResult.errors.join('\n');
    if (deployResult?.manual_instructions) return `Manual deploy required: ${deployResult.manual_instructions}`;
    if (paResult?.error) return paResult.error;
    if (paResult?.log_text) return paResult.log_text;
    return '';
  }, [deployResult, paResult]);

  const handleFix = useCallback(async () => {
    if (!savedItemId) return;
    setFixing(true);
    setFixResult(null);
    setValidateResult(null);
    const errorCtx = _getLastError();
    try {
      const r = await fetch(`${API}/d365-deploy/saved/${savedItemId}/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error_context: errorCtx }),
      });
      const d = await r.json();
      setFixResult(d);
      if (d.ok && d.fixed_code) {
        setConvertedCode(d.fixed_code);
        // Reset previous deploy/PA results so user redeploys fresh
        setDeployResult(null);
        setPaResult(null);
      }
    } catch (e) { setFixResult({ ok: false, error: e.message }); }
    setFixing(false);
  }, [savedItemId, _getLastError]);

  const handleDeploy = useCallback(async () => {
    if (!savedItemId) return;
    setDeploying(true);
    setDeployResult(null);
    try {
      const r = await fetch(`${API}/d365-deploy/saved/${savedItemId}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await r.json();
      setDeployResult(d);
      if (d.log_id) {
        const lr = await fetch(`${API}/d365-deploy/logs/${selectedOrg}/${d.log_id}`);
        const ld = await lr.json();
        setDeployLogText(ld.log_text || '');
      }
    } catch (e) { setDeployResult({ success: false, errors: [e.message] }); }
    setDeploying(false);
  }, [savedItemId, selectedOrg]);

  // ── Power Automate ─────────────────────────────────────────────────────────
  const handleLoadPaEnvs = useCallback(async () => {
    if (!selectedOrg) return;
    setPaEnvsLoading(true);
    try {
      const r = await fetch(`${API}/power-automate/environments/${selectedOrg}`);
      const d = await r.json();
      if (r.ok) {
        setPaEnvs(d.environments || []);
        const def = (d.environments || []).find(e => e.isDefault);
        if (def) setPaEnvId(def.id);
        else if (d.environments?.length) setPaEnvId(d.environments[0].id);
      }
    } catch { /* ignore */ }
    setPaEnvsLoading(false);
  }, [selectedOrg]);

  const handlePaDeploy = useCallback(async () => {
    if (!convertedCode || !selectedComp || !paEnvId) return;
    setPaDeploying(true);
    setPaResult(null);
    try {
      const r = await fetch(`${API}/power-automate/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connection_id:  selectedOrg,
          environment_id: paEnvId,
          flow_name:      selectedComp.name,
          converted_code: convertedCode,
          saved_item_id:  savedItemId || null,
        }),
      });
      const d = await r.json();
      if (!r.ok) setPaResult({ ok: false, error: d.detail || 'Deploy failed' });
      else setPaResult({ ok: d.ok, ...d });
    } catch (e) { setPaResult({ ok: false, error: e.message }); }
    setPaDeploying(false);
  }, [convertedCode, selectedComp, selectedOrg, paEnvId, savedItemId]);

  const handleSeedPaRulebook = useCallback(async () => {
    const r = await fetch(`${API}/power-automate/seed-flow-rulebook`, { method: 'POST' });
    const d = await r.json();
    alert(d.ok ? `Rulebook ${d.action}: ${d.title}` : 'Failed to seed rulebook');
  }, []);

  const handleLoadHistory = useCallback(async () => {
    if (!selectedComp || !selectedOrg) return;
    setHistoryLoading(true);
    setHistoryLogs([]);
    setExpandedLogId(null);
    setLogDetail({});
    setShowHistory(true);
    try {
      const url = `${API}/d365-deploy/logs/${selectedOrg}?component_name=${encodeURIComponent(selectedComp.name)}&component_type=${selectedComp.type}&limit=50`;
      const r = await fetch(url);
      const d = await r.json();
      setHistoryLogs(d.logs || []);
    } catch { /* ignore */ }
    setHistoryLoading(false);
  }, [selectedComp, selectedOrg]);

  // ── Load orgs ──────────────────────────────────────────────────────────────
  useEffect(() => {
    setLoadingOrgs(true);
    fetch(`${API}/code-converter/orgs`)
      .then(r => r.json())
      .then(d => {
        const list = d.orgs || [];
        setOrgs(list);
        // Pre-select initialOrgId if provided, otherwise fall back to first org
        if (initialOrgId && list.find(o => o.id === initialOrgId)) {
          setSelectedOrg(initialOrgId);
        } else if (list[0]) {
          setSelectedOrg(list[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingOrgs(false));
  }, []);

  // ── Load components when org changes ──────────────────────────────────────
  useEffect(() => {
    if (!selectedOrg) return;
    setLoadingComps(true);
    setComponents({});
    setCounts({});
    setSelectedComp(null);
    setConvertedCode('');
    setConvUsage(null);
    setConvError('');
    setSavedItemId(null);
    setSavedAt(null);

    fetch(`${API}/code-converter/components/${selectedOrg}`)
      .then(r => r.json())
      .then(d => {
        setComponents(d.components || {});
        setCounts(d.counts || {});
        setOrgName(d.org_name || '');
      })
      .catch(() => {})
      .finally(() => setLoadingComps(false));
  }, [selectedOrg]);

  // ── Build flat component list based on filter + search ────────────────────
  const flatList = React.useMemo(() => {
    const types = filterType === 'all'
      ? ['apex_class', 'apex_trigger', 'flow', 'lwc', 'aura']
      : [filterType];

    const items = [];
    for (const t of types) {
      for (const comp of (components[t] || [])) {
        items.push({ ...comp, type: t });
      }
    }

    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter(i => i.name.toLowerCase().includes(q));
  }, [components, filterType, search]);

  const totalCount = Object.values(counts).reduce((s, c) => s + c, 0);

  // ── Convert (+ auto-save) ──────────────────────────────────────────────────
  const handleConvert = useCallback(async () => {
    if (!selectedComp || !selectedOrg || converting) return;
    setConverting(true);
    setConvError('');
    setConvertedCode('');
    setConvNotes([]);
    setConvUsage(null);
    setSavedItemId(null);
    setSavedAt(null);

    try {
      const r = await fetch(`${API}/code-converter/convert`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          connection_id:  selectedOrg,
          component_type: selectedComp.type,
          component_name: selectedComp.name,
          component_id:   selectedComp.id || null,
          code:           sourceCode || '',
          target:         'dynamics365',
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setConvError(d.detail || 'Conversion failed.');
      } else {
        const code = d.converted_code || '';
        setConvertedCode(code);
        setConvNotes(d.notes || []);
        setConvUsage(d.usage || null);

        // Auto-save immediately after conversion
        setSaving(true);
        try {
          const sr = await fetch(`${API}/d365-deploy/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              connection_id:  selectedOrg,
              component_type: selectedComp.type,
              component_name: selectedComp.name,
              component_id:   selectedComp.id || null,
              sf_source:      sourceCode || '',
              d365_output:    code,
              llm_model:      d.usage?.model || null,
              input_tokens:   d.usage?.input_tokens || 0,
              output_tokens:  d.usage?.output_tokens || 0,
              cost_usd:       d.usage?.cost_usd || 0,
            }),
          });
          const sd = await sr.json();
          if (sr.ok) {
            setSavedItemId(sd.id);
            setSavedAt(new Date().toISOString());
            setDeployResult(null);
            setValidateResult(null);
          }
        } catch { /* silent */ }
        setSaving(false);
      }
    } catch (e) {
      setConvError(`fetch failed: ${e.message}`);
    }
    setConverting(false);
  }, [selectedComp, selectedOrg, sourceCode, converting]);

  const handleCopy = () => {
    if (!convertedCode) return;
    navigator.clipboard.writeText(convertedCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleSelectComp = useCallback(async (comp) => {
    setSelectedComp(comp);
    setConvertedCode('');
    setConvNotes([]);
    setConvUsage(null);
    setConvError('');
    setSourceCode('');
    setSourceError('');
    setFlowMeta(null);
    setFlowView('visual');
    setSavedItemId(null);
    setSavedAt(null);
    setEditMode(false);
    setValidateResult(null);
    setFixResult(null);
    setDeployResult(null);
    setShowHistory(false);
    setHistoryLogs([]);
    setPaResult(null);
    setPaEnvs([]);
    setPaEnvId('');

    // Fetch source + check for existing saved conversion in parallel
    setLoadingSource(true);
    const [sourceResult, savedResult] = await Promise.allSettled([
      fetch(`${API}/code-converter/source/${selectedOrg}/${comp.type}/${comp.id}`).then(r => r.json().then(d => ({ ok: r.ok, d }))),
      fetch(`${API}/d365-deploy/saved/${selectedOrg}?component_type=${comp.type}&component_name=${encodeURIComponent(comp.name)}&limit=1`).then(r => r.json()),
    ]);

    if (sourceResult.status === 'fulfilled') {
      const { ok, d } = sourceResult.value;
      if (!ok) {
        setSourceError(d.detail || 'Failed to load source.');
      } else {
        setSourceCode(d.code || d.source || '');
        if (d.flow_meta) {
          setFlowMeta(d.flow_meta);
          setFlowView('visual');
        }
      }
    } else {
      setSourceError(`Failed to load source: ${sourceResult.reason?.message}`);
    }

    if (savedResult.status === 'fulfilled') {
      const saved = savedResult.value?.items?.[0];
      if (saved) {
        setConvertedCode(saved.d365_output || '');
        setSavedItemId(saved.id);
        setSavedAt(saved.updated_at || saved.created_at);
      }
    }

    setLoadingSource(false);
  }, [selectedOrg]);

  // ── Source file name ───────────────────────────────────────────────────────
  const sourceFileName = selectedComp
    ? `${selectedComp.name}${TYPE_LABELS[selectedComp.type]?.ext || ''}`
    : null;

  const targetFileName = convertedCode && selectedComp
    ? `${selectedComp.name}${selectedComp.type === 'flow' ? '.json' : '.cs'}`
    : null;

  // ── Org selector org ───────────────────────────────────────────────────────
  const currentOrg = orgs.find(o => o.id === selectedOrg);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
    <div className="cc-page">

      {/* ── Top bar ── */}
      <div className="cc-topbar">
        <div className="cc-topbar-left">
          {onBack && (
            <button className="cc-back-btn" onClick={onBack} title="Back to Metadata Migration">
              ← Back
            </button>
          )}
          <div className="cc-topbar-title">
            <span className="cc-topbar-icon">⟨/⟩</span>
            Code Converter
          </div>

          {/* Org selector */}
          {loadingOrgs ? (
            <span className="cc-org-label">Loading orgs…</span>
          ) : orgs.length === 0 ? (
            <span className="cc-org-label cc-org-label--warn">No orgs connected</span>
          ) : (
            <select
              className="cc-org-select"
              value={selectedOrg || ''}
              onChange={e => setSelectedOrg(Number(e.target.value))}
            >
              {orgs.map(o => (
                <option key={o.id} value={o.id}>
                  {o.name}{!o.has_metadata ? ' (no metadata)' : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="cc-topbar-center">
          <span className="cc-flow-pill cc-flow-pill--sf">Salesforce Apex</span>
          <span className="cc-flow-arrow">→</span>
          <span className="cc-flow-pill cc-flow-pill--d365">Dynamics 365 C#</span>
        </div>

        <div className="cc-topbar-right">
          {convUsage && <UsageBar usage={convUsage} />}
          <button
            className="cc-convert-btn"
            onClick={handleConvert}
            disabled={!selectedComp || converting || !selectedOrg}
          >
            {converting
              ? <><span className="cc-btn-spinner" /> Converting…</>
              : <><span>⚡</span> Convert</>}
          </button>
        </div>
      </div>

      {/* ── Three-panel body ── */}
      <div className="cc-body">

        {/* ── Left: component list ── */}
        <div className="cc-panel cc-panel--list">
          <div className="cc-panel-header">
            <span className="cc-panel-dot cc-panel-dot--sf" />
            <span className="cc-panel-title">SOURCE</span>
            {!loadingComps && (
              <span className="cc-panel-count">{totalCount} components</span>
            )}
          </div>

          {/* Search */}
          <div className="cc-search-wrap">
            <span className="cc-search-icon">⌕</span>
            <input
              className="cc-search"
              placeholder="Search components…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {/* Filter pills */}
          <div className="cc-filter-pills">
            {COMP_TYPES.map(ct => {
              const cnt = ct.id === 'all' ? totalCount : (counts[ct.id] || 0);
              const isActive = filterType === ct.id;
              return (
                <button
                  key={ct.id}
                  type="button"
                  className={`cc-pill${isActive ? ' active' : ''}`}
                  style={isActive ? {
                    background: `${ct.color}22`,
                    borderColor: ct.color,
                    color: ct.color,
                  } : {}}
                  onClick={() => setFilterType(ct.id)}
                >
                  {ct.label}
                  {cnt > 0 && <span className="cc-pill-cnt">{cnt}</span>}
                </button>
              );
            })}
          </div>

          {/* Component list */}
          <div className="cc-comp-list">
            {loadingComps ? (
              <div className="cc-empty">Loading components…</div>
            ) : flatList.length === 0 ? (
              <div className="cc-empty">
                {!currentOrg?.has_metadata
                  ? 'No metadata extracted yet. Extract metadata from the Shift page first.'
                  : 'No components found.'}
              </div>
            ) : (
              flatList.map(comp => (
                <button
                  key={`${comp.type}::${comp.name}`}
                  className={`cc-comp-item${selectedComp?.name === comp.name && selectedComp?.type === comp.type ? ' active' : ''}`}
                  onClick={() => handleSelectComp(comp)}
                >
                  <TypeBadge type={comp.type} />
                  <span className="cc-comp-name" title={comp.name}>{comp.name}</span>
                  <span className="cc-comp-arrow">›</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* ── Center: source code ── */}
        <div className="cc-panel cc-panel--source">
          <div className="cc-panel-header">
            {selectedComp && (
              <>
                <span className="cc-file-icon">{selectedComp.type === 'flow' ? '🌊' : '📄'}</span>
                <span className="cc-file-name">{sourceFileName}</span>
                {flowMeta && (
                  <div className="cc-flow-view-toggle">
                    <button className={`cc-flow-tab${flowView === 'visual'  ? ' active' : ''}`} onClick={() => setFlowView('visual')}>Visual</button>
                    <button className={`cc-flow-tab${flowView === 'chart'   ? ' active' : ''}`} onClick={() => setFlowView('chart')}>⬡ Chart</button>
                    <button className={`cc-flow-tab${flowView === 'xml'     ? ' active' : ''}`} onClick={() => setFlowView('xml')}>XML</button>
                    <button className={`cc-flow-tab${flowView === 'raw'     ? ' active' : ''}`} onClick={() => setFlowView('raw')}>Raw</button>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="cc-code-wrap">
            {!selectedComp ? (
              <div className="cc-code-placeholder">
                <div className="cc-placeholder-icon">◈</div>
                <div className="cc-placeholder-title">Select a component</div>
                <div className="cc-placeholder-sub">Choose a component from the list to view its source code</div>
              </div>
            ) : loadingSource ? (
              <div className="cc-code-placeholder">
                <div className="cc-converting-spinner" />
                <div className="cc-placeholder-title">Loading source…</div>
                <div className="cc-placeholder-sub">Fetching from Salesforce</div>
              </div>
            ) : sourceError ? (
              <div className="cc-conv-error">
                <div className="cc-conv-error-icon">⚠</div>
                <div className="cc-conv-error-title">Failed to load source</div>
                <pre className="cc-conv-error-detail">// {sourceError}</pre>
                {(sourceError.includes('session expired') || sourceError.includes('re-authorize') || sourceError.includes('needs_reauth')) && (
                  <button
                    className="cc-reauth-btn"
                    onClick={onGoToMetadata || onBack}
                    style={{
                      marginTop: 14,
                      padding: '7px 18px',
                      background: 'rgba(35,165,94,0.15)',
                      border: '1px solid rgba(35,165,94,0.4)',
                      borderRadius: 6,
                      color: '#4ade80',
                      fontSize: 12,
                      cursor: 'pointer',
                      fontWeight: 600,
                    }}
                  >
                    → Go to Metadata Migration to Re-authorize
                  </button>
                )}
              </div>
            ) : (flowMeta && flowView === 'visual') ? (
              <FlowViewer meta={flowMeta} onViewXml={() => setFlowView('xml')} onViewRaw={() => setFlowView('raw')} />
            ) : (flowMeta && flowView === 'chart') ? (
              <FlowChart meta={flowMeta} />
            ) : (flowMeta && flowView === 'xml') ? (
              <CodeBlock code={flowMeta.raw_json || '// No XML metadata available.\n// This flow may not have structured metadata accessible via the Tooling API.'} />
            ) : sourceCode ? (
              <CodeBlock code={sourceCode} />
            ) : (
              <CodeBlock
                code={`// ${TYPE_LABELS[selectedComp.type]?.badge || ''} Component: ${selectedComp.name}\n// No source available`}
                dim
              />
            )}
          </div>
        </div>

        {/* ── Right: target (C#) ── */}
        <div className="cc-panel cc-panel--target">
          <div className="cc-panel-header cc-panel-header--two-rows">
            {/* Row 1: title + saved badge */}
            <div className="cc-panel-header-row1">
              <span className="cc-panel-dot cc-panel-dot--d365" />
              <span className="cc-panel-title">TARGET</span>
              <span className="cc-panel-lang">C#</span>
              {saving && (
                <span style={{ fontSize: 10, color: '#6b7280', marginLeft: 6 }}>Saving…</span>
              )}
              {savedAt && !saving && (
                <span style={{ fontSize: 10, color: '#23a55a', background: 'rgba(35,165,94,.12)', border: '1px solid rgba(35,165,94,.3)', borderRadius: 8, padding: '1px 7px', marginLeft: 6 }}>
                  ✓ Saved {new Date(savedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
            {/* Row 2: action buttons */}
            <div className="cc-panel-header-row2">
              {selectedComp && selectedOrg && (
                <button
                  className="cc-action-btn"
                  onClick={handleLoadHistory}
                  title="View deployment history for this component"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  {' '}History
                </button>
              )}
              {selectedComp && (
                <button
                  className="cc-action-btn"
                  style={{ color: '#f59e0b', borderColor: 'rgba(245,158,11,0.35)' }}
                  onClick={() => { setGuideTab(selectedComp.type); setShowManualGuide(true); }}
                  title="Step-by-step manual deployment guide for this component type"
                >
                  📖 Manual Deploy
                </button>
              )}
              {convertedCode && (
                <>
                  {convNotes.length > 0 && (
                    <button className="cc-action-btn cc-notes-btn" onClick={() => setShowNotes(true)}>
                      ⚠ Notes <span className="cc-notes-badge">{convNotes.length}</span>
                    </button>
                  )}
                  <button className="cc-action-btn" onClick={handleCopy}>
                    {copied ? '✓ Copied' : '⎘ Copy code'}
                  </button>
                  {savedItemId && !editMode && (
                    <button
                      className="cc-action-btn"
                      onClick={() => { setEditMode(true); setEditedCode(convertedCode); }}
                      title="Edit converted code manually"
                    >
                      ✏ Edit
                    </button>
                  )}
                  {savedItemId && (
                    <button
                      className={`cc-action-btn${(deployResult && !deployResult.success) || (paResult && !paResult.ok) ? ' cc-fix-btn--active' : ''}`}
                      onClick={handleFix}
                      disabled={fixing}
                      title={_getLastError() ? 'Send error + code to LLM for auto-fix' : 'Send code to LLM for general review and fix'}
                      style={
                        (deployResult && !deployResult.success) || (paResult && !paResult.ok)
                          ? { color: '#f87171', borderColor: 'rgba(248,113,113,0.5)', background: 'rgba(248,113,113,0.08)' }
                          : {}
                      }
                    >
                      {fixing ? <><span className="cc-btn-spinner" /> Fixing…</> : '🔧 Fix'}
                    </button>
                  )}
                  {savedItemId && selectedComp?.type !== 'flow' && (
                    <button
                      className={`cc-action-btn cc-deploy-btn${deployResult?.success ? ' cc-deploy-btn--done' : ''}`}
                      onClick={handleDeploy}
                      disabled={deploying}
                      title={dotnetOk === false && selectedComp?.type !== 'lwc' && selectedComp?.type !== 'aura'
                        ? 'dotnet CLI not found — install .NET SDK 6+ to deploy C# plugins'
                        : 'Deploy to Dynamics 365'}
                    >
                      {deploying
                        ? <><span className="cc-btn-spinner" /> Deploying…</>
                        : deployResult?.success
                          ? '✓ Deployed'
                          : <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>{' '}Deploy to D365</>}
                    </button>
                  )}
                  {/* Power Automate deploy — flows only */}
                  {convertedCode && selectedComp?.type === 'flow' && (
                    <div className="pa-deploy-inline">
                      {paEnvs.length === 0 && (
                        <button
                          className="cc-action-btn pa-load-envs-btn"
                          onClick={handleLoadPaEnvs}
                          disabled={paEnvsLoading}
                          title="Load Power Automate environments"
                        >
                          {paEnvsLoading ? '…' : '⚡ Deploy to Power Automate'}
                        </button>
                      )}
                      {paEnvs.length > 0 && (
                        <>
                          <select
                            className="pa-env-select"
                            value={paEnvId}
                            onChange={e => setPaEnvId(e.target.value)}
                          >
                            {paEnvs.map(e => (
                              <option key={e.id} value={e.id}>
                                {e.displayName || e.id}{e.isDefault ? ' (default)' : ''}
                              </option>
                            ))}
                          </select>
                          <button
                            className={`cc-action-btn pa-deploy-btn${paResult?.ok ? ' cc-deploy-btn--done' : ''}`}
                            onClick={handlePaDeploy}
                            disabled={paDeploying || !paEnvId}
                          >
                            {paDeploying ? <><span className="cc-btn-spinner" /> Deploying…</> : paResult?.ok ? '✓ Flow Created' : '⚡ Deploy'}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Notes modal */}
          {showNotes && convNotes.length > 0 && (
            <div className="cc-notes-modal-overlay" onClick={() => setShowNotes(false)}>
              <div className="cc-notes-modal" onClick={e => e.stopPropagation()}>
                <div className="cc-notes-modal-header">
                  <span>⚠ Conversion Notes</span>
                  <button className="cc-notes-modal-close" onClick={() => setShowNotes(false)}>×</button>
                </div>
                <ul className="cc-notes-modal-list">
                  {convNotes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            </div>
          )}

          {/* Fix result banner */}
          {fixResult && (
            <div className={`cc-validate-banner cc-validate-banner--${fixResult.ok ? 'pass' : 'fail'}`}>
              {fixResult.ok ? (
                <>
                  <strong>🔧 Fixed — code updated. Ready to deploy again.</strong>
                  {fixResult.explanation && (
                    <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      {fixResult.explanation}
                    </div>
                  )}
                  {fixResult.usage && (
                    <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>
                      {fixResult.model} · {fixResult.usage.input_tokens}+{fixResult.usage.output_tokens} tokens · ${fixResult.usage.cost_usd?.toFixed(4)}
                    </div>
                  )}
                </>
              ) : (
                <strong>✗ Fix failed: {fixResult.error}</strong>
              )}
            </div>
          )}

          {/* Validate result banner (legacy) */}
          {validateResult && (
            <div className={`cc-validate-banner cc-validate-banner--${validateResult.verdict === 'PASS' ? 'pass' : 'fail'}`}>
              <strong>{validateResult.verdict === 'PASS' ? '✓ Validation passed' : validateResult.verdict === 'ERROR' ? '✗ Validate error' : `✗ Validation failed — ${validateResult.issues?.length || 0} issue(s)`}</strong>
              {validateResult.issues?.length > 0 && (
                <ul className="cc-validate-issues">
                  {validateResult.issues.map((iss, i) => <li key={i}>{iss}</li>)}
                </ul>
              )}
              {validateResult.auto_fixed && <div className="cc-validate-fixed">Auto-fixed and updated ✓</div>}
            </div>
          )}

          {/* Deploy result banner */}
          {deployResult && (
            <div className={`cc-deploy-result cc-deploy-result--${deployResult.success ? 'ok' : 'fail'}`}>
              <div className="cc-deploy-result-title">
                {deployResult.is_manual
                  ? '📋 Manual deployment required'
                  : deployResult.success
                    ? '✓ Deployed to Dynamics 365'
                    : '✗ Deployment failed'}
              </div>
              {deployResult.assembly_id && <div className="cc-deploy-result-meta">Assembly: {deployResult.assembly_id}</div>}
              {deployResult.step_ids?.length > 0 && <div className="cc-deploy-result-meta">Steps: {deployResult.step_ids.length} registered</div>}
              {deployResult.web_resource_id && <div className="cc-deploy-result-meta">Web Resource: {deployResult.web_resource_id}</div>}
              {deployResult.errors?.length > 0 && (
                <ul className="cc-deploy-errors">
                  {deployResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
              {deployResult.manual_instructions && (
                <pre className="cc-deploy-manual">{deployResult.manual_instructions}</pre>
              )}
              {deployLogText && (
                <button className="cc-action-btn" style={{marginTop: 6}} onClick={() => setShowDeployLog(true)}>
                  📋 View Log
                </button>
              )}
              {deployResult.log_id && (
                <a
                  href={`${API}/d365-deploy/log-download/${deployResult.log_id}`}
                  className="cc-action-btn"
                  style={{marginTop: 6, display: 'inline-block', textDecoration: 'none'}}
                  download
                >
                  ⬇ Download Log
                </a>
              )}
            </div>
          )}

          {/* Power Automate deploy result */}
          {paResult && (
            <div className={`cc-deploy-result cc-deploy-result--${paResult.ok ? 'ok' : paResult.is_manual ? 'fail' : 'fail'}`}>
              <div className="cc-deploy-result-title">
                {paResult.ok ? '⚡ Power Automate Flow Created!' : paResult.is_manual ? '📋 Auto-deploy failed — manual steps required' : '✗ PA Deploy Failed'}
              </div>
              {paResult.ok && (
                <>
                  <div className="cc-deploy-result-meta">Flow: {paResult.flow_name}</div>
                  <div className="cc-deploy-result-meta">
                    State: {paResult.state}
                    {paResult.state === 'Draft' && (
                      <span style={{marginLeft:8,fontSize:10,color:'#f59e0b',background:'rgba(245,158,11,0.12)',padding:'2px 7px',borderRadius:4,border:'1px solid rgba(245,158,11,0.3)'}}>
                        ⚠ Needs manual activation in Power Automate
                      </span>
                    )}
                  </div>
                  {paResult.flow_id && <div className="cc-deploy-result-meta" style={{fontSize:10,color:'var(--text-muted)'}}>ID: {paResult.flow_id}</div>}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    {paResult.edit_url && (
                      <a href={paResult.edit_url} target="_blank" rel="noreferrer"
                        className="cc-action-btn" style={{ textDecoration: 'none', fontSize: 11 }}>
                        ✏ Edit in Power Automate
                      </a>
                    )}
                    {paResult.run_url && (
                      <a href={paResult.run_url} target="_blank" rel="noreferrer"
                        className="cc-action-btn" style={{ textDecoration: 'none', fontSize: 11 }}>
                        ▶ Open Flow
                      </a>
                    )}
                  </div>
                  <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    ⚠ You may need to authorize the Dataverse connection in Power Automate before running.
                  </div>
                </>
              )}
              {!paResult.ok && paResult.is_manual && (
                <>
                  <div style={{ fontSize: 11, color: '#f87171', marginTop: 4 }}>{paResult.error}</div>
                  <pre style={{ marginTop: 10, fontSize: 10.5, color: '#e2e8f0', background: 'var(--bg-secondary)', padding: 12, borderRadius: 6, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                    {paResult.manual_steps}
                  </pre>
                  <button
                    className="cc-action-btn"
                    style={{ marginTop: 8, color: '#f59e0b', borderColor: 'rgba(245,158,11,0.35)' }}
                    onClick={() => { setGuideTab('flow'); setShowManualGuide(true); }}
                  >
                    📖 Open Manual Deploy Guide
                  </button>
                </>
              )}
              {!paResult.ok && !paResult.is_manual && (
                <div style={{ fontSize: 11, color: '#f87171', marginTop: 4 }}>{paResult.error}</div>
              )}
            </div>
          )}

          {/* Deploy log modal */}
          {showDeployLog && (
            <div className="cc-notes-modal-overlay" onClick={() => setShowDeployLog(false)}>
              <div className="cc-notes-modal cc-notes-modal--lg" onClick={e => e.stopPropagation()}>
                <div className="cc-notes-modal-header">
                  <span>📋 Deployment Log</span>
                  <button className="cc-notes-modal-close" onClick={() => setShowDeployLog(false)}>×</button>
                </div>
                <pre className="cc-deploy-log-pre">{deployLogText}</pre>
              </div>
            </div>
          )}

          {/* Deployment History modal — fixed full-screen overlay */}
          {showHistory && (
            <div
              onClick={() => setShowHistory(false)}
              style={{
                position: 'fixed', inset: 0, zIndex: 1000,
                background: 'rgba(0,0,0,0.55)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '24px',
              }}
            >
              <div
                className="cc-notes-modal"
                onClick={e => e.stopPropagation()}
                style={{ width: '780px', maxWidth: '95vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
              >
                <div className="cc-notes-modal-header">
                  <span>📋 Deployment History — {selectedComp?.name}</span>
                  <button className="cc-notes-modal-close" onClick={() => setShowHistory(false)}>×</button>
                </div>

                {historyLoading ? (
                  <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    Loading…
                  </div>
                ) : historyLogs.length === 0 ? (
                  <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    No deployment history for this component yet.
                  </div>
                ) : (
                  <div style={{ overflowX: 'auto', overflowY: 'auto', flex: 1 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                          {['Time', 'Status', 'Source', 'Assembly / Flow URL', 'Steps', 'Download'].map(h => (
                            <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap', background: 'var(--surface-secondary)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {historyLogs.map(log => {
                          const STATUS = {
                            success: { color: '#10b981', icon: '✓' },
                            failed:  { color: '#ef4444', icon: '✕' },
                            manual:  { color: '#f59e0b', icon: '✎' },
                            running: { color: '#3b82f6', icon: '⟳' },
                          };
                          const s = STATUS[log.status] || { color: '#6b7280', icon: '?' };
                          const timeStr = log.created_at
                            ? new Date(log.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                            : '—';
                          const isExpanded = expandedLogId === log.id;
                          const handleToggleLog = async () => {
                            if (isExpanded) { setExpandedLogId(null); return; }
                            setExpandedLogId(log.id);
                            if (!logDetail[log.id]) {
                              try {
                                const r = await fetch(`${API}/d365-deploy/logs/${log.connection_id}/${log.id}`);
                                const d = await r.json();
                                setLogDetail(prev => ({ ...prev, [log.id]: d.log_text || '(no log text)' }));
                              } catch { setLogDetail(prev => ({ ...prev, [log.id]: '(failed to load log)' })); }
                            }
                          };
                          return (
                            <React.Fragment key={log.id}>
                            <tr
                              style={{
                                borderBottom: isExpanded ? 'none' : '1px solid var(--border)',
                                background: log.status === 'failed' ? 'var(--danger-bg)' : 'transparent',
                                cursor: 'pointer',
                              }}
                              onClick={handleToggleLog}
                              title="Click to view full log"
                            >
                              <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{timeStr}</td>
                              <td style={{ padding: '8px 12px' }}>
                                <span style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  padding: '2px 8px', borderRadius: 10,
                                  fontSize: 11, fontWeight: 600,
                                  background: s.color + '22', color: s.color,
                                  border: `1px solid ${s.color}44`,
                                }}>
                                  {s.icon} {log.status}
                                </span>
                              </td>
                              <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>
                                {log.source === 'converter' ? 'Code Converter' : log.source === 'plan' ? 'Deploy Plan' : log.source || '—'}
                              </td>
                              <td style={{ padding: '8px 12px', color: 'var(--text-muted)', maxWidth: 200 }} onClick={e => e.stopPropagation()}>
                                {log.flow_url
                                  ? <a href={log.flow_url} target="_blank" rel="noreferrer"
                                      style={{ color: '#f59e0b', fontSize: 11, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                      ⚡ Open Flow ↗
                                    </a>
                                  : log.assembly_id
                                    ? <span style={{fontFamily:'monospace',fontSize:11}} title={log.assembly_id}>{log.assembly_id.slice(0, 8)}…</span>
                                    : log.web_resource_id
                                      ? <span style={{fontFamily:'monospace',fontSize:11}} title={log.web_resource_id}>{log.web_resource_id.slice(0, 8)}…</span>
                                      : log.error_message
                                        ? <span title={log.error_message} style={{ color: '#ef4444', fontSize:11 }}>{log.error_message.slice(0, 40)}…</span>
                                        : '—'
                                }
                              </td>
                              <td style={{ padding: '8px 12px', textAlign: 'center', color: log.step_ids?.length ? '#10b981' : 'var(--text-muted)' }}>
                                {log.step_ids?.length || '—'}
                              </td>
                              <td style={{ padding: '8px 12px', textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                                <a
                                  href={`${API}/d365-deploy/log-download/${log.id}`}
                                  download={`deploy_${log.component_name}_${log.id}.log`}
                                  title="Download full log"
                                  style={{
                                    display: 'inline-block',
                                    padding: '3px 10px',
                                    border: '1px solid var(--border)',
                                    borderRadius: 4,
                                    color: 'var(--text-secondary)',
                                    textDecoration: 'none',
                                    fontSize: 13,
                                  }}
                                >
                                  ⬇
                                </a>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr style={{ background: '#0d1117', borderBottom: '1px solid var(--border)' }}>
                                <td colSpan={6} style={{ padding: '0 12px 12px' }}>
                                  {log.error_message && (
                                    <div style={{ padding: '6px 10px', background: '#3f0c0c', borderRadius: 4, color: '#f87171', fontSize: 11, marginBottom: 6, marginTop: 8 }}>
                                      ✕ Error: {log.error_message}
                                    </div>
                                  )}
                                  <pre style={{
                                    margin: 0, fontSize: 10.5, color: '#94a3b8',
                                    background: '#0f172a', padding: '10px 12px', borderRadius: 4,
                                    whiteSpace: 'pre-wrap', lineHeight: 1.6,
                                    maxHeight: 260, overflowY: 'auto',
                                    marginTop: log.error_message ? 0 : 8,
                                  }}>
                                    {logDetail[log.id] === undefined ? 'Loading…' : logDetail[log.id]}
                                  </pre>
                                </td>
                              </tr>
                            )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="cc-code-wrap">
            {converting ? (
              <ConversionProgress converting={converting} compName={selectedComp?.name} compType={selectedComp?.type} />
            ) : convError ? (
              <div className="cc-conv-error">
                <div className="cc-conv-error-icon">⚠</div>
                <div className="cc-conv-error-title">Conversion failed</div>
                <pre className="cc-conv-error-detail">// Error: {convError}</pre>
              </div>
            ) : editMode ? (
              <div className="cc-edit-wrap">
                <div className="cc-edit-toolbar">
                  <span style={{fontSize:12,color:'#aaa'}}>Editing converted code</span>
                  <button className="cc-action-btn cc-edit-cancel" onClick={() => setEditMode(false)}>Cancel</button>
                  <button className="cc-action-btn cc-edit-save" onClick={handleEditSave} disabled={editSaving}>
                    {editSaving ? 'Saving…' : '💾 Save Changes'}
                  </button>
                </div>
                <textarea
                  className="cc-edit-textarea"
                  value={editedCode}
                  onChange={e => setEditedCode(e.target.value)}
                  spellCheck={false}
                />
              </div>
            ) : convertedCode ? (
              <CodeBlock code={convertedCode} />
            ) : (
              <div className="cc-code-placeholder">
                <div className="cc-ready-icon">⇄</div>
                <div className="cc-placeholder-title">Ready to convert</div>
                <div className="cc-placeholder-sub">
                  {selectedComp
                    ? `Click Convert to transform this ${TYPE_LABELS[selectedComp.type]?.badge || 'component'} to C#`
                    : 'Select a component and click Convert'}
                </div>
                {selectedComp && (
                  <button className="cc-ready-btn" onClick={handleConvert} disabled={converting}>
                    {selectedComp?.type === 'flow' ? '⚡ Convert to PA Flow' : '⚡ Convert to C#'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

      </div>
    </div>

    {/* ── Manual Deploy Guide ──────────────────────────────────── */}
    {showManualGuide && (
      <ManualDeployGuide
        compType={guideTab || selectedComp?.type || 'apex_class'}
        compName={selectedComp?.name || ''}
        convertedCode={convertedCode}
        deployResult={deployResult}
        onClose={() => setShowManualGuide(false)}
        onTabChange={setGuideTab}
        guideCopied={guideCopied}
        setGuideCopied={setGuideCopied}
      />
    )}
    </>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   Manual Deploy Guide — slide-in panel with per-component instructions
   ══════════════════════════════════════════════════════════════════════ */

const GUIDE_TABS = [
  { type: 'apex_class',   label: 'Apex Class',   icon: '🔷', color: '#3b82f6' },
  { type: 'apex_trigger', label: 'Apex Trigger',  icon: '⚡', color: '#8b5cf6' },
  { type: 'lwc',          label: 'LWC → PCF',     icon: '🧩', color: '#10b981' },
  { type: 'aura',         label: 'Aura → PCF',    icon: '🌀', color: '#06b6d4' },
  { type: 'flow',         label: 'Flow → PA',     icon: '🔄', color: '#f59e0b' },
];

const GUIDE_CONTENT = {
  apex_class: {
    title: 'Deploy Apex Class as Dynamics 365 Plugin',
    subtitle: 'Convert Salesforce Apex to a C# plugin assembly and register it in Dynamics 365.',
    prereqs: ['.NET SDK 6 or later', 'Plugin Registration Tool (PRT)', 'Dynamics 365 admin credentials'],
    steps: [
      {
        label: 'Copy the converted C# code',
        desc: 'Copy the C# code from the Target panel and save it as a .cs file (e.g., MyPlugin.cs).',
        cmd: null,
      },
      {
        label: 'Create a C# class library project',
        desc: 'Open a terminal and run:',
        cmd: 'dotnet new classlib -n MyPlugin\ncd MyPlugin\ndotnet add package Microsoft.CrmSdk.CoreAssemblies',
      },
      {
        label: 'Replace the generated class file',
        desc: 'Delete Class1.cs and paste your converted C# code in its place. Make sure the namespace and class name match.',
        cmd: 'del Class1.cs',
      },
      {
        label: 'Build the assembly',
        desc: 'Compile the project. Fix any build errors (usually missing using statements or namespace issues).',
        cmd: 'dotnet build -c Release',
      },
      {
        label: 'Sign the assembly (required)',
        desc: 'Dynamics 365 requires strong-named assemblies. Create a key and rebuild:',
        cmd: 'sn -k MyPlugin.snk\n# Add to .csproj: <AssemblyOriginatorKeyFile>MyPlugin.snk</AssemblyOriginatorKeyFile>\ndotnet build -c Release',
      },
      {
        label: 'Register with Plugin Registration Tool',
        desc: 'Open the Plugin Registration Tool → Connect to your Dynamics 365 org → Register New Assembly → Browse to bin/Release/net6.0/MyPlugin.dll → Register New Step (choose message: Create/Update/Delete, entity, stage).',
        cmd: null,
        link: { label: 'Download Plugin Registration Tool', url: 'https://learn.microsoft.com/en-us/dynamics365/customerengagement/on-premises/developer/download-tools-nuget' },
      },
    ],
    errorHints: {
      'dotnet': 'Install .NET SDK 6+ from https://dotnet.microsoft.com/download then restart terminal.',
      'strong name': 'Run: sn -k MyPlugin.snk and add the key file reference to your .csproj.',
      'assembly': 'Ensure the assembly targets .NET Framework 4.6.2 or .NET 6 (Dataverse compatible).',
    },
  },
  apex_trigger: {
    title: 'Deploy Apex Trigger as Dynamics 365 Plugin',
    subtitle: 'Triggers become event-driven plugins registered on specific Dataverse messages.',
    prereqs: ['.NET SDK 6 or later', 'Plugin Registration Tool (PRT)', 'Dynamics 365 admin credentials'],
    steps: [
      {
        label: 'Copy the converted C# code',
        desc: 'Copy the C# plugin code from the Target panel. The trigger logic is in the Execute() method.',
        cmd: null,
      },
      {
        label: 'Create a C# class library project',
        desc: 'Create a new project and add the Dataverse SDK:',
        cmd: 'dotnet new classlib -n MyTriggerPlugin\ncd MyTriggerPlugin\ndotnet add package Microsoft.CrmSdk.CoreAssemblies',
      },
      {
        label: 'Paste and adapt the code',
        desc: 'Replace Class1.cs with your converted code. Verify the IPlugin interface is implemented and Execute() has the correct signature.',
        cmd: null,
      },
      {
        label: 'Build and sign',
        desc: 'Sign and build the assembly:',
        cmd: 'sn -k MyTriggerPlugin.snk\ndotnet build -c Release',
      },
      {
        label: 'Register the assembly and step',
        desc: 'In Plugin Registration Tool → Register New Assembly → choose your DLL → Register New Step. Match the Salesforce trigger event (before/after insert/update/delete) to the D365 message (Create/Update/Delete) and stage (PreValidation=10, PreOperation=20, PostOperation=40).',
        cmd: null,
        link: { label: 'Plugin step registration guide', url: 'https://learn.microsoft.com/en-us/power-apps/developer/data-platform/register-plug-in' },
      },
    ],
    errorHints: {
      'IPlugin': 'Add: using Microsoft.Xrm.Sdk; and ensure your class implements IPlugin.',
      'IOrganizationService': 'Get the service from context: var service = (IOrganizationService)serviceProvider.GetService(typeof(IOrganizationService));',
    },
  },
  lwc: {
    title: 'Deploy LWC as Power Apps PCF Control',
    subtitle: 'Lightning Web Components convert to Power Apps Component Framework (PCF) controls.',
    prereqs: ['Node.js 16+', 'Power Platform CLI (pac)', 'Visual Studio Code + PCF tools'],
    steps: [
      {
        label: 'Install Power Platform CLI',
        desc: 'Install the pac CLI if not already installed:',
        cmd: 'npm install -g @microsoft/powerplatform-cli',
      },
      {
        label: 'Create a PCF project',
        desc: 'Initialize a new PCF project. Choose "field" for simple inputs or "dataset" for list controls:',
        cmd: 'mkdir MyPCFControl && cd MyPCFControl\npac pcf init --namespace MyNamespace --name MyControl --template field',
      },
      {
        label: 'Copy the converted TypeScript',
        desc: 'Replace the contents of index.ts with your converted code. Also copy any supporting files (CSS, sub-components).',
        cmd: null,
      },
      {
        label: 'Install dependencies and build',
        desc: 'Install npm packages and build the PCF control:',
        cmd: 'npm install\nnpm run build',
      },
      {
        label: 'Test locally (optional)',
        desc: 'Start the local test harness to verify your control works before deploying:',
        cmd: 'npm start watch',
      },
      {
        label: 'Deploy to Power Apps environment',
        desc: 'Authenticate and push the control to your environment:',
        cmd: 'pac auth create --url https://YOUR-ORG.crm.dynamics.com\npac pcf push --publisher-prefix myprefix',
        link: { label: 'PCF deployment guide', url: 'https://learn.microsoft.com/en-us/power-apps/developer/component-framework/import-custom-controls' },
      },
    ],
    errorHints: {
      'pac': 'Install Power Platform CLI: npm install -g @microsoft/powerplatform-cli',
      'npm': 'Install Node.js 16+ from https://nodejs.org',
      'TypeScript': 'Run: npm install typescript --save-dev to add TypeScript support.',
    },
  },
  aura: {
    title: 'Deploy Aura Component as Power Apps PCF Control',
    subtitle: 'Salesforce Aura components are converted to PCF controls similar to LWC.',
    prereqs: ['Node.js 16+', 'Power Platform CLI (pac)', 'Power Apps environment access'],
    steps: [
      {
        label: 'Install Power Platform CLI',
        desc: 'Ensure the pac CLI is installed:',
        cmd: 'npm install -g @microsoft/powerplatform-cli',
      },
      {
        label: 'Create a PCF project',
        desc: 'Aura components typically use "dataset" template for complex UIs:',
        cmd: 'mkdir MyAuraPCF && cd MyAuraPCF\npac pcf init --namespace MyNS --name MyAuraControl --template dataset',
      },
      {
        label: 'Copy the converted TypeScript and CSS',
        desc: 'Replace index.ts with the converted TypeScript. Copy any associated CSS/SCSS files. Update the ControlManifest.Input.xml to declare your properties.',
        cmd: null,
      },
      {
        label: 'Build the control',
        desc: 'Install dependencies and build:',
        cmd: 'npm install\nnpm run build',
      },
      {
        label: 'Deploy to environment',
        desc: 'Push to your Power Apps environment:',
        cmd: 'pac auth create --url https://YOUR-ORG.crm.dynamics.com\npac pcf push --publisher-prefix myprefix',
        link: { label: 'PCF controls documentation', url: 'https://learn.microsoft.com/en-us/power-apps/developer/component-framework/overview' },
      },
    ],
    errorHints: {
      'manifest': 'Edit ControlManifest.Input.xml to declare property-set and data-set nodes matching your component inputs.',
      'pac auth': 'Run pac auth create --url https://ORG.crm.dynamics.com and sign in with admin credentials.',
    },
  },
  flow: {
    title: 'Deploy Flow as Power Automate Flow',
    subtitle: 'Salesforce Flows are converted to Power Automate flow definitions (JSON).',
    prereqs: ['Power Automate license', 'Microsoft 365 account', 'Dataverse environment access'],
    steps: [
      {
        label: 'Copy the converted flow JSON',
        desc: 'Copy the full JSON output from the Target panel. This is a Power Automate flow definition.',
        cmd: null,
      },
      {
        label: 'Open Power Automate',
        desc: 'Go to make.powerautomate.com and sign in with your Microsoft account.',
        link: { label: 'Open Power Automate', url: 'https://make.powerautomate.com' },
        cmd: null,
      },
      {
        label: 'Create a new flow from blank',
        desc: 'Click "Create" → "Instant cloud flow" (or "Automated" based on your trigger). Start building by adding the same trigger as the original Salesforce flow.',
        cmd: null,
      },
      {
        label: 'Import the JSON definition',
        desc: 'In an existing flow, open the action menu (⋯) → "Peek code" to paste JSON for individual actions, or use the import feature for full flow packages.',
        cmd: null,
        link: { label: 'Import/export flows guide', url: 'https://learn.microsoft.com/en-us/power-automate/export-import-flow-non-default-environment' },
      },
      {
        label: 'Configure connections',
        desc: 'Update each connector to use your Dataverse environment connection. Click "Fix connection" on any connectors showing errors.',
        cmd: null,
      },
      {
        label: 'Test and activate the flow',
        desc: 'Run a manual test with sample data. Fix any schema or connection errors. Then turn on the flow.',
        cmd: null,
        link: { label: 'Test a flow guide', url: 'https://learn.microsoft.com/en-us/power-automate/fix-flow-failures' },
      },
    ],
    errorHints: {
      'connection': 'Open the flow → click "Fix connection" → sign in with an account that has access to Dataverse.',
      'environment': 'Ensure you are in the correct Power Automate environment matching your Dynamics 365 org.',
      'schema': 'Flow JSON schema errors usually mean an action type changed. Recreate that action manually.',
    },
  },
};

function ManualDeployGuide({ compType, compName, convertedCode, deployResult, onClose, onTabChange, guideCopied, setGuideCopied }) {
  const activeType = compType || 'apex_class';
  const content    = GUIDE_CONTENT[activeType] || GUIDE_CONTENT['apex_class'];
  const activeTab  = GUIDE_TABS.find(t => t.type === activeType) || GUIDE_TABS[0];

  const copyCmd = (id, text) => {
    navigator.clipboard.writeText(text).then(() => {
      setGuideCopied(prev => ({ ...prev, [id]: true }));
      setTimeout(() => setGuideCopied(prev => ({ ...prev, [id]: false })), 2000);
    }).catch(() => {});
  };

  // Check if deploy errors match any hints
  const errorHints = [];
  if (deployResult?.errors?.length) {
    const errText = deployResult.errors.join(' ').toLowerCase();
    Object.entries(content.errorHints || {}).forEach(([key, hint]) => {
      if (errText.includes(key.toLowerCase())) errorHints.push(hint);
    });
  }

  return (
    <>
      <div className="guide-backdrop" onClick={onClose} />
      <div className="guide-panel" style={{ '--guide-color': activeTab.color }}>

        {/* Header */}
        <div className="guide-panel-header">
          <div className="guide-panel-header-left">
            <span className="guide-panel-logo">📖</span>
            <div>
              <div className="guide-panel-title">Manual Deploy Guide</div>
              <div className="guide-panel-tagline">
                {compName ? `${compName} — ` : ''}{activeTab.label}
              </div>
            </div>
          </div>
          <button className="guide-panel-close" onClick={onClose}>×</button>
        </div>

        {/* Body: nav + content */}
        <div className="guide-panel-body">

          {/* Left nav */}
          <nav className="guide-nav">
            <div className="guide-nav-heading">Component Types</div>
            {GUIDE_TABS.map(tab => (
              <button
                key={tab.type}
                className={`guide-nav-item${activeType === tab.type ? ' active' : ''}`}
                style={{ '--guide-color': tab.color }}
                onClick={() => onTabChange(tab.type)}
              >
                <span className="guide-nav-icon">{tab.icon}</span>
                <span className="guide-nav-label">{tab.label}</span>
                {activeType === tab.type && <span className="guide-nav-arrow">›</span>}
              </button>
            ))}
          </nav>

          {/* Right content */}
          <div className="guide-content">

            {/* Hero */}
            <div className="guide-content-hero">
              <div
                className="guide-content-hero-icon"
                style={{ background: `${activeTab.color}22`, fontSize: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12 }}
              >
                {activeTab.icon}
              </div>
              <div>
                <div className="guide-content-title">{content.title}</div>
                <div className="guide-content-subtitle">{content.subtitle}</div>
              </div>
            </div>

            {/* Error-specific hints (shown only if deploy failed) */}
            {errorHints.length > 0 && (
              <div style={{ margin: '16px 20px 0', padding: '12px 16px', background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#f87171', marginBottom: 6 }}>⚠ Errors detected — suggested fixes:</div>
                {errorHints.map((h, i) => (
                  <div key={i} style={{ fontSize: 12, color: '#fca5a5', marginTop: 4 }}>• {h}</div>
                ))}
              </div>
            )}

            {/* Prerequisites */}
            <div style={{ margin: '16px 20px 0' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 8 }}>Prerequisites</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {content.prereqs.map((p, i) => (
                  <span key={i} style={{ fontSize: 11, padding: '3px 10px', background: `${activeTab.color}18`, border: `1px solid ${activeTab.color}44`, borderRadius: 20, color: activeTab.color }}>
                    {p}
                  </span>
                ))}
              </div>
            </div>

            {/* Steps */}
            <div style={{ padding: '16px 20px 24px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 12 }}>Steps</div>
              <div className="guide-steps">
                {content.steps.map((step, idx) => (
                  <div key={idx} className="guide-step">
                    <div
                      className="guide-step-num"
                      style={{ background: `${activeTab.color}22`, color: activeTab.color, border: `1.5px solid ${activeTab.color}55` }}
                    >
                      {idx + 1}
                    </div>
                    <div className="guide-step-body">
                      <div className="guide-step-label">{step.label}</div>
                      <p className="guide-step-desc">{step.desc}</p>
                      {step.cmd && (
                        <div style={{ position: 'relative', marginTop: 8, marginBottom: 4 }}>
                          <pre style={{
                            background: 'var(--bg-secondary, #0d1117)',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            padding: '10px 40px 10px 12px',
                            fontSize: 11,
                            fontFamily: 'monospace',
                            color: '#e2e8f0',
                            overflowX: 'auto',
                            margin: 0,
                            lineHeight: 1.6,
                            whiteSpace: 'pre',
                          }}>
                            {step.cmd}
                          </pre>
                          <button
                            onClick={() => copyCmd(`step-${activeType}-${idx}`, step.cmd)}
                            style={{
                              position: 'absolute', top: 6, right: 6,
                              padding: '2px 8px', fontSize: 10,
                              background: guideCopied[`step-${activeType}-${idx}`] ? '#10b981' : 'var(--surface)',
                              color: guideCopied[`step-${activeType}-${idx}`] ? '#fff' : 'var(--text-secondary)',
                              border: '1px solid var(--border)',
                              borderRadius: 4, cursor: 'pointer',
                            }}
                          >
                            {guideCopied[`step-${activeType}-${idx}`] ? '✓' : 'Copy'}
                          </button>
                        </div>
                      )}
                      {step.link && (
                        <a
                          href={step.link.url}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontSize: 11, color: activeTab.color, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 6 }}
                        >
                          ↗ {step.link.label}
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      </div>
    </>
  );
}

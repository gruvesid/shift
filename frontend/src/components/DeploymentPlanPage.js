import React, { useState, useEffect, useCallback, useRef } from 'react';
import { authFetch } from '../utils/authFetch';

const API = process.env.REACT_APP_API_URL || 'http://localhost:8000';

const TYPE_INFO = {
  apex_class:   { label: 'Apex Class',   badge: 'CLS', color: '#6366f1' },
  apex_trigger: { label: 'Apex Trigger', badge: 'TRG', color: '#f59e0b' },
  lwc:          { label: 'LWC',          badge: 'LWC', color: '#22c55e' },
  aura:         { label: 'Aura',         badge: 'AUR', color: '#8b5cf6' },
  flow:         { label: 'Flow',         badge: 'FLW', color: '#06b6d4' },
};

const PLAN_STATUS_INFO = {
  draft:      { label: 'Draft',      cls: 'dp-badge dp-badge--draft'     },
  deploying:  { label: 'Running…',   cls: 'dp-badge dp-badge--deploying' },
  completed:  { label: 'Completed',  cls: 'dp-badge dp-badge--completed' },
  partial:    { label: 'Partial',    cls: 'dp-badge dp-badge--partial'   },
  failed:     { label: 'Failed',     cls: 'dp-badge dp-badge--failed'    },
};

const CONVERT_STATUS = {
  pending:    { bg: 'rgba(107,114,128,.12)', fg: '#9ca3af', label: 'Pending' },
  converting: { bg: 'rgba(245,158,11,.15)',  fg: '#f59e0b', label: 'Converting…' },
  converted:  { bg: 'rgba(35,165,94,.12)',   fg: '#23a55a', label: '✓ Converted' },
  failed:     { bg: 'rgba(239,68,68,.12)',   fg: '#ef4444', label: '✗ Failed' },
};

const DEPLOY_STATUS = {
  not_deployed:  { bg: 'rgba(107,114,128,.10)', fg: '#6b7280', label: '— Not Deployed' },
  deploying:     { bg: 'rgba(245,158,11,.15)',  fg: '#f59e0b', label: 'Deploying…' },
  deployed:      { bg: 'rgba(35,165,94,.12)',   fg: '#23a55a', label: '✓ Deployed' },
  deploy_failed: { bg: 'rgba(239,68,68,.12)',   fg: '#ef4444', label: '✗ Deploy Failed' },
  manual:        { bg: 'rgba(139,92,246,.12)',  fg: '#8b5cf6', label: '⚑ Manual' },
};

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function StatusChip({ status, map, spinning }) {
  const s = map[status] || { bg: 'rgba(107,114,128,.1)', fg: '#9ca3af', label: status || '—' };
  return (
    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: s.bg, color: s.fg, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', flexShrink: 0 }}>
      {spinning && <span className="odp-btn-spinner" style={{ width: 8, height: 8, borderWidth: 1.5 }} />}
      {s.label}
    </span>
  );
}

/* ── Create Plan Modal ───────────────────────────────────────────────── */
function CreatePlanModal({ onClose, onCreated, orgId }) {
  const [name,   setName]   = useState('');
  const [desc,   setDesc]   = useState('');
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  const handleCreate = async () => {
    if (!name.trim()) { setError('Plan name is required.'); return; }
    setSaving(true); setError('');
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/plans`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: desc.trim() }),
      });
      const d = await r.json();
      if (r.ok) onCreated(d);
      else setError(d.detail || 'Failed to create plan.');
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  return (
    <div className="ai-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ai-modal dp-create-modal">
        <div className="ai-modal-header">
          <span className="ai-modal-icon">🚀</span>
          <span className="ai-modal-title">New Deployment Plan</span>
          <button className="ai-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="dp-create-body">
          <div className="rb-field">
            <label className="rb-label">PLAN NAME</label>
            <input className="rb-input" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. Sprint 1 — Apex Classes" autoFocus
              onKeyDown={e => e.key === 'Enter' && handleCreate()} />
          </div>
          <div className="rb-field">
            <label className="rb-label">DESCRIPTION <span style={{ opacity: 0.5, fontWeight: 400 }}>(optional)</span></label>
            <textarea className="rb-textarea rb-textarea--sm" value={desc} onChange={e => setDesc(e.target.value)}
              rows={3} placeholder="Describe what this deployment plan covers…" spellCheck={false} />
          </div>
          {error && <div className="ai-chat-error">⚠ {error}</div>}
          <div className="rb-footer">
            <button type="button" className="rb-cancel-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="odp-save-config-btn" onClick={handleCreate} disabled={saving}>
              {saving ? 'Creating…' : '+ Create Plan'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Add Items Modal ─────────────────────────────────────────────────── */
function AddItemsModal({ orgId, planId, existingItems, onClose, onAdded }) {
  const [components, setComponents] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [search,     setSearch]     = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [selected,   setSelected]   = useState({});
  const [adding,     setAdding]     = useState(false);
  const [error,      setError]      = useState('');

  useEffect(() => {
    authFetch(`${API}/shift/connections/${orgId}/metadata-components`)
      .then(r => r.json())
      .then(d => setComponents(d.components || []))
      .catch(() => setError('Failed to load components.'))
      .finally(() => setLoading(false));
  }, [orgId]);

  const existingKeys = new Set(existingItems.map(i => `${i.item_type}::${i.item_name}`));
  const filtered = components.filter(c => {
    const matchType   = typeFilter === 'all' || c.item_type === typeFilter;
    const matchSearch = !search.trim() || c.label.toLowerCase().includes(search.toLowerCase()) || c.item_name.toLowerCase().includes(search.toLowerCase());
    const notAdded    = !existingKeys.has(`${c.item_type}::${c.item_name}`);
    return matchType && matchSearch && notAdded;
  });
  const toggleSelect = (key) => setSelected(p => ({ ...p, [key]: !p[key] }));
  const toggleAll    = () => {
    const keys   = filtered.map(c => `${c.item_type}::${c.item_name}`);
    const allSel = keys.every(k => selected[k]);
    const next   = { ...selected };
    keys.forEach(k => { next[k] = !allSel; });
    setSelected(next);
  };
  const selectedItems = components.filter(c => selected[`${c.item_type}::${c.item_name}`]);

  const handleAdd = async () => {
    if (selectedItems.length === 0) return;
    setAdding(true); setError('');
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/plans/${planId}/items`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedItems.map(c => ({ item_type: c.item_type, item_name: c.item_name, sf_id: c.sf_id }))),
      });
      const d = await r.json();
      if (r.ok) onAdded(d);
      else setError(d.detail || 'Failed to add items.');
    } catch (e) { setError(e.message); }
    setAdding(false);
  };

  const types      = ['all', ...Object.keys(TYPE_INFO)];
  const typeCounts = {};
  components.filter(c => !existingKeys.has(`${c.item_type}::${c.item_name}`)).forEach(c => {
    typeCounts[c.item_type] = (typeCounts[c.item_type] || 0) + 1;
  });

  return (
    <div className="ai-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ai-modal dp-add-modal">
        <div className="ai-modal-header">
          <span className="ai-modal-icon">➕</span>
          <span className="ai-modal-title">Add Components to Plan</span>
          <span className="ai-modal-sub">Select components from extracted metadata</span>
          <button className="ai-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="dp-add-toolbar">
          <input className="fm-search" placeholder="Search components…" value={search}
            onChange={e => setSearch(e.target.value)} style={{ flex: 1 }} />
          <div className="dp-type-pills">
            {types.map(t => (
              <button key={t} type="button" className={`dp-type-pill${typeFilter === t ? ' active' : ''}`}
                onClick={() => setTypeFilter(t)}
                style={typeFilter === t && t !== 'all' ? { background: `${TYPE_INFO[t]?.color}22`, borderColor: TYPE_INFO[t]?.color, color: TYPE_INFO[t]?.color } : {}}>
                {t === 'all' ? `All ${Object.values(typeCounts).reduce((a, b) => a + b, 0) || ''}` : `${TYPE_INFO[t]?.label} ${typeCounts[t] || 0}`}
              </button>
            ))}
          </div>
        </div>
        {error && <div className="ai-chat-error fm-error">⚠ {error}</div>}
        <div className="dp-add-list">
          {loading ? (
            <div className="fm-empty"><span className="odp-overlay-spinner" style={{ width: 32, height: 32 }} /></div>
          ) : filtered.length === 0 ? (
            <div className="fm-empty">
              <div className="fm-empty-icon">📭</div>
              <div className="fm-empty-title">{components.length === 0 ? 'No metadata extracted' : 'No components match'}</div>
              <div className="fm-empty-sub">{components.length === 0 ? 'Extract metadata first (Step 2).' : 'Try a different filter or search.'}</div>
            </div>
          ) : (
            <>
              <div className="dp-add-select-all">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>
                  <input type="checkbox" onChange={toggleAll} checked={filtered.length > 0 && filtered.every(c => selected[`${c.item_type}::${c.item_name}`])} />
                  Select all {filtered.length} visible
                </label>
                {selectedItems.length > 0 && <span className="dp-sel-count">{selectedItems.length} selected</span>}
              </div>
              {filtered.map(c => {
                const key  = `${c.item_type}::${c.item_name}`;
                const info = TYPE_INFO[c.item_type] || {};
                return (
                  <label key={key} className={`dp-add-item${selected[key] ? ' selected' : ''}`}>
                    <input type="checkbox" checked={!!selected[key]} onChange={() => toggleSelect(key)} />
                    <span className="dp-add-badge" style={{ background: `${info.color}22`, color: info.color, borderColor: `${info.color}44` }}>
                      {info.badge || c.item_type.toUpperCase().slice(0, 3)}
                    </span>
                    <span className="dp-add-name">{c.label || c.item_name}</span>
                  </label>
                );
              })}
            </>
          )}
        </div>
        <div className="dp-add-footer">
          <span className="rb-updated">{selectedItems.length} selected</span>
          <button type="button" className="rb-cancel-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="odp-save-config-btn" onClick={handleAdd} disabled={adding || selectedItems.length === 0}>
            {adding ? 'Adding…' : `+ Add ${selectedItems.length > 0 ? selectedItems.length : ''} Items`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Live Item Row ───────────────────────────────────────────────────── */
function LiveItemRow({ item, liveState, orgId, planId, onRemove, onConverted, running }) {
  const [expanded,         setExpanded]         = useState(false);
  const [editMode,         setEditMode]         = useState(false);
  const [editedCode,       setEditedCode]       = useState('');
  const [showNotes,        setShowNotes]        = useState(false);
  const [singleConverting, setSingleConverting] = useState(false);
  const [singleDeploying,  setSingleDeploying]  = useState(false);
  const logEndRef = useRef(null);

  const live           = liveState || {};
  const convertStatus  = live.convertStatus || item.convert_status || 'pending';
  const deployStatus   = live.deployStatus  || item.deploy_status  || 'not_deployed';
  const logs           = live.logs          || [];
  const phase          = live.phase;
  const costUsd        = live.costUsd       != null ? live.costUsd  : (item.cost_usd || 0);
  const tokensIn       = live.tokensIn      != null ? live.tokensIn  : (item.tokens_in || 0);
  const tokensOut      = live.tokensOut     != null ? live.tokensOut : (item.tokens_out || 0);
  const modelName      = live.model         || item.model    || '';
  const providerName   = live.provider      || item.provider || '';
  // If cost wasn't stored but we have tokens, estimate using Claude Sonnet 4.6 pricing ($3/$15 per 1M)
  const estimatedCost  = costUsd === 0 && (tokensIn > 0 || tokensOut > 0)
    ? Math.round((tokensIn * 3 + tokensOut * 15) / 1_000_000 * 1_000_000) / 1_000_000
    : 0;
  const displayCost    = costUsd > 0 ? costUsd : estimatedCost;
  const isEstimated    = costUsd === 0 && estimatedCost > 0;
  const fixAttempts    = live.fixAttempts   != null ? live.fixAttempts : (item.fix_attempts || 0);
  const isConverting   = convertStatus === 'converting' || phase === 'converting';
  const isDeploying    = deployStatus  === 'deploying'  || phase === 'deploying';
  const isFixing       = !!live.fixing;
  const info           = TYPE_INFO[item.item_type] || {};
  const code           = item.converted_code || '';
  const logId          = live.logId != null ? live.logId : item.deploy_log_id;

  useEffect(() => {
    if (expanded && logEndRef.current && logs.length > 0) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs.length, expanded]);

  // Auto-expand when this item becomes active
  useEffect(() => {
    if ((isConverting || isDeploying || isFixing) && !expanded) setExpanded(true);
  }, [isConverting, isDeploying, isFixing]); // eslint-disable-line

  const handleRetryConvert = async () => {
    setSingleConverting(true);
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/plans/${planId}/items/${item.id}/convert`, { method: 'POST' });
      const d = await r.json();
      if (r.ok) onConverted(d);
    } catch { /* ignore */ }
    setSingleConverting(false);
  };

  const handleSingleDeploy = async () => {
    setSingleDeploying(true);
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/plans/${planId}/items/${item.id}/d365-deploy`, { method: 'POST' });
      const d = await r.json();
      if (r.ok) onConverted({ ...item, deploy_status: d.status, deploy_log_id: d.log_id });
    } catch { /* ignore */ }
    setSingleDeploying(false);
  };

  const handleEditSave = async () => {
    try {
      await authFetch(`${API}/shift/connections/${orgId}/plans/${planId}/items/${item.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ converted_code: editedCode }),
      });
      onConverted({ ...item, converted_code: editedCode });
    } catch { /* ignore */ }
    setEditMode(false);
  };

  const isActive = isConverting || isDeploying || isFixing || singleConverting || singleDeploying;

  return (
    <>
      <div className={`dp-live-row${expanded ? ' dp-live-row--expanded' : ''}${isActive ? ' dp-live-row--active' : ''}`}
        style={{ borderLeft: `3px solid ${info.color || '#6b7280'}` }}>

        {/* Main clickable row */}
        <div className="dp-live-row-main" onClick={() => setExpanded(e => !e)}>
          <span className="dp-type-badge" style={{ background: `${info.color}20`, color: info.color, borderColor: `${info.color}40` }}>
            {info.badge || '?'}
          </span>
          <span className="dp-live-name" title={item.item_name}>{item.item_name}</span>

          <div className="dp-live-chips">
            <StatusChip status={convertStatus} map={CONVERT_STATUS} spinning={isConverting || singleConverting} />
            {(convertStatus === 'converted' || deployStatus !== 'not_deployed') && (
              <StatusChip status={deployStatus} map={DEPLOY_STATUS} spinning={isDeploying || isFixing || singleDeploying} />
            )}
            {fixAttempts > 0 && (
              <span style={{ fontSize: 10, color: '#f59e0b', padding: '2px 6px', borderRadius: 8, background: 'rgba(245,158,11,.12)', flexShrink: 0 }}>
                ↻ {fixAttempts} fix{fixAttempts !== 1 ? 'es' : ''}
              </span>
            )}
            {/* Inline cost + token stats right next to status chips */}
            {displayCost > 0 && (
              <span className="dp-inline-cost"
                style={isEstimated ? { opacity: 0.7, borderStyle: 'dashed' } : {}}
                title={isEstimated ? 'Estimated cost (Claude Sonnet 4.6 pricing). Re-convert to get exact cost.' : 'LLM cost for this component'}>
                {isEstimated ? '~' : ''}${displayCost.toFixed(4)}
              </span>
            )}
            {(tokensIn > 0 || tokensOut > 0) && (
              <span className="dp-inline-tokens" title={`${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out tokens`}>
                {tokensIn.toLocaleString()}↑ {tokensOut.toLocaleString()}↓
              </span>
            )}
            {modelName && (
              <span className="dp-inline-model" title={`Provider: ${providerName || 'unknown'}`}>
                {modelName.length > 20 ? modelName.slice(0, 18) + '…' : modelName}
              </span>
            )}
          </div>

          <div className="dp-live-meta">
            <span className="dp-live-expand-icon">
              {expanded
                ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              }
            </span>
          </div>
        </div>

        {/* Expanded detail */}
        {expanded && (
          <div className="dp-live-detail">
            {/* Live log stream */}
            {logs.length > 0 && (
              <div className="dp-live-logs">
                <div className="dp-live-logs-label">Run Log</div>
                <div className="dp-live-logs-body">
                  {logs.map((l, i) => (
                    <div key={i} className={`dp-live-log-line${l.includes('✓') ? ' ok' : l.includes('✗') ? ' err' : l.includes('↻') ? ' fix' : ''}`}>
                      {l}
                    </div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              </div>
            )}

            {/* Converted code */}
            {code && (
              <div className="dp-live-code-block">
                <div className="dp-live-code-toolbar">
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Converted code <span style={{ opacity: 0.6 }}>({item.file_ext || '.txt'})</span>
                  </span>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {item.migration_notes && !editMode && (
                      <button className="dp-item-btn" onClick={e => { e.stopPropagation(); setShowNotes(true); }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
                        </svg>
                        Notes
                      </button>
                    )}
                    {!editMode ? (
                      <button className="dp-item-btn" onClick={e => { e.stopPropagation(); setEditMode(true); setEditedCode(code); }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                        Edit
                      </button>
                    ) : (
                      <>
                        <button className="dp-item-btn" style={{ color: '#23a55a', borderColor: 'rgba(35,165,90,.4)' }}
                          onClick={e => { e.stopPropagation(); handleEditSave(); }}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                          Save
                        </button>
                        <button className="dp-item-btn" onClick={e => { e.stopPropagation(); setEditMode(false); }}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                          </svg>
                          Cancel
                        </button>
                      </>
                    )}
                    <button className="dp-item-btn" onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(code); }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                      </svg>
                      Copy
                    </button>
                    <a className="dp-item-btn" style={{ textDecoration: 'none' }}
                      href={`data:text/plain;charset=utf-8,${encodeURIComponent(code)}`}
                      download={`${item.item_name}${item.file_ext || '.txt'}`}
                      onClick={e => e.stopPropagation()}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                      Download
                    </a>
                  </div>
                </div>
                {editMode ? (
                  <textarea className="dp-code-editor" value={editedCode}
                    onChange={e => setEditedCode(e.target.value)}
                    onClick={e => e.stopPropagation()} spellCheck={false} />
                ) : (
                  <pre className="dp-code-pre">{code}</pre>
                )}
              </div>
            )}

            {/* Per-item actions */}
            <div className="dp-live-actions" onClick={e => e.stopPropagation()}>
              {!item.source_code && (
                <span style={{ fontSize: 11, color: '#ef4444' }}>⚠ No source code — cannot convert</span>
              )}
              {item.source_code && (convertStatus === 'pending' || convertStatus === 'failed') && !running && (
                <button className="dp-item-btn" onClick={handleRetryConvert} disabled={singleConverting}>
                  {singleConverting ? (
                    <><span className="odp-btn-spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} /> Converting…</>
                  ) : (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                      </svg>
                      Convert
                    </>
                  )}
                </button>
              )}
              {convertStatus === 'converted' && !['deployed', 'manual'].includes(deployStatus) && !running && (
                <button className="dp-item-btn" style={{ color: '#8b5cf6', borderColor: 'rgba(139,92,246,.4)' }}
                  onClick={handleSingleDeploy} disabled={singleDeploying}>
                  {singleDeploying ? (
                    <><span className="odp-btn-spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} /> Deploying…</>
                  ) : (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4 20-7z"/>
                      </svg>
                      Deploy to D365
                    </>
                  )}
                </button>
              )}
              {logId && (
                <a className="dp-item-btn" style={{ textDecoration: 'none' }}
                  href={`${API}/shift/deployment-logs/${logId}/download`} download
                  onClick={e => e.stopPropagation()}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  Deploy Log</a>
              )}
              <button className="dp-item-btn dp-item-btn--danger"
                onClick={() => onRemove(item.id)} disabled={running}
                style={{ marginLeft: 'auto' }}>🗑 Remove</button>
            </div>
          </div>
        )}
      </div>

      {showNotes && (
        <div className="ai-modal-overlay" onClick={e => e.target === e.currentTarget && setShowNotes(false)}>
          <div className="ai-modal" style={{ width: 640, maxHeight: '75vh', display: 'flex', flexDirection: 'column' }}>
            <div className="ai-modal-header">
              <span className="ai-modal-icon">📋</span>
              <span className="ai-modal-title">Migration Notes — {item.item_name}</span>
              <button className="ai-modal-close" onClick={() => setShowNotes(false)}>×</button>
            </div>
            <pre style={{ overflow: 'auto', flex: 1, padding: '12px 16px', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {item.migration_notes || 'No notes.'}
            </pre>
          </div>
        </div>
      )}
    </>
  );
}

/* ── Deployment Logs Modal ───────────────────────────────────────────── */
function DeployLogsModal({ orgId, planId, planName, onClose }) {
  const [logs,    setLogs]    = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authFetch(`${API}/shift/connections/${orgId}/plans/${planId}/deployment-logs`)
      .then(r => r.json())
      .then(d => setLogs(d.logs || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [orgId, planId]);

  return (
    <div className="ai-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ai-modal" style={{ width: 780, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        <div className="ai-modal-header">
          <span className="ai-modal-icon">📋</span>
          <span className="ai-modal-title">Deployment Logs — {planName}</span>
          <button className="ai-modal-close" onClick={onClose}>×</button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: 12 }}>
          {loading ? (
            <div className="fm-empty"><span className="odp-overlay-spinner" style={{ width: 28, height: 28 }} /></div>
          ) : logs.length === 0 ? (
            <div className="fm-empty">
              <div className="fm-empty-icon">📭</div>
              <div className="fm-empty-title">No deployment logs yet</div>
              <div className="fm-empty-sub">Logs appear after deploying items to Dynamics 365.</div>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                  <th style={{ textAlign: 'left', padding: '4px 8px' }}>Component</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px' }}>Type</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px' }}>Status</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px' }}>Time</th>
                  <th style={{ padding: '4px 8px' }}>Log</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => {
                  const ok = log.status === 'success' || log.status === 'deployed';
                  const isManual = log.status === 'manual';
                  return (
                    <tr key={log.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '5px 8px', fontWeight: 500 }}>{log.component_name}</td>
                      <td style={{ padding: '5px 8px', color: 'var(--text-muted)' }}>{log.component_type}</td>
                      <td style={{ padding: '5px 8px' }}>
                        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8,
                          background: ok ? 'rgba(35,165,94,.15)' : isManual ? 'rgba(139,92,246,.15)' : 'rgba(239,68,68,.15)',
                          color: ok ? '#23a55a' : isManual ? '#8b5cf6' : '#ef4444' }}>
                          {ok ? '✓ Deployed' : isManual ? '⚑ Manual' : '✗ Failed'}
                        </span>
                        {log.error_message && <div style={{ fontSize: 10, color: '#ef4444', marginTop: 2 }}>{log.error_message.slice(0, 80)}</div>}
                      </td>
                      <td style={{ padding: '5px 8px', color: 'var(--text-muted)', fontSize: 11 }}>{formatDate(log.completed_at || log.created_at)}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'center' }}>
                        <a href={`${API}/shift/deployment-logs/${log.id}/download`}
                          style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 11 }} download>⬇</a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Plan Detail ─────────────────────────────────────────────────────── */
function PlanDetail({ orgId, plan: initialPlan, onBack, onPlanUpdated }) {
  const [plan,        setPlan]        = useState(initialPlan);
  const [items,       setItems]       = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [nameVal,     setNameVal]     = useState(initialPlan.name);
  const [editingName, setEditingName] = useState(false);
  const [error,       setError]       = useState('');
  const [showAdd,     setShowAdd]     = useState(false);
  const [showLogs,    setShowLogs]    = useState(false);
  const nameInputRef = useRef(null);

  // Real-time run state
  const [running,    setRunning]    = useState(false);
  const [runMode,    setRunMode]    = useState(null);
  const [progress,   setProgress]   = useState({ current: 0, total: 0 });
  const [itemStates, setItemStates] = useState({});  // { [id]: { convertStatus, deployStatus, logs[], phase, costUsd, fixAttempts, logId, fixing } }
  const [totalCost,  setTotalCost]  = useState(0);
  const [runSummary, setRunSummary] = useState(null);
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/plans/${plan.id}`);
      if (r.ok) {
        const d = await r.json();
        setPlan(d);
        setItems(d.items || []);
        setNameVal(d.name);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [orgId, plan.id]);

  useEffect(() => { load(); }, [load]);

  // helpers to mutate itemStates immutably
  const patchItem = useCallback((id, patch) => {
    setItemStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  }, []);
  const appendLog = useCallback((id, log) => {
    setItemStates(prev => {
      const cur = prev[id] || {};
      return { ...prev, [id]: { ...cur, logs: [...(cur.logs || []), log] } };
    });
  }, []);

  const handleStreamEvent = useCallback((ev) => {
    switch (ev.event) {
      case 'plan_start':
        setProgress({ current: 0, total: ev.total });
        break;
      case 'item_start':
        setProgress(p => ({ ...p, current: ev.index }));
        patchItem(ev.id, {
          convertStatus: ev.phase === 'converting' ? 'converting' : undefined,
          deployStatus:  ev.phase === 'deploying'  ? 'deploying'  : undefined,
          phase: ev.phase, fixing: false,
        });
        break;
      case 'item_log':
        appendLog(ev.id, ev.log);
        break;
      case 'item_fixing':
        patchItem(ev.id, { fixing: true, fixAttempts: ev.attempt });
        break;
      case 'item_phase_done':
        if (ev.phase === 'converting') {
          patchItem(ev.id, {
            convertStatus: ev.status === 'ok' ? 'converted' : 'failed',
            phase: null,
            tokensIn: ev.tokens_in || 0, tokensOut: ev.tokens_out || 0,
            model: ev.model || '', provider: ev.provider || '',
          });
          if (ev.cost_usd) {
            setItemStates(prev => {
              const cur = prev[ev.id] || {};
              return { ...prev, [ev.id]: { ...cur, costUsd: (cur.costUsd || 0) + ev.cost_usd } };
            });
            setTotalCost(p => p + (ev.cost_usd || 0));
          }
        } else {
          patchItem(ev.id, {
            deployStatus: ev.deploy_status || (ev.status === 'ok' ? 'deployed' : 'deploy_failed'),
            phase: 'done', fixAttempts: ev.fix_attempts || 0, logId: ev.log_id, fixing: false,
          });
        }
        break;
      case 'item_done':
        patchItem(ev.id, {
          convertStatus: ev.convert_status, deployStatus: ev.deploy_status,
          phase: 'done', fixing: false, costUsd: ev.cost_usd,
          fixAttempts: ev.fix_attempts, logId: ev.log_id,
          tokensIn: ev.tokens_in || 0, tokensOut: ev.tokens_out || 0,
          model: ev.model || '', provider: ev.provider || '',
        });
        break;
      case 'item_skip':
        patchItem(ev.id, { phase: 'skip' });
        break;
      case 'plan_done':
        setRunSummary({ status: ev.status, stats: ev.stats, totalCostUsd: ev.total_cost_usd });
        setTotalCost(ev.total_cost_usd || 0);
        break;
      case 'error':
        setError(ev.message || 'Stream error.');
        break;
      default: break;
    }
  }, [patchItem, appendLog]);

  const handleRun = useCallback(async (mode, forceReconvert = false) => {
    if (running) {
      if (abortRef.current) abortRef.current.abort();
      return;
    }
    if (mode === 'convert_and_deploy' || mode === 'convert_only') {
      const pending = items.filter(i => i.convert_status !== 'converted').length;
      if (pending === 0 && mode === 'convert_only') { setError('All items already converted.'); return; }
    }
    setRunning(true);
    setRunMode(mode);
    setRunSummary(null);
    setError('');
    setTotalCost(0);
    setItemStates({});
    setProgress({ current: 0, total: items.length });

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const resp = await fetch(
        `${API}/shift/connections/${orgId}/plans/${plan.id}/run-stream?mode=${mode}${forceReconvert ? '&force_reconvert=true' : ''}`,
        { method: 'POST', signal: controller.signal },
      );
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        setError(d.detail || 'Failed to start run.');
        setRunning(false); setRunMode(null);
        return;
      }
      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try { handleStreamEvent(JSON.parse(line.slice(6))); }
          catch { /* skip malformed */ }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    }
    setRunning(false); setRunMode(null);
    await load();
    onPlanUpdated();
  }, [running, items, orgId, plan.id, handleStreamEvent, load, onPlanUpdated]);

  const handleSaveName = async () => {
    if (!nameVal.trim() || nameVal === plan.name) { setEditingName(false); return; }
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/plans/${plan.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameVal }),
      });
      if (r.ok) { const d = await r.json(); setPlan(p => ({ ...p, name: d.name })); }
    } catch { /* ignore */ }
    setEditingName(false);
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete plan "${plan.name}"? This cannot be undone.`)) return;
    await authFetch(`${API}/shift/connections/${orgId}/plans/${plan.id}`, { method: 'DELETE' });
    onBack();
  };

  const handleRemoveItem = async (itemId) => {
    if (running) return;
    await authFetch(`${API}/shift/connections/${orgId}/plans/${plan.id}/items/${itemId}`, { method: 'DELETE' });
    setItems(p => p.filter(i => i.id !== itemId));
    setPlan(p => ({ ...p, total_items: p.total_items - 1 }));
  };

  const handleItemConverted = useCallback((updatedItem) => {
    setItems(prev => prev.map(i => i.id === updatedItem.id ? { ...i, ...updatedItem } : i));
    onPlanUpdated();
  }, [onPlanUpdated]);

  const handleAdded = () => { setShowAdd(false); load(); onPlanUpdated(); };

  // Computed stats
  const totalItems    = items.length;
  const convertedCnt  = items.filter(i => i.convert_status === 'converted').length;
  const deployedCnt   = items.filter(i => ['deployed', 'manual'].includes(i.deploy_status)).length;
  const failedConv    = items.filter(i => i.convert_status === 'failed').length;
  const failedDeploy  = items.filter(i => i.deploy_status === 'deploy_failed').length;
  const pendingCnt    = items.filter(i => i.convert_status === 'pending').length;
  const readyDeploy   = items.filter(i => i.convert_status === 'converted' && !['deployed','manual'].includes(i.deploy_status)).length;
  const planStatusInfo = PLAN_STATUS_INFO[plan.status] || PLAN_STATUS_INFO.draft;

  // Progress percent during run
  const runPct = running && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div className="dp-page">
      {showAdd && (
        <AddItemsModal orgId={orgId} planId={plan.id} existingItems={items}
          onClose={() => setShowAdd(false)} onAdded={handleAdded} />
      )}
      {showLogs && (
        <DeployLogsModal orgId={orgId} planId={plan.id} planName={plan.name}
          onClose={() => setShowLogs(false)} />
      )}

      {/* Header */}
      <button className="odp-back-btn" onClick={onBack}>← Back to Plans</button>
      <div className="dp-detail-header">
        <div className="dp-detail-title-row">
          {editingName ? (
            <input ref={nameInputRef} className="dp-name-input" value={nameVal}
              onChange={e => setNameVal(e.target.value)} onBlur={handleSaveName}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') { setNameVal(plan.name); setEditingName(false); } }}
              autoFocus />
          ) : (
            <h2 className="dp-detail-title" onClick={() => !running && plan.status === 'draft' && setEditingName(true)}>
              {plan.name}
              {plan.status === 'draft' && !running && <span className="dp-edit-icon" title="Edit name">✎</span>}
            </h2>
          )}
          <span className={planStatusInfo.cls}>{planStatusInfo.label}</span>
        </div>
        {plan.description && <p className="dp-detail-desc">{plan.description}</p>}

        {/* Stats row */}
        <div className="dp-stats-row">
          {[
            { label: 'Total',       val: totalItems,   color: 'var(--text-secondary)' },
            { label: 'Converted',   val: convertedCnt, color: '#23a55a' },
            { label: 'Deployed',    val: deployedCnt,  color: '#6366f1' },
            { label: 'Conv Failed', val: failedConv,   color: failedConv   > 0 ? '#ef4444' : 'var(--text-muted)' },
            { label: 'Dep Failed',  val: failedDeploy, color: failedDeploy > 0 ? '#ef4444' : 'var(--text-muted)' },
          ].map(({ label, val, color }) => (
            <div key={label} className="dp-stat-pill">
              <span className="dp-stat-pill-val" style={{ color }}>{val}</span>
              <span className="dp-stat-pill-label">{label}</span>
            </div>
          ))}
          {totalCost > 0 && (
            <div className="dp-stat-pill dp-stat-pill--cost">
              <span className="dp-stat-pill-val" style={{ color: '#f59e0b' }}>${totalCost.toFixed(4)}</span>
              <span className="dp-stat-pill-label">LLM Cost</span>
            </div>
          )}
        </div>
      </div>

      {/* Progress bar (during run) */}
      {running && (
        <div className="dp-run-progress">
          <div className="dp-run-progress-bar">
            <div className="dp-run-progress-fill" style={{ width: `${Math.max(runPct, 4)}%` }} />
          </div>
          <div className="dp-run-progress-label">
            <span className="odp-btn-spinner" style={{ width: 10, height: 10 }} />
            {runMode === 'convert_only' ? 'Converting' : runMode === 'deploy_only' ? 'Deploying' : 'Converting & Deploying'} — {progress.current}/{progress.total} items
            <button className="dp-item-btn dp-item-btn--danger" style={{ marginLeft: 12, padding: '2px 8px', fontSize: 11 }} onClick={() => handleRun(runMode)}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> Stop
            </button>
          </div>
        </div>
      )}

      {/* Run summary banner */}
      {runSummary && !running && (
        <div className="dp-run-summary" style={{
          background: runSummary.status === 'completed' ? 'rgba(35,165,94,.07)' : runSummary.status === 'partial' ? 'rgba(245,158,11,.07)' : 'rgba(239,68,68,.07)',
          border: `1px solid ${runSummary.status === 'completed' ? 'rgba(35,165,94,.3)' : runSummary.status === 'partial' ? 'rgba(245,158,11,.3)' : 'rgba(239,68,68,.3)'}`,
        }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>
            {runSummary.status === 'completed' ? '✓ Run complete' : runSummary.status === 'partial' ? '⚠ Partial success' : '✗ Run failed'}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 12 }}>
            {runSummary.stats?.converted > 0 && `${runSummary.stats.converted} converted `}
            {runSummary.stats?.deployed  > 0 && `· ${runSummary.stats.deployed} deployed `}
            {runSummary.stats?.manual    > 0 && `· ${runSummary.stats.manual} manual `}
            {(runSummary.stats?.failed_convert > 0 || runSummary.stats?.failed_deploy > 0) &&
              `· ${(runSummary.stats.failed_convert || 0) + (runSummary.stats.failed_deploy || 0)} failed `}
            {runSummary.totalCostUsd > 0 && `· $${runSummary.totalCostUsd.toFixed(4)} cost`}
          </span>
        </div>
      )}

      {error && <div className="ai-chat-error" style={{ margin: '0 0 12px' }}>⚠ {error}</div>}

      {/* Design note for "Validate" */}
      {items.length > 0 && !running && plan.status === 'draft' && convertedCnt === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '6px 12px', marginBottom: 8, background: 'var(--bg-secondary)', borderRadius: 6, lineHeight: 1.6 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle',marginRight:4}}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <strong>Tip:</strong> Use <em>Convert All</em> → review code → <em>Deploy All</em> for step-by-step control.
          Or use <em>Convert &amp; Deploy</em> for fully automated pipeline with auto-fix on failures (3 retries per item).
        </div>
      )}

      {/* Items list */}
      {loading ? (
        <div className="fm-empty"><span className="odp-overlay-spinner" style={{ width: 32, height: 32 }} /></div>
      ) : items.length === 0 ? (
        <div className="dp-empty-state">
          <div className="dp-empty-icon">📦</div>
          <div className="dp-empty-title">No items in this plan</div>
          <div className="dp-empty-sub">Add components from extracted metadata to begin migration</div>
          <button type="button" className="odp-save-config-btn" onClick={() => setShowAdd(true)}>+ Add Items</button>
        </div>
      ) : (
        <div className="dp-items-list">
          {/* Table header */}
          <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '2px 14px 6px', display: 'flex', justifyContent: 'space-between' }}>
            <span>{items.length} component{items.length !== 1 ? 's' : ''} — click row to expand logs &amp; code</span>
            <span>cost · tokens · model shown per row</span>
          </div>
          {items.map(item => (
            <LiveItemRow
              key={item.id}
              item={item}
              liveState={itemStates[item.id] || null}
              orgId={orgId}
              planId={plan.id}
              onRemove={handleRemoveItem}
              onConverted={handleItemConverted}
              running={running}
            />
          ))}

          {/* Cost summary footer */}
          {(() => {
            const totCost = items.reduce((s, it) => {
              const live = itemStates[it.id];
              return s + (live?.costUsd != null ? live.costUsd : (it.cost_usd || 0));
            }, 0);
            const totTokIn = items.reduce((s, it) => {
              const live = itemStates[it.id];
              return s + (live?.tokensIn != null ? live.tokensIn : (it.tokens_in || 0));
            }, 0);
            const totTokOut = items.reduce((s, it) => {
              const live = itemStates[it.id];
              return s + (live?.tokensOut != null ? live.tokensOut : (it.tokens_out || 0));
            }, 0);
            if (totTokIn === 0 && totTokOut === 0 && totCost === 0) return null;
            // Estimate cost from tokens if not stored (Claude Sonnet 4.6: $3/$15 per 1M)
            const totEstCost = totCost === 0 && (totTokIn > 0 || totTokOut > 0)
              ? Math.round((totTokIn * 3 + totTokOut * 15) / 1_000_000 * 1_000_000) / 1_000_000
              : 0;
            const displayTotCost = totCost > 0 ? totCost : totEstCost;
            return (
              <div className="dp-cost-summary">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{opacity:.6}}>
                  <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
                </svg>
                <span className="dp-cost-summary-label">Total LLM cost</span>
                {displayTotCost > 0 ? (
                  <span className="dp-cost-summary-value" title={totCost === 0 ? 'Estimated based on Claude Sonnet 4.6 pricing' : ''}>
                    {totCost === 0 ? '~' : ''}${displayTotCost.toFixed(4)}
                  </span>
                ) : (
                  <span className="dp-cost-summary-value" style={{opacity:.4}}>—</span>
                )}
                {(totTokIn > 0 || totTokOut > 0) && (
                  <span className="dp-cost-summary-tokens">
                    <strong style={{color:'var(--text-secondary)'}}>{totTokIn.toLocaleString()}</strong> in
                    {' / '}
                    <strong style={{color:'var(--text-secondary)'}}>{totTokOut.toLocaleString()}</strong> out tokens
                    {' · '}
                    <strong style={{color:'var(--text-secondary)'}}>{((totTokIn + totTokOut)/1000).toFixed(1)}k</strong> total
                  </span>
                )}
                {totCost === 0 && totEstCost > 0 && (
                  <span style={{fontSize:9, color:'var(--text-muted)', opacity:.7}}>
                    (estimated · re-convert for exact)
                  </span>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Sticky Action Bar */}
      {items.length > 0 && (
        <div className="dp-action-bar">
          {/* Info row */}
          <div className="dp-action-bar-info">
            <span className="dp-abar-count">{totalItems} items</span>
            {convertedCnt > 0 && <span className="dp-abar-chip dp-abar-chip--green">{convertedCnt} converted</span>}
            {deployedCnt  > 0 && <span className="dp-abar-chip dp-abar-chip--indigo">{deployedCnt} deployed</span>}
            {pendingCnt   > 0 && <span className="dp-abar-chip dp-abar-chip--gray">{pendingCnt} pending</span>}
            {readyDeploy  > 0 && <span className="dp-abar-chip dp-abar-chip--amber">{readyDeploy} ready</span>}
          </div>

          {/* Buttons row */}
          <div className="dp-action-bar-btns">
            {/* ── Utility group ── */}
            <div className="dp-btn-group">
              <button type="button" className="dp-bar-btn dp-bar-btn--danger dp-bar-btn--icon" onClick={handleDelete} disabled={running} title="Delete this plan">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                </svg>
                <span className="dp-btn-label">Delete</span>
              </button>
              {!running && plan.status !== 'deploying' && (
                <button type="button" className="dp-bar-btn dp-bar-btn--icon" onClick={() => setShowAdd(true)} title="Add components to this plan">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
                  </svg>
                  <span className="dp-btn-label">Add</span>
                </button>
              )}
              <button type="button" className="dp-bar-btn dp-bar-btn--icon" onClick={() => setShowLogs(true)} title="View deployment history">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
                <span className="dp-btn-label">History</span>
              </button>
            </div>

            {/* ── Divider ── */}
            <div className="dp-btn-divider" />

            {/* ── Execution group ── */}
            <div className="dp-btn-group">
              <button
                type="button"
                className={`dp-bar-btn${runMode === 'convert_only' ? ' dp-bar-btn--running' : ''}`}
                onClick={() => handleRun('convert_only')}
                disabled={running && runMode !== 'convert_only'}
                title="Convert all pending items using LLM (no deploy)"
              >
                {running && runMode === 'convert_only' ? (
                  <><span className="odp-btn-spinner" />Stop</>
                ) : (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                    </svg>
                    Convert All{pendingCnt > 0 ? ` (${pendingCnt})` : ''}
                  </>
                )}
              </button>

              <button
                type="button"
                className={`dp-bar-btn dp-bar-btn--deploy${runMode === 'deploy_only' ? ' dp-bar-btn--running' : ''}`}
                onClick={() => handleRun('deploy_only')}
                disabled={(running && runMode !== 'deploy_only') || readyDeploy === 0}
                title="Deploy all converted items to Dynamics 365"
              >
                {running && runMode === 'deploy_only' ? (
                  <><span className="odp-btn-spinner" />Stop</>
                ) : (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4 20-7z"/>
                    </svg>
                    Deploy All{readyDeploy > 0 ? ` (${readyDeploy})` : ''}
                  </>
                )}
              </button>

              <button
                type="button"
                className={`dp-bar-btn dp-bar-btn--primary${runMode === 'convert_and_deploy' ? ' dp-bar-btn--running' : ''}`}
                onClick={() => handleRun('convert_and_deploy')}
                disabled={running && runMode !== 'convert_and_deploy'}
                title="Convert pending items then deploy. Auto-fix on failures (3 retries)."
              >
                {running && runMode === 'convert_and_deploy' ? (
                  <><span className="odp-btn-spinner" />Stop</>
                ) : (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 3l14 9-14 9V3z"/>
                    </svg>
                    Convert &amp; Deploy
                  </>
                )}
              </button>

              <button
                type="button"
                className="dp-bar-btn dp-bar-btn--reconvert"
                onClick={() => handleRun('convert_and_deploy', true)}
                disabled={running}
                title="Force re-convert ALL items then deploy. Refreshes cost/token data."
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
                <span className="dp-btn-label">Re-convert</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Main DeploymentPlanPage ─────────────────────────────────────────── */
export default function DeploymentPlanPage({ orgId, orgName, onBack }) {
  const [view,         setView]         = useState('list');
  const [plans,        setPlans]        = useState([]);
  const [stats,        setStats]        = useState({ total: 0, completed: 0, draft: 0, failed: 0 });
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [showCreate,   setShowCreate]   = useState(false);
  const [error,        setError]        = useState('');

  const loadPlans = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch(`${API}/shift/connections/${orgId}/plans`);
      if (r.ok) {
        const d = await r.json();
        setPlans(d.plans || []);
        setStats(d.stats || {});
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [orgId]);

  useEffect(() => { loadPlans(); }, [loadPlans]);

  const handleCreated = (plan) => {
    setShowCreate(false);
    setPlans(p => [plan, ...p]);
    setStats(s => ({ ...s, total: s.total + 1, draft: s.draft + 1 }));
    setSelectedPlan(plan);
    setView('detail');
  };

  const handleOpenPlan  = (plan) => { setSelectedPlan(plan); setView('detail'); };
  const handleBackToList = ()   => { setView('list'); setSelectedPlan(null); loadPlans(); };

  if (view === 'detail' && selectedPlan) {
    return (
      <PlanDetail
        orgId={orgId}
        plan={selectedPlan}
        onBack={handleBackToList}
        onPlanUpdated={loadPlans}
      />
    );
  }

  // ── List View ──
  return (
    <div className="dp-page">
      {showCreate && (
        <CreatePlanModal orgId={orgId} onClose={() => setShowCreate(false)} onCreated={handleCreated} />
      )}

      <button className="odp-back-btn" onClick={onBack}>← Back to Org</button>
      <div className="dp-list-header">
        <div>
          <h2 className="dp-list-title">🚀 Deployment Plans</h2>
          <p className="dp-list-sub">Create, manage, and execute deployment plans for <strong>{orgName}</strong></p>
        </div>
        <button type="button" className="dp-new-btn" onClick={() => setShowCreate(true)}>+ New Plan</button>
      </div>

      <div className="dp-stat-grid">
        {[
          { label: 'Total',     value: stats.total,     cls: '',               icon: '◈' },
          { label: 'Completed', value: stats.completed, cls: 'dp-stat--green', icon: '✓' },
          { label: 'Draft',     value: stats.draft,     cls: 'dp-stat--blue',  icon: '◎' },
          { label: 'Failed',    value: stats.failed,    cls: 'dp-stat--red',   icon: '✗' },
        ].map(({ label, value, cls, icon }) => (
          <div key={label} className={`dp-stat-card ${cls}`}>
            <div className="dp-stat-label">{label}</div>
            <div className="dp-stat-value">{value}</div>
            <span className="dp-stat-icon">{icon}</span>
          </div>
        ))}
      </div>

      {error && <div className="ai-chat-error">⚠ {error}</div>}

      {loading ? (
        <div className="fm-empty"><span className="odp-overlay-spinner" style={{ width: 32, height: 32 }} /></div>
      ) : plans.length === 0 ? (
        <div className="dp-empty-state">
          <div className="dp-empty-icon">🚀</div>
          <div className="dp-empty-title">No deployment plans yet</div>
          <div className="dp-empty-sub">Create a plan to organize and deploy your migration components</div>
          <button type="button" className="odp-save-config-btn" onClick={() => setShowCreate(true)}>+ Create First Plan</button>
        </div>
      ) : (
        <div className="dp-plan-list">
          {plans.map(plan => {
            const si  = PLAN_STATUS_INFO[plan.status] || PLAN_STATUS_INFO.draft;
            const pct = plan.total_items > 0 ? Math.round((plan.converted_count / plan.total_items) * 100) : 0;
            return (
              <div key={plan.id} className={`dp-plan-card dp-plan-card--${plan.status || 'draft'}`} onClick={() => handleOpenPlan(plan)}>
                <div className="dp-plan-card-row">
                  <div className="dp-plan-card-left">
                    <div className="dp-plan-card-title">{plan.name}</div>
                    {plan.description && <div className="dp-plan-card-desc">{plan.description}</div>}
                    <div className="dp-plan-card-meta">
                      <span>{plan.total_items} items</span>
                      {plan.converted_count > 0 && <span> · {plan.converted_count} converted</span>}
                      {plan.failed_count    > 0 && <span className="dp-plan-card-meta--fail"> · {plan.failed_count} failed</span>}
                      <span> · {formatDate(plan.created_at)}</span>
                    </div>
                  </div>
                  <div className="dp-plan-card-right">
                    <span className={si.cls}>{si.label}</span>
                    <span className="dp-plan-card-arrow">›</span>
                  </div>
                </div>
                {plan.total_items > 0 && (
                  <div className="dp-plan-progress">
                    <div className="dp-plan-progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

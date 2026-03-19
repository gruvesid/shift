import React, { useState, useEffect, useCallback, useRef } from 'react';
const API = process.env.REACT_APP_API_URL || 'http://localhost:8000';

/* ================================================================
   Reusable search-dropdown component
   ================================================================ */
const SearchDropdown = ({ items, value, onChange, placeholder, disabled, renderItem, labelKey = 'label', valueKey = 'value' }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = (items || []).filter((it) => {
    const label = typeof it === 'string' ? it : (it[labelKey] || '');
    return label.toLowerCase().includes(query.toLowerCase());
  });

  const selectedLabel = (() => {
    if (!value) return '';
    const found = (items || []).find((it) => (typeof it === 'string' ? it : it[valueKey]) === value);
    if (found) return typeof found === 'string' ? found : found[labelKey];
    return value;
  })();

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      <input
        className="form-input"
        style={{ padding: '7px 10px', fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer' }}
        value={open ? query : selectedLabel}
        placeholder={placeholder || 'Search…'}
        disabled={disabled}
        onFocus={() => { if (!disabled) { setOpen(true); setQuery(''); } }}
        onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); }}
      />
      {open && !disabled && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', maxHeight: 220, overflowY: 'auto',
          boxShadow: '0 8px 24px rgba(0,0,0,0.15)', marginTop: 4,
        }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
              No results for "{query}"
            </div>
          ) : filtered.slice(0, 100).map((it, idx) => {
            const val = typeof it === 'string' ? it : it[valueKey];
            const label = typeof it === 'string' ? it : it[labelKey];
            const isSelected = val === value;
            return (
              <div
                key={val || idx}
                onClick={() => { onChange(val, it); setOpen(false); setQuery(''); }}
                style={{
                  padding: '8px 14px', cursor: 'pointer', fontSize: 13,
                  background: isSelected ? 'rgba(35,165,94,0.08)' : 'transparent',
                  color: isSelected ? 'var(--accent-primary)' : 'var(--text-primary)',
                  borderBottom: '1px solid var(--border)',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-card-hover)'}
                onMouseLeave={(e) => e.currentTarget.style.background = isSelected ? 'rgba(35,165,94,0.08)' : 'transparent'}
              >
                {renderItem ? renderItem(it) : label}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/* ================================================================
   MappingTab
   ================================================================ */
const MappingTab = ({ selectedObjects, onConfirm, onUnconfirm, isConfirmed: wizardConfirmed }) => {
  const [mappings, setMappings] = useState({});
  const [confirmed, setConfirmed] = useState({});
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState({});

  // Dataverse entities & fields (fetched lazily)
  const [dvEntities, setDvEntities] = useState(null); // null = not loaded, [] = loaded empty
  const [dvFields, setDvFields] = useState({});        // { entityLogicalName: [...] }
  const [dvLoading, setDvLoading] = useState(false);
  const [dvError, setDvError] = useState(null);
  const [fieldSearchQuery, setFieldSearchQuery] = useState({});  // per-object search

  // Sync state (batched Sync Now — mirrors ObjectsTab pattern)
  const [syncState, setSyncState] = useState('idle'); // 'idle' | 'pending' | 'syncing' | 'synced' | 'error'
  const [syncMsg, setSyncMsg] = useState(null);

  // Per-object save result (populated during sync, not on confirm)
  const [saving, setSaving] = useState({});
  const [saveResult, setSaveResult] = useState({});

  useEffect(() => {
    if (selectedObjects.length === 0) return;
    setExpanded(selectedObjects[0]);
    setConfirmed({});
    selectedObjects.forEach((obj) => {
      if (!mappings[obj]) fetchSuggestions(obj);
    });
  }, [selectedObjects]); // eslint-disable-line

  // ── Fetch Dataverse entities ──
  const fetchDvEntities = useCallback(async (force = false) => {
    if (dvEntities !== null && !force) return; // already loaded (skip unless forced)
    setDvLoading(true);
    setDvError(null);
    setDvEntities(null); // reset so we show loading state
    try {
      const res = await fetch(`${API}/dataverse/entities`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to load Dataverse entities');
      }
      const data = await res.json();
      setDvEntities(data);
    } catch (e) {
      setDvError(e.message);
      setDvEntities([]); // mark as attempted
    } finally {
      setDvLoading(false);
    }
  }, [dvEntities]);

  // Trigger entity fetch on first expand
  useEffect(() => {
    if (expanded) fetchDvEntities();
  }, [expanded, fetchDvEntities]);

  // ── Fetch fields for a specific Dataverse entity ──
  const fetchDvFields = useCallback(async (logicalName) => {
    if (dvFields[logicalName]) return;
    try {
      const res = await fetch(`${API}/dataverse/entities/${encodeURIComponent(logicalName)}/fields`);
      if (!res.ok) return;
      const data = await res.json();
      setDvFields((p) => ({ ...p, [logicalName]: data }));
    } catch (_) { }
  }, [dvFields]);

  const fetchSuggestions = useCallback(async (obj) => {
    setLoading((p) => ({ ...p, [obj]: true }));
    try {
      // Fetch Lakehouse confirmed mappings and live SF columns in parallel
      const [suggestRes, sfRes] = await Promise.allSettled([
        fetch(`${API}/field-suggestions/${encodeURIComponent(obj)}`),
        fetch(`${API}/salesforce/objects/${encodeURIComponent(obj)}/fields`),
      ]);

      // Lakehouse suggestions — fatal if it fails
      if (suggestRes.status === 'rejected' || !suggestRes.value.ok) {
        const err = suggestRes.status === 'fulfilled'
          ? await suggestRes.value.json().catch(() => ({}))
          : {};
        const msg = typeof err.detail === 'string' ? err.detail : 'Failed to load mapping';
        setMappings((p) => ({ ...p, [obj]: { fields: [], no_mapping: false, fetchError: msg } }));
        return;
      }
      const suggestData = await suggestRes.value.json();

      // SF columns from Salesforce API — non-fatal (fall back to Lakehouse suggestions)
      let sfFields = [];
      if (sfRes.status === 'fulfilled' && sfRes.value.ok) {
        sfFields = await sfRes.value.json();
      }

      // Build a fast-lookup map from the Lakehouse confirmed/suggested mappings
      const suggestedMap = {};
      for (const f of (suggestData.fields || [])) {
        suggestedMap[f.sf_api] = f;
      }

      let mergedFields;
      if (sfFields.length > 0) {
        // Salesforce is the source of truth for which columns exist;
        // overlay with any existing confirmed D365 mappings from the Lakehouse.
        mergedFields = sfFields.map((sf) => {
          const existing = suggestedMap[sf.sf_api] || {};
          return {
            sf_label: sf.sf_label || sf.sf_api,
            sf_api: sf.sf_api,
            sf_type: sf.sf_type || '',
            d365_name: existing.edited_d365_name || existing.d365_name || '',
            d365_api: existing.edited_d365_api || existing.d365_api || '',
            d365_type: existing.d365_type || '',
            edited_d365_name: existing.edited_d365_name || existing.d365_name || '',
            edited_d365_api: existing.edited_d365_api || existing.d365_api || '',
          };
        });
      } else {
        // No live SF data — fall back to whatever the Lakehouse has
        mergedFields = (suggestData.fields || []).map((r) => ({
          ...r,
          edited_d365_name: r.edited_d365_name || r.d365_name || '',
          edited_d365_api: r.edited_d365_api || r.d365_api || '',
        }));
      }

      setMappings((p) => ({
        ...p,
        [obj]: {
          fields: mergedFields,
          no_mapping: !suggestData.dynamics_object,
          dynamics_object: typeof suggestData.dynamics_object === 'string' ? suggestData.dynamics_object : null,
          publisher_prefix: typeof suggestData.publisher_prefix === 'string' ? suggestData.publisher_prefix : 'new_',
          selected_entity: typeof suggestData.dynamics_object === 'string' ? suggestData.dynamics_object : '',
          create_new_table: false,
          sfFieldCount: sfFields.length,  // track whether live SF data was loaded
        },
      }));

      if (suggestData.dynamics_object) fetchDvFields(suggestData.dynamics_object);
    } catch (_) {
      setMappings((p) => ({ ...p, [obj]: { fields: [], no_mapping: false, fetchError: 'Cannot reach backend' } }));
    } finally {
      setLoading((p) => ({ ...p, [obj]: false }));
    }
  }, [fetchDvFields]);

  const handleEdit = (obj, idx, field, value) => {
    setMappings((prev) => {
      const rows = [...(prev[obj]?.fields || [])];
      rows[idx] = { ...rows[idx], [field]: value };
      return { ...prev, [obj]: { ...prev[obj], fields: rows } };
    });
  };

  const addFieldRow = (obj) => {
    setMappings((prev) => {
      const rows = [...(prev[obj]?.fields || [])];
      rows.push({
        sf_label: '', sf_api: '', sf_type: '',
        d365_name: '', d365_api: '', d365_type: '',
        edited_d365_name: '', edited_d365_api: '',
      });
      return { ...prev, [obj]: { ...prev[obj], fields: rows } };
    });
  };

  const removeFieldRow = (obj, idx) => {
    setMappings((prev) => {
      const rows = [...(prev[obj]?.fields || [])];
      rows.splice(idx, 1);
      return { ...prev, [obj]: { ...prev[obj], fields: rows } };
    });
  };

  const handleEntityChange = (obj, entityLogicalName) => {
    setMappings((prev) => ({
      ...prev,
      [obj]: {
        ...prev[obj],
        selected_entity: entityLogicalName,
        dynamics_object: entityLogicalName,
        create_new_table: false,
        no_mapping: false,
      },
    }));
    if (entityLogicalName) fetchDvFields(entityLogicalName);
  };

  const handleCreateNewTable = (obj) => {
    setMappings((prev) => ({
      ...prev,
      [obj]: {
        ...prev[obj],
        create_new_table: true,
        selected_entity: '',
        no_mapping: true,
      },
    }));
  };

  const handleFieldDropdownChange = (obj, idx, fieldLogicalName, fieldObj) => {
    setMappings((prev) => {
      const rows = [...(prev[obj]?.fields || [])];
      rows[idx] = {
        ...rows[idx],
        edited_d365_name: fieldObj?.display_name || fieldLogicalName,
        edited_d365_api: fieldLogicalName,
        d365_type: fieldObj?.attribute_type || rows[idx].d365_type,
      };
      return { ...prev, [obj]: { ...prev[obj], fields: rows } };
    });
  };

  const toggleConfirm = (obj) => {
    const nowConfirmed = !confirmed[obj];
    setConfirmed((p) => ({ ...p, [obj]: nowConfirmed }));
    // Mark that there are unsaved local changes
    setSyncState('pending');
    setSyncMsg(null);
    if (nowConfirmed) {
      const nextIdx = selectedObjects.indexOf(obj) + 1;
      setExpanded(nextIdx < selectedObjects.length ? selectedObjects[nextIdx] : null);
    }
  };

  // ── Sync Now: push ALL confirmed mappings in ONE bulk request ──
  const syncAllMappings = async () => {
    const confirmedObjects = selectedObjects.filter((o) => confirmed[o]);
    if (confirmedObjects.length === 0) return;

    setSyncState('syncing');
    setSyncMsg(null);
    setSaveResult({});
    setSaving(confirmedObjects.reduce((acc, o) => ({ ...acc, [o]: true }), {}));

    const payload = confirmedObjects.map((obj) => {
      const info = mappings[obj] || {};

      // Filter out fields that have no mapping configured on the D365 side
      const filteredFields = (info.fields || []).filter(
        (row) => row.edited_d365_api && row.edited_d365_api.trim() !== ''
      );

      return {
        sf_object: obj,
        d365_entity: info.selected_entity || info.dynamics_object || obj,
        fields: filteredFields,
      };
    });

    try {
      const res = await fetch(`${API}/mapping/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      // Mark each object with per-UID feedback
      const perObj = {};
      confirmedObjects.forEach((obj) => {
        const uid = data.uids?.[obj];
        perObj[obj] = { ok: true, msg: `✅ Saved${uid ? ` (UID: ${uid.slice(0, 8)}…)` : ''}` };
      });
      setSaveResult(perObj);
      setSyncState('synced');
      setSyncMsg(`✅ ${data.objects_saved} object${data.objects_saved !== 1 ? 's' : ''}, ${data.total_fields_saved} fields pushed to Lakehouse`);
    } catch (e) {
      setSyncState('error');
      setSyncMsg(`❌ ${e.message}`);
    } finally {
      setSaving({});
    }
  };

  const confirmedCount = selectedObjects.filter((o) => confirmed[o]).length;
  const allConfirmed = selectedObjects.length > 0 && confirmedCount === selectedObjects.length;

  const isCustomObject = (name) => name.endsWith('__c') || name.endsWith('__C');

  if (selectedObjects.length === 0) {
    return (
      <div>
        <div className="section-header">
          <div className="section-title">Field Mapping</div>
          <div className="section-desc">Select objects first to configure field mappings.</div>
        </div>
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">🗺️</div>
            No objects selected. Go to the <strong>Objects</strong> tab first.
          </div>
        </div>
      </div>
    );
  }

  // Build entity dropdown items
  const entityDropdownItems = (dvEntities || []).map((e) => ({
    label: `${e.display_name} (${e.logical_name})`,
    value: e.logical_name,
    display_name: e.display_name,
    is_custom: e.is_custom,
  }));

  return (
    <div>
      <div className="section-header">
        <div className="section-title">Field Mapping</div>
        <div className="section-desc">
          Pre-filled from <code style={{ fontSize: 12, color: 'var(--accent-primary)', background: 'rgba(35,165,94,0.08)', padding: '2px 6px', borderRadius: 4 }}>raw.field_mapping</code>
          {' '}Review, search, and map before confirming.
          {allConfirmed ? (
            <span className="chip chip-green">✓ All objects confirmed</span>
          ) : (
            <span className="chip chip-blue">{confirmedCount}/{selectedObjects.length} confirmed</span>
          )}
          {dvError && (
            <span className="chip chip-yellow" title={dvError}>⚠️ Dataverse unavailable</span>
          )}
        </div>
      </div>

      {/* ── Sync Now bar ── */}
      <div style={{
        marginBottom: 16,
        padding: '14px 20px',
        background: syncState === 'pending' || syncState === 'syncing'
          ? 'rgba(35,165,94,0.06)'
          : syncState === 'error'
            ? 'rgba(220,38,38,0.04)'
            : 'var(--bg-card)',
        border: `1.5px solid ${syncState === 'pending' || syncState === 'syncing' ? 'var(--accent-primary)'
          : syncState === 'error' ? 'rgba(220,38,38,0.35)'
            : 'var(--border)'}`,
        borderRadius: 'var(--radius-md)',
        display: 'flex', alignItems: 'center', gap: 16,
        transition: 'all 0.2s',
        position: 'sticky', top: 60, zIndex: 10,
        backdropFilter: 'blur(8px)',
        flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', marginBottom: 2 }}>
            {syncState === 'pending' && '📤 Confirmed mappings not yet pushed'}
            {syncState === 'syncing' && '⏳ Syncing with Lakehouse…'}
            {syncState === 'synced' && '✅ Synced to Lakehouse'}
            {syncState === 'error' && '⚠️ Sync completed with errors'}
            {syncState === 'idle' && '✅ Mappings synced'}
          </div>
          <div style={{ fontSize: 12, color: syncState === 'error' ? 'var(--danger)' : 'var(--text-muted)' }}>
            {syncState === 'pending' && `Confirm objects below, then click "Sync Now" to push all mappings to Lakehouse.`}
            {syncState === 'syncing' && 'Uploading all confirmed field mappings to Fabric Lakehouse…'}
            {syncState === 'synced' && (syncMsg || 'All confirmed field mappings are live in the Fabric Lakehouse.')}
            {syncState === 'error' && (syncMsg || 'Some mappings failed — check per-object feedback below.')}
            {syncState === 'idle' && `Confirm ${selectedObjects.length} object mapping${selectedObjects.length !== 1 ? 's' : ''} below, then click "Sync Now".`}
          </div>
        </div>
        <button
          className="btn btn-secondary"
          onClick={syncAllMappings}
          disabled={syncState === 'syncing' || confirmedCount === 0}
          style={{ flexShrink: 0, fontSize: 13 }}
          title="Push all confirmed mappings to Lakehouse"
        >
          {syncState === 'syncing' ? '⏳ Syncing…' : '↑ Sync Now'}
        </button>
      </div>

      {selectedObjects.map((obj, objIdx) => {
        const info = mappings[obj] || {};
        const rows = info.fields || [];
        const noMapping = info.no_mapping;
        const createNew = info.create_new_table;
        const selectedEntity = info.selected_entity || info.dynamics_object || '';
        const prefix = info.publisher_prefix || 'new_';
        const isOpen = expanded === obj;
        const isLoading = loading[obj];
        const isConfirmed = !!confirmed[obj];
        const fetchError = info.fetchError;
        const isCustom = isCustomObject(obj);
        const fq = fieldSearchQuery[obj] || '';
        const sfFieldCount = info.sfFieldCount || 0;
        const mappedCount = rows.filter(r => r.edited_d365_api && r.edited_d365_api.trim() !== '').length;

        // Get fields for the currently selected D365 entity
        const entityFields = selectedEntity ? (dvFields[selectedEntity] || []) : [];
        const fieldDropdownItems = entityFields.map((f) => ({
          label: `${f.display_name} (${f.logical_name}) — ${f.attribute_type}`,
          value: f.logical_name,
          display_name: f.display_name,
          attribute_type: f.attribute_type,
        }));

        // Filter rows by field search
        const filteredRows = fq
          ? rows.filter((r) =>
            (r.sf_label || '').toLowerCase().includes(fq.toLowerCase()) ||
            (r.sf_api || '').toLowerCase().includes(fq.toLowerCase()) ||
            (r.edited_d365_name || '').toLowerCase().includes(fq.toLowerCase()) ||
            (r.edited_d365_api || '').toLowerCase().includes(fq.toLowerCase())
          )
          : [...rows];

        // Sort so mapped fields appear first
        filteredRows.sort((a, b) => {
          const aMapped = a.edited_d365_api && a.edited_d365_api.trim() !== '';
          const bMapped = b.edited_d365_api && b.edited_d365_api.trim() !== '';
          if (aMapped === bMapped) return 0;
          return aMapped ? -1 : 1;
        });

        return (
          <div key={obj} className={`mapping-card${isConfirmed ? ' confirmed-card' : ''}`}>

            {/* ── Card Header (always visible) ── */}
            <div className="mapping-card-header" onClick={() => setExpanded(isOpen ? null : obj)}>
              <span style={{
                width: 28, height: 28, borderRadius: 7, flexShrink: 0,
                background: isConfirmed ? 'rgba(35,165,94,0.15)' : noMapping ? 'rgba(251,191,36,0.12)' : 'rgba(35,165,94,0.08)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
              }}>
                {isConfirmed ? '✅' : noMapping ? '⚠️' : '📦'}
              </span>

              <div className="mapping-card-title">
                {obj}
                {selectedEntity && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>
                    → {selectedEntity}
                  </span>
                )}
                {isCustom && <span className="chip chip-yellow" style={{ fontSize: 10 }}>Custom</span>}
                {!isLoading && (
                  <span className="chip chip-blue" style={{ fontSize: 10 }}>
                    {noMapping && !createNew
                      ? 'No mapping'
                      : sfFieldCount > 0
                        ? `${mappedCount}/${rows.length} mapped`
                        : `${rows.length} fields`}
                  </span>
                )}
              </div>

              <span className={`chip ${isConfirmed ? 'chip-green' : 'chip-yellow'}`}>
                {isConfirmed ? '✓ Confirmed' : '⏳ Pending'}
              </span>

              <span className={`accordion-chevron${isOpen ? ' open' : ''}`}>▼</span>
            </div>

            {/* ── Accordion Body (collapsible) ── */}
            <div className={`mapping-card-body${isOpen ? ' expanded' : ''}`}>

              {isLoading ? (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  ⏳ Querying <code>raw.object_mapping</code> + <code>raw.field_mapping</code>…
                </div>

              ) : fetchError ? (
                <div style={{
                  margin: 20, padding: '14px 18px',
                  background: 'var(--danger-bg, rgba(220,38,38,0.06))',
                  border: '1px solid rgba(220,38,38,0.3)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--danger, #dc2626)', fontSize: 13,
                }}>
                  ❌ {fetchError}
                  <button
                    onClick={(e) => { e.stopPropagation(); fetchSuggestions(obj); }}
                    style={{
                      marginLeft: 12, fontSize: 12, padding: '2px 10px', cursor: 'pointer',
                      background: 'none', border: '1px solid currentColor', borderRadius: 4, color: 'inherit'
                    }}
                  >Retry</button>
                </div>

              ) : (
                <>
                  {/* ── D365 Entity selector ── */}
                  <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-muted)', marginBottom: 8 }}>
                      Target Dynamics 365 Entity
                    </div>

                    {isCustom && !createNew && (
                      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                        <button
                          className={`btn btn-sm ${!createNew ? 'btn-primary' : 'btn-secondary'}`}
                          onClick={(e) => { e.stopPropagation(); }}
                          disabled={isConfirmed}
                          style={{ fontSize: 12 }}
                        >
                          Map to existing entity
                        </button>
                        <button
                          className={`btn btn-sm ${createNew ? 'btn-primary' : 'btn-secondary'}`}
                          onClick={(e) => { e.stopPropagation(); handleCreateNewTable(obj); }}
                          disabled={isConfirmed}
                          style={{ fontSize: 12 }}
                        >
                          ➕ Create new custom table
                        </button>
                      </div>
                    )}

                    {/* Deselect button — shown when an entity is chosen and not yet confirmed */}
                    {selectedEntity && !isConfirmed && !createNew && (
                      <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'flex-end' }}>
                        <button
                          className="btn btn-sm btn-secondary"
                          style={{ fontSize: 11, color: 'var(--danger)', borderColor: 'rgba(220,38,38,0.35)' }}
                          onClick={(e) => { e.stopPropagation(); handleEntityChange(obj, ''); }}
                          title="Clear target entity selection"
                        >
                          ✕ Deselect Entity
                        </button>
                      </div>
                    )}

                    {isCustom && createNew ? (
                      <div style={{
                        padding: '12px 16px',
                        background: 'rgba(251,191,36,0.08)',
                        border: '1px solid rgba(251,191,36,0.3)',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 13, color: 'var(--warning)',
                      }}>
                        ⚠️ A new custom entity <strong>{prefix}{obj.replace('__c', '').replace('__C', '')}</strong> will be created.
                        All fields will use the <code style={{ background: 'rgba(251,191,36,0.12)', padding: '1px 5px', borderRadius: 3 }}>{prefix}</code> prefix.
                        <button
                          className="btn btn-sm btn-secondary"
                          style={{ marginLeft: 12, fontSize: 11 }}
                          onClick={(e) => { e.stopPropagation(); handleEntityChange(obj, ''); }}
                          disabled={isConfirmed}
                        >
                          ← Map to existing instead
                        </button>
                      </div>
                    ) : (
                      <div onClick={(e) => e.stopPropagation()}>
                        {dvLoading ? (
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>⏳ Loading Dataverse entities…</div>
                        ) : dvError ? (
                          <div style={{
                            padding: '10px 14px',
                            background: 'rgba(220,38,38,0.05)',
                            border: '1px solid rgba(220,38,38,0.25)',
                            borderRadius: 'var(--radius-sm)',
                            fontSize: 13,
                          }}>
                            <div style={{ color: 'var(--danger)', fontWeight: 600, marginBottom: 4 }}>
                              ⚠️ Could not load Dataverse entities
                            </div>
                            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
                              {dvError}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                              Check your Dynamics 365 connection in the <strong>Connections</strong> tab, then retry.
                            </div>
                            <button
                              className="btn btn-sm btn-secondary"
                              style={{ fontSize: 12 }}
                              onClick={(e) => { e.stopPropagation(); fetchDvEntities(true); }}
                            >
                              ↺ Retry
                            </button>
                          </div>
                        ) : (
                          <>
                            <SearchDropdown
                              items={entityDropdownItems}
                              value={selectedEntity}
                              onChange={(val) => handleEntityChange(obj, val)}
                              placeholder="🔍 Search Dataverse entities…"
                              disabled={isConfirmed}
                              labelKey="label"
                              valueKey="value"
                              renderItem={(it) => (
                                <div>
                                  <div style={{ fontWeight: 500 }}>{it.display_name}</div>
                                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                                    {it.value} {it.is_custom && '(custom)'}
                                  </div>
                                </div>
                              )}
                            />
                            {!selectedEntity && (
                              <div style={{
                                marginTop: 8,
                                padding: '10px 14px',
                                background: 'rgba(59,130,246,0.06)',
                                border: '1px solid rgba(59,130,246,0.2)',
                                borderRadius: 'var(--radius-sm)',
                                fontSize: 12, color: 'var(--text-muted)',
                              }}>
                                ℹ️ No entity selected — a new table and all its columns will be created automatically during the schema pipeline.
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {/* ── Field search ── */}
                  {rows.length > 0 && (
                    <div style={{ padding: '8px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 14 }}>🔍</span>
                      <input
                        className="search-input"
                        style={{ flex: 1, padding: '6px 12px', fontSize: 13 }}
                        placeholder="Search fields…"
                        value={fq}
                        onChange={(e) => setFieldSearchQuery(p => ({ ...p, [obj]: e.target.value }))}
                        onClick={(e) => e.stopPropagation()}
                      />
                      {fq && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {filteredRows.length} of {rows.length}
                        </span>
                      )}
                    </div>
                  )}

                  {/* ── Field mapping rows — shown for all objects ── */}
                  {rows.length === 0 ? (
                    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                      {createNew
                        ? 'Add fields below to define what data will be migrated.'
                        : 'No field mappings found. Select a D365 entity above or add fields manually.'}
                    </div>
                  ) : (
                    <>
                      {/* Sticky column header */}
                      <div className="mapping-field-header" style={{ gridTemplateColumns: '1fr 28px 1fr auto 28px' }}>
                        <span>Salesforce Field</span>
                        <span />
                        <span>Dynamics 365 Field</span>
                        <span>Data Types</span>
                        <span />
                      </div>

                      {/* ── Scrollable rows ── */}
                      <div className="mapping-fields-scroll">
                        {filteredRows.map((row) => {
                          const realIdx = rows.indexOf(row);
                          // In createNew mode or when no entity fields are loaded, use manual text inputs
                          const useManualInput = createNew || fieldDropdownItems.length === 0;
                          return (
                            <div className="mapping-field-row" key={realIdx} style={{ gridTemplateColumns: '1fr 28px 1fr auto 28px' }}>
                              {/* SF field — editable for manually-added rows (empty sf_api) */}
                              <div className="sf-field-col" onClick={(e) => e.stopPropagation()}>
                                {row.sf_api ? (
                                  <>
                                    <span className="sf-field-name">{row.sf_label || row.sf_api}</span>
                                    <span className="sf-field-meta">{row.sf_api}{row.sf_type ? ` · ${row.sf_type}` : ''}</span>
                                  </>
                                ) : (
                                  <>
                                    <input
                                      className="form-input"
                                      style={{ padding: '7px 10px', fontSize: 13, marginBottom: 4 }}
                                      placeholder="SF display name"
                                      value={row.sf_label}
                                      onChange={(e) => handleEdit(obj, realIdx, 'sf_label', e.target.value)}
                                      disabled={isConfirmed}
                                    />
                                    <input
                                      className="form-input"
                                      style={{ padding: '5px 10px', fontSize: 11, fontFamily: 'monospace', opacity: 0.8 }}
                                      placeholder="SF API name"
                                      value={row.sf_api}
                                      onChange={(e) => handleEdit(obj, realIdx, 'sf_api', e.target.value)}
                                      disabled={isConfirmed}
                                    />
                                  </>
                                )}
                              </div>
                              <div className="arrow-col">→</div>
                              <div className="d365-field-col" onClick={(e) => e.stopPropagation()}>
                                {!useManualInput ? (
                                  <>
                                    <SearchDropdown
                                      items={fieldDropdownItems}
                                      value={row.edited_d365_api}
                                      onChange={(val, fieldObj) => handleFieldDropdownChange(obj, realIdx, val, fieldObj)}
                                      placeholder="🔍 Search D365 fields…"
                                      disabled={isConfirmed}
                                      labelKey="label"
                                      valueKey="value"
                                      renderItem={(it) => (
                                        <div>
                                          <span style={{ fontWeight: 500 }}>{it.display_name}</span>
                                          <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>{it.value} · {it.attribute_type}</span>
                                        </div>
                                      )}
                                    />
                                    {(!row.edited_d365_api || row.edited_d365_api.trim() === '') && (
                                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
                                        ℹ️ Column will be created in schema pipeline
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <>
                                    <input
                                      className="form-input"
                                      style={{ padding: '7px 10px', fontSize: 13, marginBottom: 4 }}
                                      placeholder="Display Name"
                                      value={row.edited_d365_name}
                                      onChange={(e) => handleEdit(obj, realIdx, 'edited_d365_name', e.target.value)}
                                      disabled={isConfirmed}
                                    />
                                    <input
                                      className="form-input"
                                      style={{ padding: '5px 10px', fontSize: 11, fontFamily: 'monospace', opacity: 0.8 }}
                                      placeholder={createNew ? `Will create as: ${prefix}api_name` : 'Enter API name to map'}
                                      value={row.edited_d365_api}
                                      onChange={(e) => handleEdit(obj, realIdx, 'edited_d365_api', e.target.value)}
                                      disabled={isConfirmed}
                                    />
                                    {/* Visual indicator for missing/unmapped fields */}
                                    {(!row.edited_d365_api || row.edited_d365_api.trim() === '') && (
                                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                                        ℹ️ Column will be created in schema pipeline
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <span className="chip chip-blue" style={{ fontSize: 10 }}>SF: {row.sf_type || '—'}</span>
                                <span className="chip" style={{ fontSize: 10, background: 'rgba(35,165,94,0.08)', color: 'var(--accent-primary)' }}>
                                  D365: {row.d365_type || '—'}
                                </span>
                              </div>
                              {/* Remove row button */}
                              {
                                !isConfirmed && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); removeFieldRow(obj, realIdx); }}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: '0 4px', alignSelf: 'center' }}
                                    title="Remove this field"
                                  >✕</button>
                                )
                              }
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}

                  {/* ── Add Field button ── */}
                  {!isConfirmed && (
                    <div style={{ padding: '10px 20px', borderTop: rows.length > 0 ? '1px solid var(--border)' : 'none' }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        style={{ fontSize: 12 }}
                        onClick={(e) => { e.stopPropagation(); addFieldRow(obj); }}
                      >
                        + Add Field
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* ── Confirm Row — OUTSIDE accordion body, always visible when expanded ── */}
            {
              isOpen && (
                <div className={`mapping-card-confirm-row${isConfirmed ? ' is-confirmed' : ''}`}>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={isConfirmed} onChange={() => toggleConfirm(obj)} disabled={saving[obj]} />
                    <span className="toggle-slider" />
                  </label>
                  <label className="confirm-label" onClick={() => !saving[obj] && toggleConfirm(obj)}>
                    {saving[obj]
                      ? `⏳ Syncing ${obj}…`
                      : isConfirmed
                        ? `✅ Mapping confirmed for ${obj} — inputs locked`
                        : `Confirm mapping for ${obj}`}
                  </label>
                  {!isConfirmed && objIdx < selectedObjects.length - 1 && (
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
                      Next: {selectedObjects[objIdx + 1]}
                    </span>
                  )}
                </div>
              )
            }

            {/* Save result feedback */}
            {
              saveResult[obj] && (
                <div style={{
                  padding: '8px 20px',
                  fontSize: 12,
                  color: saveResult[obj].ok ? 'var(--success)' : 'var(--danger)',
                  background: saveResult[obj].ok ? 'var(--success-bg)' : 'var(--danger-bg)',
                  borderTop: '1px solid var(--border)',
                }}>
                  {saveResult[obj].msg}
                </div>
              )
            }
          </div>
        );
      })}

      {/* ── Proceed to Migration ── */}
      {wizardConfirmed ? (
        <div className="wizard-confirm-bar confirmed">
          <div style={{ flex: 1, fontWeight: 600 }}>✅ All {selectedObjects.length} mappings confirmed</div>
          <button className="btn btn-primary" onClick={onConfirm}>
            Proceed to Migration →
          </button>
        </div>
      ) : (() => {
        const syncDone = syncState === 'synced';
        const ready = allConfirmed && syncDone;
        return (
          <div className="wizard-confirm-bar" style={{ opacity: ready ? 1 : 0.75 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
                {!allConfirmed
                  ? `⏳ ${confirmedCount}/${selectedObjects.length} mappings confirmed`
                  : !syncDone
                    ? '📤 Sync required before proceeding'
                    : `✅ All ${selectedObjects.length} mappings confirmed & synced`}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {!allConfirmed
                  ? 'Confirm all field mappings above to proceed to migration.'
                  : !syncDone
                    ? 'Click "Sync Now" above to push mappings to Lakehouse, then confirm.'
                    : 'Mappings synced to Lakehouse. Ready to proceed to migration.'}
              </div>
            </div>
            <button
              className="btn btn-primary"
              disabled={!ready}
              onClick={onConfirm}
            >
              Proceed to Migration →
            </button>
          </div>
        );
      })()}
    </div >
  );
};

export default MappingTab;

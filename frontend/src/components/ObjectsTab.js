import React, { useState, useEffect, useCallback, useRef } from 'react';
const API = process.env.REACT_APP_API_URL || 'http://localhost:8000';

const ObjectsTab = ({ onSelectionChange, onConfirm, onUnconfirm, isConfirmed }) => {
  const [objects, setObjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updating, setUpdating] = useState({});
  const [rowErrors, setRowErrors] = useState({}); // per-object error messages
  const [query, setQuery] = useState('');
  const [hasFabric, setHasFabric] = useState(null);
  const [syncState, setSyncState] = useState('idle'); // 'idle' | 'pending' | 'syncing' | 'synced' | 'error'
  const [syncMsg, setSyncMsg] = useState(null);
  const autoConfirmTimer = useRef(null);

  /* ── Check whether ANY connection profile is saved ─────────── */
  useEffect(() => {
    let cancelled = false;
    const checkConfigs = async () => {
      try {
        const res = await fetch(`${API}/configs`);
        if (!res.ok) throw new Error();
        const names = await res.json();
        // Any saved profile is enough — backend gates /objects on having at least one
        if (!cancelled) setHasFabric(Array.isArray(names) && names.length > 0);
      } catch {
        // Can't reach backend — let the fetch attempt happen and show the error there
        if (!cancelled) setHasFabric(true);
      }
    };
    checkConfigs();
    return () => { cancelled = true; };
  }, []);

  /* ── Fetch objects (called once when hasFabric resolves) ───── */
  // Stabilize callback ref to avoid infinite fetchObjects loop
  const selectionChangeRef = useRef(onSelectionChange);
  selectionChangeRef.current = onSelectionChange;

  /* ── Fetch objects (called once when hasFabric resolves) ───── */
  const fetchObjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/objects`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to load objects');
      }
      const data = await res.json();
      setObjects(data);
      if (selectionChangeRef.current) {
        selectionChangeRef.current(data.filter((o) => o.migrate).map((o) => o.name));
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []); // no deps — ref handles the callback

  useEffect(() => {
    if (hasFabric === null) return; // still checking
    if (hasFabric === false) { setLoading(false); return; }
    fetchObjects();
  }, [hasFabric, fetchObjects]);



  const toggleMigrate = async (objName, flag) => {
    if (isConfirmed && onUnconfirm) onUnconfirm(); // Unconfirm when user changes selection

    // Snapshot BEFORE any state mutation — used for rollback if backend fails
    const snapshot = objects;

    // Clear any previous error for this row
    setRowErrors(p => ({ ...p, [objName]: null }));

    const updated = snapshot.map((o) =>
      o.name === objName ? { ...o, migrate: flag } : o
    );
    setObjects(updated);
    if (onSelectionChange) {
      onSelectionChange(updated.filter((o) => o.migrate).map((o) => o.name));
    }

    setUpdating((p) => ({ ...p, [objName]: true }));
    try {
      const res = await fetch(
        `${API}/migrate/flag?object_name=${encodeURIComponent(objName)}&migrate=${flag}`,
        { method: 'POST' }
      );
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `HTTP ${res.status}`);
      }
      // Flag saved locally — user must click "Sync Now" to push to Fabric
      setSyncState('pending');
    } catch (err) {
      console.error(`[ObjectsTab] Failed to update ${objName}:`, err.message);
      setRowErrors(p => ({ ...p, [objName]: err.message }));
      setObjects(snapshot);
      if (onSelectionChange) {
        onSelectionChange(snapshot.filter((o) => o.migrate).map((o) => o.name));
      }
    } finally {
      setUpdating((p) => ({ ...p, [objName]: false }));
    }
  };

  /* ── Select All / Unselect All ─ */
  const selectAll = async () => {
    if (isConfirmed && onUnconfirm) onUnconfirm();
    const updated = objects.map((o) => ({ ...o, migrate: true }));
    setObjects(updated);
    if (onSelectionChange) {
      onSelectionChange(updated.map((o) => o.name));
    }
    // Single bulk call — saves locally only, user clicks "Sync Now" to push
    try {
      const bulkFlags = {};
      objects.forEach((o) => { bulkFlags[o.name] = true; });
      await fetch(`${API}/migrate/flag/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bulkFlags),
      });
      setSyncState('pending');
    } catch (err) {
      console.error('[ObjectsTab] Select all error:', err);
    }
  };

  const unselectAll = async () => {
    if (isConfirmed && onUnconfirm) onUnconfirm();
    const updated = objects.map((o) => ({ ...o, migrate: false }));
    setObjects(updated);
    if (onSelectionChange) {
      onSelectionChange([]);
    }
    try {
      const bulkFlags = {};
      objects.forEach((o) => { bulkFlags[o.name] = false; });
      await fetch(`${API}/migrate/flag/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bulkFlags),
      });
      setSyncState('pending');
    } catch (err) {
      console.error('[ObjectsTab] Unselect all error:', err);
    }
  };

  const pushToFabric = useCallback(async () => {
    setSyncState('syncing');
    setSyncMsg(null);
    try {
      const res = await fetch(`${API}/objects/confirm`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setSyncState('synced');
      setSyncMsg(`✅ ${data.count} objects pushed to Fabric`);
    } catch (e) {
      setSyncState('error');
      setSyncMsg(`❌ ${e.message}`);
    }
  }, []);

  const selectedCount = objects.filter((o) => o.migrate).length;

  /* ── No Fabric connection ───────────────────────────────────── */
  if (hasFabric === false) {
    return (
      <div>
        <div className="section-header">
          <div className="section-title">Salesforce Objects</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '48px 32px' }}>
          <div style={{ fontSize: 44, marginBottom: 16 }}>🏗️</div>
          <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text-primary)', marginBottom: 8 }}>
            Fabric Lakehouse Not Connected
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', maxWidth: 420, margin: '0 auto 24px' }}>
            Objects are read from your Fabric Lakehouse. Please add a{' '}
            <strong>Fabric Lakehouse</strong> connection in the{' '}
            <strong>Connections</strong> tab before continuing.
          </div>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 10,
            background: 'rgba(227, 0, 140, 0.06)',
            border: '1.5px solid rgba(227, 0, 140, 0.25)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 20px',
            fontSize: 13, color: '#E3008C',
          }}>
            <span>🔗</span>
            Go to <strong>Connections → Add Connection → Fabric Lakehouse</strong>
          </div>
        </div>
      </div>
    );
  }

  /* ── Loading skeleton ──────────────────────────────────────── */
  if (loading) {
    return (
      <div>
        <div className="section-header">
          <div className="section-title">Salesforce Objects</div>
          <div className="section-desc">Loading from Fabric Lakehouse…</div>
        </div>
        <div className="card">
          {[...Array(6)].map((_, i) => (
            <div key={i} style={{
              height: 52, borderRadius: 8, marginBottom: 8,
              background: 'var(--bg-secondary)',
              animation: 'shimmer 1.4s infinite',
              opacity: 1 - i * 0.1,
            }} />
          ))}
        </div>
        <style>{`
          @keyframes shimmer {
            0%,100% { opacity: 0.5; }
            50%      { opacity: 0.2; }
          }
        `}</style>
      </div>
    );
  }

  /* ── Error state ───────────────────────────────────────────── */
  if (error) {
    return (
      <div>
        <div className="section-header">
          <div className="section-title">Salesforce Objects</div>
        </div>
        <div className="card">
          <div style={{
            padding: '20px 0', textAlign: 'center',
            color: 'var(--danger)', fontSize: 14,
          }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
            <strong>Could not load objects</strong>
            <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 12 }}>{error}</div>
            <div style={{ marginTop: 16 }}>
              <button className="btn btn-secondary btn-sm" onClick={fetchObjects}>
                ↺ Retry
              </button>
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
              Make sure the Fabric Lakehouse connection is saved and the backend is running.
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── Main table ────────────────────────────────────────────── */
  return (
    <div>
      <div className="section-header">
        <div className="section-title">Salesforce Objects</div>
        <div className="section-desc">
          {objects.length} objects from{' '}
          <code style={{ fontSize: 12, color: 'var(--accent-primary)', background: 'rgba(35,165,94,0.08)', padding: '2px 6px', borderRadius: 4 }}>
            raw.object_names
          </code>
          {selectedCount > 0 && (
            <span className="chip chip-blue">{selectedCount} selected for migration</span>
          )}
        </div>
      </div>

      {/* ── Fabric Sync Status bar ─── */}
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
            {syncState === 'pending' && '📤 Changes not yet pushed'}
            {syncState === 'syncing' && '⏳ Syncing with Fabric…'}
            {syncState === 'synced' && '✅ Synced to Fabric'}
            {syncState === 'error' && '❌ Sync failed'}
            {syncState === 'idle' && '✅ Selection synced'}
          </div>
          <div style={{ fontSize: 12, color: syncState === 'error' ? 'var(--danger)' : 'var(--text-muted)' }}>
            {syncState === 'pending' && 'Click "Sync Now" to push your selections to Fabric Lakehouse.'}
            {syncState === 'syncing' && 'Uploading selections to Fabric Lakehouse…'}
            {syncState === 'synced' && (syncMsg || 'Object selections are live in the Fabric Lakehouse.')}
            {syncState === 'error' && (syncMsg || 'Could not reach Fabric. Check your connection settings.')}
            {syncState === 'idle' && 'Toggle objects, then click "Sync Now" to push to Fabric.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={selectAll}
            title="Select all objects"
          >
            ☑ Select All
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={unselectAll}
            title="Unselect all objects"
          >
            ☐ Unselect All
          </button>
          <button
            className="btn btn-secondary"
            onClick={pushToFabric}
            disabled={syncState === 'syncing'}
            style={{ flexShrink: 0, fontSize: 13 }}
            title="Push current selections to Fabric now"
          >
            {syncState === 'syncing' ? '⏳ Syncing…' : '↑ Sync Now'}
          </button>
        </div>
      </div>

      {/* ── Object table — scrollable ─── */}
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 20 }}>
        {/* Search bar */}
        <div className="search-bar">
          <span style={{ fontSize: 16 }}>🔍</span>
          <input
            className="search-input"
            placeholder="Search objects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--text-muted)', padding: '0 4px' }}
            >✕</button>
          )}
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {query
              ? `${objects.filter(o => o.name.toLowerCase().includes(query.toLowerCase())).length} of ${objects.length}`
              : `${objects.length} objects`}
          </span>
        </div>

        <div style={{ maxHeight: 520, overflowY: 'auto' }}>
          <table className="styled-table">
            <thead>
              <tr>
                <th style={{ paddingLeft: 24, position: 'sticky', top: 0, background: 'var(--bg-secondary)', zIndex: 2 }}>Salesforce Object</th>
                <th style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', zIndex: 2 }}>Status</th>
                <th style={{ textAlign: 'center', position: 'sticky', top: 0, background: 'var(--bg-secondary)', zIndex: 2 }}>Include in Migration</th>
              </tr>
            </thead>
            <tbody>
              {objects
                .filter((o) => o.name.toLowerCase().includes(query.toLowerCase()))
                .map((o) => (
                  <tr key={o.name} style={{ background: rowErrors[o.name] ? 'rgba(220,38,38,0.03)' : undefined }}>
                    <td style={{ paddingLeft: 24 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{
                          width: 30, height: 30, borderRadius: 7,
                          background: o.migrate ? 'rgba(35,165,94,0.12)' : 'var(--bg-secondary)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 13, flexShrink: 0,
                          transition: 'background 0.15s',
                        }}>
                          {o.migrate ? '✓' : '📦'}
                        </span>
                        <div>
                          <span style={{ fontWeight: 500, fontSize: 14 }}>{o.name}</span>
                          {rowErrors[o.name] && (
                            <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>
                              ⚠️ {rowErrors[o.name]}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      {updating[o.name] ? (
                        <span className="chip" style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
                          ⏳ Saving…
                        </span>
                      ) : o.migrate ? (
                        <span className="chip chip-green">✓ Selected</span>
                      ) : (
                        <span className="chip" style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
                          Skipped
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={!!o.migrate}
                          disabled={!!updating[o.name]}
                          onChange={(e) => toggleMigrate(o.name, e.target.checked)}
                        />
                        <span className="toggle-slider" />
                      </label>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Confirm & Proceed ── */}
      {isConfirmed ? (
        <div className="wizard-confirm-bar confirmed">
          <div style={{ flex: 1, fontWeight: 600 }}>✅ Object selection confirmed ({selectedCount} objects)</div>
          <button className="btn btn-primary" onClick={onConfirm}>
            Proceed to Mapping →
          </button>
        </div>
      ) : (
        <div className="wizard-confirm-bar">
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
              {selectedCount === 0
                ? '⚠️ Select at least one object to proceed'
                : syncState !== 'synced'
                  ? '📤 Sync required before proceeding'
                  : `✅ ${selectedCount} objects synced`}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {selectedCount === 0
                ? 'Toggle objects above to include them in the migration.'
                : syncState !== 'synced'
                  ? 'Click "Sync Now" above to push your selections to Fabric, then confirm.'
                  : 'Selections synced to Fabric. Confirm to continue to field mapping.'}
            </div>
          </div>
          <button
            className="btn btn-primary"
            disabled={selectedCount === 0 || syncState !== 'synced'}
            onClick={onConfirm}
          >
            Confirm & Proceed →
          </button>
        </div>
      )}
    </div>
  );
};

export default ObjectsTab;

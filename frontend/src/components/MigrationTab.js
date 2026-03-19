import React, { useState, useEffect, useRef } from 'react';
const API = process.env.REACT_APP_API_URL || 'http://localhost:8000';

const POLL_INTERVAL_MS = 2000;
const CANCEL_POLL_MS = 1000;
const CANCEL_TIMEOUT_MS = 15000;

const STATUS_STYLES = {
  Accepted: { bg: 'rgba(35,165,94,0.08)', color: 'var(--success)', icon: '⏳' },
  Running: { bg: 'rgba(35,165,94,0.08)', color: 'var(--success)', icon: '🔄' },
  InProgress: { bg: 'rgba(35,165,94,0.08)', color: 'var(--success)', icon: '🔄' },
  Succeeded: { bg: 'rgba(35,165,94,0.08)', color: 'var(--success)', icon: '✅' },
  Failed: { bg: 'rgba(220,38,38,0.07)', color: 'var(--danger)', icon: '❌' },
  Cancelled: { bg: 'rgba(251,191,36,0.08)', color: 'var(--warning)', icon: '⛔' },
  CancelRequested: { bg: 'rgba(251,191,36,0.08)', color: 'var(--warning)', icon: '⏳' },
  Unknown: { bg: 'var(--bg-secondary)', color: 'var(--text-muted)', icon: '❓' },
};

const ACTIVITY_ICONS = {
  Succeeded: '✅',
  Failed: '❌',
  Running: '🔄',
  InProgress: '🔄',
  Queued: '⏳',
  Cancelled: '⛔',
  Canceled: '⛔',
};

const fmtDuration = (sec) => {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

const MigrationTab = ({ pipelineType = 'data', title = 'Data Migration Pipeline', selectedObjects, onMigrationStateChange, isConfirmed, onConfirm }) => {
  const STORAGE_KEY = `sf2d_active_job_${pipelineType}`;

  const [jobInfo, setJobInfo] = useState(null);
  const [pollStatus, setPollStatus] = useState(null);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const pollRef = useRef(null);

  // ── Activity Runs ──
  const [activities, setActivities] = useState([]);

  // ── Run History ──
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  // ── Resume active job from localStorage on mount ──
  useEffect(() => {
    fetchHistory();
    const savedJobId = localStorage.getItem(STORAGE_KEY);
    if (savedJobId) {
      // Recover state: set job info and check if still running
      setJobInfo({ job_id: savedJobId });
      setRunning(true);
      if (onMigrationStateChange) onMigrationStateChange(true);
      // Immediately fetch current status
      (async () => {
        try {
          const res = await fetch(`${API}/migration/status/${savedJobId}`);
          if (res.ok) {
            const data = await res.json();
            setPollStatus(data);
            fetchActivities(savedJobId);
            if (data.is_terminal) {
              // Job already finished while we were away
              localStorage.removeItem(STORAGE_KEY);
              setRunning(false);
              if (onMigrationStateChange) onMigrationStateChange(false);
              fetchHistory();
              return;
            }
          }
        } catch (_) { }
        // Still running — resume polling
        startPoll(savedJobId);
      })();
    }
    return () => clearInterval(pollRef.current);
  }, []); // eslint-disable-line

  const fetchHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch(`${API}/migration/history?pipeline_type=${pipelineType}`);
      if (res.ok) setHistory(await res.json());
    } catch (_) { }
    setHistoryLoading(false);
  };

  const fetchActivities = async (jobId) => {
    try {
      const res = await fetch(`${API}/migration/activities/${jobId}`);
      if (res.ok) {
        const data = await res.json();
        setActivities(data);
      }
    } catch (_) { }
  };

  const startMigration = async () => {
    setJobInfo(null);
    setPollStatus(null);
    setCancelling(false);
    setActivities([]);
    setRunning(true);
    if (onMigrationStateChange) onMigrationStateChange(true);

    try {
      const res = await fetch(`${API}/migration/${pipelineType}/start`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setJobInfo(data);
      // Persist job_id so we can recover after refresh
      if (data.job_id) localStorage.setItem(STORAGE_KEY, data.job_id);

      // Use retry_after from backend for initial delay, then poll at POLL_INTERVAL_MS
      const retryAfterSec = data.retry_after ?? 5;
      setTimeout(() => startPoll(data.job_id), retryAfterSec * 1000);
    } catch (err) {
      setJobInfo({ error: err.message });
      setRunning(false);
      if (onMigrationStateChange) onMigrationStateChange(false);
    }
  };

  const startPoll = (jobId) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API}/migration/status/${jobId}`);
        if (!res.ok) return;
        const data = await res.json();
        setPollStatus(data);

        // Also poll activity runs
        fetchActivities(jobId);

        if (data.is_terminal) {
          clearInterval(pollRef.current);
          localStorage.removeItem(STORAGE_KEY);
          setRunning(false);
          setCancelling(false);
          if (onMigrationStateChange) onMigrationStateChange(false);
          // One final activity fetch
          fetchActivities(jobId);
          // Refresh history
          fetchHistory();
        }
      } catch (_) { }
    }, POLL_INTERVAL_MS);
  };

  const cancelMigration = async () => {
    if (!jobInfo?.job_id) return;
    setCancelling(true);
    try {
      await fetch(`${API}/migration/cancel/${jobInfo.job_id}`, { method: 'POST' });
    } catch (_) { }

    // Switch to rapid polling to detect cancellation faster
    clearInterval(pollRef.current);
    const cancelStart = Date.now();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API}/migration/status/${jobInfo.job_id}`);
        if (!res.ok) return;
        const data = await res.json();
        setPollStatus(data);
        fetchActivities(jobInfo.job_id);

        if (data.is_terminal) {
          clearInterval(pollRef.current);
          localStorage.removeItem(STORAGE_KEY);
          setRunning(false);
          setCancelling(false);
          if (onMigrationStateChange) onMigrationStateChange(false);
          fetchActivities(jobInfo.job_id);
          fetchHistory();
          return;
        }

        // Force-reset after timeout if Fabric is slow to report
        if (Date.now() - cancelStart > CANCEL_TIMEOUT_MS) {
          clearInterval(pollRef.current);
          localStorage.removeItem(STORAGE_KEY);
          setRunning(false);
          setCancelling(false);
          setPollStatus(prev => ({ ...prev, status: 'Cancelled', is_terminal: true }));
          if (onMigrationStateChange) onMigrationStateChange(false);
          fetchHistory();
        }
      } catch (_) { }
    }, CANCEL_POLL_MS);
  };

  const currentStatus = pollStatus?.status || jobInfo?.status || null;
  const style = STATUS_STYLES[currentStatus] || STATUS_STYLES.Unknown;

  const fmtTime = (iso) => {
    if (!iso) return '—';
    const s = String(iso);
    // Treat bare ISO strings (no Z / offset) as UTC so local clocks display correctly
    const utc = s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z';
    return new Date(utc).toLocaleString();
  };

  const fmtFailure = (reason) => {
    if (!reason) return '—';
    if (typeof reason === 'string') return reason;
    if (typeof reason === 'object') {
      return reason.ErrorMessage || reason.message || reason.errorCode || JSON.stringify(reason);
    }
    return String(reason);
  };

  return (
    <div>
      <div className="section-header">
        <div className="section-title">{title}</div>
        <div className="section-desc">
          Triggers the Fabric Data Pipeline for the selected objects.
          {pipelineType === 'schema' ? ' This step prepares the raw database tables.' : ' This step copies the actual data records.'}
        </div>
      </div>

      {/* Stat cards — expanded layout */}
      <div className="migration-overview" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 20 }}>
        <div className="stat-card" style={{ padding: '24px 20px' }}>
          <div className="stat-value" style={{ fontSize: 36 }}>{selectedObjects.length}</div>
          <div className="stat-label">Objects Selected</div>
        </div>
        <div className="stat-card" style={{ padding: '24px 20px' }}>
          <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
            <span>{style.icon}</span>
            <span style={{ color: style.color }}>{currentStatus || '—'}</span>
          </div>
          <div className="stat-label">Pipeline Status</div>
        </div>
        <div className="stat-card" style={{ padding: '24px 20px' }}>
          <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'monospace', wordBreak: 'break-all', color: 'var(--text-primary)', marginBottom: 4, minHeight: 20 }}>
            {jobInfo?.job_id || '—'}
          </div>
          <div className="stat-label">Job ID</div>
        </div>
        <div className="stat-card" style={{ padding: '24px 20px' }}>
          <div className="stat-value" style={{ fontSize: 22 }}>{POLL_INTERVAL_MS / 1000}s</div>
          <div className="stat-label">Poll Interval</div>
        </div>
      </div>

      {/* Control card */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">🚀 {title} Control</div>
        <div className="card-desc">
          {selectedObjects.length === 0
            ? 'No objects selected. Go back to Objects tab.'
            : `Ready to migrate: ${selectedObjects.slice(0, 4).join(', ')}${selectedObjects.length > 4 ? ` +${selectedObjects.length - 4} more` : ''}`}
        </div>

        <button
          className="btn btn-primary"
          onClick={startMigration}
          disabled={selectedObjects.length === 0 || running}
        >
          {running && !cancelling
            ? <><span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span> Running…</>
            : jobInfo && !jobInfo.error ? '🔄 Run Again' : `🚀 Start ${pipelineType === 'schema' ? 'Schema' : 'Data'} Pipeline`}
        </button>

        {/* Cancel button — shown while a job is active and not yet in terminal state */}
        {jobInfo?.job_id && !jobInfo?.error && running && (
          <button
            className="btn"
            onClick={cancelMigration}
            disabled={cancelling}
            style={{
              marginLeft: 10,
              background: 'var(--danger-bg)',
              color: 'var(--danger)',
              border: '1px solid rgba(220,38,38,0.35)',
            }}
          >
            {cancelling ? '⏳ Cancelling…' : '⏹ Stop Migration'}
          </button>
        )}

        {/* Error */}
        {jobInfo?.error && (
          <div style={{
            marginTop: 16, padding: '12px 16px',
            background: 'var(--danger-bg)',
            border: '1px solid rgba(220,38,38,0.3)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--danger)', fontSize: 13,
          }}>
            ❌ {jobInfo.error}
          </div>
        )}
      </div>

      {/* Job status card + Activity Timeline */}
      {(jobInfo?.job_id || pollStatus) && !jobInfo?.error && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">📊 Pipeline Run Details</div>

          <div style={{
            marginTop: 8, padding: '14px 16px',
            background: style.bg,
            border: `1px solid ${style.color}33`,
            borderRadius: 'var(--radius-sm)',
            display: 'flex', alignItems: 'center', gap: 12,
            fontSize: 14, fontWeight: 600, color: style.color,
            marginBottom: 16,
          }}>
            <span style={{ fontSize: 20 }}>{style.icon}</span>
            {currentStatus || 'Accepted'}
            {['Accepted', 'Running'].includes(currentStatus) && (
              <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 'auto', color: 'var(--text-muted)' }}>
                Polling every {POLL_INTERVAL_MS / 1000}s…
              </span>
            )}
          </div>

          <div className="migration-run-grid">
            {[
              ['Job ID', jobInfo?.job_id || '—'],
              ['Started', fmtTime(pollStatus?.start_time)],
              ['Finished', fmtTime(pollStatus?.end_time)],
              ['Failure', fmtFailure(pollStatus?.failure_reason)],
            ].map(([label, val]) => (
              <div key={label} style={{
                padding: '10px 14px',
                background: 'var(--bg-secondary)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)',
              }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 4 }}>
                  {label}
                </div>
                <div style={{ fontFamily: label === 'Job ID' ? 'monospace' : 'inherit', wordBreak: 'break-all', color: 'var(--text-primary)' }}>
                  {String(val ?? '—')}
                </div>
              </div>
            ))}
          </div>

          {/* ── Activity Timeline ── */}
          {activities.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{
                fontSize: 13, fontWeight: 700, color: 'var(--text-primary)',
                textTransform: 'uppercase', letterSpacing: '0.8px',
                marginBottom: 12,
              }}>
                ⚡ Pipeline Activities
              </div>

              <div style={{ position: 'relative', paddingLeft: 28 }}>
                {/* Vertical timeline line */}
                <div style={{
                  position: 'absolute', left: 10, top: 4, bottom: 4,
                  width: 2, background: 'var(--border)', borderRadius: 2,
                }} />

                {activities.map((act, idx) => {
                  const icon = ACTIVITY_ICONS[act.status] || '⏳';
                  const isRunning = act.status === 'Running' || act.status === 'In Progress';
                  const isFailed = act.status === 'Failed';
                  const isSucceeded = act.status === 'Succeeded';

                  return (
                    <div key={idx} style={{
                      position: 'relative',
                      padding: '10px 14px',
                      marginBottom: 8,
                      background: isFailed ? 'rgba(220,38,38,0.04)'
                        : isRunning ? 'rgba(35,165,94,0.04)'
                          : isSucceeded ? 'rgba(35,165,94,0.02)'
                            : 'var(--bg-secondary)',
                      border: `1px solid ${isFailed ? 'rgba(220,38,38,0.2)'
                        : isRunning ? 'rgba(35,165,94,0.25)'
                          : 'var(--border)'}`,
                      borderRadius: 'var(--radius-sm)',
                      transition: 'all 0.2s',
                    }}>
                      {/* Timeline dot */}
                      <div style={{
                        position: 'absolute', left: -23, top: 14,
                        width: 12, height: 12, borderRadius: '50%',
                        background: isFailed ? 'var(--danger)'
                          : isRunning ? 'var(--success)'
                            : isSucceeded ? 'var(--success)'
                              : 'var(--text-muted)',
                        border: '2px solid var(--bg-card)',
                        boxShadow: isRunning ? '0 0 8px rgba(35,165,94,0.5)' : 'none',
                        animation: isRunning ? 'pulse 1.5s ease-in-out infinite' : 'none',
                      }} />

                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {/* Icon + Name */}
                        <span style={{
                          fontSize: 16,
                          animation: isRunning ? 'spin 1s linear infinite' : 'none',
                          display: 'inline-block',
                        }}>
                          {icon}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontWeight: 600, fontSize: 13,
                            color: 'var(--text-primary)',
                            display: 'flex', alignItems: 'center', gap: 8,
                          }}>
                            {act.name}
                            {act.type && (
                              <span style={{
                                fontSize: 10, padding: '2px 6px',
                                background: 'rgba(99,102,241,0.08)',
                                color: 'rgba(99,102,241,0.9)',
                                borderRadius: 4, fontWeight: 500,
                              }}>
                                {act.type}
                              </span>
                            )}
                          </div>
                          {isFailed && act.error && (
                            <div style={{
                              fontSize: 11, color: 'var(--danger)',
                              marginTop: 4, lineHeight: 1.3,
                            }}>
                              ⚠️ {act.error}
                            </div>
                          )}
                        </div>

                        {/* Duration + Status */}
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{
                            fontSize: 12, fontWeight: 600, fontFamily: 'monospace',
                            color: isRunning ? 'var(--success)' : 'var(--text-secondary)',
                          }}>
                            {fmtDuration(act.duration_sec)}
                          </div>
                          <div style={{
                            fontSize: 10, fontWeight: 500,
                            color: isFailed ? 'var(--danger)'
                              : isSucceeded ? 'var(--success)'
                                : 'var(--text-muted)',
                          }}>
                            {act.status}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Activities loading state */}
          {activities.length === 0 && running && (
            <div style={{
              marginTop: 16, padding: '16px',
              textAlign: 'center', fontSize: 13,
              color: 'var(--text-muted)',
            }}>
              ⏳ Waiting for pipeline activities to start…
            </div>
          )}

          {pollStatus?.status === 'Succeeded' && (
            <div style={{
              marginTop: 16, padding: '12px 16px',
              background: 'var(--success-bg)',
              border: '1px solid rgba(35,165,94,0.3)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--success)', fontSize: 14, fontWeight: 500,
            }}>
              ✅ Pipeline completed successfully!
            </div>
          )}
        </div>
      )}

      {/* ── Run History ── */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 12 }}>📜 Run History</div>

        {historyLoading ? (
          <div style={{ padding: '16px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            Loading history…
          </div>
        ) : history.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No previous migration runs.
          </div>
        ) : (
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table className="styled-table">
              <thead>
                <tr>
                  <th style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', zIndex: 2 }}>Job ID</th>
                  <th style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', zIndex: 2 }}>Status</th>
                  <th style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', zIndex: 2 }}>Started</th>
                  <th style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', zIndex: 2 }}>Finished</th>
                </tr>
              </thead>
              <tbody>
                {history.map((run, idx) => {
                  const s = STATUS_STYLES[run.status] || STATUS_STYLES.Unknown;
                  return (
                    <tr key={run.job_id || idx}>
                      <td style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
                        {run.job_id || '—'}
                      </td>
                      <td>
                        <span className="chip" style={{
                          background: s.bg, color: s.color,
                          fontSize: 11, fontWeight: 600,
                        }}>
                          {s.icon} {run.status || 'Unknown'}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {fmtTime(run.start_time || run.saved_at)}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {fmtTime(run.end_time)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Confirm & Proceed (Only for Schema Step) ── */}
      {pipelineType === 'schema' && onConfirm && (
        <div style={{ marginTop: 24 }}>
          {isConfirmed ? (
            <div className="wizard-confirm-bar confirmed">
              <div style={{ flex: 1, fontWeight: 600 }}>✅ Schema Pipeline verified</div>
              <button className="btn btn-primary" onClick={onConfirm}>
                Proceed to Data Migration →
              </button>
            </div>
          ) : (
            <div className="wizard-confirm-bar">
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="chip" style={{ background: pollStatus?.status === 'Succeeded' ? 'rgba(35,165,94,0.1)' : 'rgba(251,191,36,0.1)', color: pollStatus?.status === 'Succeeded' ? 'var(--success)' : 'var(--warning)', fontWeight: 600 }}>
                  {pollStatus?.status === 'Succeeded' ? 'Ready' : 'Pending'}
                </span>
                Verify the schema pipeline ran successfully before starting data migration.
              </div>
              <button
                className="btn btn-primary"
                onClick={onConfirm}
              >
                Confirm & Proceed →
              </button>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse {
          0%, 100% { box-shadow: 0 0 4px rgba(35,165,94,0.3); }
          50%      { box-shadow: 0 0 12px rgba(35,165,94,0.6); }
        }
      `}</style>
    </div>
  );
};

export default MigrationTab;
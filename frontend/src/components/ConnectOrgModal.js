import React, { useState, useEffect, useRef } from 'react';
import { authFetch } from '../utils/authFetch';

const API = process.env.REACT_APP_API_URL || 'http://localhost:8000';

const TARGET_CRMS = [
  { id: 'dynamics365', label: 'Microsoft Dynamics 365' },
  { id: 'hubspot',     label: 'HubSpot CRM' },
  { id: 'zoho',        label: 'Zoho CRM' },
];

export default function ConnectOrgModal({ onClose, onSaved, initialData, editOrgId }) {
  const isEditMode = !!editOrgId;

  const [form, setForm] = useState({
    name:                          initialData?.name                          || '',
    sf_client_id:                  initialData?.sf_client_id                  || '',
    sf_client_secret:              initialData?.sf_client_secret              || '',
    sf_instance_url:               initialData?.sf_instance_url               || '',
    target_crm:                    initialData?.target_crm                    || 'dynamics365',
    d365_tenant_id:                initialData?.d365_tenant_id                || '',
    d365_client_id:                initialData?.d365_client_id                || '',
    d365_client_secret:            initialData?.d365_client_secret            || '',
    d365_environment_url:          initialData?.d365_environment_url          || '',
    power_platform_env_id:         initialData?.power_platform_env_id         || '',
    fabric_enabled:                initialData?.fabric_enabled                || false,
    fabric_tenant_id:              initialData?.fabric_tenant_id              || '',
    fabric_service_principal_id:   initialData?.fabric_service_principal_id   || '',
    fabric_service_principal_secret: initialData?.fabric_service_principal_secret || '',
    fabric_server:                 initialData?.fabric_server                 || '',
    fabric_database:               initialData?.fabric_database               || '',
  });

  const [sfStatus,     setSfStatus]     = useState(initialData?.sf_status     === 'connected' ? 'connected' : 'idle');
  const [d365Status,   setD365Status]   = useState(initialData?.d365_status   === 'connected' ? 'connected' : 'idle');
  const [fabricStatus, setFabricStatus] = useState(initialData?.fabric_status === 'connected' ? 'connected' : 'idle');
  const [sfMsg,        setSfMsg]        = useState('');
  const [d365Msg,      setD365Msg]      = useState('');
  const [fabricMsg,    setFabricMsg]    = useState('');
  const [saving,       setSaving]       = useState(false);
  const [error,        setError]        = useState('');
  const [pendingOrgId, setPendingOrgId] = useState(editOrgId || null);

  const popupRef      = useRef(null);
  const popupTimerRef = useRef(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    const handleOAuthMessage = (event) => {
      const allowed = [window.location.origin, API.replace(/\/$/, '')];
      if (!allowed.includes(event.origin)) return;
      if (!event.data || event.data.type !== 'sf-oauth-result') return;
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
      clearInterval(popupTimerRef.current);
      if (event.data.success) { setSfStatus('connected'); setSfMsg(event.data.message || 'Salesforce connected successfully'); }
      else                    { setSfStatus('error');     setSfMsg(event.data.error   || 'Salesforce authorization failed'); }
    };
    window.addEventListener('message', handleOAuthMessage);
    return () => { window.removeEventListener('message', handleOAuthMessage); clearInterval(popupTimerRef.current); };
  }, []);

  const buildPayload = (extra = {}) => ({
    name: form.name.trim(),
    sf_client_id: form.sf_client_id, sf_client_secret: form.sf_client_secret, sf_instance_url: form.sf_instance_url,
    target_crm: form.target_crm,
    d365_tenant_id: form.d365_tenant_id, d365_client_id: form.d365_client_id,
    d365_client_secret: form.d365_client_secret, d365_environment_url: form.d365_environment_url,
    power_platform_env_id: form.power_platform_env_id,
    fabric_enabled: form.fabric_enabled,
    fabric_tenant_id: form.fabric_tenant_id,
    fabric_service_principal_id: form.fabric_service_principal_id,
    fabric_service_principal_secret: form.fabric_service_principal_secret,
    fabric_server: form.fabric_server, fabric_database: form.fabric_database,
    ...extra,
  });

  const handleAuthorizeSF = async () => {
    if (!form.name.trim())     return setError('Please enter a Connection Name.');
    if (!form.sf_client_id)    return setError('Salesforce Client ID is required.');
    if (!form.sf_instance_url) return setError('Salesforce Instance URL is required.');
    setError(''); setSfStatus('authorizing'); setSfMsg('');
    try {
      let orgId = pendingOrgId;
      if (!orgId) {
        const r = await authFetch(`${API}/shift/connections`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildPayload({ sf_status: 'pending', d365_status: d365Status === 'connected' ? 'connected' : 'pending' })),
        });
        const d = await r.json();
        if (!r.ok && r.status !== 201) { setSfStatus('error'); setSfMsg(d.detail || 'Failed to save.'); return; }
        orgId = d.id; setPendingOrgId(orgId);
      }
      const ar = await authFetch(`${API}/shift/salesforce/authorize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, client_id: form.sf_client_id, client_secret: form.sf_client_secret, instance_url: form.sf_instance_url }),
      });
      const ad = await ar.json();
      if (!ar.ok) { setSfStatus('error'); setSfMsg(ad.detail || 'Failed to authorize.'); return; }
      if (ad.authorized) { setSfStatus('connected'); setSfMsg(ad.message || 'Salesforce connected successfully'); return; }
      const popup = window.open(ad.auth_url, 'sf-oauth-popup', 'width=600,height=700,scrollbars=yes,resizable=yes');
      popupRef.current = popup;
      popupTimerRef.current = setInterval(() => {
        if (popup && popup.closed) { clearInterval(popupTimerRef.current); setSfStatus(s => s === 'authorizing' ? 'idle' : s); }
      }, 500);
    } catch (e) { setSfStatus('error'); setSfMsg(e.message); }
  };

  const handleAuthorizeD365 = async () => {
    if (!form.d365_tenant_id || !form.d365_client_id || !form.d365_client_secret || !form.d365_environment_url)
      return setError('Please fill in all Dynamics 365 fields.');
    setError(''); setD365Status('authorizing'); setD365Msg('');
    try {
      const r = await authFetch(`${API}/shift/dynamics/authorize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: pendingOrgId, tenant_id: form.d365_tenant_id, client_id: form.d365_client_id, client_secret: form.d365_client_secret, environment_url: form.d365_environment_url }),
      });
      const d = await r.json();
      if (r.ok) { setD365Status('connected'); setD365Msg(d.message || 'Dynamics 365 connected successfully'); }
      else      { setD365Status('error');     setD365Msg(d.detail  || 'Authorization failed'); }
    } catch (e) { setD365Status('error'); setD365Msg(e.message); }
  };

  const handleTestFabric = async () => {
    if (!form.fabric_tenant_id || !form.fabric_service_principal_id || !form.fabric_service_principal_secret || !form.fabric_server || !form.fabric_database)
      return setError('Please fill in all Fabric connection fields.');
    setError(''); setFabricStatus('testing'); setFabricMsg('');
    try {
      const r = await authFetch(`${API}/shift/fabric/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: form.fabric_tenant_id, service_principal_id: form.fabric_service_principal_id, service_principal_secret: form.fabric_service_principal_secret, server: form.fabric_server, database: form.fabric_database }),
      });
      const d = await r.json();
      if (r.ok) { setFabricStatus('connected'); setFabricMsg(d.message || 'Fabric connected successfully'); }
      else      { setFabricStatus('error');     setFabricMsg(d.detail  || 'Fabric connection failed'); }
    } catch (e) { setFabricStatus('error'); setFabricMsg(e.message); }
  };

  const handleSave = async () => {
    if (!form.name.trim()) return setError('Connection Name is required.');

    if (isEditMode) {
      setSaving(true); setError('');
      try {
        const r = await authFetch(`${API}/shift/connections/${editOrgId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildPayload({
            sf_status:     sfStatus     === 'connected' ? 'connected' : (initialData?.sf_status     || 'pending'),
            d365_status:   d365Status   === 'connected' ? 'connected' : (initialData?.d365_status   || 'pending'),
            fabric_status: fabricStatus === 'connected' ? 'connected' : (initialData?.fabric_status || 'pending'),
          })),
        });
        const d = await r.json();
        if (r.ok) { onSaved?.(); onClose(); }
        else setError(d.detail || 'Failed to update connection.');
      } catch (e) { setError(e.message); }
      finally { setSaving(false); }
      return;
    }

    if (pendingOrgId) { onSaved?.(); onClose(); return; }
    if (!form.sf_client_id || !form.sf_instance_url) return setError('Salesforce Client ID and Instance URL are required.');
    setSaving(true); setError('');
    try {
      const r = await authFetch(`${API}/shift/connections`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload({ sf_status: sfStatus === 'connected' ? 'connected' : 'pending', d365_status: d365Status === 'connected' ? 'connected' : 'pending', fabric_status: fabricStatus === 'connected' ? 'connected' : 'pending' })),
      });
      const d = await r.json();
      if (r.ok || r.status === 201) { onSaved?.(); onClose(); }
      else setError(d.detail || 'Failed to save connection.');
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const sfBtnLabel  = () => sfStatus  === 'authorizing' ? 'Opening Authorization…' : sfStatus  === 'connected' ? '✓ Salesforce Connected — Reconnect' : '☁ Authorize Salesforce';
  const d365BtnLabel = () => d365Status === 'authorizing' ? 'Connecting…'           : d365Status === 'connected' ? '✓ D365 Connected — Reconnect'       : '🔒 Authorize Dynamics 365';
  const fabricBtnLabel = () => fabricStatus === 'testing' ? 'Testing…'              : fabricStatus === 'connected' ? '✓ Fabric Connected — Retest'        : '⬡ Test Fabric Connection';

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" role="dialog" aria-modal="true">

        {/* ── Header ── */}
        <div className="modal-header">
          <div>
            <h2 className="modal-title">{isEditMode ? 'Edit connection' : 'Connect org'}</h2>
            <p className="modal-subtitle">Configure Salesforce source, Dynamics 365 target, and optionally Fabric Data Lake.</p>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {error && <div className="modal-error">{error}</div>}

        {/* ── Connection Name ── */}
        <div className="modal-name-row">
          <label className="modal-field-label">
            <span className="modal-field-icon">🏢</span>
            Connection Name <span style={{ color: 'var(--danger)' }}>*</span>
          </label>
          <input className="modal-input" placeholder="e.g., Production Org Migration" value={form.name} onChange={e => set('name', e.target.value)} />
        </div>

        {/* ── 3-column grid ── */}
        <div className="modal-3col-grid">

          {/* ── Col 1: Salesforce ── */}
          <div className="modal-card">
            <div className="modal-card-header">
              <div className="modal-card-title-row">
                <span className="modal-card-icon sf-icon">☁️</span>
                <div>
                  <div className="modal-card-title">Source System</div>
                  <div className="modal-card-subtitle">Salesforce</div>
                </div>
              </div>
              {sfStatus === 'connected' && <span className="badge badge-connected">✓</span>}
              {sfStatus === 'error'     && <span className="badge badge-error">✗</span>}
            </div>

            <div className="modal-field-group">
              <label className="modal-field-label">Connected App Client ID</label>
              <input className="modal-input" placeholder="3MVG9..." value={form.sf_client_id} onChange={e => set('sf_client_id', e.target.value)} />
            </div>
            <div className="modal-field-group">
              <label className="modal-field-label">Client Secret (optional)</label>
              <input className="modal-input" type="password" placeholder="Enter client secret" value={form.sf_client_secret} onChange={e => set('sf_client_secret', e.target.value)} />
            </div>
            <div className="modal-field-group">
              <label className="modal-field-label">Instance URL</label>
              <input className="modal-input" placeholder="https://login.salesforce.com" value={form.sf_instance_url} onChange={e => set('sf_instance_url', e.target.value)} />
              <span className="modal-hint">Callback: localhost:8000/shift/oauth/callback/salesforce</span>
            </div>

            {sfMsg && <div className={`modal-msg ${sfStatus === 'connected' ? 'modal-msg-ok' : 'modal-msg-err'}`}>{sfStatus === 'connected' ? '✓' : '✗'} {sfMsg}</div>}

            <button className={`modal-btn-auth sf-btn${sfStatus === 'connected' ? ' connected' : ''}`}
              onClick={sfStatus === 'connected' ? () => { setSfStatus('idle'); setSfMsg(''); } : handleAuthorizeSF}
              disabled={sfStatus === 'authorizing'}>
              {sfStatus === 'authorizing' && <span className="btn-spinner" />}
              {sfBtnLabel()}
            </button>
          </div>

          {/* ── Col 2: Dynamics 365 ── */}
          <div className="modal-card">
            <div className="modal-card-header">
              <div className="modal-card-title-row">
                <span className="modal-card-icon d365-icon">⊞</span>
                <div>
                  <div className="modal-card-title">Target System</div>
                  <div className="modal-card-subtitle">Migration destination</div>
                </div>
              </div>
              {d365Status === 'connected' && <span className="badge badge-connected">✓</span>}
              {d365Status === 'error'     && <span className="badge badge-error">✗</span>}
            </div>

            <div className="modal-field-group">
              <label className="modal-field-label">Target CRM</label>
              <select className="modal-input modal-select" value={form.target_crm} onChange={e => set('target_crm', e.target.value)}>
                {TARGET_CRMS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>

            {form.target_crm === 'dynamics365' ? (
              <>
                <div className="modal-divider-row"><span className="modal-divider-label">🔒 Azure AD App Registration</span></div>
                <div className="modal-field-group">
                  <label className="modal-field-label">Azure Tenant ID</label>
                  <input className="modal-input" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={form.d365_tenant_id} onChange={e => set('d365_tenant_id', e.target.value)} />
                </div>
                <div className="modal-field-group">
                  <label className="modal-field-label">App Client ID</label>
                  <input className="modal-input" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={form.d365_client_id} onChange={e => set('d365_client_id', e.target.value)} />
                </div>
                <div className="modal-field-group">
                  <label className="modal-field-label">App Client Secret</label>
                  <input className="modal-input" type="password" placeholder="Enter client secret" value={form.d365_client_secret} onChange={e => set('d365_client_secret', e.target.value)} />
                </div>
                <div className="modal-field-group">
                  <label className="modal-field-label">Environment URL</label>
                  <input className="modal-input" placeholder="https://your-org.crm8.dynamics.com" value={form.d365_environment_url} onChange={e => set('d365_environment_url', e.target.value)} />
                </div>
                <div className="modal-field-group">
                  <label className="modal-field-label">Power Automate Environment ID <span style={{color:'var(--text-muted)',fontWeight:400}}>(optional)</span></label>
                  <input className="modal-input" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={form.power_platform_env_id} onChange={e => set('power_platform_env_id', e.target.value)} />
                  <span className="modal-hint">GUID from make.powerautomate.com/environments/<b>…</b>/flows — needed for direct flow links</span>
                </div>
                {d365Msg && <div className={`modal-msg ${d365Status === 'connected' ? 'modal-msg-ok' : 'modal-msg-err'}`}>{d365Status === 'connected' ? '✓' : '✗'} {d365Msg}</div>}
                <button className={`modal-btn-auth d365-btn${d365Status === 'connected' ? ' connected' : ''}`}
                  onClick={d365Status === 'connected' ? () => { setD365Status('idle'); setD365Msg(''); } : handleAuthorizeD365}
                  disabled={d365Status === 'authorizing'}>
                  {d365Status === 'authorizing' && <span className="btn-spinner" />}
                  {d365BtnLabel()}
                </button>
              </>
            ) : (
              <div className="modal-coming-soon">
                ℹ️ {TARGET_CRMS.find(c => c.id === form.target_crm)?.label} configuration coming soon.
              </div>
            )}
          </div>

          {/* ── Col 3: Fabric Data Lake (optional) ── */}
          <div className={`modal-card modal-card--fabric${form.fabric_enabled ? ' enabled' : ''}`}>
            <div className="modal-card-header">
              <div className="modal-card-title-row">
                <span className="modal-card-icon fabric-icon">⬡</span>
                <div>
                  <div className="modal-card-title">Fabric Data Lake</div>
                  <div className="modal-card-subtitle">Microsoft Fabric SQL</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {fabricStatus === 'connected' && <span className="badge badge-connected">✓</span>}
                {fabricStatus === 'error'     && <span className="badge badge-error">✗</span>}
                <label className="fabric-switch" title={form.fabric_enabled ? 'Disable Fabric' : 'Enable Fabric'}>
                  <input type="checkbox" checked={form.fabric_enabled} onChange={e => { set('fabric_enabled', e.target.checked); setFabricStatus('idle'); setFabricMsg(''); }} />
                  <span className="fabric-switch-track" />
                </label>
              </div>
            </div>

            {!form.fabric_enabled ? (
              <div className="fabric-disabled-hint">
                <span className="fabric-optional-badge">Optional</span>
                <p>Enable to connect your Microsoft Fabric Data Lake for field mapping and LLM-assisted migration.</p>
              </div>
            ) : (
              <>
                <div className="modal-field-group">
                  <label className="modal-field-label">Tenant ID</label>
                  <input className="modal-input" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={form.fabric_tenant_id} onChange={e => set('fabric_tenant_id', e.target.value)} />
                </div>
                <div className="modal-field-group">
                  <label className="modal-field-label">Service Principal ID</label>
                  <input className="modal-input" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={form.fabric_service_principal_id} onChange={e => set('fabric_service_principal_id', e.target.value)} />
                </div>
                <div className="modal-field-group">
                  <label className="modal-field-label">Service Principal Secret</label>
                  <input className="modal-input" type="password" placeholder="Enter secret" value={form.fabric_service_principal_secret} onChange={e => set('fabric_service_principal_secret', e.target.value)} />
                </div>
                <div className="modal-field-group">
                  <label className="modal-field-label">SQL Server Endpoint</label>
                  <input className="modal-input" placeholder="xxx.datawarehouse.fabric.microsoft.com" value={form.fabric_server} onChange={e => set('fabric_server', e.target.value)} />
                </div>
                <div className="modal-field-group">
                  <label className="modal-field-label">Database Name</label>
                  <input className="modal-input" placeholder="my_fabric_database" value={form.fabric_database} onChange={e => set('fabric_database', e.target.value)} />
                </div>
                {fabricMsg && <div className={`modal-msg ${fabricStatus === 'connected' ? 'modal-msg-ok' : 'modal-msg-err'}`}>{fabricStatus === 'connected' ? '✓' : '✗'} {fabricMsg}</div>}
                <button className={`modal-btn-auth fabric-btn${fabricStatus === 'connected' ? ' connected' : ''}`}
                  onClick={fabricStatus === 'connected' ? () => { setFabricStatus('idle'); setFabricMsg(''); } : handleTestFabric}
                  disabled={fabricStatus === 'testing'}>
                  {fabricStatus === 'testing' && <span className="btn-spinner" />}
                  {fabricBtnLabel()}
                </button>
              </>
            )}
          </div>

        </div>{/* end 3col grid */}

        {/* ── Footer ── */}
        <div className="modal-footer">
          <button className="modal-btn-cancel" onClick={onClose}>Cancel</button>
          <button className="modal-btn-save" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Back to Home'}
          </button>
        </div>
      </div>
    </div>
  );
}

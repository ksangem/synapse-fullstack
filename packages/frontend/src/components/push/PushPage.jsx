import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../../hooks/useToast';
import { api } from '../../services/api';
import DuplicatePushModal from './DuplicatePushModal';
import {
  btnStyle, btnPrimaryStyle, btnDangerStyle,
  labelStyle, inputStyle, selectStyle,
  thStyle, tdStyle,
} from '../connected/styles';

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */
export default function PushPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();

  // Integration list from backend
  const [connectedIntegrations, setConnectedIntegrations] = useState([]);
  const [loadingIntegrations, setLoadingIntegrations] = useState(true);

  // Form state
  const [selectedIntegration, setSelectedIntegration] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [listName, setListName] = useState('Nalashaa_Jira_Issues');
  const [sharepointUrl, setSharepointUrl] = useState('https://mynalashaa.sharepoint.com/sites/ResourceManagement');
  const [dateStart, setDateStart] = useState('2026-03-01');
  const [dateEnd, setDateEnd] = useState('2026-03-31');

  // Push result state
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState(null);
  const [pushError, setPushError] = useState(null);

  // Duplicate detection modal
  const [duplicateInfo, setDuplicateInfo] = useState(null);

  /* ---- Load connected integrations ---- */
  useEffect(() => {
    (async () => {
      const res = await api.getConnected();
      if (res.ok && res.data?.data) {
        setConnectedIntegrations(res.data.data);
      }
      setLoadingIntegrations(false);
    })();
  }, []);

  const selectedIntgObj = useMemo(
    () => connectedIntegrations.find((i) => i.integrationId === selectedIntegration) || null,
    [selectedIntegration, connectedIntegrations]
  );

  // Auto-fill form fields when integration is selected
  useEffect(() => {
    if (selectedIntgObj) {
      const fm = selectedIntgObj.fieldMappings || {};
      setProjectKey(fm.projectKey || '');
      setListName(fm.listName || 'Nalashaa_Jira_Issues');
      setSharepointUrl(fm.endpointUrl || '');
    }
  }, [selectedIntgObj]);

  const isFormValid = selectedIntegration && projectKey.trim() && listName.trim() && sharepointUrl.trim() && dateStart && dateEnd;

  /* ---- Build the push body ---- */
  const buildPushBody = (forceOverride = false) => ({
    integrationId: selectedIntegration,
    clientId: selectedIntgObj?.fieldMappings?.clientId || 'unknown',
    projectKey: projectKey.trim(),
    dateRangeStart: dateStart,
    dateRangeEnd: dateEnd,
    forceOverride,
    siteUrl: sharepointUrl.trim(),
    listName: listName.trim(),
  });

  /* ---- Handlers ---- */
  const handlePush = async () => {
    if (!isFormValid) return;

    setPushError(null);
    setPushResult(null);
    setPushing(true);

    const res = await api.pushProject(buildPushBody(false));
    setPushing(false);

    if (res.ok) {
      const d = res.data?.data || res.data;
      setPushResult({
        success: true,
        recordCount: d.recordCount ?? 0,
        pushId: d.pushLogId || d.pushId || '--',
        message: `Push started for ${projectKey.toUpperCase()} — ${d.recordCount ?? 0} records queued`,
      });
      showToast(`Push started for ${projectKey.toUpperCase()}`);
    } else if (res.status === 409 && res.data?.code === 'DUPLICATE_PUSH') {
      // Show duplicate modal
      setDuplicateInfo({
        projectKey: projectKey.trim().toUpperCase(),
        clientId: selectedIntgObj?.fieldMappings?.clientId,
        dateRangeStart: dateStart,
        dateRangeEnd: dateEnd,
        previousPush: res.data.previousPush,
      });
    } else {
      setPushError(res.data?.error || `Push failed (HTTP ${res.status})`);
    }
  };

  const handleForcePush = async () => {
    setDuplicateInfo(null);
    setPushError(null);
    setPushResult(null);
    setPushing(true);

    const res = await api.pushProject(buildPushBody(true));
    setPushing(false);

    if (res.ok) {
      const d = res.data?.data || res.data;
      setPushResult({
        success: true,
        recordCount: d.recordCount ?? 0,
        pushId: d.pushLogId || d.pushId || '--',
        message: `Force push started for ${projectKey.toUpperCase()} — overwriting existing data`,
      });
      showToast(`Force push started for ${projectKey.toUpperCase()}`);
    } else {
      setPushError(res.data?.error || `Force push failed (HTTP ${res.status})`);
    }
  };

  const handleResync = async (integrationId) => {
    setDuplicateInfo(null);
    const res = await api.triggerSync(integrationId, {
      mode: 'RESYNC_SAME',
      skipCompleted: true,
      deltaOnly: false,
    });
    if (res.ok || res.status === 202) {
      showToast(`Re-sync queued for ${projectKey.toUpperCase()}`);
    } else {
      showToast(res.data?.error || 'Failed to trigger re-sync');
    }
  };

  const resetForm = () => {
    setProjectKey('');
    setListName('Nalashaa_Jira_Issues');
    setSharepointUrl('https://mynalashaa.sharepoint.com/sites/ResourceManagement');
    setDateStart('2026-03-01');
    setDateEnd('2026-03-31');
    setPushResult(null);
    setPushError(null);
    setDuplicateInfo(null);
    setSelectedIntegration('');
  };

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */
  return (
    <div className="page active">
      {/* Header */}
      <div className="page-header">
        <div>
          <div className="page-title">Push New Project</div>
          <div className="page-subtitle">Push Jira project data to a SharePoint list</div>
        </div>
        <button style={btnStyle} onClick={() => navigate('/connected')}>
          View Connected Instances
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* =========================================================== */}
        {/*  Left column - Push form                                    */}
        {/* =========================================================== */}
        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ margin: '0 0 16px', fontSize: '1rem', fontWeight: 700 }}>
            Push Configuration
          </h3>

          {/* Integration selector */}
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Integration</label>
            <select
              style={selectStyle}
              value={selectedIntegration}
              onChange={(e) => setSelectedIntegration(e.target.value)}
            >
              <option value="">-- Select an integration --</option>
              {loadingIntegrations && <option disabled>Loading...</option>}
              {connectedIntegrations.map((intg) => (
                <option key={intg.integrationId} value={intg.integrationId}>
                  {intg.name} ({intg.fieldMappings?.projectKey || 'N/A'})
                </option>
              ))}
            </select>
            {selectedIntgObj && (
              <div style={{ fontSize: '.76rem', color: 'var(--text-dim)', marginTop: 4 }}>
                {selectedIntgObj.fieldMappings?.clientId} &middot; {selectedIntgObj.fieldMappings?.listName}
              </div>
            )}
          </div>

          {/* Project Key */}
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Jira Project Key</label>
            <input
              style={inputStyle}
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value.toUpperCase())}
              placeholder="e.g. FLAT, ONCO, CAS"
            />
          </div>

          {/* List Name */}
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>SharePoint List Name</label>
            <input
              style={inputStyle}
              value={listName}
              onChange={(e) => setListName(e.target.value)}
              placeholder="Nalashaa_Jira_Issues"
            />
          </div>

          {/* SharePoint URL */}
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>SharePoint Site URL</label>
            <input
              style={inputStyle}
              value={sharepointUrl}
              onChange={(e) => setSharepointUrl(e.target.value)}
              placeholder="https://mynalashaa.sharepoint.com/sites/..."
            />
          </div>

          {/* Date Range */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={labelStyle}>Date Range Start</label>
              <input
                type="date"
                style={inputStyle}
                value={dateStart}
                onChange={(e) => setDateStart(e.target.value)}
              />
            </div>
            <div>
              <label style={labelStyle}>Date Range End</label>
              <input
                type="date"
                style={inputStyle}
                value={dateEnd}
                onChange={(e) => setDateEnd(e.target.value)}
              />
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              style={{
                ...btnPrimaryStyle,
                opacity: isFormValid && !pushing ? 1 : 0.5,
                pointerEvents: isFormValid && !pushing ? 'auto' : 'none',
              }}
              onClick={handlePush}
              disabled={!isFormValid || pushing}
            >
              {pushing ? (
                <span>
                  <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite', marginRight: 6 }}>&#9696;</span>
                  Pushing...
                </span>
              ) : (
                '\u25B6 Push to SharePoint'
              )}
            </button>
            <button style={btnStyle} onClick={resetForm}>
              Reset
            </button>
          </div>

          {/* Push error display */}
          {pushError && (
            <div style={{ marginTop: 14, padding: '10px 14px', background: 'var(--error-dim)', border: '1px solid var(--error)', borderRadius: 8, fontSize: '.82rem', color: 'var(--error)' }}>
              <strong>Push Failed:</strong> {pushError}
            </div>
          )}
        </div>

        {/* =========================================================== */}
        {/*  Right column - Result / Preview                            */}
        {/* =========================================================== */}
        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ margin: '0 0 16px', fontSize: '1rem', fontWeight: 700 }}>
            Push Result
          </h3>

          {!pushResult && !pushing && (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-dim)' }}>
              <div style={{ fontSize: '2rem', marginBottom: 8 }}>&#128640;</div>
              <div style={{ fontSize: '.9rem', fontWeight: 600 }}>Ready to push</div>
              <div style={{ fontSize: '.82rem', marginTop: 4 }}>
                Fill in the configuration on the left and hit Push to sync Jira issues to SharePoint.
              </div>
            </div>
          )}

          {pushing && (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-dim)' }}>
              <div style={{ fontSize: '2rem', marginBottom: 8, animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>&#9696;</div>
              <div style={{ fontSize: '.9rem', fontWeight: 600, marginTop: 8 }}>Pushing data...</div>
              <div style={{ fontSize: '.82rem', marginTop: 4 }}>
                Fetching Jira issues for <strong>{projectKey}</strong> and writing to <strong>{listName}</strong>
              </div>
            </div>
          )}

          {pushResult && (
            <div>
              {/* Success banner */}
              <div style={{ padding: '12px 16px', background: 'var(--success-dim)', border: '1px solid var(--success)', borderRadius: 8, marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: '1.2rem' }}>&#9989;</span>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '.9rem', color: 'var(--success)' }}>Push Started</div>
                    <div style={{ fontSize: '.82rem', color: 'var(--text-secondary)', marginTop: 2 }}>{pushResult.message}</div>
                  </div>
                </div>
              </div>

              {/* Result details */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ padding: 12, background: 'var(--bg-main)', borderRadius: 6 }}>
                  <div style={labelStyle}>Push ID</div>
                  <div style={{ fontSize: '.85rem', fontFamily: 'monospace' }}>{pushResult.pushId}</div>
                </div>
                <div style={{ padding: 12, background: 'var(--bg-main)', borderRadius: 6 }}>
                  <div style={labelStyle}>Records Queued</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--primary)' }}>{pushResult.recordCount}</div>
                </div>
                <div style={{ padding: 12, background: 'var(--bg-main)', borderRadius: 6 }}>
                  <div style={labelStyle}>Project Key</div>
                  <div style={{ fontSize: '.85rem', fontWeight: 600 }}>{projectKey}</div>
                </div>
                <div style={{ padding: 12, background: 'var(--bg-main)', borderRadius: 6 }}>
                  <div style={labelStyle}>Date Range</div>
                  <div style={{ fontSize: '.85rem' }}>{dateStart} &rarr; {dateEnd}</div>
                </div>
                <div style={{ padding: 12, background: 'var(--bg-main)', borderRadius: 6, gridColumn: '1 / -1' }}>
                  <div style={labelStyle}>Destination</div>
                  <div style={{ fontSize: '.85rem' }}>{listName} @ {sharepointUrl}</div>
                </div>
              </div>

              {/* Post-push actions */}
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button style={btnPrimaryStyle} onClick={() => navigate('/connected')}>
                  View in Connected
                </button>
                <button style={btnStyle} onClick={resetForm}>
                  Push Another
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* =========================================================== */}
      {/*  Available integrations reference table                      */}
      {/* =========================================================== */}
      {connectedIntegrations.length > 0 && (
        <div className="card" style={{ marginTop: 20, padding: 20 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: '1rem', fontWeight: 700 }}>
            Connected Integrations
          </h3>
          <div className="table-wrap">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Project</th>
                  <th style={thStyle}>SharePoint List</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {connectedIntegrations.map((intg) => (
                  <tr key={intg.integrationId}>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>{intg.name}</td>
                    <td style={tdStyle}>{intg.fieldMappings?.projectKey || '--'}</td>
                    <td style={tdStyle}>{intg.fieldMappings?.listName || '--'}</td>
                    <td style={tdStyle}>
                      <span
                        style={{
                          display: 'inline-block', width: 8, height: 8,
                          borderRadius: '50%', marginRight: 6,
                          background: intg.status === 'active' ? 'var(--success)' : 'var(--warning)',
                        }}
                      />
                      {intg.status}
                    </td>
                    <td style={tdStyle}>
                      <button
                        style={{ ...btnStyle, fontSize: '.76rem', padding: '3px 10px' }}
                        onClick={() => {
                          setSelectedIntegration(intg.integrationId);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                      >
                        Select
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/*  Duplicate Push Modal                                        */}
      {/* ============================================================ */}
      {duplicateInfo && (
        <DuplicatePushModal
          duplicateInfo={duplicateInfo}
          integrationId={selectedIntegration}
          onCancel={() => setDuplicateInfo(null)}
          onResync={handleResync}
          onForcePush={handleForcePush}
        />
      )}
    </div>
  );
}
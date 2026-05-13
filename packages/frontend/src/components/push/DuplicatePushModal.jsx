import React, { useState } from 'react';
import {
  btnStyle, btnPrimaryStyle, btnDangerStyle,
  overlayStyle, modalStyle, labelStyle, fmtDate,
} from '../connected/styles';

/**
 * Shown when api.pushProject() returns 409 DUPLICATE_PUSH.
 *
 * Props:
 *   duplicateInfo   – { projectKey, clientId, dateRangeStart, dateRangeEnd, previousPush: { id, pushedAt, recordCount } }
 *   integrationId   – for the re-sync call
 *   onCancel        – close modal
 *   onResync        – (integrationId) => void  — triggers re-sync
 *   onForcePush     – () => void               — retries push with forceOverride: true
 */
export default function DuplicatePushModal({ duplicateInfo, integrationId, onCancel, onResync, onForcePush }) {
  const [acting, setActing] = useState(null); // 'resync' | 'force' | null

  const handleResync = async () => {
    setActing('resync');
    await onResync(integrationId);
    setActing(null);
  };

  const handleForce = async () => {
    setActing('force');
    await onForcePush();
    setActing(null);
  };

  const prev = duplicateInfo.previousPush || {};

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: '1.05rem', color: 'var(--warning)' }}>
            &#9888; Duplicate Push Detected
          </h3>
          <button
            style={{ background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: 'var(--text-dim)' }}
            onClick={onCancel}
          >
            &times;
          </button>
        </div>

        {/* Description */}
        <div style={{ fontSize: '.88rem', marginBottom: 16, lineHeight: 1.5 }}>
          A push already exists for project <strong>{duplicateInfo.projectKey}</strong> covering
          the date range <strong>{duplicateInfo.dateRangeStart}</strong> &rarr; <strong>{duplicateInfo.dateRangeEnd}</strong>.
        </div>

        {/* Previous push details */}
        <div style={{ padding: '10px 14px', background: 'var(--warning-dim)', borderRadius: 8, marginBottom: 16, fontSize: '.82rem' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Previous Push</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <div>
              <span style={{ color: 'var(--text-dim)' }}>Push ID: </span>
              <span style={{ fontFamily: 'monospace' }}>{prev.id || '--'}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-dim)' }}>Records: </span>
              <span style={{ fontWeight: 600 }}>{prev.recordCount ?? '--'}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-dim)' }}>Pushed At: </span>
              <span>{fmtDate(prev.pushedAt)}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-dim)' }}>Project: </span>
              <span style={{ fontWeight: 600 }}>{duplicateInfo.projectKey}</span>
            </div>
          </div>
        </div>

        {/* Help text */}
        <div style={{ fontSize: '.82rem', color: 'var(--text-dim)', marginBottom: 16 }}>
          <strong>Re-sync</strong> will run a delta sync to update only changed records.
          <strong> Force Push</strong> will overwrite the existing data entirely.
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button style={btnStyle} onClick={onCancel} disabled={!!acting}>
            Cancel
          </button>
          <button
            style={{ ...btnPrimaryStyle, opacity: acting ? 0.5 : 1 }}
            onClick={handleResync}
            disabled={!!acting}
          >
            {acting === 'resync' ? 'Starting sync...' : '\u21BB Re-sync'}
          </button>
          <button
            style={{ ...btnDangerStyle, opacity: acting ? 0.5 : 1 }}
            onClick={handleForce}
            disabled={!!acting}
          >
            {acting === 'force' ? 'Pushing...' : 'Force Push'}
          </button>
        </div>
      </div>
    </div>
  );
}
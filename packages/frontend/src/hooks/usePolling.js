import { useEffect, useRef } from 'react';
import { api } from '../services/api';

/**
 * Polls api.getSyncState(integrationId) every `interval` ms while `enabled` is true.
 * Stops automatically when sync_status reaches COMPLETED or FAILED.
 * Calls `onUpdate(syncState)` on every successful poll.
 * Calls `onTerminal(syncState)` once when a terminal status is reached.
 */
export function usePolling(integrationId, enabled, { interval = 5000, onUpdate, onTerminal } = {}) {
  const timerRef = useRef(null);
  const stoppedRef = useRef(false);
  // Latest-callback refs: onUpdate/onTerminal are usually inline lambdas that change every
  // render. Reading them through refs keeps the poll from restarting on every render — the
  // effect intentionally re-runs only when integrationId/enabled/interval change.
  const onUpdateRef = useRef(onUpdate);
  const onTerminalRef = useRef(onTerminal);
  useEffect(() => { onUpdateRef.current = onUpdate; onTerminalRef.current = onTerminal; });

  useEffect(() => {
    if (!enabled || !integrationId) {
      clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }

    stoppedRef.current = false;

    const poll = async () => {
      if (stoppedRef.current) return;
      const res = await api.getSyncState(integrationId);
      if (!res.ok || !res.data?.data) return;

      const syncState = res.data.data;
      onUpdateRef.current?.(syncState);

      if (syncState.syncStatus === 'COMPLETED' || syncState.syncStatus === 'FAILED') {
        stoppedRef.current = true;
        clearInterval(timerRef.current);
        timerRef.current = null;
        onTerminalRef.current?.(syncState);
      }
    };

    // Immediately poll once, then set interval
    poll();
    timerRef.current = setInterval(poll, interval);

    return () => {
      clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [integrationId, enabled, interval]);
}
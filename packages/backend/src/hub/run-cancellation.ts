/**
 * run-cancellation — cooperative "stop" for in-flight bus runs.
 *
 * A "Stop run" sets an in-process flag (and the run's DB status → 'cancelled').
 * Two places honour it:
 *   • the publish loop (run-integration) checks isRunCancelled() per record and
 *     stops queuing the rest — so records 17→N are never even enqueued;
 *   • the dispatch worker checks it per job and SKIPS delivery of any envelope
 *     whose run was cancelled (recording it as 'skipped' on the ledger).
 *
 * Because each envelope is idempotent and destinations upsert by key, a half-done
 * run is safe to stop: already-delivered records are simply kept (no duplicates).
 *
 * In-process state is sufficient here — the API server and the BullMQ workers
 * share one Node process in this deployment. The accompanying DB status flip
 * (see run-recorder.cancelRun) is what makes the cancel visible to run-status and
 * would carry the signal across processes if the workers are ever split out.
 */

/** runIds that have been asked to stop. Tiny strings; never auto-pruned so a
 *  late-arriving queued job for a cancelled run is still skipped. */
const cancelled = new Set<string>();

/** Live source-read AbortControllers, so a stop can also interrupt an in-progress
 *  source fetch (not just the publish loop between records). */
const controllers = new Map<string, AbortController>();

export function registerRunController(runId: string, controller: AbortController): void {
  controllers.set(runId, controller);
}

export function clearRunController(runId: string): void {
  controllers.delete(runId);
}

/** Request cancellation: flag the run and abort its source read if one is live. */
export function markRunCancelled(runId: string): void {
  cancelled.add(runId);
  controllers.get(runId)?.abort();
}

export function isRunCancelled(runId: string | undefined | null): boolean {
  return !!runId && cancelled.has(runId);
}

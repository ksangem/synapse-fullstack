/**
 * Request/activity logger — one line per API call so the backend's work is visible
 * instead of silent. Logs method, path, final status, and duration on response finish;
 * flags slow calls (>2s) and errors (>=400) distinctly so they stand out in a tail.
 *
 * This exists because pushes/syncs previously produced no per-request output, making a
 * slow or hung call indistinguishable from "nothing happening". Mounted in index.ts.
 */
import type { Request, Response, NextFunction } from 'express';

const SLOW_MS = 2000;

function ts(): string {
  // Local wall-clock time, HH:MM:SS.mmm — enough to correlate with the UI.
  return new Date().toISOString().slice(11, 23);
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const { method, originalUrl } = req;

  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const slow = ms >= SLOW_MS ? '  ⏱ SLOW' : '';
    const tag = status >= 500 ? 'ERR ' : status >= 400 ? 'WARN' : 'OK  ';
    console.log(`[${ts()}] ${tag} ${method} ${originalUrl} → ${status} (${ms}ms)${slow}`);
  });

  // Connection dropped before a response was sent (client gave up / hung call aborted).
  res.on('close', () => {
    if (!res.writableEnded) {
      const ms = Date.now() - start;
      console.log(`[${ts()}] ABRT ${method} ${originalUrl} → client closed, no response (${ms}ms)`);
    }
  });

  next();
}

/** Terminal error handler — logs anything that bubbles up unhandled, then 500s. */
export function errorLogger(
  err: unknown, req: Request, res: Response, _next: NextFunction
): void {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  console.error(`[${ts()}] ERR  ${req.method} ${req.originalUrl} threw:\n${msg}`);
  if (!res.headersSent) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

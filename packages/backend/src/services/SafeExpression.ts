/**
 * SafeExpression — run user-written mapping expressions in an ISOLATED sandbox.
 *
 * BRD §7.3 / §7.8: never `eval` untrusted code on the main process. We use
 * quickjs-emscripten — a JS engine compiled to WASM — so an expression runs in a
 * separate VM with NO access to Node globals (process/require/fetch/fs), bounded
 * memory, and a wall-clock interrupt (infinite loops are killed). The expression is
 * a function body (`return ...;`) and receives only the `source` object.
 *
 * The WASM module loads asynchronously once (initSandbox, called at hub startup);
 * after that, evalExpression is synchronous so the per-record mapper stays sync.
 */
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

type Mod = Awaited<ReturnType<typeof getQuickJS>>;
type Rt = ReturnType<Mod['newRuntime']>;
type Ctx = ReturnType<Rt['newContext']>;

const TIME_LIMIT_MS = 1000;
const MEM_LIMIT_BYTES = 32 * 1024 * 1024;
const RECYCLE_EVERY = 1000; // recreate the context periodically to bound any global growth

let modPromise: Promise<Mod> | null = null;
let runtime: Rt | null = null;
let ctx: Ctx | null = null;
let evalCount = 0;

/** Load the WASM engine + a runtime/context once. Call at startup before any mapping. */
export async function initSandbox(): Promise<void> {
  if (!modPromise) modPromise = getQuickJS();
  const mod = await modPromise;
  if (!runtime) {
    runtime = mod.newRuntime();
    runtime.setMemoryLimit(MEM_LIMIT_BYTES);
    ctx = runtime.newContext();
  }
}

export function isSandboxReady(): boolean {
  return !!ctx && !!runtime;
}

function recycleContext(): void {
  if (ctx) ctx.dispose();
  ctx = runtime!.newContext();
  evalCount = 0;
}

/**
 * Evaluate `expr` (a function body) against `source` in isolation; returns the JS value.
 * Throws on syntax error, runtime error, timeout, or OOM — the caller decides the fallback.
 */
export function evalExpression(expr: string, source: Record<string, unknown>): unknown {
  if (!ctx || !runtime) throw new Error('Expression sandbox not initialized');
  if (++evalCount > RECYCLE_EVERY) recycleContext();

  // Fresh deadline per eval (the interrupt handler lives on the runtime).
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + TIME_LIMIT_MS));

  // source is built from already-extracted scalars, so it's JSON-safe.
  const code = `(function(source){ ${expr} })(${JSON.stringify(source ?? {})})`;
  const res = ctx.evalCode(code);
  if (res.error) {
    const detail = ctx.dump(res.error) as { message?: string } | string;
    res.error.dispose();
    throw new Error(`expression failed: ${typeof detail === 'object' ? (detail.message ?? JSON.stringify(detail)) : String(detail)}`);
  }
  const value = ctx.dump(res.value);
  res.value.dispose();
  return value;
}

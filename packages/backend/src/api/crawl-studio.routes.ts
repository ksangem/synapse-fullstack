/**
 * Crawl Studio routes — drive the streamed server browser used by the recorder.
 *
 * The live screencast frames + input flow over a WebSocket (see index.ts); these
 * REST endpoints manage the session lifecycle and persist what the designer
 * captures onto the connector draft:
 *   - save-auth   → encrypt the storageState and store as the connector's session
 *   - save-recipe → store the recorded steps + field selectors
 *   - replay-test → re-run the recipe headless and return extracted records
 */
import { Router, type Request, type Response } from 'express';
import { browserStreamService } from '../services/runtime/BrowserStreamService';
import { stepReplayer } from '../services/runtime/StepReplayer';
import { connectorService } from '../services/ConnectorService';
import { connectorAuthoringService } from '../services/ConnectorAuthoringService';
import { CredentialService } from '../services/CredentialService';
import type { FieldCandidate } from '../services/runtime/BrowserStreamService';

const router = Router();
const credentialService = new CredentialService();

function fail(res: Response, err: unknown, code = 400) {
  res.status(code).json({ success: false, error: err instanceof Error ? err.message : String(err) });
}

// Turn a captured label into a clean snake_case field name.
function slug(s: string): string {
  return (s || 'field').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
}
const NOISE = /^(menu|skip to|search|home|settings|help|notifications?|loading|breadcrumb|sign ?in|log ?out|toggle|close|open|back|next|previous|more)\b/i;
function toField(c: FieldCandidate, used: Set<string>) {
  let name = slug(c.label || c.sample);
  while (used.has(name)) name = `${name}_2`;
  used.add(name);
  return { label: c.label, name, selector: c.selector, sample: c.sample, attr: c.attr ?? null, keep: !!c.sample && !NOISE.test(c.label || '') };
}

/** Merge a patch into the draft version's runtimeConfig.categoryConfig and persist. */
async function patchCategoryConfig(connectorId: string, versionId: string, patch: Record<string, unknown>) {
  const version = await connectorService.getVersion(connectorId, versionId);
  const rc = (version?.runtimeConfig as Record<string, unknown>) ?? {};
  const categoryConfig = { ...((rc.categoryConfig as Record<string, unknown>) ?? {}), ...patch };
  await connectorAuthoringService.updateVersion(versionId, { runtimeConfig: { ...rc, runtimeKind: rc.runtimeKind ?? 'scrape', categoryConfig } });
}

// Start a live browser session (optionally seeded with the connector's saved session).
router.post('/session', async (req: Request, res: Response) => {
  try {
    const { startUrl, connectorId, versionId } = req.body ?? {};
    let storageState = null;
    if (connectorId) {
      const version = await connectorService.getVersion(connectorId, versionId);
      const enc = (version?.runtimeConfig as { categoryConfig?: { sessionState?: string } })?.categoryConfig?.sessionState;
      if (enc) { try { storageState = JSON.parse(credentialService.decrypt(enc)); } catch { /* corrupt/none */ } }
    }
    const { sessionId } = await browserStreamService.createSession({ startUrl, storageState });
    res.json({ success: true, data: { sessionId } });
  } catch (err) { fail(res, err); }
});

router.post('/session/:id/navigate', async (req: Request, res: Response) => {
  try { await browserStreamService.navigate(String(req.params.id), req.body?.url); res.json({ success: true }); }
  catch (err) { fail(res, err); }
});

router.post('/session/:id/record/start', (req: Request, res: Response) => {
  try { browserStreamService.startRecording(String(req.params.id)); res.json({ success: true }); }
  catch (err) { fail(res, err); }
});

router.post('/session/:id/record/stop', (req: Request, res: Response) => {
  try { const steps = browserStreamService.stopRecording(String(req.params.id)); res.json({ success: true, data: { steps } }); }
  catch (err) { fail(res, err); }
});

router.get('/session/:id/steps', (req: Request, res: Response) => {
  try { res.json({ success: true, data: { steps: browserStreamService.getSteps(String(req.params.id)), url: browserStreamService.currentUrl(String(req.params.id)) } }); }
  catch (err) { fail(res, err); }
});

// Toggle the in-page hover highlight (designer enters/leaves "pick fields" mode).
router.post('/session/:id/pick-mode', async (req: Request, res: Response) => {
  try { await browserStreamService.setPickMode(String(req.params.id), !!req.body?.on); res.json({ success: true }); }
  catch (err) { fail(res, err); }
});

// Pick the element currently under the cursor (designer pressed S). Returns one
// field, auto-labelled from page metadata — the designer renames it afterwards.
router.post('/session/:id/pick', async (req: Request, res: Response) => {
  try {
    const hov = await browserStreamService.pickHovered(String(req.params.id));
    if (!hov) { res.json({ success: false, error: 'Nothing under the cursor — hover a value, then press S.' }); return; }
    res.json({ success: true, data: { field: toField(hov, new Set()) } });
  } catch (err) { fail(res, err); }
});

// Optional bulk grab: deterministically scan the whole page for label→value pairs.
router.post('/session/:id/scan-fields', async (req: Request, res: Response) => {
  try {
    const scan = await browserStreamService.suggestFields(String(req.params.id));
    const used = new Set<string>();
    const fields = scan.candidates.map((c) => toField(c, used));
    res.json({ success: true, data: { url: scan.url, title: scan.title, fields } });
  } catch (err) { fail(res, err); }
});

// Scan the live page for embedded JSON blobs (Next.js, Apollo, ld+json, app globals)
// so the designer can pick a `script-json` source without hunting through the DOM.
router.post('/session/:id/detect-json', async (req: Request, res: Response) => {
  try {
    const candidates = await browserStreamService.detectJsonSources(String(req.params.id));
    res.json({ success: true, data: { candidates } });
  } catch (err) { fail(res, err); }
});

// Capture the authenticated session → encrypt → store as the connector's reusable creds.
router.post('/session/:id/save-auth', async (req: Request, res: Response) => {
  try {
    const { connectorId, versionId } = req.body ?? {};
    if (!connectorId || !versionId) { fail(res, 'connectorId and versionId required'); return; }
    const storageState = await browserStreamService.saveAuth(String(req.params.id));
    const enc = credentialService.encrypt(JSON.stringify(storageState));
    await patchCategoryConfig(connectorId, versionId, { sessionState: enc, authMode: 'Recorded Session' });
    // The authenticated session is now baked into the connector, so the operator
    // has nothing to enter — strip the login credential fields down to an optional name.
    await connectorAuthoringService.updateVersion(versionId, {
      credentialSchema: { version: 1, fields: [{ key: 'connectionName', label: 'Connection Name (optional)', type: 'text' }] },
    });
    const cookieCount = Array.isArray(storageState.cookies) ? storageState.cookies.length : 0;
    res.json({ success: true, data: { cookieCount } });
  } catch (err) { fail(res, err); }
});

// Persist the recorded steps + field selectors as the connector's crawl recipe.
router.post('/session/:id/save-recipe', async (req: Request, res: Response) => {
  try {
    const { connectorId, versionId, rowSelector, selectors, fields, jsonSource } = req.body ?? {};
    if (!connectorId || !versionId) { fail(res, 'connectorId and versionId required'); return; }
    const steps = browserStreamService.getSteps(String(req.params.id));
    const js = jsonSource && (jsonSource.scriptSelector || jsonSource.jsonVar) ? jsonSource : undefined;
    await patchCategoryConfig(connectorId, versionId, {
      recipe: { steps, rowSelector: rowSelector || '', selectors: selectors || {}, fields: Array.isArray(fields) ? fields : [], jsonSource: js },
    });
    res.json({ success: true, data: { stepCount: steps.length } });
  } catch (err) { fail(res, err); }
});

router.delete('/session/:id', async (req: Request, res: Response) => {
  try { await browserStreamService.closeSession(String(req.params.id)); res.json({ success: true }); }
  catch (err) { fail(res, err); }
});

// Test/Validate: re-run the saved recipe headless (with the saved session) and
// return extracted records, so the designer can confirm values are still alive.
router.post('/replay-test', async (req: Request, res: Response) => {
  try {
    const { connectorId, versionId } = req.body ?? {};
    const version = await connectorService.getVersion(connectorId, versionId);
    const cc = (version?.runtimeConfig as { categoryConfig?: Record<string, unknown> })?.categoryConfig ?? {};
    const recipe = (cc.recipe as { steps?: unknown[]; rowSelector?: string; selectors?: Record<string, string>; fields?: import('../services/runtime/fieldTransform').FieldRule[]; jsonSource?: import('../services/runtime/CrawlEngine').JsonSource }) ?? {};
    if (!recipe.steps?.length) { fail(res, 'No recorded recipe on this connector version'); return; }
    let storageState = null;
    if (typeof cc.sessionState === 'string') { try { storageState = JSON.parse(credentialService.decrypt(cc.sessionState)); } catch { /* none */ } }
    const result = await stepReplayer.replay({
      steps: recipe.steps as never, rowSelector: recipe.rowSelector, selectors: recipe.selectors ?? {}, fields: recipe.fields, jsonSource: recipe.jsonSource,
      storageState, paceMs: 400,
    });
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err); }
});

export default router;

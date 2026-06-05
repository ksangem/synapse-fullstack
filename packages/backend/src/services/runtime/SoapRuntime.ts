/**
 * SoapRuntime — SOAP / WSDL web service (legacy SAP, TFS SOAP, Dynamics AX).
 * SOAP is RPC, not list-oriented, so "fetch" = invoke a configured operation
 * with arguments and wrap the result as a record; "discoverEntities" = the WSDL
 * operations. Uses strong-soap (dynamic import).
 *
 * runtimeConfig.categoryConfig: { wsdlUrl, operation, args (JSON), resultPath }
 * creds may override wsdlUrl / operation / args.
 */
import { connectorService } from '../ConnectorService';
import type { IConnectorRuntime, RuntimeCapabilities, RuntimeContext, Creds, TestResult, FetchResult, PushResult, EntitySummary, FieldDef } from './types';

interface SoapConfig { runtimeKind: string; categoryConfig?: Record<string, string> }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class SoapRuntime implements IConnectorRuntime {
  readonly kind = 'soap';
  readonly capabilities: RuntimeCapabilities = {
    scopeLabel: null, supportsDateWindow: false, entitySelectionMode: 'list',
    hasDdlPreview: false, hasQuickView: false, pushIsAsync: false,
    canTestAtDesignTime: true, role: 'both', ingestModel: 'pull', lifecycle: 'request',
  };

  private async cfg(ctx: RuntimeContext): Promise<Record<string, string>> {
    const version = await connectorService.getVersion(ctx.connectorId, ctx.versionId);
    const rc = (version?.runtimeConfig as SoapConfig) ?? { runtimeKind: 'soap' };
    return rc.categoryConfig ?? {};
  }

  private async client(wsdlUrl: string): Promise<Record<string, (args: unknown, cb: (e: unknown, r: unknown) => void) => void> & { describe(): unknown }> {
    if (!wsdlUrl) throw new Error('No WSDL URL configured');
    const mod = await import('strong-soap');
    const soap = (mod as { soap?: unknown }).soap ?? (mod as { default?: { soap?: unknown } }).default?.soap ?? mod;
    return new Promise((resolve, reject) => {
      (soap as { createClient(u: string, o: unknown, cb: (e: unknown, c: unknown) => void): void })
        .createClient(wsdlUrl, {}, (err: unknown, c: unknown) => (err ? reject(err) : resolve(c as never)));
    });
  }

  private opNames(describe: unknown): string[] {
    const out: string[] = [];
    if (!isRecord(describe)) return out;
    for (const svc of Object.values(describe)) {
      if (!isRecord(svc)) continue;
      for (const port of Object.values(svc)) {
        if (isRecord(port)) out.push(...Object.keys(port));
      }
    }
    return [...new Set(out)];
  }

  async test(creds: Creds, ctx: RuntimeContext): Promise<TestResult> {
    const cfg = await this.cfg(ctx);
    try {
      const client = await this.client(creds.wsdlUrl || cfg.wsdlUrl);
      const ops = this.opNames(client.describe());
      return { ok: true, sampleCount: ops.length, message: `WSDL parsed — ${ops.length} operations` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async discoverEntities(creds: Creds, ctx: RuntimeContext): Promise<EntitySummary[]> {
    const cfg = await this.cfg(ctx);
    try {
      const client = await this.client(creds.wsdlUrl || cfg.wsdlUrl);
      return this.opNames(client.describe()).map((op) => ({ key: op, name: op, description: 'SOAP operation' }));
    } catch {
      return [{ key: 'operation', name: 'Operation' }];
    }
  }

  async discoverFields(): Promise<FieldDef[]> { return []; }

  async fetch(creds: Creds, entityKey: string, ctx: RuntimeContext): Promise<FetchResult> {
    const cfg = await this.cfg(ctx);
    const operation = creds.operation || cfg.operation || entityKey;
    if (!operation) throw new Error('No SOAP operation configured');
    let args: unknown = {};
    const argsRaw = creds.args || cfg.args;
    if (argsRaw) { try { args = JSON.parse(argsRaw); } catch { throw new Error('SOAP args is not valid JSON'); } }
    const client = await this.client(creds.wsdlUrl || cfg.wsdlUrl);
    const method = client[operation];
    if (typeof method !== 'function') throw new Error(`Operation "${operation}" not found in WSDL`);
    const result = await new Promise<unknown>((resolve, reject) => method(args, (e: unknown, r: unknown) => (e ? reject(e) : resolve(r))));
    const records = isRecord(result) ? [result] : [{ result }];
    return { records, totalCount: records.length };
  }

  async push(): Promise<PushResult> {
    throw new Error('SOAP write is not wired yet in this build.');
  }
}

export const soapRuntime = new SoapRuntime();

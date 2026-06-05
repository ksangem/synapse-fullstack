/**
 * EmailRuntime — IMAP mailbox source (Outlook/Gmail/Generic IMAP) via imapflow.
 * Reads message envelopes (from/subject/date) as records. Send (SMTP) is a
 * follow-up. Polling model; source-only. Live-verifiable only with a real
 * mailbox, so it's structurally complete and errors clearly on bad creds.
 *
 * runtimeConfig.categoryConfig: { provider, imapHost, imapPort, mailbox }
 * creds: { host, port, username, password, mailbox }  (creds override config)
 */
import { connectorService } from '../ConnectorService';
import type { IConnectorRuntime, RuntimeCapabilities, RuntimeContext, Creds, TestResult, FetchResult, PushResult, EntitySummary, FieldDef } from './types';

interface EmailConfig { runtimeKind: string; categoryConfig?: Record<string, string> }

const PROVIDER_HOST: Record<string, { host: string; port: number }> = {
  'outlook 365': { host: 'outlook.office365.com', port: 993 },
  gmail: { host: 'imap.gmail.com', port: 993 },
};

export class EmailRuntime implements IConnectorRuntime {
  readonly kind = 'email';
  readonly capabilities: RuntimeCapabilities = {
    scopeLabel: null, supportsDateWindow: true, entitySelectionMode: 'list',
    hasDdlPreview: false, hasQuickView: false, pushIsAsync: false,
    canTestAtDesignTime: false, role: 'source', ingestModel: 'pull', lifecycle: 'long-running',
  };

  private async cfg(ctx: RuntimeContext): Promise<Record<string, string>> {
    const version = await connectorService.getVersion(ctx.connectorId, ctx.versionId);
    const rc = (version?.runtimeConfig as EmailConfig) ?? { runtimeKind: 'email' };
    return rc.categoryConfig ?? {};
  }

  private conn(cfg: Record<string, string>, creds: Creds) {
    const provider = (creds.provider || cfg.provider || '').toLowerCase();
    const preset = PROVIDER_HOST[provider];
    const host = creds.host || cfg.imapHost || preset?.host;
    const port = Number(creds.port || cfg.imapPort || preset?.port || 993);
    const mailbox = creds.mailbox || cfg.mailbox || 'INBOX';
    if (!host) throw new Error('No IMAP host configured');
    return { host, port, mailbox, user: creds.username, pass: creds.password };
  }

  private async withClient<T>(cfg: Record<string, string>, creds: Creds, fn: (client: unknown, mailbox: string) => Promise<T>): Promise<T> {
    const { host, port, mailbox, user, pass } = this.conn(cfg, creds);
    const mod = await import('imapflow');
    const ImapFlow = (mod as { ImapFlow: new (o: unknown) => { connect(): Promise<void>; logout(): Promise<void>; getMailboxLock(m: string): Promise<{ release(): void }>; mailbox: { exists: number }; fetch(range: string, opts: unknown): AsyncIterable<unknown> } }).ImapFlow;
    const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    try { return await fn(client, mailbox); } finally { lock.release(); await client.logout(); }
  }

  async test(creds: Creds, ctx: RuntimeContext): Promise<TestResult> {
    try {
      const count = await this.withClient(await this.cfg(ctx), creds, async (client) => (client as { mailbox: { exists: number } }).mailbox.exists);
      return { ok: true, sampleCount: count, message: `Connected — ${count} messages` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async discoverEntities(): Promise<EntitySummary[]> {
    return [{ key: 'messages', name: 'Messages', description: 'Mailbox messages' }];
  }

  async discoverFields(): Promise<FieldDef[]> {
    return [{ name: 'from', type: 'string' }, { name: 'subject', type: 'string' }, { name: 'date', type: 'datetime' }, { name: 'messageId', type: 'string' }];
  }

  async fetch(creds: Creds, _entityKey: string, ctx: RuntimeContext, opts?: Record<string, unknown>): Promise<FetchResult> {
    const limit = Number(opts?.limit ?? 50);
    const records = await this.withClient(await this.cfg(ctx), creds, async (client) => {
      const c = client as { mailbox: { exists: number }; fetch(range: string, o: unknown): AsyncIterable<{ envelope?: { from?: Array<{ address?: string }>; subject?: string; date?: Date; messageId?: string } }> };
      const total = c.mailbox.exists;
      if (!total) return [];
      const start = Math.max(1, total - limit + 1);
      const out: Record<string, unknown>[] = [];
      for await (const msg of c.fetch(`${start}:*`, { envelope: true })) {
        const e = msg.envelope ?? {};
        out.push({ from: e.from?.[0]?.address ?? null, subject: e.subject ?? null, date: e.date ? new Date(e.date).toISOString() : null, messageId: e.messageId ?? null });
      }
      return out;
    });
    return { records, totalCount: records.length };
  }

  async push(): Promise<PushResult> {
    throw new Error('Email send (SMTP) is not wired yet in this build.');
  }
}

export const emailRuntime = new EmailRuntime();

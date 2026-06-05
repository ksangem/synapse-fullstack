/**
 * MqRuntime — message queue / event bus source (streaming-consumer category).
 *
 * Phase-6 MVP over Redis Streams (Redis is part of the stack; ioredis is already
 * a dependency). `fetch` PEEKS messages (XRANGE, non-destructive) for the Wizard
 * preview / drain; a continuous, offset-committing consumer worker (XREADGROUP +
 * XACK → hub inbox) is the follow-up for true streaming. Kafka / RabbitMQ / SQS
 * are recognized but return a clear "not wired yet" error until their client is
 * added. Source-only.
 *
 * runtimeConfig.categoryConfig: { technology, brokerUrl, topic, batchSize }
 * creds may override brokerUrl / topic.
 */
import { connectorService } from '../ConnectorService';
import type { IConnectorRuntime, RuntimeCapabilities, RuntimeContext, Creds, TestResult, FetchResult, PushResult, EntitySummary, FieldDef } from './types';

interface MqConfig { runtimeKind: string; categoryConfig?: Record<string, string> }
type RedisCtor = new (url: string) => { ping(): Promise<string>; xlen(k: string): Promise<number>; xrange(k: string, start: string, end: string, ...args: unknown[]): Promise<Array<[string, string[]]>>; quit(): Promise<unknown> };

const REDIS_TECHS = ['redis streams', 'redis pub-sub', 'redis'];

function entryToRecord(id: string, kv: string[]): Record<string, unknown> {
  const obj: Record<string, unknown> = { _id: id };
  for (let i = 0; i < kv.length; i += 2) obj[kv[i]!] = kv[i + 1];
  for (const k of ['payload', 'data', 'body', 'value', 'json']) {
    const v = obj[k];
    if (typeof v === 'string') {
      try { const p = JSON.parse(v); if (p && typeof p === 'object' && !Array.isArray(p)) return { _id: id, ...(p as Record<string, unknown>) }; } catch { /* keep raw */ }
    }
  }
  return obj;
}

export class MqRuntime implements IConnectorRuntime {
  readonly kind = 'mq';
  readonly capabilities: RuntimeCapabilities = {
    scopeLabel: null, supportsDateWindow: false, entitySelectionMode: 'list',
    hasDdlPreview: false, hasQuickView: false, pushIsAsync: false,
    canTestAtDesignTime: false, role: 'source', ingestModel: 'streaming-consumer', lifecycle: 'long-running',
  };

  private async cfg(ctx: RuntimeContext): Promise<Record<string, string>> {
    const version = await connectorService.getVersion(ctx.connectorId, ctx.versionId);
    const rc = (version?.runtimeConfig as MqConfig) ?? { runtimeKind: 'mq' };
    return rc.categoryConfig ?? {};
  }

  private resolve(cfg: Record<string, string>, creds: Creds) {
    const tech = (creds.technology || cfg.technology || 'Redis Streams').toLowerCase();
    if (!REDIS_TECHS.includes(tech)) {
      throw new Error(`Queue technology "${cfg.technology || creds.technology}" is not wired yet (Redis Streams is supported; Kafka/RabbitMQ/SQS need their client).`);
    }
    const brokerUrl = creds.brokerUrl || cfg.brokerUrl || 'redis://localhost:6379';
    const topic = creds.topic || cfg.topic;
    if (!topic) throw new Error('No topic / stream key configured');
    const batchSize = Number(creds.batchSize || cfg.batchSize || 100);
    return { brokerUrl, topic, batchSize };
  }

  private async withRedis<T>(brokerUrl: string, fn: (r: InstanceType<RedisCtor>) => Promise<T>): Promise<T> {
    const mod = await import('ioredis');
    const Redis = (mod.default ?? mod) as unknown as RedisCtor;
    const redis = new Redis(brokerUrl);
    try { return await fn(redis); } finally { try { await redis.quit(); } catch { /* ignore */ } }
  }

  async test(creds: Creds, ctx: RuntimeContext): Promise<TestResult> {
    const { brokerUrl, topic } = this.resolve(await this.cfg(ctx), creds);
    try {
      const count = await this.withRedis(brokerUrl, async (r) => { await r.ping(); return r.xlen(topic).catch(() => 0); });
      return { ok: true, sampleCount: count, message: `Connected — stream "${topic}" has ${count} messages` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async discoverEntities(_creds: Creds, ctx: RuntimeContext): Promise<EntitySummary[]> {
    const cfg = await this.cfg(ctx);
    const topic = cfg.topic;
    return [{ key: topic || 'messages', name: topic || 'Messages', description: 'Stream messages' }];
  }

  async discoverFields(creds: Creds, ctx: RuntimeContext): Promise<FieldDef[]> {
    const { records } = await this.fetch(creds, '', ctx, { limit: 1 });
    const first = records[0];
    if (!first) return [];
    return Object.keys(first).map((name) => ({ name, displayName: name, type: typeof first[name] === 'number' ? 'number' : 'string' }));
  }

  async fetch(creds: Creds, _entityKey: string, ctx: RuntimeContext, opts?: Record<string, unknown>): Promise<FetchResult> {
    const { brokerUrl, topic, batchSize } = this.resolve(await this.cfg(ctx), creds);
    const count = Number(opts?.limit ?? batchSize);
    const entries = await this.withRedis(brokerUrl, (r) => r.xrange(topic, '-', '+', 'COUNT', count));
    const records = (entries || []).map(([id, kv]) => entryToRecord(id, kv));
    return { records, totalCount: records.length };
  }

  async push(): Promise<PushResult> {
    throw new Error('Message Queue is a source-only connector in this build.');
  }
}

export const mqRuntime = new MqRuntime();

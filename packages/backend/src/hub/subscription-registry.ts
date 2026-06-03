/**
 * SubscriptionRegistry — the hub's "address book" (T-02).
 *
 * Holds the set of active subscriptions (a destination's interest in a topic
 * pattern) and answers the router's core question: "given this envelope's
 * topic, who should receive a copy?". Matching is org-scoped so a subscription
 * never receives another tenant's messages.
 */

import type { Subscription, MessageEnvelope } from './interfaces';
import { topicMatches, isValidTopicPattern } from './topic';

export class SubscriptionRegistry {
  private readonly byId = new Map<string, Subscription>();

  /** Add (or replace) a subscription. Rejects malformed topic patterns. */
  register(sub: Subscription): void {
    if (!isValidTopicPattern(sub.topic)) {
      throw new Error(
        `Subscription "${sub.id}" has an invalid topic pattern: "${sub.topic}"`,
      );
    }
    this.byId.set(sub.id, sub);
  }

  /** Remove a subscription by id. Returns true if one was removed. */
  unregister(id: string): boolean {
    return this.byId.delete(id);
  }

  get(id: string): Subscription | undefined {
    return this.byId.get(id);
  }

  list(): Subscription[] {
    return Array.from(this.byId.values());
  }

  get size(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
  }

  /**
   * All subscriptions whose topic pattern matches `topic`.
   * When `orgId` is given, only subscriptions belonging to that org match
   * (multi-tenant isolation).
   */
  findMatching(topic: string, orgId?: string): Subscription[] {
    return this.list().filter(
      (s) =>
        (orgId === undefined || s.orgId === orgId) && topicMatches(s.topic, topic),
    );
  }

  /** Convenience: match using an envelope's own topic + orgId. */
  findForEnvelope(envelope: MessageEnvelope): Subscription[] {
    return this.findMatching(envelope.topic, envelope.orgId);
  }
}

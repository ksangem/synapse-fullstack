/**
 * Hub topic model — canonical addressing for the message bus (T-01, LLD §6).
 *
 * A topic is the "address" on a MessageEnvelope. Destinations subscribe to
 * topics (optionally with wildcards) and the RouterService fans each envelope
 * out to the subscriptions whose pattern matches.
 *
 * Canonical topic form:  <source>.<entity>.<event>   (3 lowercase segments)
 *   e.g. "sharepoint.projects.created", "jira.issues.updated"
 * Each segment is [a-z0-9] with optional internal hyphens (e.g. "sql-server").
 *
 * Subscription PATTERNS extend topics with wildcards:
 *   - "*"                        → matches every topic
 *   - per-segment "*"            → matches exactly one segment ("sharepoint.*.created")
 *   - trailing ".*"              → matches the prefix and any deeper suffix ("sharepoint.projects.*")
 */

export interface TopicParts {
  source: string;
  entity: string;
  event: string;
}

/** A single topic segment: lowercase alphanumerics with optional internal hyphens. */
const SEGMENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSegment(segment: string): boolean {
  return typeof segment === 'string' && SEGMENT_RE.test(segment);
}

/** A concrete (non-pattern) topic: one or more valid dot-separated segments. */
export function isValidTopic(topic: string): boolean {
  if (typeof topic !== 'string' || topic.length === 0) return false;
  return topic.split('.').every(isValidSegment);
}

/** The canonical 3-segment shape: source.entity.event. */
export function isCanonicalTopic(topic: string): boolean {
  if (typeof topic !== 'string') return false;
  const parts = topic.split('.');
  return parts.length === 3 && parts.every(isValidSegment);
}

/**
 * Normalize raw input to a valid topic: trims and lowercases.
 * Throws if the result is not a structurally valid topic.
 */
export function normalizeTopic(raw: string): string {
  const topic = String(raw).trim().toLowerCase();
  if (!isValidTopic(topic)) {
    throw new Error(
      `Invalid topic "${raw}": expected dot-separated lowercase segments ` +
        `like "source.entity.event" (segments may contain a-z, 0-9, hyphens).`,
    );
  }
  return topic;
}

/** Build a canonical topic from parts, validating each segment. */
export function buildTopic(parts: TopicParts): string {
  const entries: ReadonlyArray<readonly [keyof TopicParts, string]> = [
    ['source', parts.source],
    ['entity', parts.entity],
    ['event', parts.event],
  ];
  for (const [name, value] of entries) {
    const seg = String(value ?? '').toLowerCase();
    if (!isValidSegment(seg)) {
      throw new Error(`Invalid topic ${name} segment: "${value}"`);
    }
  }
  return `${parts.source}.${parts.entity}.${parts.event}`.toLowerCase();
}

/** Parse a canonical 3-segment topic into its parts; throws if not canonical. */
export function parseTopic(topic: string): TopicParts {
  const normalized = normalizeTopic(topic);
  const parts = normalized.split('.');
  if (parts.length !== 3) {
    throw new Error(
      `Topic "${topic}" is not canonical: expected exactly 3 segments (source.entity.event), got ${parts.length}.`,
    );
  }
  return { source: parts[0]!, entity: parts[1]!, event: parts[2]! };
}

/** Safe parse — returns null instead of throwing. */
export function tryParseTopic(topic: string): TopicParts | null {
  try {
    return parseTopic(topic);
  } catch {
    return null;
  }
}

/** Validate a subscription pattern (segments may be "*"; lone "*" allowed; trailing ".*" allowed). */
export function isValidTopicPattern(pattern: string): boolean {
  if (pattern === '*') return true;
  if (typeof pattern !== 'string' || pattern.length === 0) return false;
  return pattern.split('.').every((p) => p === '*' || isValidSegment(p));
}

/**
 * Does a subscription pattern match a concrete topic?
 *
 * Semantics (kept stable across the hub):
 *   - exact string match
 *   - lone "*" matches every topic
 *   - trailing ".*" matches the prefix itself and any deeper suffix
 *   - per-segment "*" matches exactly one segment (segment counts must be equal)
 */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (pattern === '*') return true;

  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return topic.startsWith(prefix + '.') || topic === prefix;
  }

  const patternParts = pattern.split('.');
  const topicParts = topic.split('.');
  if (patternParts.length !== topicParts.length) return false;

  return patternParts.every((part, i) => part === '*' || part === topicParts[i]);
}

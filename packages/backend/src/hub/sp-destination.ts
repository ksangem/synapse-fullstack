/**
 * SharePointDestinationConnector — writes the (already-mapped) envelope payload to
 * a SharePoint list, wrapping the proven SharePointPushService.
 *
 * Source-agnostic: the mapping transform produces the SP column row; this
 * connector just provisions any missing columns, finds an existing item by the
 * natural key (dedup), and PATCHes or POSTs. Failures throw so the bus retries /
 * dead-letters.
 */

import { SharePointPushService, getColumnTypeMap, coerceToColumnTypes, type SpColType } from '../services/SharePointPushService';
import type { SharePointCredentials } from '../integrations/sharepoint/types';
import type { IDestinationConnector, MessageEnvelope } from './interfaces';
import { H } from './envelope-meta';

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Make a value safe to send to ANY SharePoint column. A raw object/array value
 * (e.g. a Jira `comment`/`worklog`/`issuelinks` field that slipped into the mapping)
 * makes Graph reject the WHOLE row with an opaque 500 "generalException" — so we
 * flatten non-scalars to JSON text (Date → ISO), truncated so an oversized blob can't
 * overflow a single-line text column either. Scalars pass through untouched. This makes
 * one stray field survivable instead of fatal; coerceToColumnTypes then matches each
 * value to the column's real type.
 */
function toSpSafe(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    let s: string;
    try { s = JSON.stringify(v); } catch { s = String(v); }
    return s.length > 255 ? `${s.slice(0, 252)}…` : s;
  }
  return v;
}

// SharePoint list-item fields that are system-owned and CANNOT be set on create/patch —
// sending any of them makes Graph reject the whole row with 400 "Field 'x' is not
// recognized". A mapping that targets one of these (e.g. Jira id → a column named "id")
// would dead-letter every record; we drop them defensively so the rest of the row writes.
const RESERVED_SP_FIELDS = new Set([
  'id', 'contenttype', 'contenttypeid', 'created', 'modified',
  'author', 'editor', 'attachments', 'guid', 'fileref', 'filedirref',
]);
function isReservedSpField(name: string): boolean {
  const n = name.toLowerCase();
  return RESERVED_SP_FIELDS.has(n) || name.startsWith('@') || name.startsWith('OData__');
}

interface Resolved { token: string; siteId: string; listId: string; columns: Set<string>; colTypes: Map<string, SpColType>; at: number }

export interface SpDestinationOptions {
  connectorId: string;
  orgId: string;
  creds: SharePointCredentials;
  /** Column used to find an existing item for dedup (default 'Title'). */
  keyColumn?: string;
}

export class SharePointDestinationConnector implements IDestinationConnector {
  readonly connectorId: string;
  readonly orgId: string;
  private readonly push = new SharePointPushService();
  private resolved: Resolved | null = null;
  private resolving: Promise<Resolved> | null = null;

  constructor(private readonly opts: SpDestinationOptions) {
    this.connectorId = opts.connectorId;
    this.orgId = opts.orgId;
  }

  /**
   * Resolve token + site, and ensure the list exists WITH the row's columns — the ported
   * equivalent of the Wizard's /ensure-list (new list created atomically WITH its columns;
   * existing list gets missing columns added; exact, case-sensitive internal names). This
   * is the step the bus path previously lacked, which made every SharePoint delivery fail
   * with "Field 'X' is not recognized". Single-flight so concurrent dispatches share one
   * resolve (no Graph throttling herd); cached 40 min, and any newly-seen columns from a
   * later row are added on the cache hit.
   */
  private async ensure(fieldNames: string[]): Promise<Resolved> {
    if (this.resolved && Date.now() - this.resolved.at < 40 * 60 * 1000) {
      await this.addMissingColumns(this.resolved, fieldNames);
      return this.resolved;
    }
    if (this.resolving) {
      const r = await this.resolving;
      await this.addMissingColumns(r, fieldNames);
      return r;
    }
    this.resolving = (async () => {
      try {
        const r = await this.push.resolveAndEnsureList(this.opts.creds, fieldNames);
        // Cache the list's actual column types so values can be coerced to match
        // (a number into a Text column, an object into anything → 500 otherwise).
        const colTypes = await getColumnTypeMap(r.siteId, r.listId, r.token);
        this.resolved = { token: r.token, siteId: r.siteId, listId: r.listId, columns: r.columns, colTypes, at: Date.now() };
        return this.resolved;
      } finally {
        this.resolving = null; // allow a fresh attempt if this one failed
      }
    })();
    return this.resolving;
  }

  /** Add any columns a later row introduced that the list doesn't have yet. */
  private async addMissingColumns(r: Resolved, fieldNames: string[]): Promise<void> {
    const missing = fieldNames.filter((n) => n !== 'Title' && !isReservedSpField(n) && !r.columns.has(n));
    if (!missing.length) return;
    const ensured = await this.push.ensureListWithColumns(this.opts.creds, r.siteId, r.token, missing);
    // Newly-added columns are created as Text — record that so values land coerced.
    for (const c of ensured.columns) { r.columns.add(c); r.colTypes.set(c, 'text'); }
  }

  async dispatch(envelope: MessageEnvelope, _signal: AbortSignal): Promise<void> {
    const candidate = Object.fromEntries(
      Object.entries(envelope.payload as Record<string, unknown>)
        .filter(([k, v]) => v !== null && v !== undefined && !isReservedSpField(k)),
    );
    const keyColumn = this.opts.keyColumn ?? 'Title';
    const keyValue = String(envelope.headers?.[H.NATURAL_KEY] ?? candidate[keyColumn] ?? '');
    if (!keyValue) throw new Error(`SharePointDestination[${this.connectorId}]: no natural key for dedup`);

    const { token, siteId, listId, columns, colTypes } = await this.ensure(Object.keys(candidate));
    // Write only fields backed by a real column — a column that failed to provision is
    // skipped rather than 400-ing the whole row ("Field 'X' is not recognized").
    const rawFields = Object.fromEntries(
      Object.entries(candidate).filter(([k]) => k === 'Title' || columns.has(k)),
    );
    // Coerce so SharePoint can't 500 on a shape/type mismatch: non-scalars → JSON text
    // (the dominant cause of the 500 "generalException" wall), then each value matched to
    // its column's actual type (Text ← non-string, Number ← numeric string).
    const scalarized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawFields)) scalarized[k] = toSpSafe(v);
    const fields = coerceToColumnTypes(scalarized, colTypes);

    const existing = await this.push.findListItemByTitle(siteId, listId, token, keyValue);
    if (existing) {
      const r = await this.push.patchListItem(siteId, listId, existing, token, fields);
      if (!r.ok) throw new Error(`SP patch ${keyValue} failed (${r.status}): ${r.errorBody.slice(0, 200)}`);
    } else {
      const r = await this.push.createItemPublic(`${GRAPH}/sites/${siteId}/lists/${listId}/items`, fields, token);
      if (!r.ok) throw new Error(`SP create ${keyValue} failed (${r.status}): ${r.errorBody.slice(0, 200)}`);
    }
  }
}

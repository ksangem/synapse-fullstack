/**
 * AuditService — append-only writer for the app.audit_log table.
 *
 * This is the first real writer of audit_log. BRD §7.9 requires every credential
 * reveal/rotate/revoke to be recorded with the acting user. Keep the `diff` to
 * METADATA ONLY — never put a decrypted secret (or any plaintext credential value)
 * into an audit entry.
 */
import { db } from '../db/client';
import { auditLog } from '../db/schema';

export type AuditAction =
  | 'reveal' | 'copy' | 'rotate' | 'revoke' | 'create' | 'delete'
  | 'pause' | 'resume' | 'clone'
  | 'login' | 'role_change' | 'deactivate' | 'activate'
  | 'client_register' | 'client_revoke'
  /* Data movement. Until these existed the log could say who READ a credential but not
     who moved data with it: a push that wrote 27 rows into a customer's table, a DDL
     that altered its shape, and a DLQ replay that re-delivered messages all happened
     unattributed. The run/DLQ ledgers record WHAT moved; these record WHO asked. */
  | 'run' | 'run_group' | 'publish' | 'cancel_run' | 'apply_ddl' | 'replay';

export interface AuditEntry {
  orgId: string;
  userId?: string | null;
  action: AuditAction | string;
  entityType: string;
  entityId?: string | null;
  /** Metadata only — NEVER plaintext secret values. */
  diff?: Record<string, unknown> | null;
}

/** Record an audit entry. Best-effort: auditing must never break the main flow. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      orgId: entry.orgId,
      userId: entry.userId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      diff: entry.diff ?? null,
    });
  } catch (err) {
    console.error(`[Audit] failed to record ${entry.action} on ${entry.entityType}:`, (err as Error).message);
  }
}

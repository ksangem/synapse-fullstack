/**
 * Generic credential resolution — decrypt a stored credential by id into a flat
 * map. Connector-agnostic: the bus resolves the bag, each plug-in reads the keys
 * it needs.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { credentials } from '../db/schema';
import { CredentialService } from '../services/CredentialService';

const credService = new CredentialService();

export async function resolveCredentials(
  credId: string | null | undefined,
): Promise<Record<string, string>> {
  if (!credId) return {};
  try {
    const [row] = await db.select().from(credentials).where(eq(credentials.credId, credId)).limit(1);
    if (!row) return {};
    if (row.status === 'revoked') {
      console.warn(`[Hub] credential ${credId} is revoked — refusing to use`);
      return {};
    }
    const obj = JSON.parse(credService.decrypt(row.encryptedPayload)) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = v == null ? '' : String(v);
    return out;
  } catch (err) {
    console.error(`[Hub] credential ${credId} resolve failed:`, (err as Error).message);
    return {};
  }
}

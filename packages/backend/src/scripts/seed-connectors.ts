/**
 * Seed the built-in connector templates into the registry.
 *
 * Idempotent: safe to run repeatedly. Keyed on (orgId, connector.key),
 * (connectorId, semver), and (versionId, entity.key).
 *
 * Run:  npm run db:seed
 */
import { eq, and } from 'drizzle-orm';
import { db, pool } from '../db/client';
import { organizations, connectors, connectorVersions, entityDefinitions } from '../db/schema';
import { BUILT_IN_CONNECTORS, DEFAULT_ORG } from '../connectors/seed-data';

async function ensureDefaultOrg(): Promise<void> {
  const [existing] = await db.select().from(organizations).where(eq(organizations.orgId, DEFAULT_ORG));
  if (existing) return;
  await db.insert(organizations).values({
    orgId: DEFAULT_ORG,
    name: 'Default Organization',
    slug: 'default',
    plan: 'free',
  });
  console.log(`[seed] created default organization ${DEFAULT_ORG}`);
}

async function seed(): Promise<void> {
  await ensureDefaultOrg();

  for (const c of BUILT_IN_CONNECTORS) {
    // ── connector head (upsert by org + key) ──
    let [head] = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.orgId, DEFAULT_ORG), eq(connectors.key, c.key)));

    if (!head) {
      [head] = await db
        .insert(connectors)
        .values({
          orgId: DEFAULT_ORG,
          name: c.name,
          category: c.category,
          version: '1.0.0',
          key: c.key,
          icon: c.icon,
          runtimeKind: c.runtimeKind,
          engine: c.engine ?? null,
          isSystem: true,
          authoringMethod: 'manual',
        })
        .returning();
    } else {
      [head] = await db
        .update(connectors)
        .set({
          name: c.name,
          category: c.category,
          icon: c.icon,
          runtimeKind: c.runtimeKind,
          engine: c.engine ?? null,
          isSystem: true,
          updatedAt: new Date(),
        })
        .where(eq(connectors.connectorId, head.connectorId))
        .returning();
    }

    // ── published v1 version (upsert by connector + semver) ──
    const semver = '1.0.0';
    let [version] = await db
      .select()
      .from(connectorVersions)
      .where(and(eq(connectorVersions.connectorId, head.connectorId), eq(connectorVersions.semver, semver)));

    const versionValues = {
      credentialSchema: c.credentialSchema,
      runtimeConfig: c.runtimeConfig,
      entitiesSnapshot: c.entities,
      status: 'published' as const,
      publishedAt: new Date(),
    };

    if (!version) {
      [version] = await db
        .insert(connectorVersions)
        .values({ connectorId: head.connectorId, orgId: DEFAULT_ORG, semver, ...versionValues })
        .returning();
    } else {
      [version] = await db
        .update(connectorVersions)
        .set(versionValues)
        .where(eq(connectorVersions.versionId, version.versionId))
        .returning();
    }

    // point the head at the published version
    await db
      .update(connectors)
      .set({ latestVersionId: version.versionId, version: semver, updatedAt: new Date() })
      .where(eq(connectors.connectorId, head.connectorId));

    // ── entity definitions (replace for this version) ──
    await db.delete(entityDefinitions).where(eq(entityDefinitions.versionId, version.versionId));
    if (c.entities.length > 0) {
      await db.insert(entityDefinitions).values(
        c.entities.map((e) => ({
          versionId: version.versionId,
          key: e.key,
          name: e.name,
          description: e.description ?? null,
          defaultOn: e.defaultOn ?? false,
          discovery: e.discovery ?? null,
        })),
      );
    }

    console.log(`[seed] connector "${c.key}" → ${head.connectorId} (v${semver}, ${c.entities.length} entities)`);
  }

  console.log(`[seed] done — ${BUILT_IN_CONNECTORS.length} connectors seeded`);
}

seed()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed] failed:', err);
    pool.end().finally(() => process.exit(1));
  });

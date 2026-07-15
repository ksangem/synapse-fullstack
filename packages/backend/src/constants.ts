/**
 * App-wide constants (leaf module — no imports, safe to import anywhere).
 */

/**
 * Single-tenant default organization id. Used to attribute records/runs/audit until real
 * multi-tenancy (threading the resolved actor.orgId through) lands. Defined ONCE here so the
 * magic UUID isn't copied across the bus, seeding, and API layers.
 */
export const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';

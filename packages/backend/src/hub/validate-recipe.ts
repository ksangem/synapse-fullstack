/**
 * validateRecipe — preflight a push BEFORE any record is published.
 *
 * Every "stuck"/dead-letter-storm class of failure traces back to publishing
 * records for a recipe that could never deliver: no destination plug-in, an empty
 * list/table target, unresolved credentials. This check turns those into an
 * immediate, specific error at submit time instead of 140 records limping into the
 * dead-letter queue. Connector-agnostic: the per-connector "is my config shippable?"
 * rules live in each plug-in's validator (connector-registry validateDestinationConfig).
 *
 *   errors[]   → block the run (caller returns 400 with these)
 *   warnings[] → don't block, surfaced to the operator (e.g. no mappings)
 */

import { integrations } from '../db/schema';
import { connectorService } from '../services/ConnectorService';
import { resolveCredentials } from './credentials';
import { hasSourceFactory, hasDestinationFactory, validateDestinationConfig, type ConnectorBuildSpec } from './connector-registry';

type Integration = typeof integrations.$inferSelect;

export interface RecipeValidation {
  errors: string[];
  warnings: string[];
}

export async function validateRecipe(integration: Integration): Promise<RecipeValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const config = (integration.fieldMappings ?? {}) as Record<string, unknown>;

  // ── Source ──
  if (!integration.sourceConnectorId) {
    errors.push('No source connector is configured.');
  } else {
    const srcHead = await connectorService.getConnector(integration.sourceConnectorId);
    if (!srcHead) errors.push('The source connector no longer exists.');
    else if (!hasSourceFactory(srcHead.runtimeKind ?? '')) {
      errors.push(`Source type "${srcHead.runtimeKind ?? 'unknown'}" can't be run on the bus.`);
    }
  }

  // ── Destination ──
  if (!integration.destConnectorId) {
    errors.push('No destination connector is configured.');
  } else {
    const destHead = await connectorService.getConnector(integration.destConnectorId);
    if (!destHead) {
      errors.push('The destination connector no longer exists.');
    } else if (!hasDestinationFactory(destHead.runtimeKind ?? '')) {
      errors.push(`Destination type "${destHead.runtimeKind ?? 'unknown'}" can't be run on the bus.`);
    } else {
      const destCreds = await resolveCredentials((config.destCredId as string) ?? undefined);
      const spec: ConnectorBuildSpec = {
        connectorId: destHead.connectorId,
        orgId: integration.orgId,
        kind: destHead.runtimeKind ?? '',
        config,
        creds: destCreds,
        entity: (config.destEntity as string) ?? undefined,
        integrationId: integration.integrationId,
      };
      // Connector-declared config checks (list/table/url present, etc.)
      for (const problem of validateDestinationConfig(spec)) errors.push(problem);
      // Credentials referenced but not resolvable (deleted / revoked).
      if (config.destCredId && Object.keys(destCreds).length === 0) {
        errors.push('Destination credentials could not be resolved (missing or revoked).');
      }
    }
  }

  // ── Mappings (quality warnings, never blocking) ──
  const mappings = Array.isArray(config.mappings) ? (config.mappings as Array<Record<string, unknown>>) : [];
  if (mappings.length === 0) {
    warnings.push('No field mappings are defined — records may be delivered empty.');
  } else {
    const brokenExpr = mappings
      .filter((m) => m.transform === 'EXPRESSION' && !String(m.expression ?? '').trim())
      .map((m) => String(m.id ?? '?'));
    if (brokenExpr.length) {
      warnings.push(`${brokenExpr.length} expression mapping(s) have an empty formula and will produce no value: ${brokenExpr.join(', ')}.`);
    }
  }

  return { errors, warnings };
}

/**
 * MappingEngine — applies user-defined field mappings at push/sync time.
 *
 * Mappings are stored as JSON in integrations.fieldMappings and evaluated
 * on the fly per Jira issue. No intermediate tables are created.
 *
 * Three transform modes:
 * - DIRECT: copy source value to destination as-is
 * - PRESET: apply a built-in transform function (joinArray, dateFormat, etc.)
 * - EXPRESSION: evaluate a user-written JS expression via new Function()
 */

export interface MappingEntry {
  id: string;
  sources: string[];          // e.g. ['key'] or ['priority.name', 'summary']
  destinations: string[];     // e.g. ['IssueKey'] or ['CreatedDate', 'CycleTimeDays']
  srcTypes: string[];
  destTypes: string[];
  transform: 'DIRECT' | 'PRESET' | 'EXPRESSION';
  preset: string | null;      // e.g. 'joinArray', 'dateFormat'
  presetConfig?: Record<string, unknown>;
  expression: string;         // JS code: return source['key'];
}

export interface MappingConfig {
  entity: string;             // e.g. 'issues'
  projectKey?: string;
  mappings: MappingEntry[];
}

/**
 * Resolve a dot-path like "status.name" against a Jira issue object.
 * Tries both flat (issue.fields['status.name']) and nested (issue.fields.status.name).
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  // For issue-level fields like 'key', 'id'
  if (path === 'key' || path === 'id') return obj[path];

  const fields = (obj.fields ?? obj) as Record<string, unknown>;

  // Try flat key first (for fields like 'customfield_10016')
  if (path in fields) return fields[path];

  // Try dot-notation traversal
  const parts = path.split('.');
  let current: unknown = fields;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === 'object' && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Apply a built-in preset transform to a value.
 */
function runPreset(preset: string, value: unknown, config?: Record<string, unknown>): unknown {
  if (value === null || value === undefined) return null;
  switch (preset) {
    case 'dateFormat':
      return typeof value === 'string' ? value.substring(0, 10) : String(value);
    case 'uppercase':
      return String(value).toUpperCase();
    case 'lowercase':
      return String(value).toLowerCase();
    case 'trim':
      return String(value).trim();
    case 'joinArray': {
      const sep = (config?.separator as string) ?? ', ';
      return Array.isArray(value) ? value.join(sep) : String(value);
    }
    case 'extractNumber': {
      const match = String(value).match(/[\d.]+/);
      return match ? Number(match[0]) : null;
    }
    case 'boolean':
      return Boolean(value);
    default:
      return value;
  }
}

/**
 * Apply all mappings to a single Jira issue and produce a flat SharePoint fields object.
 */
export function applyMappings(
  jiraIssue: Record<string, unknown>,
  mappingConfig: MappingConfig
): Record<string, unknown> {
  const spFields: Record<string, unknown> = {};

  for (const mapping of mappingConfig.mappings) {
    if (mapping.sources.length === 0 || mapping.destinations.length === 0) continue;

    // 1. Gather source values
    const source: Record<string, unknown> = {};
    for (const srcField of mapping.sources) {
      source[srcField] = getNestedValue(jiraIssue, srcField);
    }

    let result: unknown;

    // 2. Apply transform
    if (mapping.transform === 'DIRECT') {
      result = source[mapping.sources[0]];
    } else if (mapping.transform === 'PRESET') {
      result = runPreset(mapping.preset ?? '', source[mapping.sources[0]], mapping.presetConfig);
    } else if (mapping.transform === 'EXPRESSION') {
      try {
        const fn = new Function('source', mapping.expression);
        result = fn(source);
      } catch (err) {
        console.error(`[MappingEngine] Expression error for mapping ${mapping.id}: ${err}`);
        result = null;
      }
    }

    // 3. Write to SP fields
    if (mapping.destinations.length === 1) {
      spFields[mapping.destinations[0]] = result;
    } else {
      // One-to-many or many-to-many: expression should return { ColA: val1, ColB: val2 }
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        Object.assign(spFields, result);
      } else {
        // Fallback: write same value to all destinations
        for (const dest of mapping.destinations) {
          spFields[dest] = result;
        }
      }
    }
  }

  return spFields;
}

/**
 * Check if a mapping config is valid.
 */
export function validateMappingConfig(config: MappingConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!config.mappings || config.mappings.length === 0) {
    errors.push('No mappings defined');
  }
  for (const m of config.mappings) {
    if (m.sources.length === 0) errors.push(`Mapping ${m.id}: no source fields`);
    if (m.destinations.length === 0) errors.push(`Mapping ${m.id}: no destination fields`);
    if (m.transform === 'EXPRESSION' && !m.expression.trim()) {
      errors.push(`Mapping ${m.id}: empty expression`);
    }
    if (m.transform === 'PRESET' && !m.preset) {
      errors.push(`Mapping ${m.id}: no preset selected`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * aggregate — the single source of truth for aggregating a list of values.
 *
 * Shared by the row-local mapping presets (MappingEngine.computeValue: sum/avg/min/max/count)
 * and by cross-entity join aggregation (EntityJoinStep), so the two can never drift.
 *
 * Numeric fns (sum/avg/min/max) ignore null/undefined/'' before coercing to Number — an
 * absent field must not read as 0 and drag an average toward zero; a genuine 0 is kept.
 * `count` counts the present (non-empty) values. `concat` joins present values with ", ".
 * `first` returns the first present value (or null). Empty numeric input → 0; empty first → null.
 *
 * NOTE: this is GROUP aggregation. MappingEngine keeps its own row-local `concat` preset
 * (space-joined, empties preserved) separate on purpose — that concatenates a row's own fields,
 * a different operation from aggregating a column across many joined rows.
 */

export type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'concat' | 'first';

export function aggregate(fn: AggFn, values: unknown[]): number | string | null {
  const present = values.filter((v) => v !== null && v !== undefined && v !== '');
  const nums = present.map((v) => Number(v)).filter((n) => !Number.isNaN(n));
  switch (fn) {
    case 'count': return present.length;
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case 'min': return nums.length ? Math.min(...nums) : 0;
    case 'max': return nums.length ? Math.max(...nums) : 0;
    case 'concat': return present.map((v) => String(v)).join(', ');
    case 'first': return present.length ? (present[0] as number | string) : null;
    default: return null;
  }
}

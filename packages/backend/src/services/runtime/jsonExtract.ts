/**
 * jsonExtract — the `script-json` source mode for the crawler (Phase 2).
 *
 * Many SaaS SPAs (Jira, anything Next.js, Apollo, Nuxt, schema.org) ship their
 * data as a JSON blob embedded in the page — in a `<script>` tag or a global
 * variable — long before (or instead of) painting it into queryable DOM. The
 * CSS-selector extractor can't see that data (virtualized rows, JSON-only state);
 * this module mines it directly.
 *
 * Pure, no I/O: it takes already-parsed JSON (the engine grabs the blob in-browser)
 * plus the recipe's field rules, and produces records. A lightweight JSON-path
 * resolver supports the shapes embedded state actually uses: `a.b.c`, `a[0]`,
 * and `a[*]` (wildcard fan-out). Regex + type from Phase 1 still apply on top.
 */
import { applyRegex, coerceValue, type FieldRule } from './fieldTransform';

type Token = { key: string } | { index: number } | { wild: true };

/** Tokenize a path like `props.pageProps.issues[*].fields.summary` into steps. */
function tokenize(path: string): Token[] {
  const clean = path.replace(/^\$\.?/, '');
  const tokens: Token[] = [];
  for (const seg of clean.split('.')) {
    if (!seg) continue;
    const head = seg.replace(/\[[^\]]*\]/g, '');       // key before any brackets
    if (head) tokens.push({ key: head });
    const brackets = seg.match(/\[[^\]]+\]/g) || [];     // [0], [*], ...
    for (const b of brackets) {
      const inner = b.slice(1, -1).trim().replace(/^['"]|['"]$/g, '');
      if (inner === '*') tokens.push({ wild: true });
      else if (/^-?\d+$/.test(inner)) tokens.push({ index: Number(inner) });
      else tokens.push({ key: inner });                  // ['quoted.key']
    }
  }
  return tokens;
}

/**
 * Resolve a JSON path against a root value, returning every matched value.
 * Returns an array because `[*]` (and traversing into an array with a key) fan out.
 */
export function resolveJsonPath(root: unknown, path: string): unknown[] {
  const tokens = tokenize(path);
  if (!tokens.length) return [root];
  let current: unknown[] = [root];
  for (const tok of tokens) {
    const next: unknown[] = [];
    for (const node of current) {
      if (node == null) continue;
      if ('wild' in tok) {
        if (Array.isArray(node)) next.push(...node);
        else if (typeof node === 'object') next.push(...Object.values(node as Record<string, unknown>));
      } else if ('index' in tok) {
        if (Array.isArray(node)) next.push(node[tok.index < 0 ? node.length + tok.index : tok.index]);
      } else { // key
        if (Array.isArray(node)) {
          for (const e of node) if (e && typeof e === 'object') next.push((e as Record<string, unknown>)[tok.key]);
        } else if (typeof node === 'object') {
          next.push((node as Record<string, unknown>)[tok.key]);
        }
      }
    }
    current = next.filter((x) => x !== undefined);
  }
  return current;
}

/** Apply a field rule to a JSON value: optional regex (strings only) then optional type. */
function coerceField(value: unknown, rule: FieldRule): unknown {
  let v: unknown = value;
  if (rule.regex && typeof v === 'string') v = applyRegex(v, rule.regex, rule.regexFlags, rule.regexGroup);
  if (rule.type && v != null && v !== '') {
    if (rule.type === 'json') return v;                                  // already structured
    if (rule.type === 'number' && typeof v === 'number') return v;
    if (rule.type === 'boolean' && typeof v === 'boolean') return v;
    return coerceValue(typeof v === 'string' ? v : JSON.stringify(v), rule.type);
  }
  return v;
}

/** Build one record from a single JSON item per the field rules. */
function buildRecord(item: unknown, rules: FieldRule[]): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  for (const rule of rules) {
    const path = rule.path || rule.name;
    const matches = resolveJsonPath(item, path);
    const raw = matches.length > 1 ? matches : matches[0];               // multi-match → array
    rec[rule.name] = coerceField(raw, rule);
  }
  return rec;
}

/**
 * Extract records from a parsed JSON document.
 *  - `rootPath` (optional) points at the array of items; if it resolves to a single
 *    array, its elements become the items. With no rootPath, the whole document is
 *    one item (object) or its elements (array).
 *  - each `rule` reads `rule.path` (or `rule.name`) relative to an item.
 */
export function extractFromJson(json: unknown, rootPath: string | undefined, rules: FieldRule[]): Record<string, unknown>[] {
  let items: unknown[];
  if (rootPath && rootPath.trim()) {
    const matched = resolveJsonPath(json, rootPath.trim());
    items = matched.length === 1 && Array.isArray(matched[0]) ? matched[0] : matched;
  } else {
    items = Array.isArray(json) ? json : [json];
  }
  return items.filter((i) => i != null).map((item) => buildRecord(item, rules));
}

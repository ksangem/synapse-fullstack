/**
 * MappingAIService — AI-assisted field mapping (BRD §7.3).
 *
 * Uses the Claude API for auto-map suggestions (with confidence) and
 * natural-language → JS transform generation. Degrades gracefully to a
 * deterministic name/semantic matcher when ANTHROPIC_API_KEY is unset or the
 * API call fails, so the platform works fully offline.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

export interface FieldDef { name: string; type?: string; displayName?: string }
export interface MappingSuggestion {
  sources: string[];
  destinations: string[];
  srcTypes: string[];
  destTypes: string[];
  transform: 'DIRECT' | 'PRESET' | 'EXPRESSION';
  preset: string | null;
  expression: string;
  confidence: number; // 0..1
}

const AUTOMAP_INSTRUCTIONS = `You map SOURCE data fields to DESTINATION columns for a data-integration platform.
Given source fields and destination columns (each with a name and type), return the best 1:1 mappings.
Rules:
- Prefer semantic matches (e.g. "summary"→"Title", "assignee.displayName"→"Assignee", "key"→"IssueKey").
- transform = "DIRECT" when types are compatible and no change is needed.
- transform = "EXPRESSION" with a JS body (using \`source['fieldName']\`, returning a value) when a nested path, type coercion, array join, or object extraction is needed.
- confidence is 0..1 (1 = certain).
Return ONLY JSON: {"mappings":[{"sources":["..."],"destinations":["..."],"srcTypes":["..."],"destTypes":["..."],"transform":"DIRECT|EXPRESSION","preset":null,"expression":"","confidence":0.0}]}`;

const NL_INSTRUCTIONS = `You write a single JavaScript transform body for a data-integration platform.
Input is available as \`source\` (an object keyed by source field name). Return a JS snippet that ends with a \`return\`.
Return ONLY the JS code, no markdown fences, no explanation.`;

// ── Deterministic fallback (server-side port of the wizard auto-mapper) ──
const SEMANTIC: Array<[string[], string[]]> = [
  [['key'], ['IssueKey', 'ExternalId']],
  [['summary'], ['Title', 'Summary']],
  [['status.name', 'status'], ['Status', 'StatusName']],
  [['priority.name', 'priority'], ['Priority']],
  [['assignee.displayName', 'assignee'], ['Assignee', 'AssigneeName', 'AssignedTo']],
  [['reporter.displayName', 'reporter'], ['Reporter']],
  [['issuetype.name', 'issuetype'], ['IssueType']],
  [['created'], ['CreatedDate', 'JiraCreated']],
  [['updated'], ['UpdatedDate', 'JiraUpdated', 'ModifiedDate']],
  [['labels'], ['Labels', 'Tags']],
];

function typesCompatible(a?: string, b?: string): boolean {
  if (!a || !b) return true;
  const s = a.toLowerCase(); const d = b.toLowerCase();
  if (s === d) return true;
  const stringLike = new Set(['string', 'text', 'choice', 'note']);
  if (stringLike.has(s) && stringLike.has(d)) return true;
  if (s === 'datetime' && (d === 'datetime' || d === 'date')) return true;
  return s === d;
}

function norm(n: string): string { return n.toLowerCase().replace(/[^a-z0-9]/g, ''); }

export function deterministicAutoMap(src: FieldDef[], dest: FieldDef[]): MappingSuggestion[] {
  const out: MappingSuggestion[] = [];
  const usedDest = new Set<string>();
  const push = (sf: FieldDef, df: FieldDef, confidence: number) => {
    const compat = typesCompatible(sf.type, df.type) && sf.type !== 'object' && sf.type !== 'array' && !sf.name.includes('.');
    out.push({
      sources: [sf.name], destinations: [df.name],
      srcTypes: [sf.type || 'string'], destTypes: [df.type || 'string'],
      transform: compat ? 'DIRECT' : 'EXPRESSION', preset: null,
      expression: compat ? '' : `return source['${sf.name.split('.')[0]}'];`,
      confidence,
    });
    usedDest.add(df.name);
  };
  // exact name
  for (const sf of src) {
    const sn = norm(sf.name);
    const df = dest.find((d) => !usedDest.has(d.name) && (norm(d.name) === sn || norm(d.displayName || d.name) === sn));
    if (df) push(sf, df, 0.95);
  }
  // semantic
  for (const [srcNames, destNames] of SEMANTIC) {
    const sf = src.find((f) => srcNames.includes(f.name));
    if (!sf || out.some((m) => m.sources.includes(sf.name))) continue;
    const df = dest.find((d) => !usedDest.has(d.name) && destNames.some((dn) => dn.toLowerCase() === d.name.toLowerCase() || dn.toLowerCase() === (d.displayName || '').toLowerCase()));
    if (df) push(sf, df, 0.8);
  }
  return out;
}

function getClient(): Anthropic | null {
  if (!config.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return JSON.parse(start >= 0 ? body.slice(start, end + 1) : body);
}

export class MappingAIService {
  async autoMap(src: FieldDef[], dest: FieldDef[]): Promise<{ mappings: MappingSuggestion[]; source: 'ai' | 'deterministic' }> {
    const client = getClient();
    if (!client) return { mappings: deterministicAutoMap(src, dest), source: 'deterministic' };
    try {
      const msg = await client.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: 2000,
        system: [{ type: 'text', text: AUTOMAP_INSTRUCTIONS, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: `SOURCE fields:\n${JSON.stringify(src)}\n\nDESTINATION columns:\n${JSON.stringify(dest)}`,
        }],
      });
      const text = msg.content.find((c) => c.type === 'text');
      const parsed = extractJson(text && 'text' in text ? text.text : '') as { mappings?: MappingSuggestion[] };
      const mappings = (parsed.mappings || []).map((m) => ({
        sources: m.sources || [], destinations: m.destinations || [],
        srcTypes: m.srcTypes || [], destTypes: m.destTypes || [],
        transform: m.transform || 'DIRECT', preset: m.preset ?? null,
        expression: m.expression || '', confidence: typeof m.confidence === 'number' ? m.confidence : 0.7,
      }));
      if (mappings.length === 0) return { mappings: deterministicAutoMap(src, dest), source: 'deterministic' };
      return { mappings, source: 'ai' };
    } catch (err) {
      console.warn('[MappingAIService] AI auto-map failed, using deterministic fallback:', (err as Error).message);
      return { mappings: deterministicAutoMap(src, dest), source: 'deterministic' };
    }
  }

  async nlTransform(description: string, sourceFields: FieldDef[]): Promise<{ expression: string; source: 'ai' | 'fallback' }> {
    const client = getClient();
    if (!client) {
      const first = sourceFields[0]?.name || 'value';
      return { expression: `// ${description}\nreturn source['${first}'];`, source: 'fallback' };
    }
    try {
      const msg = await client.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: 600,
        system: [{ type: 'text', text: NL_INSTRUCTIONS, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: `Available source fields: ${sourceFields.map((f) => f.name).join(', ')}\n\nTransform: ${description}`,
        }],
      });
      const text = msg.content.find((c) => c.type === 'text');
      let code = (text && 'text' in text ? text.text : '').trim();
      code = code.replace(/```(?:js|javascript)?/g, '').replace(/```/g, '').trim();
      return { expression: code, source: 'ai' };
    } catch (err) {
      console.warn('[MappingAIService] NL transform failed:', (err as Error).message);
      const first = sourceFields[0]?.name || 'value';
      return { expression: `// ${description}\nreturn source['${first}'];`, source: 'fallback' };
    }
  }
}

export const mappingAIService = new MappingAIService();

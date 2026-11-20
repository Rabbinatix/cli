// The API operations an OpenAPI (or Swagger) file's change adds, removes or changes. `$ref`s are followed, so a
// changed schema changes every operation that uses it. Pure.
import { parse } from 'yaml';

export interface SpecChange { method: string; path: string; change: 'added' | 'removed' | 'changed'; file: string }

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

export const looksLikeSpec = (text: string | null | undefined) => !!text && /^\s*["']?(?:openapi|swagger)["']?\s*:/m.test(text) && /["']?paths["']?\s*:/.test(text);

function read(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = parse(text, { maxAliasCount: 100 });
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** the value with local `$ref`s replaced by what they point at (a cycle stays a `$ref`) */
function resolved(doc: Record<string, unknown>, v: unknown, stack: string[] = []): unknown {
  if (Array.isArray(v)) return v.map((x) => resolved(doc, x, stack));
  if (!v || typeof v !== 'object') return v;
  const ref = (v as { $ref?: unknown }).$ref;
  if (typeof ref === 'string' && ref.startsWith('#/')) {
    if (stack.includes(ref) || stack.length > 30) return { $ref: ref };
    const target = ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')).reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), doc);
    return resolved(doc, target, [...stack, ref]);
  }
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, resolved(doc, x, stack)]));
}

/** each operation as `METHOD /path` → its resolved definition, as text */
function operations(doc: Record<string, unknown> | null): Map<string, string> {
  const out = new Map<string, string>();
  const paths = doc?.['paths'];
  if (!doc || !paths || typeof paths !== 'object') return out;
  for (const [p, item] of Object.entries(paths as Record<string, unknown>)) {
    if (!item || typeof item !== 'object') continue;
    const shared = (item as Record<string, unknown>)['parameters'];
    for (const m of METHODS) {
      const op = (item as Record<string, unknown>)[m];
      if (op) out.set(`${m.toUpperCase()} ${p}`, JSON.stringify(resolved(doc, { op, shared })));
    }
  }
  return out;
}

export function specChanges(base: string | null, head: string | null, file: string): SpecChange[] {
  const before = operations(read(base)), after = operations(read(head));
  const out: SpecChange[] = [];
  const split = (k: string) => ({ method: k.slice(0, k.indexOf(' ')), path: k.slice(k.indexOf(' ') + 1) });
  for (const [k, v] of after) {
    if (!before.has(k)) out.push({ ...split(k), change: 'added', file });
    else if (before.get(k) !== v) out.push({ ...split(k), change: 'changed', file });
  }
  for (const k of before.keys()) if (!after.has(k)) out.push({ ...split(k), change: 'removed', file });
  return out;
}

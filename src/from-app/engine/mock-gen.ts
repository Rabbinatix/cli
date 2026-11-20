import { Shape } from './types';
import { fnv1a } from '../shared/fnv';

const NAMES = ['Jane Cooper', 'Wade Warren', 'Esther Howard', 'Cameron Williamson', 'Brooklyn Simmons', 'Leslie Alexander', 'Jenny Wilson', 'Guy Hawkins'];

/** a number in [0, 1) that depends only on the seed and where in the document it is asked for */
function seeded(seed: string, path: string): number {
  let h = fnv1a(`${seed}|${path}`) | 0;
  // one round of xorshift spreads nearby inputs apart
  h ^= h << 13;
  h ^= h >>> 17;
  h ^= h << 5;
  return (h >>> 0) / 0x100000000;
}

/**
 * docs/03-features/F17-mock-server.md: example values from a Shape. Without a seed the output is the same "typical"
 * example every time; with a seed (the hosted mock's `?__seed=`) the values vary, but the same seed always gives the
 * same document (production-readiness 7.3).
 */
export function exampleFromShape(s: Shape | undefined, name = '', seed?: string | number): unknown {
  return gen(s, name, '$', seed === undefined || seed === '' ? undefined : (path: string) => seeded(String(seed), path));
}

/**
 * The example body of a request or response (F91): its stored full example, else values from the shape (field examples
 * first). With a seed the stored example is skipped, so seeded mocks still vary.
 */
export function bodyExample(spec: { body?: Shape; example?: unknown }, seed?: string | number): unknown {
  if (spec.example !== undefined && (seed === undefined || seed === '')) return structuredClone(spec.example);
  return spec.body ? exampleFromShape(spec.body, '', seed) : undefined;
}

function gen(s: Shape | undefined, name: string, path: string, rnd?: (path: string) => number): unknown {
  if (!s) return null;
  // a documented field example wins over a made-up value (not in seeded mocks, which vary on purpose)
  if (!rnd && s.example !== undefined) return structuredClone(s.example);
  const pick = <T>(list: T[], at = path) => list[Math.min(list.length - 1, Math.floor((rnd ? rnd(at) : 0) * list.length))];
  if (s.oneOf?.length) return gen(pick(s.oneOf, `${path}#oneOf`), name, path, rnd);
  if (s.enum?.length) return pick(s.enum);
  // guess from whole words of the name (createdAt → created, at), not substrings (`format` is not a date)
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const has = (...w: string[]) => words.some((x) => w.includes(x));
  const last = words[words.length - 1] ?? '';
  const r = rnd ? rnd(path) : 0;
  const n = (min: number, max: number) => min + Math.floor(r * (max - min + 1));
  const hex = (len: number) => (rnd ? Math.floor(r * 16 ** len).toString(16).padStart(len, '0') : '8f2a61'.padEnd(len, '0').slice(0, len));
  switch (s.type) {
    case 'string':
      if (s.format === 'email' || has('email', 'emails')) return rnd ? `${pick(NAMES).split(' ')[0].toLowerCase()}.${n(1, 99)}@example.com` : 'jane.cooper@example.com';
      if (s.format === 'uuid') return rnd ? `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}` : '3f2c9a1e-7b4d-4e8a-9c21-5d6f0b8a4e17';
      if (s.format === 'date-time' || last === 'at') return rnd ? new Date(Date.UTC(2026, 0, 1) + n(0, 364) * 864e5 + n(0, 86399) * 1000).toISOString().replace('.000', '') : '2026-09-28T10:21:00Z';
      if (s.format === 'date') return rnd ? new Date(Date.UTC(2026, 0, 1) + n(0, 364) * 864e5).toISOString().slice(0, 10) : '2026-09-28';
      if (s.format === 'uri' || has('url', 'uri')) return rnd ? `https://example.com/resource/${n(1, 9999)}` : 'https://example.com/resource';
      if (has('token')) return rnd ? `eyJhbGciOiJIUzI1NiJ9.${hex(8)}.signature` : 'eyJhbGciOiJIUzI1NiJ9.mock.signature';
      if (last === 'id') return `${words.slice(0, -1).join('_') || 'obj'}_${hex(6)}`;
      if (words.some((x) => x.endsWith('name'))) return rnd ? pick(NAMES) : 'Jane Cooper';
      if (has('currency')) return rnd ? pick(['USD', 'EUR', 'GBP', 'JPY']) : 'USD';
      if (has('status')) return rnd ? pick(['active', 'pending', 'inactive']) : 'active';
      if (has('password')) return '••••••••';
      return rnd ? `string_${n(1, 999)}` : 'string';
    case 'integer':
      if (has('amount', 'total')) return rnd ? n(100, 99_999) : 4999;
      if (has('expires')) return rnd ? n(60, 86_400) : 3600;
      return rnd ? n(1, 1000) : 42;
    case 'number':
      return rnd ? Math.round(r * 100_000) / 100 : 19.99;
    case 'boolean':
      return rnd ? r < 0.5 : true;
    case 'null':
      return null;
    case 'array': {
      const count = rnd ? 1 + Math.floor(r * 3) : 1;
      return Array.from({ length: count }, (_, i) => gen(s.items, name.replace(/s$/, ''), `${path}[${i}]`, rnd));
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, f] of Object.entries(s.properties ?? {})) out[k] = gen(f, k, `${path}.${k}`, rnd);
      return out;
    }
    default:
      return 'any';
  }
}

import { Endpoint } from './types';

/** A path parameter segment: `:id`, `{id}` or `[id]` (Express, OpenAPI, Next.js); the name, or undefined for a literal. */
export function pathParamOf(seg: string): string | undefined {
  const m = /^:([^/]+)$/.exec(seg) || /^\{([^}]*)\}$/.exec(seg) || /^\[([^\]]*)\]$/.exec(seg);
  return m ? m[1] : undefined;
}

export const isPathParam = (seg: string) => pathParamOf(seg) !== undefined;

/** `/users/:id` → `/users/{id}` (whole segments only: `items:batch` stays) */
export const toBraceParams = (path: string) => path.split('/').map((s) => (s.startsWith(':') && isPathParam(s) ? `{${s.slice(1)}}` : s)).join('/');

/** docs/02-engine/matching.md: normalizes a path for matching. */
export function normalizePath(path: string): string {
  let p = (path || '').trim();
  p = p.split('?')[0].split('#')[0];
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/{2,}/g, '/');
  const segments = p.split('/').map((seg) => {
    if (isPathParam(seg)) return '{}';
    return seg.toLowerCase();
  });
  p = segments.join('/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

export function deriveApiVersion(path: string, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim().toLowerCase();
  const seg = (path || '').split('/').find((s) => /^v\d+(\.\d+)?$/i.test(s));
  return seg ? seg.toLowerCase() : 'v1';
}

/** an API version label as paths carry it: `v2`, `v2.1` (deriveApiVersion finds only these in a path) */
export const API_VERSION_LABEL = /^v\d+(\.\d+)?$/i;

/** older first: v2 before v10, v2 before v2.1 */
export const compareApiVersions = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/**
 * The version a test server call has to name (`?__version=v1`): another version of the system has the same method and
 * path, so the test server would answer with the newest (functions/src/mock-logic.ts). '' when the path is its own.
 */
export function mockVersionOf(e: Pick<Endpoint, 'id' | 'systemId' | 'role' | 'method' | 'path' | 'apiVersion'>, endpoints: readonly Endpoint[]): string {
  const mine = deriveApiVersion(e.path, e.apiVersion);
  const shared = endpoints.some((x) => x.id !== e.id && x.role === 'provider' && x.systemId === e.systemId && x.method === e.method && x.path === e.path && deriveApiVersion(x.path, x.apiVersion) !== mine);
  return shared ? mine : '';
}

/** an endpoint's path moved to another API version: `/api/v1/orders` → `/api/v2/orders` (a path without one stays) */
export function pathInVersion(path: string, from: string, to: string): string {
  const re = new RegExp(`/${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`, 'i');
  return path.replace(re, `/${to}$1`);
}

/**
 * docs/04-roadmap/public-api-per-api-plan.md: one API across its versions, `GET /orders/{}` for both
 * `GET /v1/orders/{id}` and `GET /v2/orders/{id}`: the method and the normalized path without its version segment.
 */
export function apiKeyOf(e: Pick<Endpoint, 'method' | 'path' | 'apiVersion'>): string {
  const version = deriveApiVersion(e.path, e.apiVersion);
  const path = normalizePath(e.path).split('/').filter((seg) => seg !== version).join('/') || '/';
  return `${e.method.toUpperCase()} ${path}`;
}

/** Path parameter names in order of appearance: /users/:id/orders/{orderId} → ['id','orderId'] */
export function pathParamNames(path: string): string[] {
  const out: string[] = [];
  for (const seg of (path || '').split('?')[0].split('/')) {
    const name = pathParamOf(seg);
    if (name) out.push(name);
  }
  return out;
}

export function providerSystemIdOf(e: Pick<Endpoint, 'role' | 'systemId' | 'targetSystemId'>): string {
  return e.role === 'consumer' ? e.targetSystemId ?? '' : e.systemId;
}

export function matchKey(e: Pick<Endpoint, 'role' | 'systemId' | 'targetSystemId' | 'method' | 'path' | 'apiVersion'>): string {
  return [providerSystemIdOf(e), 'http', e.method, normalizePath(e.path), deriveApiVersion(e.path, e.apiVersion)].join('|');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** the part of a path that names its API family: up to a version (`/api/v2`), else the first segment (`/internal`) */
export function pathPrefix(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const v = parts.slice(0, 3).findIndex((p) => /^v\d+$/i.test(p));
  return '/' + (v >= 0 ? parts.slice(0, v + 1) : parts.slice(0, 1)).join('/');
}

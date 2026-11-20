// Which contract a real call belongs to: host → provider system, then method + path template (most literal wins).
import { isPathParam } from '../../engine/path';
import { WatchApi } from './types';

interface Compiled { api: WatchApi; re: RegExp; literals: number }

export interface CallMatch {
  api?: WatchApi;
  /** the provider system the host maps to, if any */
  providerId?: string;
  /** a call we are responsible for: same origin, or a mapped host (undeclared calls are reported only for these) */
  known: boolean;
  path: string;
}

function templateRegex(path: string): { re: RegExp; literals: number } {
  const segs = path.split('?')[0].replace(/\/+$/, '').split('/');
  let literals = 0;
  const body = segs.map((s) => {
    if (isPathParam(s)) return '[^/]+';
    if (s) literals++;
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { re: new RegExp(`^${body || ''}/?$`, 'i'), literals };
}

/** "/" = the page's own origin; "api.acme.com" = a host; "https://api.acme.com" = an origin */
export function hostSystem(hosts: Record<string, string>, url: URL, pageOrigin: string): string | undefined {
  for (const [key, system] of Object.entries(hosts)) {
    const k = key.trim().replace(/\/+$/, '');
    if (!k || k === '/' ? url.origin === pageOrigin : /^[a-z]+:\/\//i.test(k) ? url.origin === k.toLowerCase() : url.host === k.toLowerCase()) return system;
  }
  return undefined;
}

function globRegex(glob: string): RegExp {
  const body = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${body}$`, 'i');
}

export function isIgnored(ignore: (string | RegExp)[], url: URL): boolean {
  return ignore.some((p) => (typeof p === 'string' ? globRegex(p).test(url.pathname) : p.test(url.href)));
}

/** a call to a provider's test server (`/mock/{org}/{project}/{system}/<path>`, functions/src/mock-logic.ts): the system
 *  and the API path in it, when the system is one these contracts call */
export function testServerCall(url: URL, providers: Set<string>): { providerId: string; path: string } | undefined {
  const m = /^\/mock\/[^/]+\/[^/]+\/([^/]+)(\/.*)?$/.exec(url.pathname);
  return m && providers.has(m[1]) ? { providerId: m[1], path: m[2] || '/' } : undefined;
}

export function createMatcher(apis: WatchApi[]) {
  const compiled: Compiled[] = apis.map((api) => ({ api, ...templateRegex(api.path) }));
  const providers = new Set(apis.map((a) => a.provider.id));
  return (method: string, url: URL, hosts: Record<string, string>, pageOrigin: string): CallMatch => {
    // a frontend pointed at a provider's test server is checked like one calling the real API
    const test = testServerCall(url, providers);
    const providerId = test?.providerId ?? hostSystem(hosts, url, pageOrigin);
    const m = method.toUpperCase();
    const path = test?.path ?? url.pathname;
    const known = !!providerId || url.origin === pageOrigin;
    // an unmapped third-party host (analytics, CDNs…) is never matched by path alone
    if (!known) return { known, path };
    let candidates = compiled.filter((c) => c.api.method.toUpperCase() === m && c.re.test(path));
    if (providerId) candidates = candidates.filter((c) => c.api.provider.id === providerId);
    const best = candidates.sort((a, b) => b.literals - a.literals)[0];
    return { api: best?.api, providerId, known, path };
  };
}

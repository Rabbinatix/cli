// The test server's answer (F17), with no Firebase in it: given a system's provided endpoints and a request, what the
// test server says. The hosted one (functions/src/mock-logic.ts) and the one on the developer's machine
// (rabbinatix-cli, `rabbinatix mock`) both use it, so they answer the same.
//
// `?__status=404` or `X-Mock-Status: 404` picks a declared response; `?__seed=abc` or `X-Mock-Seed: abc` varies the
// values, the same seed always giving the same body. When two API versions share the path, the newest answers;
// `?__version=v1` or `X-Mock-Version: v1` picks another. With "Validate requests" on for the endpoint, a call that
// doesn't fit the declared request is refused with a 400 that says why (mock-check.ts).
import { bodyExample } from '../engine/mock-gen';
import { compareApiVersions, deriveApiVersion, pathParamOf } from '../engine/path';
import { Endpoint } from '../engine/types';
import { requestProblems } from './mock-check';

export interface MockRequest {
  method: string;
  /** the path inside the system (`/orders/42`) */
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  /** the parsed JSON body, if any */
  body?: unknown;
}
export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** what a test server endpoint needs of an endpoint */
export type MockEndpoint = Pick<Endpoint, 'id' | 'method' | 'path' | 'apiVersion' | 'request' | 'responses'>;

export const MOCK_HEADERS: Record<string, string> = { 'content-type': 'application/json', 'x-rabbinatix-mock': 'true' };

/** what a 404 lists: each method and path once, sorted, with its versions when there are several
 *  (`GET /payments/{id} (v1, v2)`, pick one with `?__version=`) */
export function declaredList(provided: MockEndpoint[], version: (e: MockEndpoint) => string): string[] {
  const by = new Map<string, Set<string>>();
  for (const x of provided) {
    const k = `${x.method} ${x.path}`;
    by.set(k, (by.get(k) ?? new Set()).add(version(x)));
  }
  return [...by]
    .sort(([a], [b]) => a.split(' ')[1].localeCompare(b.split(' ')[1]) || a.localeCompare(b))
    .map(([k, v]) => (v.size > 1 ? `${k} (${[...v].filter(Boolean).sort(compareApiVersions).join(', ')})` : k));
}

/** does a concrete path (`/api/v1/orders/42`) fit a declared one (`/api/v1/orders/{orderId}` or `:orderId`)? */
export function pathFits(declared: string, actual: string): boolean {
  const d = declared.split('?')[0].split('/').filter(Boolean);
  const a = actual.split('?')[0].split('/').filter(Boolean);
  return d.length === a.length && d.every((seg, i) => pathParamOf(seg) !== undefined || seg === safeDecode(a[i]));
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** the answer to one request. `validates` says whether "Validate requests" is on for an endpoint; it is asked only
 *  for the endpoint that answers (the hosted server reads that setting lazily). */
export async function answerMock(
  provided: MockEndpoint[],
  req: MockRequest,
  validates: (endpointId: string) => boolean | Promise<boolean>,
): Promise<MockResponse> {
  const path = req.path || '/';
  const no = (status: number, error: string, extra: object = {}): MockResponse => ({ status, headers: MOCK_HEADERS, body: { error, ...extra } });
  // an exact path wins over one with parameters; of the versions with that path, the one asked for or else the newest
  const matches = provided.filter((e) => e.method === req.method.toUpperCase() && pathFits(e.path, path));
  const exact = matches.filter((x) => x.path === path);
  const best = exact.length ? exact : matches.filter((x) => x.path === matches[0]?.path);
  const version = (x: MockEndpoint) => deriveApiVersion(x.path, x.apiVersion);
  const asked = (req.query['__version'] ?? req.headers['x-mock-version'])?.trim().toLowerCase();
  // a version asked for that isn't there is refused, not answered by another (a typo would go unnoticed)
  const versions = [...new Set(best.map(version).filter(Boolean))].sort(compareApiVersions);
  if (asked && best.length && !best.some((x) => version(x) === asked)) {
    return no(404, `No version ${asked} of ${best[0].method} ${best[0].path}.${versions.length ? ` It has ${versions.join(', ')}.` : ' It has no versions.'}`);
  }
  const e = best.find((x) => asked && version(x) === asked) ?? [...best].sort((a, b) => compareApiVersions(version(b), version(a)))[0];
  if (!e) return no(404, `No declared endpoint for ${req.method.toUpperCase()} ${path}.`, { declared: declaredList(provided, version) });
  // "Validate requests": a call the provider wouldn't accept is refused, with what's wrong
  if (await validates(e.id)) {
    const query = Object.fromEntries(Object.entries(req.query).filter(([k]) => !k.startsWith('__')));
    const problems = requestProblems(e.request, { method: req.method, query, headers: req.headers, body: req.body === '' ? undefined : req.body });
    if (problems.length) {
      return {
        status: 400,
        headers: { ...MOCK_HEADERS, 'x-rabbinatix-endpoint': e.id, 'x-rabbinatix-mock-rejected': 'true' },
        body: { error: `This request doesn't match ${e.method} ${e.path} as declared.`, problems },
      };
    }
  }
  const wanted = Number(req.query['__status'] ?? req.headers['x-mock-status']) || undefined;
  const res = wanted ? e.responses.find((r) => r.status === wanted) : (e.responses.find((r) => r.status >= 200 && r.status < 300) ?? e.responses[0]);
  if (!res) return no(404, `${e.method} ${e.path} declares no ${wanted ?? ''} response.`.replace('  ', ' '));
  const seed = req.query['__seed'] ?? req.headers['x-mock-seed'];
  return { status: res.status, headers: { ...MOCK_HEADERS, 'x-rabbinatix-endpoint': e.id }, body: res.body ? (bodyExample(res, seed) ?? null) : null };
}

// The test server on this machine (`rabbinatix mock`): loads a system's APIs from Rabbinatix once (GET /v1/mock), or
// from a file saved earlier, then answers every call itself, the way the hosted test server would. The answer is the
// app's own (app/src/app/data/mock-answer.ts), so both say the same. Calls to it never reach Rabbinatix.
import * as http from 'node:http';
import { answerMock, MockEndpoint, MockRequest, MockResponse } from './from-app/data/mock-answer';
import { call, Connection } from './connect.js';

/** what GET /v1/mock answers, and what --save writes */
export interface MockSnapshot {
  system: { id: string; name: string };
  endpoints: MockEndpoint[];
  /** the endpoints with "Validate requests" on */
  validate: string[];
}

export function isSnapshot(x: unknown): x is MockSnapshot {
  const s = x as MockSnapshot;
  return !!s && typeof s === 'object' && typeof s.system?.id === 'string' && Array.isArray(s.endpoints) && Array.isArray(s.validate);
}

/** the one call: a system's provided APIs */
export async function loadSnapshot(c: Connection, system: string, warn?: (s: string) => void): Promise<MockSnapshot> {
  const data = await call<unknown>(c, 'GET', `/mock?system=${encodeURIComponent(system)}`, { timeoutMs: 30_000, warn });
  if (!isSnapshot(data)) throw new Error('Rabbinatix answered without the system’s APIs. Is this the right API address?');
  return data;
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': 'x-rabbinatix-endpoint, x-rabbinatix-mock, x-rabbinatix-mock-rejected',
};

/** a Node request as the answer reads it: the path, the query, lower-case headers, the body parsed when it is JSON */
export function toMockRequest(method: string, rawUrl: string, headers: http.IncomingHttpHeaders, raw: string): MockRequest {
  const u = new URL(rawUrl, 'http://localhost');
  const query: Record<string, string> = {};
  u.searchParams.forEach((v, k) => (query[k] ??= v));
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) flat[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  let body: unknown = raw === '' ? undefined : raw;
  if (raw !== '') {
    try {
      body = JSON.parse(raw);
    } catch {
      // not JSON: passed on as text, as the hosted server does
    }
  }
  return { method, path: u.pathname, query, headers: flat, body };
}

export interface Served {
  server: http.Server;
  url: string;
  /** what it answers from; swapped by a reload */
  use(s: MockSnapshot): void;
  close(): Promise<void>;
}

/** serve a snapshot; `onCall` hears each call and its answer (the log) */
export function serveMock(first: MockSnapshot, opts: { port: number; host: string; onCall?: (req: MockRequest, res: MockResponse) => void }): Promise<Served> {
  let snap = first;
  let validate = new Set(first.validate);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      raw += c;
      // a test server needn't take uploads: 5 MB, like a function's request
      if (raw.length > 5_000_000) req.destroy();
    });
    req.on('end', () => {
      const method = (req.method ?? 'GET').toUpperCase();
      if (method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
      }
      const mreq = toMockRequest(method, req.url ?? '/', req.headers, raw);
      answerMock(snap.endpoints, mreq, (id) => validate.has(id)).then(
        (answer) => {
          opts.onCall?.(mreq, answer);
          res.writeHead(answer.status, { ...answer.headers, ...CORS });
          res.end(method === 'HEAD' || answer.body === null ? '' : JSON.stringify(answer.body, null, 2));
        },
        (e: Error) => {
          res.writeHead(500, { 'content-type': 'application/json', ...CORS });
          res.end(JSON.stringify({ error: `The test server failed: ${e.message}` }));
        },
      );
    });
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port, opts.host, () => {
      server.off('error', fail);
      const a = server.address() as { port: number };
      const host = opts.host === '0.0.0.0' || opts.host === '::' ? 'localhost' : opts.host.includes(':') ? `[${opts.host}]` : opts.host;
      ok({
        server,
        url: `http://${host}:${a.port}`,
        use: (s) => {
          snap = s;
          validate = new Set(s.validate);
        },
        close: () => new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}

/** the list printed at start: each endpoint once, sorted by path */
export function endpointLines(s: MockSnapshot, base: string): string[] {
  const v = new Set(s.validate);
  return [...s.endpoints]
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
    .map((e) => `  ${e.method.padEnd(6)} ${base}${e.path}${e.apiVersion && s.endpoints.some((x) => x !== e && x.path === e.path && x.method === e.method) ? `  (${e.apiVersion})` : ''}${v.has(e.id) ? '  · checks requests' : ''}`);
}

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { MockSnapshot, toMockRequest } from '../src/mock.js';
import { MockRun, parseMockArgs, startMock } from '../src/mock-cli.js';

const obj = (fields: Record<string, object>) => ({ type: 'object', properties: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { ...v, required: true }])) });
const str = { type: 'string' };
const int = { type: 'integer' };
const req = (extra: object = {}) => ({ headers: [], query: [], pathParams: [], auth: { type: 'none' }, ...extra });

/** Orders: GET /orders/{id} (validates requests), POST /orders, GET /items in v1 and v2 */
const ORDERS: MockSnapshot = {
  system: { id: 'orders', name: 'Orders' },
  endpoints: [
    { id: 'get-order', method: 'GET', path: '/orders/{id}', request: req({ pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }] }), responses: [{ status: 200, headers: [], body: obj({ id: str, total: int }) }, { status: 404, headers: [], body: obj({ error: str }) }] },
    { id: 'post-order', method: 'POST', path: '/orders', request: req({ contentType: 'application/json', body: obj({ item: str }) }), responses: [{ status: 201, headers: [], body: obj({ id: str }) }] },
    { id: 'items-1', method: 'GET', path: '/items', apiVersion: 'v1', request: req(), responses: [{ status: 200, headers: [], body: obj({ v1: str }) }] },
    { id: 'items-2', method: 'GET', path: '/items', apiVersion: 'v2', request: req(), responses: [{ status: 200, headers: [], body: obj({ v2: str }) }] },
  ] as unknown as MockSnapshot['endpoints'],
  validate: ['post-order'],
};

let run: MockRun | undefined;
let api: http.Server | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await run?.served?.close();
  run = undefined;
  api?.close();
  api = undefined;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** a fake Rabbinatix answering GET /v1/mock; counts the calls */
function fakeApi(answer: unknown, status = 200): Promise<{ url: string; calls: { url?: string; auth?: string }[] }> {
  const calls: { url?: string; auth?: string }[] = [];
  api = http.createServer((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
  return new Promise((ok) => api!.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(api!.address() as { port: number }).port}/api/v1`, calls })));
}

async function start(argv: string[], env: NodeJS.ProcessEnv = {}, input?: PassThrough) {
  const out: string[] = [];
  const err: string[] = [];
  run = await startMock(argv, process.cwd(), env, (s) => out.push(s), (s) => err.push(s), input);
  return { out, err, base: run.served?.url ?? '' };
}

const get = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init);
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
};

describe('rabbinatix mock', () => {
  it('loads the system with one call and then answers every call itself, like the hosted test server', async () => {
    const rbx = await fakeApi(ORDERS);
    const { out, base } = await start(['--system', 'Orders', '--port', '0', '--api', rbx.url], { RABBINATIX_TOKEN: 'cm_live_x' });
    expect(rbx.calls).toEqual([{ url: '/api/v1/mock?system=Orders', auth: 'Bearer cm_live_x' }]);
    expect(out[0]).toBe(`Test server for Orders at ${base}`);
    expect(out.join('\n')).toContain(`POST   ${base}/orders  · checks requests`);

    const order = await get(`${base}/orders/42`);
    expect(order.status).toBe(200);
    expect(Object.keys(order.body)).toEqual(['id', 'total']);
    expect(order.headers.get('x-rabbinatix-endpoint')).toBe('get-order');
    expect(order.headers.get('access-control-allow-origin')).toBe('*');
    // the same seed, the same body; another declared response on asking
    expect((await get(`${base}/orders/42?__seed=a`)).body).toEqual((await get(`${base}/orders/42`, { headers: { 'x-mock-seed': 'a' } })).body);
    expect((await get(`${base}/orders/42?__status=404`)).status).toBe(404);
    // the newest version answers unless another is asked for; one that isn't there is refused
    expect(Object.keys((await get(`${base}/items`)).body)).toEqual(['v2']);
    expect(Object.keys((await get(`${base}/items?__version=v1`)).body)).toEqual(['v1']);
    expect((await get(`${base}/items?__version=v9`)).body.error).toBe('No version v9 of GET /items. It has v1, v2.');
    // "Validate requests": a body that doesn't fit is refused with why; one that fits is answered
    const bad = await get(`${base}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item: 3 }) });
    expect(bad.status).toBe(400);
    expect(bad.headers.get('x-rabbinatix-mock-rejected')).toBe('true');
    expect((await get(`${base}/orders`, { method: 'POST', body: JSON.stringify({ item: 'tea' }) })).status).toBe(201);
    // nothing declared: a 404 listing what is
    const none = await get(`${base}/nope`);
    expect(none).toMatchObject({ status: 404, body: { error: 'No declared endpoint for GET /nope.', declared: ['GET /items (v1, v2)', 'POST /orders', 'GET /orders/{id}'] } });
    // a browser's preflight
    expect((await fetch(`${base}/orders`, { method: 'OPTIONS' })).status).toBe(204);
    // each call printed; and none of them reached Rabbinatix
    expect(out).toContain('GET    /orders/42 → 200');
    expect(out).toContain('GET    /nope → 404  No declared endpoint for GET /nope.');
    expect(rbx.calls).toHaveLength(1);
  });

  it('saves what it loaded and starts from the file with no call and no token; r reloads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-mock-'));
    dirs.push(dir);
    const file = path.join(dir, 'orders.mock.json');
    const rbx = await fakeApi(ORDERS);
    const input = new PassThrough();
    const first = await start(['--system', 'orders', '--port', '0', '--api', rbx.url, '--save', file, '--quiet'], { RABBINATIX_TOKEN: 't' }, input);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(ORDERS);
    expect(first.out).toContain(`Saved to ${file}: start from it with --from ${file}.`);
    input.write('r\n');
    await expect.poll(() => rbx.calls.length).toBe(2);
    await expect.poll(() => first.out.includes('Loaded again.')).toBe(true);
    await run!.served!.close();
    expect(await run!.done).toBe(0);

    const offline = await start(['--from', file, '--port', '0', '--quiet']);
    expect(offline.err).toEqual([]);
    expect((await get(`${offline.base}/orders/1`)).status).toBe(200);
    expect(rbx.calls).toHaveLength(2);
  });

  it('says what is wrong instead of starting', async () => {
    expect((await start(['--system', 'orders'])).err).toEqual(['Say where Rabbinatix is: --api <url>, RABBINATIX_API, or "api" in .rabbinatix/config.json (Integrations → API & CI shows the address).']);
    expect((await start(['--system', 'orders'], { RABBINATIX_API: 'http://x' })).err[0]).toMatch(/^No API token: set RABBINATIX_TOKEN/);
    const rbx = await fakeApi({ error: 'No system nope in this project. GET /v1/systems lists them.' }, 404);
    const missing = await start(['--system', 'nope', '--port', '0', '--api', rbx.url], { RABBINATIX_TOKEN: 't' });
    expect(missing.err).toEqual(['Rabbinatix answered 404: No system nope in this project. GET /v1/systems lists them.']);
    expect(await run!.done).toBe(2);
    // a file that isn't one saved with --save
    const empty = await start(['--from', '/dev/null', '--port', '0']);
    expect(empty.err[0]).toMatch(/^Couldn’t read \/dev\/null/);
  });

  it('reads its options', () => {
    expect(parseMockArgs(['--system', 'a'])).toMatchObject({ system: 'a', port: 4010, host: '127.0.0.1', tokenEnv: 'RABBINATIX_TOKEN', quiet: false });
    expect(() => parseMockArgs([])).toThrow('Say which system');
    expect(() => parseMockArgs(['--system', 'a', '--port', 'x'])).toThrow('--port is a number');
    expect(() => parseMockArgs(['--from', 'a.json', '--save', 'b.json'])).toThrow('don’t go together');
    expect(() => parseMockArgs(['--system', 'a', '--nope'])).toThrow('Unknown option --nope');
    expect(parseMockArgs(['--help']).help).toBe(true);
  });

  it('hands the answer the path, query, headers and a JSON body (text when it isn’t JSON)', () => {
    expect(toMockRequest('POST', '/a/b?x=1&x=2&y=', { 'X-Mock-Seed': 's', accept: ['a', 'b'] } as never, '{"k":1}')).toEqual({ method: 'POST', path: '/a/b', query: { x: '1', y: '' }, headers: { 'x-mock-seed': 's', accept: 'a, b' }, body: { k: 1 } });
    expect(toMockRequest('POST', '/', {}, 'plain').body).toBe('plain');
    expect(toMockRequest('GET', '/', {}, '').body).toBeUndefined();
  });
});

describe('a port in use', () => {
  it('is named', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-mock-'));
    dirs.push(dir);
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, JSON.stringify(ORDERS));
    const taken = http.createServer();
    await new Promise<void>((ok) => taken.listen(0, '127.0.0.1', () => ok()));
    const port = String((taken.address() as { port: number }).port);
    try {
      const r = await start(['--from', file, '--port', port]);
      expect(r.err).toEqual([`Port ${port} is in use. Pick another with --port.`]);
    } finally {
      taken.close();
    }
  });
});

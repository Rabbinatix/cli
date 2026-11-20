import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { allowedOrigin, newCode, parseRelayArgs, relayHandler } from '../src/relay-cli.js';

let server: http.Server | undefined;
afterEach(() => server?.close());

async function start(fetchFn: typeof fetch, origins: string[] = []) {
  server = http.createServer(relayHandler({ port: 0, origins, code: 'abcd-efgh-jkmn', fetchFn }));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const APP = 'https://dev.rabbinatix.com';

describe('rabbinatix relay', () => {
  it('accepts only the app’s addresses and the code; preflight allows a private network', async () => {
    const base = await start((() => { throw new Error('no call'); }) as unknown as typeof fetch);
    expect((await fetch(`${base}/hello`, { headers: { origin: 'https://evil.example', 'x-rabbinatix-relay': 'abcd-efgh-jkmn' } })).status).toBe(403);
    expect((await fetch(`${base}/hello`, { headers: { origin: APP, 'x-rabbinatix-relay': 'wrong-code-xx' } })).status).toBe(401);
    const hello = await fetch(`${base}/hello`, { headers: { origin: APP, 'x-rabbinatix-relay': 'abcd-efgh-jkmn' } });
    expect(hello.status).toBe(200);
    expect(hello.headers.get('access-control-allow-origin')).toBe(APP);
    const pre = await fetch(`${base}/send`, { method: 'OPTIONS', headers: { origin: APP } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-private-network')).toBe('true');
  });

  it('sends the request from this machine, without the browser’s headers, and gives the whole answer back', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const base = await start((async (url: URL, init: RequestInit) => {
      seen = { url: String(url), init };
      return new Response('{"id":1}', { status: 201, headers: { 'x-trace': 't1', 'content-type': 'application/json' } });
    }) as unknown as typeof fetch);
    const r = await fetch(`${base}/send`, {
      method: 'POST', headers: { origin: APP, 'x-rabbinatix-relay': 'abcd-efgh-jkmn', 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'post', url: 'http://10.0.0.5:8080/orders', headers: { Authorization: 'Bearer t', Cookie: 'a=1', 'Content-Type': 'application/json' }, body: '{"x":1}' }),
    });
    const b = await r.json() as { status: number; headers: Record<string, string>; body: string };
    expect(b).toMatchObject({ status: 201, body: '{"id":1}', headers: { 'x-trace': 't1' } });
    expect(seen!.url).toBe('http://10.0.0.5:8080/orders');
    expect(seen!.init).toMatchObject({ method: 'POST', body: '{"x":1}', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' } });
    expect(Object.keys(seen!.init.headers as object)).not.toContain('Cookie');
  });

  it('refuses other schemes; says when the API can’t be reached', async () => {
    const base = await start((async () => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED') }); }) as unknown as typeof fetch);
    const send = (url: string) => fetch(`${base}/send`, { method: 'POST', headers: { origin: APP, 'x-rabbinatix-relay': 'abcd-efgh-jkmn' }, body: JSON.stringify({ method: 'GET', url }) });
    expect((await send('file:///etc/passwd')).status).toBe(400);
    const r = await send('http://localhost:9/x');
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: string }).error).toContain('ECONNREFUSED');
  });

  it('codes, origins and flags', () => {
    expect(newCode()).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(allowedOrigin('https://rabbinatix.com', [])).toBe(true);
    expect(allowedOrigin('https://rabbinatix.com.evil.io', [])).toBe(false);
    expect(allowedOrigin('https://my.app', ['https://my.app'])).toBe(true);
    expect(parseRelayArgs(['--origin', 'https://my.app/x', '--port', '5000'])).toMatchObject({ origins: ['https://my.app'], port: 5000 });
    expect(() => parseRelayArgs(['--code', 'short'])).toThrow('8 characters');
  });
});

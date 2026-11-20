import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, call, connection, readConfig } from '../src/connect.js';
import { VERSION } from '../src/version.js';

let dir = '';
afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));
const repo = (config?: unknown) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-conn-'));
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, '.rabbinatix'));
    fs.writeFileSync(path.join(dir, '.rabbinatix', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  fs.mkdirSync(path.join(dir, 'services', 'orders'), { recursive: true });
  return dir;
};

describe('connection: flags, then the environment, then .rabbinatix/config.json', () => {
  it('reads the repository’s config from a sub-folder, and a flag or the environment wins over it', () => {
    const root = repo({ api: 'https://file.example/v1/', systems: { 'services/orders': 'orders', bad: 3 } });
    const sub = path.join(root, 'services', 'orders');
    expect(readConfig(sub)).toMatchObject({ api: 'https://file.example/v1/', systems: { 'services/orders': 'orders' } });
    expect(connection({}, { RABBINATIX_TOKEN: 't' }, sub, 'read')).toEqual({ api: 'https://file.example/v1', token: 't' });
    expect(connection({}, { RABBINATIX_TOKEN: 't', RABBINATIX_API: 'https://env.example/v1' }, sub, 'read')).toMatchObject({ api: 'https://env.example/v1' });
    expect(connection({ api: 'https://flag.example/v1' }, { RABBINATIX_TOKEN: 't', RABBINATIX_API: 'https://env.example/v1' }, sub, 'read')).toMatchObject({ api: 'https://flag.example/v1' });
    expect(connection({ tokenEnv: 'CI_TOKEN' }, { CI_TOKEN: 'c' }, sub, 'read')).toMatchObject({ token: 'c' });
  });

  it('says what is missing, naming the scope; never reads a token from the file', () => {
    expect(connection({}, {}, repo(), 'read')).toEqual({ missing: expect.stringContaining('Say where Rabbinatix is') });
    expect(connection({ api: 'https://x' }, {}, dir, 'deploy')).toEqual({ missing: expect.stringContaining('with the deploy scope') });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => readConfig(repo({ api: 'https://x', token: 'cm_live_x' }))).toThrow('remove it');
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => readConfig(repo('{ nope'))).toThrow('isn’t valid JSON');
  });
});

describe('call: one way every command talks to Rabbinatix', () => {
  const c = { api: 'https://api.example/v1', token: 'cm_live_t' };
  it('sends the token and its version, and reads JSON', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: true }));
    }) as typeof fetch;
    expect(await call(c, 'POST', '/impact', { body: { a: 1 }, fetchFn })).toEqual({ ok: true });
    expect(seen!.url).toBe('https://api.example/v1/impact');
    expect(seen!.init.headers).toMatchObject({ authorization: 'Bearer cm_live_t', 'user-agent': `rabbinatix/${VERSION}`, 'content-type': 'application/json' });
  });

  it('turns answers into readable errors with the status', async () => {
    const answer = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    await expect(call(c, 'GET', '/x', { fetchFn: answer(403, '{"error":"This token lacks the deploy scope."}') })).rejects.toMatchObject({ status: 403, message: 'Rabbinatix answered 403: This token lacks the deploy scope.' });
    await expect(call(c, 'GET', '/x', { fetchFn: answer(200, '<html>') })).rejects.toBeInstanceOf(ApiError);
    await expect(call(c, 'GET', '/x', { fetchFn: (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch })).rejects.toThrow('Couldn’t reach https://api.example/v1/x: ENOTFOUND');
  });

  it('warns once when Rabbinatix asks for a newer CLI', async () => {
    const warned: string[] = [];
    const fetchFn = (async () => new Response('{}', { headers: { 'x-rabbinatix-min-cli': '99.0.0' } })) as unknown as typeof fetch;
    await call(c, 'GET', '/x', { fetchFn, warn: (s) => warned.push(s) });
    await call(c, 'GET', '/x', { fetchFn, warn: (s) => warned.push(s) });
    expect(warned).toEqual([expect.stringContaining('asks for 99.0.0 or newer')]);
  });
});

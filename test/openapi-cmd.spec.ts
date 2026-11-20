import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mainOpenApi, operationsOf, parseOpenApiArgs } from '../src/openapi-cli.js';

const env = { RABBINATIX_API: 'https://api.example/v1', RABBINATIX_TOKEN: 't' };
const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, log: (s: string) => void out.push(s), warn: (s: string) => void err.push(s) }; };
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-oa-'));

describe('rabbinatix openapi', () => {
  it('diff sends only the operations and fails on a breaking change', async () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'api.yaml'), 'openapi: 3.1.0\ninfo:\n  title: Secret plans\n  description: internal notes\nservers:\n  - url: https://internal.example\npaths:\n  /users/{id}:\n    get:\n      responses:\n        "200":\n          description: ok\n');
    let sent: { system: string; spec: Record<string, unknown> } | undefined;
    const fetchFn = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ system: { id: 'users', name: 'Users' }, changes: [{}], lines: [{ level: 'major', text: 'Removed POST /users' }], breaking: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = io();
    expect(await mainOpenApi(['diff', 'api.yaml', '--system', 'users'], d, env, p.log, p.warn, fetchFn)).toBe(1);
    expect(sent!.system).toBe('users');
    expect(Object.keys(sent!.spec['paths'] as object)).toEqual(['/users/{id}']);
    expect(JSON.stringify(sent)).not.toMatch(/Secret plans|internal/);
    expect(p.out.join('\n')).toContain('- breaking: Removed POST /users');
    expect(p.err).toEqual(['The spec would break callers of Users (1).']);
    expect(await mainOpenApi(['diff', 'api.yaml', '--system', 'users', '--fail-on', 'never'], d, env, p.log, p.warn, fetchFn)).toBe(0);
  });

  it('pull writes JSON or YAML by the file name', async () => {
    const d = dir();
    const fetchFn = (async (u: string) => {
      expect(u).toBe('https://api.example/v1/openapi?system=users&version=1.2.0');
      return new Response(JSON.stringify({ system: { id: 'users', name: 'Users', slug: 'users' }, version: '1.2.0', filename: 'users-1.2.0.openapi.json', hash: 'h', openapi: { openapi: '3.1.0', paths: {} } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = io();
    expect(await mainOpenApi(['pull', '--system', 'users', '--version', '1.2.0', '--out', 'api.yml'], d, env, p.log, p.warn, fetchFn)).toBe(0);
    expect(fs.readFileSync(path.join(d, 'api.yml'), 'utf8')).toContain('openapi: 3.1.0');
    expect(p.out).toEqual(['Wrote api.yml: Users 1.2.0.']);
  });

  it('refuses what is not a spec, and bad flags', () => {
    expect(() => operationsOf('{"a":1}')).toThrow('not an OpenAPI document');
    expect(parseOpenApiArgs(['diff', 'x.json', '--system', 's'])).toMatchObject({ action: 'diff', file: 'x.json' });
    expect(() => parseOpenApiArgs(['pull', 'x.json'])).toThrow('Unknown option x.json');
  });
});

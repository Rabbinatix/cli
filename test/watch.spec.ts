import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { watcherModule } from '../src/from-app/watch/assemble';
import { parseShapeText } from '../src/from-app/engine/shape-text';
import type { WatchContracts } from '../src/from-app/watch/runtime/types';
import { gzipSync } from 'node:zlib';
import { otlpProtoFile, otlpProtoRequest } from '../src/otlp-proto.js';
import { contractsOf, harCalls, mainWatch, otlpCalls, otlpRequests, startListener } from '../src/watch-cli.js';

const contracts: WatchContracts = {
  format: 'rabbinatix-watch/1', generatedAt: '2026-11-07T00:00:00Z', fingerprint: 'f', org: { name: 'Acme', slug: 'acme' },
  system: { id: 'web', name: 'Web App', kind: 'frontend' }, hosts: { 'https://api.acme.test': 'users' },
  apis: [{
    key: 'API-WEB-USERS-001', method: 'GET', path: '/users/{id}', provider: { id: 'users', name: 'Users' },
    expects: { request: { pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }], query: [], headers: [] }, responses: [{ status: 200, headers: [], body: parseShapeText('id: string\nname: string') }] },
  } as unknown as WatchContracts['apis'][number]],
  report: { url: 'https://api.example/v1/watch/report', key: 'cm_watch_KEY' },
};
const entry = (url: string, body: string, status = 200) => ({
  startedDateTime: '2026-11-07T10:00:00.000Z', time: 42,
  request: { method: 'GET', url, headers: [{ name: ':authority', value: 'x' }, { name: 'Accept', value: 'application/json' }] },
  response: { status, headers: [{ name: 'Content-Type', value: 'application/json' }], content: { text: Buffer.from(body).toString('base64'), encoding: 'base64' } },
});
const har = { log: { pages: [{ title: 'https://app.acme.test/home' }], entries: [
  entry('https://api.acme.test/users/u1?token=secret', '{"id":"u1"}'),
  entry('https://api.acme.test/teams/t1', '{"id":"t1"}'),
  entry('https://cdn.other.test/lib.json', '{}'),
] } };

describe('rabbinatix watch import', () => {
  it('reads the downloaded watcher’s contracts and the HAR’s calls', () => {
    expect(contractsOf(watcherModule(contracts, '// runtime')).apis[0].key).toBe('API-WEB-USERS-001');
    expect(() => contractsOf('export const x = 1;')).toThrow("isn't a Rabbinatix contract watcher");
    const h = harCalls(JSON.stringify(har));
    expect(h.origin).toBe('https://app.acme.test');
    expect(h.calls[0]).toMatchObject({ method: 'GET', status: 200, responseBody: '{"id":"u1"}', durationMs: 42, requestHeaders: { accept: 'application/json' } });
  });

  it('checks as the watcher does and reports with the watcher’s key, without values or query strings', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-watch-'));
    fs.writeFileSync(path.join(dir, 'rabbinatix-watch.js'), watcherModule(contracts, '// runtime'));
    fs.writeFileSync(path.join(dir, 'session.har'), JSON.stringify(har));
    let sent: { url: string; init: RequestInit } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => { sent = { url, init }; return new Response('{"recorded":2}', { status: 202 }); }) as unknown as typeof fetch;
    const out: string[] = [];
    const err: string[] = [];
    const code = await mainWatch(['import', 'session.har', '--fail-on', 'breaking'], dir, (s) => out.push(s), (s) => err.push(s), fetchFn);
    const body = JSON.parse(String(sent!.init.body)) as { findings: { code: string; apiKey?: string; path: string }[]; calls: { apiKey: string }[] };
    expect(sent!.url).toBe('https://api.example/v1/watch/report');
    expect((sent!.init.headers as Record<string, string>).authorization).toBe('Bearer cm_watch_KEY');
    expect(body.findings.map((f) => f.code).sort()).toEqual(['FIELD_MISSING', 'UNDECLARED_CALL']);
    expect(body.calls).toEqual([{ apiKey: 'API-WEB-USERS-001', status: 200, startMs: Date.parse('2026-11-07T10:00:00.000Z'), durationMs: 42 }]);
    expect(String(sent!.init.body)).not.toMatch(/secret|u1"|sample/);
    expect(out.join('\n')).toContain('Web App: 1 of 3 calls checked against its contracts · 2 findings');
    expect(code).toBe(1);
    expect(await mainWatch(['import', 'session.har', '--no-share'], dir, () => undefined, () => undefined, (() => { throw new Error('sent'); }) as unknown as typeof fetch)).toBe(0);
  });
});

// OTLP/JSON as an exporter sends it: a client span (new conventions), an old-convention one, a server span
const attr = (key: string, v: string | number) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } });
const otlp = { resourceSpans: [{ scopeSpans: [{ spans: [
  { kind: 3, startTimeUnixNano: '1762509600000000000', endTimeUnixNano: '1762509600042000000', attributes: [attr('http.request.method', 'GET'), attr('url.full', 'https://api.acme.test/users/u1'), attr('http.response.status_code', 500)] },
  { kind: 'SPAN_KIND_CLIENT', attributes: [attr('http.method', 'GET'), attr('net.peer.name', 'api.acme.test'), attr('http.target', '/teams/t1'), attr('http.status_code', 200)] },
  { kind: 2, attributes: [attr('http.request.method', 'POST'), attr('url.path', '/orders'), attr('http.response.status_code', 201)] },
] }] }] };

// the same spans in protobuf, as exporters send them by default (a small encoder: the field numbers of trace.proto)
const varint = (x: bigint) => { const o: number[] = []; do { let b = Number(x & 0x7fn); x >>= 7n; if (x) b |= 0x80; o.push(b); } while (x); return o; };
const len = (no: number, b: number[]) => [...varint(BigInt(no << 3 | 2)), ...varint(BigInt(b.length)), ...b];
const str = (no: number, t: string) => len(no, [...Buffer.from(t, 'utf8')]);
const fix64 = (no: number, x: string) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(x)); return [...varint(BigInt(no << 3 | 1)), ...b]; };
const pbValue = (v: { stringValue?: string; intValue?: string }) => (v.stringValue !== undefined ? str(1, v.stringValue) : [...varint(3n << 3n), ...varint(BigInt.asUintN(64, BigInt(v.intValue!)))]);
const pbSpan = (sp: (typeof otlp.resourceSpans)[0]['scopeSpans'][0]['spans'][0]) => [
  ...(typeof sp.kind === 'number' ? [...varint(6n << 3n), ...varint(BigInt(sp.kind))] : [...varint(6n << 3n), 3]),
  ...(sp.startTimeUnixNano ? [...fix64(7, sp.startTimeUnixNano), ...fix64(8, sp.endTimeUnixNano!)] : []),
  ...sp.attributes.flatMap((a) => len(9, [...str(1, a.key), ...len(2, pbValue(a.value))])),
];
const otlpProto = Uint8Array.from(len(1, len(2, otlp.resourceSpans[0].scopeSpans[0].spans.flatMap((sp) => len(2, pbSpan(sp))))));

describe('rabbinatix watch: OpenTelemetry', () => {
  it('protobuf reads into the same calls as JSON; a collector file export (length before each request) too', () => {
    const json = otlpCalls(otlpRequests(JSON.stringify(otlp))!);
    expect(otlpCalls([otlpProtoRequest(otlpProto)! as never])).toEqual(json);
    const frame = (b: Uint8Array) => { const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
    expect(otlpProtoFile(Buffer.concat([frame(otlpProto), frame(otlpProto)]))).toHaveLength(2);
    expect(otlpProtoFile(otlpProto)).toHaveLength(1);
    expect(otlpProtoFile(Buffer.from('not protobuf'))).toBeNull();
    expect(otlpProtoRequest(otlpProto.subarray(0, otlpProto.length - 2))).toBeNull();
  });

  it('client spans are the calls, in both conventions, without bodies or headers to check; server spans are left out', () => {
    const r = otlpCalls(otlpRequests(JSON.stringify(otlp))!);
    expect(r.skipped).toBe(1);
    expect(r.calls.map((c) => `${c.method} ${c.url} ${c.status}`)).toEqual(['GET https://api.acme.test/users/u1 500', 'GET https://api.acme.test/teams/t1 200']);
    expect(r.calls[0]).toMatchObject({ responseBodyUnread: true, requestHeadersUnread: true, durationMs: 42, startedAt: 1762509600000 });
    // a collector's file export: one request per line
    expect(otlpRequests(`${JSON.stringify(otlp)}\n${JSON.stringify(otlp)}\n`)).toHaveLength(2);
    expect(otlpRequests(JSON.stringify(har))).toBeNull();
  });

  it('import reads trace files: a status the app doesn\'t handle, a call nobody declared, no body findings', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-otel-'));
    fs.writeFileSync(path.join(dir, 'rabbinatix-watch.js'), watcherModule(contracts, '// runtime'));
    fs.writeFileSync(path.join(dir, 'traces.json'), JSON.stringify(otlp));
    fs.writeFileSync(path.join(dir, 'traces.pb.gz'), gzipSync(otlpProto));
    for (const file of ['traces.json', 'traces.pb.gz']) {
      const out: string[] = [];
      expect(await mainWatch(['import', file, '--no-share', '--format', 'json'], dir, (s) => out.push(s), () => undefined)).toBe(0);
      const j = JSON.parse(out[0]) as { calls: number; checked: number; findings: { code: string }[] };
      expect(j).toMatchObject({ calls: 2, checked: 1 });
      expect(j.findings.map((f) => f.code).sort()).toEqual(['STATUS_UNHANDLED', 'UNDECLARED_CALL']);
    }
  });
});

describe('rabbinatix watch listen', () => {
  it('checks calls the phone SDKs send and traces exporters send, prints each new finding once, and reports in a batch', async () => {
    const sent: string[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => { sent.push(String(init.body)); return new Response('{}', { status: 202 }); }) as unknown as typeof fetch;
    const out: string[] = [];
    const l = await startListener({ contracts, port: 0, host: '127.0.0.1', share: true, fetchFn, log: (s) => out.push(s), warn: () => undefined });
    const at = `http://127.0.0.1:${l.port}`;
    const call = { method: 'GET', url: 'https://api.acme.test/users/u1', status: 200, requestHeaders: {}, responseHeaders: { 'Content-Type': 'application/json' }, responseBody: '{"id":"u1"}' };
    for (let i = 0; i < 2; i++) expect((await fetch(`${at}/calls`, { method: 'POST', body: JSON.stringify({ calls: [call] }) })).status).toBe(200);
    expect((await fetch(`${at}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(otlp) })).status).toBe(200);
    // protobuf, gzipped, as an exporter sends it by default; the reply is an empty ExportTraceServiceResponse
    const pb = await fetch(`${at}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip' }, body: gzipSync(otlpProto) });
    expect([pb.status, pb.headers.get('content-type'), (await pb.arrayBuffer()).byteLength]).toEqual([200, 'application/x-protobuf', 0]);
    expect((await fetch(`${at}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: 'x\xff\xff' })).status).toBe(400);
    expect((await fetch(`${at}/calls`, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: 'x' })).status).toBe(415);
    expect(await (await fetch(at)).json()).toMatchObject({ system: 'Web App', received: 6, checked: 4 });
    expect(out.filter((s) => s.includes('name'))).toHaveLength(1);
    await l.close();
    const batch = JSON.parse(sent[0]) as { findings: { code: string; count: number }[] };
    expect(batch.findings.find((f) => f.code === 'FIELD_MISSING')).toMatchObject({ count: 2 });
    expect(sent[0]).not.toContain('u1');
  });

  it('with a code (phones on the network), a call without it is turned away', async () => {
    const l = await startListener({ contracts, port: 0, host: '127.0.0.1', code: 'k7xm-p2qa-9fdz', share: false, fetchFn: fetch, log: () => undefined, warn: () => undefined });
    const at = `http://127.0.0.1:${l.port}/calls`;
    expect((await fetch(at, { method: 'POST', body: '[]' })).status).toBe(401);
    expect((await fetch(at, { method: 'POST', headers: { 'x-rabbinatix-code': 'k7xm-p2qa-9fdz' }, body: '[]' })).status).toBe(200);
    expect((await fetch(at, { method: 'POST', headers: { authorization: 'Bearer k7xm-p2qa-9fdz' }, body: '[]' })).status).toBe(200);
    await l.close();
  });
});

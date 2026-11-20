// rabbinatix watch (assistant-and-cli-plan.md § 3.2; languages-plan.md § Final scope, step 2): calls checked like the
// downloaded contract watcher checks live calls in a browser, with the watcher's own contracts and code
// (app/src/app/watch/runtime), and reported into the same place: the connection page's drift and "Declare this API?"
// (POST /v1/watch/report with the watcher's key). Values seen never leave the machine.
//   import <file>   a HAR recording (the browser's Network tab, a proxy) or OpenTelemetry trace data (OTLP in JSON
//                   or protobuf, a collector's file export)
//   listen          a local address that apps send their calls to while they run: the phone SDKs (Android, iOS, Flutter,
//                   React Native: app/scripts/watch/phone) and any OpenTelemetry exporter (OTLP/HTTP, protobuf or JSON)
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import { otlpProtoFile, otlpProtoRequest } from './otlp-proto.js';
import { checkCall, undeclared } from './from-app/watch/runtime/check';
import { atLeast, createFindings } from './from-app/watch/runtime/findings';
import { createReporter } from './from-app/watch/runtime/report-server';
import { newCode } from './relay-cli.js';
import { createMatcher } from './from-app/watch/runtime/match';
import { isJsonType } from './from-app/watch/runtime/observe';
import type { Finding, FindingLevel, ObservedCall, WatchContracts } from './from-app/watch/runtime/types';
import type { Fetch } from './connect.js';
import { VERSION } from './version.js';

export const WATCH_PORT = 4012;

export const WATCH_HELP = `rabbinatix watch: calls checked against the contracts, like the contract watcher in a browser

Usage: rabbinatix watch import <file> [--watcher <rabbinatix-watch.js>] [options]
       rabbinatix watch listen [--watcher <rabbinatix-watch.js>] [options]

Checks every call against what the system expects of the APIs it calls (and what their providers declare), as the
downloaded contract watcher does in the browser. Findings go to Rabbinatix like the watcher's: drift on the connection
page, calls nobody declared as "Declare this API?".

  import <file>           a HAR recording (the browser's Network tab → Save all as HAR, Charles, Proxyman, mitmproxy)
                          or OpenTelemetry trace data, JSON or protobuf (a collector's file exporter, or one OTLP
                          request)
  listen                  wait for calls while your app runs: the phone SDKs (Android, iOS, Flutter, React Native)
                          send each call here, and an OpenTelemetry exporter can send its traces here (OTLP/HTTP)

  --watcher <file>        the system's downloaded watcher (System → Contract watcher → Download); default
                          ./rabbinatix-watch.js. It holds the contracts and the key findings are reported with.
  --origin <url>          import: the address of the page that made the calls (default: the HAR's first page)
  --port <n>              listen: the port (default ${WATCH_PORT})
  --host <address>        listen: 127.0.0.1 (default: this computer, emulators and simulators) or 0.0.0.0 (phones
                          on your network too, which then need the code it shows)
  --code <code>           listen: use this code instead of a new one
  --no-share              check and print only; send nothing
  --fail-on <level>       breaking, warning or never (default): exit 1 when a finding is at least this bad
  --format <md|json>      what to print (default md)
  -h, --help              this help

Sends (unless --no-share): per finding, the API, what was expected and what was found, and how often; per call, the
API's key, status and timing. Never the values seen, URLs' query strings or bodies.
Exit codes: 0 done · 1 --fail-on matched · 2 an error.`;

interface WatchArgs { action?: 'import' | 'listen'; file?: string; watcher: string; origin?: string; share: boolean; failOn: FindingLevel | 'never'; format: 'md' | 'json'; help: boolean; port: number; host: string; code?: string }

export function parseWatchArgs(argv: string[]): WatchArgs {
  const a: WatchArgs = { watcher: 'rabbinatix-watch.js', share: true, failOn: 'never', format: 'md', help: false, port: WATCH_PORT, host: '127.0.0.1' };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case '--watcher': a.watcher = value(i++, f); break;
      case '--origin': { const v = value(i++, f); try { a.origin = new URL(v).origin; } catch { throw new Error(`--origin ${v} isn't a web address.`); } break; }
      case '--no-share': a.share = false; break;
      case '--fail-on': { const v = value(i++, f); if (!['breaking', 'warning', 'never'].includes(v)) throw new Error('--fail-on is breaking, warning or never.'); a.failOn = v as WatchArgs['failOn']; break; }
      case '--format': { const v = value(i++, f); if (v !== 'md' && v !== 'json') throw new Error('--format is md or json.'); a.format = v; break; }
      case '--port': { const v = Number(value(i++, f)); if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error('--port is a number from 1 to 65535.'); a.port = v; break; }
      case '--host': a.host = value(i++, f); break;
      case '--code': { const v = value(i++, f); if (v.length < 8) throw new Error('--code needs at least 8 characters.'); a.code = v; break; }
      case '-h': case '--help': a.help = true; break;
      default:
        if (i === 0 && (f === 'import' || f === 'listen')) { a.action = f; break; }
        if (a.action && !a.file && !f.startsWith('-')) { a.file = f; break; }
        throw new Error(`Unknown option ${f}. See --help.`);
    }
  }
  return a;
}

/** the contracts a downloaded rabbinatix-watch.js carries (assemble.ts watcherModule writes them as JSON) */
export function contractsOf(js: string): WatchContracts {
  const m = /\nconst CONTRACTS = (\{[\s\S]*?\n\});\n/.exec(js);
  if (!m) throw new Error("that isn't a Rabbinatix contract watcher (no contracts in it). Download it from the system's Contract watcher.");
  const c = JSON.parse(m[1]) as WatchContracts;
  if (!c.format?.startsWith('rabbinatix-watch/')) throw new Error(`a watcher format this version doesn't read (${c.format}): update rabbinatix.`);
  return c;
}

interface HarHeader { name: string; value: string }
interface HarEntry {
  startedDateTime?: string; time?: number;
  request: { method: string; url: string; headers?: HarHeader[]; postData?: { text?: string; mimeType?: string } };
  response: { status: number; headers?: HarHeader[]; content?: { text?: string; encoding?: string; mimeType?: string } };
}

const headers = (list: HarHeader[] = []) => Object.fromEntries(list.filter((h) => !h.name.startsWith(':')).map((h) => [h.name.toLowerCase(), h.value]));

/** a HAR file's calls, as the watcher's interceptor hands them over; the page's address from its first page */
export function harCalls(text: string): { calls: ObservedCall[]; origin?: string; skipped: number } {
  const har = JSON.parse(text) as { log?: { entries?: HarEntry[]; pages?: { title?: string }[] } };
  if (!har.log || !Array.isArray(har.log.entries)) throw new Error('not a HAR file (no log.entries).');
  let origin: string | undefined;
  try { origin = har.log.pages?.[0]?.title ? new URL(har.log.pages[0].title).origin : undefined; } catch { /* a title that isn't an address */ }
  let skipped = 0;
  const calls: ObservedCall[] = [];
  for (const e of har.log.entries) {
    if (!e?.request?.url || !/^https?:/.test(e.request.url) || !e.response || e.response.status <= 0) { skipped++; continue; }
    const content = e.response.content;
    const body = content?.text === undefined ? undefined : content.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
    const rh = headers(e.response.headers);
    if (!rh['content-type'] && content?.mimeType) rh['content-type'] = content.mimeType;
    const start = e.startedDateTime ? Date.parse(e.startedDateTime) : NaN;
    calls.push({
      method: e.request.method.toUpperCase(), url: e.request.url, requestHeaders: headers(e.request.headers),
      ...(e.request.postData?.text !== undefined ? { requestBody: e.request.postData.text } : {}),
      status: e.response.status, responseHeaders: rh, ...(body !== undefined ? { responseBody: body } : {}),
      ...(Number.isFinite(start) ? { startedAt: start } : {}), ...(typeof e.time === 'number' && e.time >= 0 ? { durationMs: Math.round(e.time) } : {}),
    });
  }
  return { calls, origin, skipped };
}

// ---------------------------------------------------------------- OpenTelemetry

interface OtlpValue { stringValue?: string; intValue?: string | number; boolValue?: boolean; doubleValue?: number; arrayValue?: { values?: OtlpValue[] } }
interface OtlpSpan { kind?: number | string; startTimeUnixNano?: string | number; endTimeUnixNano?: string | number; attributes?: { key: string; value: OtlpValue }[] }
interface OtlpRequest { resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[]; instrumentationLibrarySpans?: { spans?: OtlpSpan[] }[] }[] }

const otlpValue = (v: OtlpValue | undefined): string | undefined => {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return String(v.intValue);
  if (v.doubleValue !== undefined) return String(v.doubleValue);
  if (v.boolValue !== undefined) return String(v.boolValue);
  return v.arrayValue?.values?.map(otlpValue).filter((x) => x !== undefined).join(', ');
};

/** OTLP/JSON requests in a text: one, or a collector's file export (one per line); null when it holds none */
export function otlpRequests(text: string): OtlpRequest[] | null {
  const parse = (t: string) => { try { return JSON.parse(t) as OtlpRequest; } catch { return null; } };
  const whole = parse(text);
  const list = whole ? [whole] : text.split(/\r?\n/).filter((l) => l.trim()).map(parse).filter((x): x is OtlpRequest => !!x);
  return list.some((r) => Array.isArray(r?.resourceSpans)) ? list : null;
}

/**
 * The HTTP calls OpenTelemetry client spans record (the calls a service makes), with the semantic conventions old and
 * new (`http.request.method` / `http.method`, `url.full` / `http.url` …). Spans hold no bodies and, unless the SDK was
 * told to capture them, no headers: those aren't checked.
 */
export function otlpCalls(reqs: OtlpRequest[]): { calls: ObservedCall[]; skipped: number } {
  const calls: ObservedCall[] = [];
  let skipped = 0;
  for (const r of reqs) for (const rs of r.resourceSpans ?? []) for (const ss of [...(rs.scopeSpans ?? []), ...(rs.instrumentationLibrarySpans ?? [])]) for (const sp of ss.spans ?? []) {
    const a = new Map((sp.attributes ?? []).map((x) => [x.key, otlpValue(x.value)]));
    const kind = String(sp.kind ?? '');
    const method = a.get('http.request.method') ?? a.get('http.method');
    const status = Number(a.get('http.response.status_code') ?? a.get('http.status_code'));
    // client spans only (3, SPAN_KIND_CLIENT): a server span is a call to this service, not one it makes
    if (!method || !(status > 0) || (kind !== '3' && kind !== 'SPAN_KIND_CLIENT')) { skipped++; continue; }
    let url = a.get('url.full') ?? a.get('http.url');
    if (!url) {
      const host = a.get('server.address') ?? a.get('net.peer.name') ?? a.get('http.host');
      const port = a.get('server.port') ?? a.get('net.peer.port');
      const scheme = a.get('url.scheme') ?? a.get('http.scheme') ?? 'https';
      const target = a.get('url.path') ?? a.get('http.target') ?? '/';
      if (!host) { skipped++; continue; }
      url = `${scheme}://${host}${port && !['80', '443'].includes(port) ? `:${port}` : ''}${target.startsWith('/') ? target : `/${target}`}`;
    }
    const headers = (prefix: string) => Object.fromEntries([...a].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length).replace(/_/g, '-').toLowerCase(), v ?? '']));
    const requestHeaders = headers('http.request.header.');
    const responseHeaders = headers('http.response.header.');
    const start = Number(sp.startTimeUnixNano) / 1e6;
    const end = Number(sp.endTimeUnixNano) / 1e6;
    calls.push({
      method: method.toUpperCase(), url, status, requestHeaders, responseHeaders, responseBodyUnread: true, requestBodyUnread: true,
      ...(Object.keys(requestHeaders).length ? {} : { requestHeadersUnread: true }),
      ...(Number.isFinite(start) && start > 0 ? { startedAt: Math.round(start) } : {}), ...(Number.isFinite(end - start) && end >= start ? { durationMs: Math.round(end - start) } : {}),
    });
  }
  return { calls, skipped };
}

/** a call as a phone SDK sends it (app/scripts/watch/phone): the same fields the browser watcher sees */
export function sdkCall(x: unknown): ObservedCall | null {
  const o = x as Record<string, unknown>;
  if (!o || typeof o.method !== 'string' || typeof o.url !== 'string' || typeof o.status !== 'number') return null;
  const hs = (h: unknown) => Object.fromEntries(Object.entries((h && typeof h === 'object' ? h : {}) as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    method: o.method.toUpperCase(), url: o.url, status: o.status, requestHeaders: hs(o.requestHeaders), responseHeaders: hs(o.responseHeaders),
    ...(typeof o.requestBody === 'string' ? { requestBody: o.requestBody } : {}), ...(o.requestBodyUnread === true ? { requestBodyUnread: true } : {}),
    ...(typeof o.responseBody === 'string' ? { responseBody: o.responseBody } : {}), ...(o.responseBodyUnread === true ? { responseBodyUnread: true } : {}),
    ...(typeof o.startedAt === 'number' ? { startedAt: o.startedAt } : {}), ...(typeof o.durationMs === 'number' ? { durationMs: o.durationMs } : {}),
  };
}

// ---------------------------------------------------------------- listen

export interface Listener { port: number; findings: () => Finding[]; checked: () => number; received: () => number; close: () => Promise<void> }

/**
 * A local address apps send their calls to: POST /calls (the SDKs: { calls: [...] }) and POST /v1/traces (OTLP/HTTP
 * JSON). Each call is checked as it arrives; new findings are printed, and reported in the watcher's batches.
 */
export function startListener(o: { contracts: WatchContracts; port: number; host: string; code?: string; share: boolean; fetchFn: Fetch; log: Print; warn: Print }): Promise<Listener> {
  const c = o.contracts;
  const match = createMatcher(c.apis);
  const store = createFindings();
  const send = ((url: string, init: RequestInit) => o.fetchFn(url, { ...init, headers: { ...(init.headers as Record<string, string>), 'user-agent': `rabbinatix/${VERSION}` } })) as typeof fetch;
  const reporter = o.share && c.report ? createReporter(c, send) : undefined;
  let checked = 0;
  let received = 0;
  const icon: Record<string, string> = { breaking: '❌', warning: '⚠️', info: '·' };
  const take = (calls: ObservedCall[]) => {
    for (const call of calls) {
      received++;
      let url: URL;
      try { url = new URL(call.url); } catch { continue; }
      const m = match(call.method, url, c.hosts, '');
      const raw = m.api ? checkCall(m.api, call) : m.known && (call.responseBodyUnread || isJsonType(call.responseHeaders['content-type'])) ? [undeclared(call, m.path, m.providerId)] : [];
      if (m.api) { checked++; reporter?.call(m.api.key, call); }
      for (const r of raw) {
        const { finding, isNew } = store.add(r);
        reporter?.add(finding);
        if (isNew && atLeast(finding.level, 'info')) o.log(`${icon[finding.level]} ${finding.method} ${finding.path ?? finding.url}: ${finding.message}`);
      }
    }
  };
  const server = http.createServer((req, res) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && (req.url === '/' || req.url === '/status')) return reply(200, { system: c.system.name, received, checked, findings: store.list().length });
    if (req.method !== 'POST') return reply(405, { error: 'POST calls to /calls, or traces to /v1/traces.' });
    if (o.code) {
      const given = String(req.headers['x-rabbinatix-code'] ?? '') || String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (given !== o.code) return reply(401, { error: "The code doesn't match: use the code the terminal shows." });
    }
    const proto = /protobuf/i.test(String(req.headers['content-type'] ?? ''));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (b: Buffer) => { size += b.length; if (size <= 10_000_000) chunks.push(b); });
    req.on('end', () => {
      if (size > 10_000_000) return reply(413, { error: 'At most 10 MB at a time.' });
      // exporters compress with gzip by default (OTEL_EXPORTER_OTLP_COMPRESSION)
      let raw = Buffer.concat(chunks);
      const encoding = String(req.headers['content-encoding'] ?? '').toLowerCase();
      try {
        if (encoding === 'gzip') raw = gunzipSync(raw, { maxOutputLength: 50_000_000 });
        else if (encoding === 'deflate') raw = inflateSync(raw, { maxOutputLength: 50_000_000 });
      } catch { return reply(400, { error: `Not ${encoding} data.` }); }
      const pathName = (req.url ?? '').split('?')[0];
      if (proto) {
        if (pathName !== '/v1/traces') return reply(415, { error: 'Only traces (/v1/traces) are read in protobuf; send calls to /calls as JSON.' });
        const r = otlpProtoRequest(raw);
        if (!r) return reply(400, { error: 'Not an OTLP trace request in protobuf.' });
        take(otlpCalls([r as OtlpRequest]).calls);
        // an empty ExportTraceServiceResponse
        res.writeHead(200, { 'content-type': 'application/x-protobuf' });
        return res.end();
      }
      let body: unknown;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return reply(400, { error: 'Not JSON.' }); }
      if (pathName === '/v1/traces') {
        const r = otlpCalls([body as OtlpRequest]);
        take(r.calls);
        return reply(200, {});
      }
      if (pathName === '/calls') {
        const list = (Array.isArray(body) ? body : (body as { calls?: unknown[] })?.calls ?? []).map(sdkCall).filter((x): x is ObservedCall => !!x);
        take(list);
        return reply(200, { checked: list.length });
      }
      reply(404, { error: 'POST calls to /calls, or traces to /v1/traces.' });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port, findings: () => store.list(), checked: () => checked, received: () => received,
        close: () => new Promise<void>((done) => { reporter?.flush(); server.close(() => done()); server.closeAllConnections?.(); }),
      });
    });
  });
}

/** the calls checked as the watcher checks them; what would be reported, as the watcher's reporter batches it */
export function checkHar(c: WatchContracts, calls: ObservedCall[], origin: string) {
  const match = createMatcher(c.apis);
  const store = createFindings();
  const traced: { apiKey: string; status: number; startMs: number; durationMs: number }[] = [];
  let checked = 0;
  for (const call of calls) {
    let url: URL;
    try { url = new URL(call.url); } catch { continue; }
    const m = match(call.method, url, c.hosts, origin);
    const raw = m.api ? checkCall(m.api, call) : m.known && (call.responseBodyUnread || isJsonType(call.responseHeaders['content-type'])) ? [undeclared(call, m.path, m.providerId)] : [];
    if (m.api) { checked++; traced.push({ apiKey: m.api.key, status: call.status, startMs: call.startedAt ?? Date.now(), durationMs: call.durationMs ?? 0 }); }
    for (const r of raw) store.add(r);
  }
  const providerOf = new Map(c.apis.map((x) => [x.key, x.provider.id]));
  const findings = store.list();
  const report = findings.map((f) => ({
    method: f.method, path: f.path ?? new URL(f.url).pathname, apiKey: f.apiKey, providerId: (f.apiKey && providerOf.get(f.apiKey)) || f.providerId || '', code: f.code, level: f.level,
    against: f.against, pointer: f.pointer, expected: f.expected, actual: f.actual, message: f.message, count: f.count,
  }));
  return { findings, report, calls: traced, checked };
}

type Print = (s: string) => void;

export async function mainWatch(argv: string[], cwd: string, log: Print, warn: Print, fetchFn: Fetch = fetch): Promise<number> {
  let a: WatchArgs;
  try {
    a = parseWatchArgs(argv);
  } catch (e) {
    warn((e as Error).message);
    return 2;
  }
  if (a.help) { log(WATCH_HELP); return 0; }
  if (!a.action || (a.action === 'import' && !a.file)) { warn('Usage: rabbinatix watch import <file> or rabbinatix watch listen [--watcher rabbinatix-watch.js]. See --help.'); return 2; }
  let contracts: WatchContracts;
  let har: ReturnType<typeof harCalls>;
  try {
    contracts = contractsOf(fs.readFileSync(path.resolve(cwd, a.watcher), 'utf8'));
  } catch (e) {
    warn(`Can't read the watcher ${a.watcher}: ${(e as Error).message}`);
    return 2;
  }
  if (a.action === 'listen') return listenUntilStopped(a, contracts, log, warn, fetchFn);
  try {
    let bytes = fs.readFileSync(path.resolve(cwd, a.file!));
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes, { maxOutputLength: 500_000_000 });
    const text = bytes.toString('utf8');
    const otlp = otlpRequests(text) ?? (/^\s*[{[]/.test(text) ? null : (otlpProtoFile(bytes) as OtlpRequest[] | null));
    har = otlp ? { ...otlpCalls(otlp), origin: undefined } : harCalls(text);
  } catch (e) {
    warn(`Can't read ${a.file}: ${(e as Error).message}`);
    return 2;
  }
  const origin = a.origin ?? har.origin ?? '';
  if (!origin && /\.har$/i.test(a.file!)) warn('note: the HAR names no page, so calls to the page’s own address aren’t matched. Say it with --origin.');
  const r = checkHar(contracts, har.calls, origin);
  let sent = false;
  if (a.share && contracts.report && (r.report.length || r.calls.length)) {
    // one report, as one watcher batch: at most 200 findings and 50 calls are read (functions/src/api-logic.ts)
    const res = await fetchFn(contracts.report.url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${contracts.report.key}`, 'user-agent': `rabbinatix/${VERSION}` },
      body: JSON.stringify({ findings: r.report.slice(0, 200), calls: r.calls.slice(0, 50) }),
    }).catch((e: Error) => e);
    if (res instanceof Error || !res.ok) {
      warn(`Rabbinatix didn't take the report: ${res instanceof Error ? res.message : `${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`}`);
      return 2;
    }
    sent = true;
  } else if (a.share && !contracts.report) warn('note: this watcher was downloaded without a report key, so nothing is sent. Download it again to report.');
  const shown = r.findings.filter((f) => atLeast(f.level, 'info'));
  if (a.format === 'json') log(JSON.stringify({ system: contracts.system, calls: har.calls.length, checked: r.checked, findings: shown.map(({ sample: _s, ...f }) => f), sent }, null, 2));
  else log(watchMarkdown(contracts, har.calls.length, r.checked, shown, sent));
  const failed = a.failOn !== 'never' && r.findings.some((f) => atLeast(f.level, a.failOn as FindingLevel));
  if (failed) warn(`Failing: findings at ${a.failOn} or worse.`);
  return failed ? 1 : 0;
}

async function listenUntilStopped(a: WatchArgs, contracts: WatchContracts, log: Print, warn: Print, fetchFn: Fetch): Promise<number> {
  const local = a.host === '127.0.0.1' || a.host === 'localhost' || a.host === '::1';
  const code = local ? a.code : (a.code ?? newCode());
  let l: Listener;
  try {
    l = await startListener({ contracts, port: a.port, host: a.host, code, share: a.share && !!contracts.report, fetchFn, log, warn });
  } catch (e) {
    warn(`Can't listen on ${a.host}:${a.port}: ${(e as Error).message}${(e as { code?: string }).code === 'EADDRINUSE' ? ' (in use: try --port)' : ''}`);
    return 2;
  }
  const at = (h: string) => `http://${h}:${l.port}`;
  log([
    `Checking ${contracts.system.name}'s calls against its contracts (${contracts.apis.length} API${contracts.apis.length === 1 ? '' : 's'}). Send them to:`,
    `  Android emulator             ${at('10.0.2.2')}`,
    `  iOS simulator, this computer ${at('127.0.0.1')}`,
    ...(local ? [] : [`  phones on your network       http://<this computer's address>:${l.port}   code: ${code}`]),
    `  OpenTelemetry                OTEL_EXPORTER_OTLP_ENDPOINT=${at('127.0.0.1')} (protobuf or JSON)`,
    a.share && contracts.report ? 'Findings are reported to Rabbinatix as they come (about every 10 seconds).' : 'Nothing is sent to Rabbinatix.',
    'Stop with Ctrl+C.',
  ].join('\n'));
  await new Promise<void>((done) => { process.once('SIGINT', () => done()); process.once('SIGTERM', () => done()); });
  await l.close();
  const shown = l.findings().filter((f) => atLeast(f.level, 'info'));
  if (a.format === 'json') log(JSON.stringify({ system: contracts.system, calls: l.received(), checked: l.checked(), findings: shown.map(({ sample: _s, ...f }) => f), sent: a.share && !!contracts.report }, null, 2));
  else log(watchMarkdown(contracts, l.received(), l.checked(), shown, a.share && !!contracts.report));
  const failed = a.failOn !== 'never' && l.findings().some((f) => atLeast(f.level, a.failOn as FindingLevel));
  if (failed) warn(`Failing: findings at ${a.failOn} or worse.`);
  return failed ? 1 : 0;
}

function watchMarkdown(c: WatchContracts, total: number, checked: number, findings: Finding[], sent: boolean): string {
  const icon: Record<string, string> = { breaking: '❌', warning: '⚠️', info: '·' };
  const out = [`## ${c.system.name}: ${checked} of ${total} call${total === 1 ? '' : 's'} checked against its contracts · ${findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'all as expected'}`, ''];
  for (const f of findings) out.push(`- ${icon[f.level]} ${f.method} ${f.path ?? f.url}${f.count > 1 ? ` (${f.count}×)` : ''}: ${f.message}`);
  if (sent) out.push('', 'Reported to Rabbinatix: see the connection page (drift) and the system page (“Declare this API?”).');
  return out.join('\n');
}

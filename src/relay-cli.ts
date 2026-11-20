// rabbinatix relay (assistant-and-cli-plan.md § 3.2): Test APIs' requests sent from this machine, so the API needs no
// CORS headers and local or VPN addresses work. Listens on 127.0.0.1 only; answers only the Rabbinatix app's web
// addresses (and --origin ones), and only calls that carry the code shown in the terminal. Sends nothing to Rabbinatix.
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { VERSION } from './version.js';

export const RELAY_HELP = `rabbinatix relay: send Test APIs' requests from this machine (no CORS; local and VPN addresses work)

Usage: rabbinatix relay [--port 4011] [--origin <url>]

Starts a relay on 127.0.0.1 (this machine only). In Rabbinatix, open Test APIs → Send through → This computer, and type
the code it shows. Stop it with Ctrl+C; the code changes every time it starts.

  --port <n>        the port (default 4011)
  --origin <url>    also accept calls from this web address (the app's own addresses are accepted already); repeat it
  --code <code>     use this code instead of a new one (for scripts; keep it secret)
  -h, --help        this help

Sends nothing to Rabbinatix: each request goes from this machine to the API it names, and the answer goes back to the
page that asked.`;

/** the app's own addresses */
const APP_ORIGINS = [/^https:\/\/(?:[a-z0-9-]+\.)*rabbinatix\.com$/, /^http:\/\/localhost:4200$/, /^http:\/\/127\.0\.0\.1:4200$/];
export const RELAY_PORT = 4011;
const MAX_BODY = 10_000_000;
const TIMEOUT_MS = 30_000;
/** not passed on: the browser's own, the relay's, and those of one connection */
const DROP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'origin', 'referer', 'cookie', 'x-rabbinatix-relay', 'accept-encoding']);

export interface RelayOptions { port: number; origins: string[]; code: string; fetchFn?: typeof fetch; log?: (s: string) => void }

export function parseRelayArgs(argv: string[]): { port: number; origins: string[]; code?: string; help: boolean } {
  const a = { port: RELAY_PORT, origins: [] as string[], code: undefined as string | undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    const v = argv[i + 1];
    const need = () => { if (v === undefined || v.startsWith('--')) throw new Error(`${f} needs a value.`); i++; return v; };
    switch (f) {
      case '--port': { const n = Number(need()); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('--port is a number from 1 to 65535.'); a.port = n; break; }
      case '--origin': { const o = need(); let u: URL; try { u = new URL(o); } catch { throw new Error(`--origin ${o} isn't a web address.`); } a.origins.push(u.origin); break; }
      case '--code': { const c = need(); if (c.length < 8) throw new Error('--code needs at least 8 characters.'); a.code = c; break; }
      case '-h': case '--help': a.help = true; break;
      default: throw new Error(`Unknown option ${f}. See --help.`);
    }
  }
  return a;
}

/** a code people can type: 3 groups of 4, no look-alike letters */
export function newCode(): string {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  return [0, 4, 8].map((s) => Array.from(bytes.subarray(s, s + 4), (b) => abc[b % abc.length]).join('')).join('-');
}

const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function allowedOrigin(origin: string | undefined, extra: string[]): boolean {
  return !!origin && (extra.includes(origin) || APP_ORIGINS.some((r) => r.test(origin)));
}

/** the relay's request handler (exported for the specs) */
export function relayHandler(o: RelayOptions): http.RequestListener {
  const fetchFn = o.fetchFn ?? fetch;
  return (req, res) => {
    const origin = req.headers.origin;
    const ok = allowedOrigin(origin, o.origins);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', ...(ok ? { 'access-control-allow-origin': origin!, vary: 'Origin' } : {}) });
      res.end(JSON.stringify(body));
    };
    if (!ok) return json(403, { error: `Calls from ${origin ?? 'no web page'} aren't accepted. Start the relay with --origin ${origin ?? '<url>'} to accept them.` });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': origin!, vary: 'Origin', 'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type, x-rabbinatix-relay', 'access-control-allow-private-network': 'true', 'access-control-max-age': '600',
      });
      return res.end();
    }
    const code = String(req.headers['x-rabbinatix-relay'] ?? '');
    if (!same(code, o.code)) return json(401, { error: "The relay's code doesn't match: type the code the terminal shows." });
    if (req.method === 'GET' && req.url === '/hello') return json(200, { ok: true, version: VERSION });
    if (req.method !== 'POST' || req.url !== '/send') return json(404, { error: 'The relay answers GET /hello and POST /send.' });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { json(413, { error: 'At most 10 MB a request.' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (size > MAX_BODY) return;
      let ask: { method?: string; url?: string; headers?: Record<string, string>; body?: string };
      try {
        ask = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(400, { error: 'Send JSON: {"method", "url", "headers", "body"}.' });
      }
      let url: URL;
      try {
        url = new URL(String(ask.url));
      } catch {
        return json(400, { error: `${ask.url} isn't a web address.` });
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return json(400, { error: 'Only http and https addresses.' });
      const method = String(ask.method ?? 'GET').toUpperCase();
      const headers = Object.fromEntries(Object.entries(ask.headers ?? {}).filter(([k]) => !DROP.has(k.toLowerCase())).map(([k, v]) => [k, String(v)]));
      const start = performance.now();
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const r = await fetchFn(url, { method, headers, ...(ask.body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body: ask.body } : {}), redirect: 'follow', signal: ctl.signal });
        const text = await r.text();
        o.log?.(`${method} ${url.origin}${url.pathname} → ${r.status}`);
        json(200, { status: r.status, statusText: r.statusText, headers: Object.fromEntries([...r.headers].map(([k, v]) => [k.toLowerCase(), v])), body: text, ms: Math.round(performance.now() - start), size: Buffer.byteLength(text) });
      } catch (e) {
        const timedOut = ctl.signal.aborted;
        o.log?.(`${method} ${url.origin}${url.pathname} → ${timedOut ? 'no answer in 30 s' : 'failed'}`);
        json(502, { error: timedOut ? 'No answer in 30 seconds.' : `The API couldn't be reached from this machine: ${(e as Error & { cause?: Error }).cause?.message ?? (e as Error).message}`, timeout: timedOut, ms: Math.round(performance.now() - start) });
      } finally {
        clearTimeout(t);
      }
    });
  };
}

export async function mainRelay(argv: string[], log: (s: string) => void, warn: (s: string) => void): Promise<number> {
  let a: ReturnType<typeof parseRelayArgs>;
  try {
    a = parseRelayArgs(argv);
  } catch (e) {
    warn((e as Error).message);
    return 2;
  }
  if (a.help) { log(RELAY_HELP); return 0; }
  const code = a.code ?? newCode();
  const server = http.createServer(relayHandler({ port: a.port, origins: a.origins, code, log }));
  return new Promise<number>((resolve) => {
    server.on('error', (e: NodeJS.ErrnoException) => {
      warn(e.code === 'EADDRINUSE' ? `Port ${a.port} is in use: is a relay running already? Or pick another with --port.` : e.message);
      resolve(2);
    });
    server.listen(a.port, '127.0.0.1', () => {
      log(`Relay on http://127.0.0.1:${a.port} (this machine only).\n\n  Code: ${code}\n\nIn Rabbinatix: Test APIs → Send through → This computer, and type the code. Ctrl+C stops it.\n`);
      const stop = () => server.close(() => resolve(0));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  });
}

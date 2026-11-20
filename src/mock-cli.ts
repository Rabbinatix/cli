// rabbinatix mock: the test server on this machine. One call to Rabbinatix when it starts (and one per reload), or
// none with --from; every call to the test server is answered here.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { connection } from './connect.js';
import { endpointLines, isSnapshot, loadSnapshot, MockSnapshot, Served, serveMock } from './mock.js';

export const MOCK_HELP = `rabbinatix mock: a system's test server on this machine

Usage: rabbinatix mock --system <id or name> [options]

  --system <id|name>   the system whose APIs it answers for (Integrations → API & CI, GET /systems lists them)
  --port <n>           the port (default 4010; 0 picks a free one)
  --host <address>     where it listens (default 127.0.0.1; 0.0.0.0 to reach it from other machines or containers)
  --api <url>          the API address, from Integrations → API & CI (or RABBINATIX_API)
  --token-env <name>   the environment variable holding the API token (default RABBINATIX_TOKEN; the read scope)
  --save <file>        also write what was loaded, to start later with --from (commit it for CI)
  --from <file>        answer from a file saved with --save: no call to Rabbinatix, no token
  --quiet              don't print each call
  -h, --help           this help

It answers like the hosted test server: example data in the declared shape, ?__status=404 or X-Mock-Status picks
another declared response, ?__seed=abc or X-Mock-Seed varies the values, ?__version=v1 or X-Mock-Version picks an
API version, and endpoints with "Validate requests" on refuse calls that don't fit. Type r and Enter to load the
system again after publishing. Calls to it never reach Rabbinatix.

Exit codes: 0 stopped · 2 something went wrong (no token, system not found, port in use, Rabbinatix unreachable).`;

export interface MockArgs {
  system?: string; port: number; host: string; api?: string; tokenEnv: string; save?: string; from?: string; quiet: boolean; help: boolean;
}

export function parseMockArgs(argv: string[]): MockArgs {
  const a: MockArgs = { port: 4010, host: '127.0.0.1', tokenEnv: 'RABBINATIX_TOKEN', quiet: false, help: false };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case '--system': a.system = value(i++, f); break;
      case '--port': { const n = Number(value(i++, f)); if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('--port is a number from 0 to 65535.'); a.port = n; break; }
      case '--host': a.host = value(i++, f); break;
      case '--api': a.api = value(i++, f); break;
      case '--token-env': a.tokenEnv = value(i++, f); break;
      case '--save': a.save = value(i++, f); break;
      case '--from': a.from = value(i++, f); break;
      case '--quiet': a.quiet = true; break;
      case '-h': case '--help': a.help = true; break;
      default: throw new Error(`Unknown option ${f}. See --help.`);
    }
  }
  if (!a.help && !a.system && !a.from) throw new Error('Say which system: --system <id or name> (or --from <file>).');
  if (a.from && a.save) throw new Error('--from and --save don’t go together: --from already reads a saved file.');
  return a;
}

type Print = (s: string) => void;

export interface MockRun {
  /** resolves with the exit code once the server stops */
  done: Promise<number>;
  served?: Served;
  /** load the system again (what typing r does) */
  reload(): Promise<void>;
}

/** start the test server; `input` is where "r" for reload is read (the terminal, unless a spec gives none) */
export async function startMock(argv: string[], cwd: string, env: NodeJS.ProcessEnv, log: Print, warn: Print, input?: NodeJS.ReadableStream): Promise<MockRun> {
  const failed = (msg: string): MockRun => {
    warn(msg);
    return { done: Promise.resolve(2), reload: async () => undefined };
  };
  let a: MockArgs;
  try {
    a = parseMockArgs(argv);
  } catch (e) {
    return failed((e as Error).message);
  }
  if (a.help) {
    log(MOCK_HELP);
    return { done: Promise.resolve(0), reload: async () => undefined };
  }
  let load: () => Promise<MockSnapshot>;
  if (a.from) {
    const file = path.resolve(cwd, a.from);
    load = async () => {
      let data: unknown;
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        throw new Error(`Couldn’t read ${a.from}: ${(e as Error).message}`);
      }
      if (!isSnapshot(data)) throw new Error(`${a.from} isn’t a file saved with --save.`);
      return data;
    };
  } else {
    const c = connection(a, env, cwd, 'read');
    if ('missing' in c) return failed(`${c.missing}${c.missing.startsWith('No API token') ? ' Or start from a saved file with --from.' : ''}`);
    load = async () => {
      const s = await loadSnapshot(c, a.system!, warn);
      if (a.save) fs.writeFileSync(path.resolve(cwd, a.save), `${JSON.stringify(s, null, 2)}\n`);
      return s;
    };
  }

  let snap: MockSnapshot;
  try {
    snap = await load();
  } catch (e) {
    return failed((e as Error).message);
  }
  let served: Served;
  try {
    served = await serveMock(snap, {
      port: a.port,
      host: a.host,
      onCall: a.quiet ? undefined : (req, res) => {
        const q = Object.entries(req.query).map(([k, v]) => `${k}=${v}`).join('&');
        const why = res.status >= 400 ? `  ${(res.body as { error?: string } | null)?.error ?? ''}` : '';
        log(`${req.method.padEnd(6)} ${req.path}${q ? `?${q}` : ''} → ${res.status}${why}`);
      },
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return failed(err.code === 'EADDRINUSE' ? `Port ${a.port} is in use. Pick another with --port.` : err.message);
  }

  const intro = (s: MockSnapshot) => {
    log(`Test server for ${s.system.name} at ${served.url}`);
    if (!s.endpoints.length) log('  It provides no published APIs yet: every call answers 404. Publish them, then type r and Enter.');
    for (const l of endpointLines(s, served.url)) log(l);
  };
  intro(snap);
  if (a.save) log(`Saved to ${a.save}: start from it with --from ${a.save}.`);

  const reload = async () => {
    try {
      snap = await load();
      served.use(snap);
      log('Loaded again.');
      intro(snap);
    } catch (e) {
      warn(`Couldn’t load it again, still answering as before: ${(e as Error).message}`);
    }
  };
  let lines: readline.Interface | undefined;
  if (input) {
    lines = readline.createInterface({ input });
    lines.on('line', (l) => void (l.trim().toLowerCase() === 'r' && reload()));
    log(a.from ? 'Type r and Enter to read the file again; Ctrl+C stops.' : 'Type r and Enter to load the system again after publishing; Ctrl+C stops.');
  }
  const done = new Promise<number>((ok) => served.server.once('close', () => {
    lines?.close();
    ok(0);
  }));
  return { done, served, reload };
}

export async function mainMock(argv: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env, log: Print, warn: Print): Promise<number> {
  const run = await startMock(argv, cwd, env, log, warn, process.stdin.isTTY ? process.stdin : undefined);
  if (run.served) {
    const stop = () => void run.served!.close();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  return run.done;
}

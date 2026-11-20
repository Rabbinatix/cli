// Where Rabbinatix is and the token, the same for every command (assistant-and-cli-plan.md § 3.1): flags first, then
// the environment (RABBINATIX_API, RABBINATIX_TOKEN), then `.rabbinatix/config.json` in the repository. A token is never
// read from a file. And the one HTTP call every command makes through.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VERSION } from './version.js';

export interface RepoConfig {
  /** the API address (Integrations → API & CI) */
  api?: string;
  /** folder → system id, like the systems' Code repository settings */
  systems?: Record<string, string>;
}

/** `.rabbinatix/config.json` from `dir` up to the filesystem's root (the first one found), or {} */
export function readConfig(dir: string): RepoConfig & { file?: string } {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const file = path.join(d, '.rabbinatix', 'config.json');
    if (fs.existsSync(file)) {
      let j: unknown;
      try {
        j = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        throw new Error(`${file} isn’t valid JSON.`);
      }
      const c = (j ?? {}) as Record<string, unknown>;
      if ('token' in c) throw new Error(`${file} has a "token": remove it. Keep the token in the CI's secrets and pass it in RABBINATIX_TOKEN.`);
      return {
        file,
        ...(typeof c['api'] === 'string' ? { api: c['api'] } : {}),
        ...(c['systems'] && typeof c['systems'] === 'object' ? { systems: Object.fromEntries(Object.entries(c['systems'] as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string> } : {}),
      };
    }
    if (path.dirname(d) === d) return {};
  }
}

export interface Connection { api: string; token: string }

/** the API address and token, or a message saying what is missing (`scope`: what the command needs, for the message) */
export function connection(o: { api?: string; tokenEnv?: string }, env: NodeJS.ProcessEnv, cwd: string, scope: string): Connection | { missing: string } {
  const tokenEnv = o.tokenEnv ?? 'RABBINATIX_TOKEN';
  const api = o.api ?? env['RABBINATIX_API'] ?? readConfig(cwd).api;
  const token = env[tokenEnv];
  if (!api) return { missing: 'Say where Rabbinatix is: --api <url>, RABBINATIX_API, or "api" in .rabbinatix/config.json (Integrations → API & CI shows the address).' };
  if (!token) return { missing: `No API token: set ${tokenEnv} (Integrations → API tokens, with the ${scope} scope).` };
  return { api: api.replace(/\/+$/, ''), token };
}

export type Fetch = typeof fetch;

/** an error the API answered: its status (403 scope, 404 …) and message */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

let warnedOld = false;
/** the API's newest-required CLI version is newer than this one: say so once */
function checkVersion(r: Response, warn?: (s: string) => void) {
  const min = r.headers.get('x-rabbinatix-min-cli');
  if (!min || warnedOld || !warn) return;
  const older = (a: string, b: string) => {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
    return false;
  };
  if (older(VERSION, min)) {
    warnedOld = true;
    warn(`note: this rabbinatix is ${VERSION}; Rabbinatix asks for ${min} or newer. Run it with npx -y rabbinatix@latest.`);
  }
}

/** one call to {api}{route} with the token: JSON in, JSON out, a readable error otherwise */
export async function call<T>(c: Connection, method: 'GET' | 'POST', route: string, o: { body?: unknown; timeoutMs?: number; fetchFn?: Fetch; warn?: (s: string) => void } = {}): Promise<T> {
  const url = `${c.api}${route}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), o.timeoutMs ?? 60_000);
  try {
    let r: Response;
    try {
      r = await (o.fetchFn ?? fetch)(url, {
        method,
        headers: { authorization: `Bearer ${c.token}`, 'user-agent': `rabbinatix/${VERSION}`, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        signal: ctl.signal,
      });
    } catch (e) {
      throw new Error(ctl.signal.aborted ? `Rabbinatix didn’t answer in time (${url}).` : `Couldn’t reach ${url}: ${(e as Error).message}`);
    }
    checkVersion(r, o.warn);
    const text = await r.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(r.status, `Rabbinatix answered ${r.status} with something that isn’t JSON. Is ${c.api} the API address (Integrations → API & CI)?`);
    }
    if (!r.ok) throw new ApiError(r.status, `Rabbinatix answered ${r.status}: ${(data as { error?: string }).error ?? text.slice(0, 200)}`);
    return data as T;
  } finally {
    clearTimeout(t);
  }
}

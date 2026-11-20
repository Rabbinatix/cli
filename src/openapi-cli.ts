// rabbinatix openapi pull | diff (assistant-and-cli-plan.md § 3.2). pull: a system's OpenAPI as the app exports it
// (clients in any language with standard generators). diff: the repo's spec against the map, operation by operation;
// only the spec's operations are sent (openapi, paths, components), not its other text.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse, stringify } from 'yaml';
import { ApiError, call, connection, Fetch } from './connect.js';

export const OPENAPI_HELP = `rabbinatix openapi: a system's OpenAPI, and the repo's spec against the map

Usage:
  rabbinatix openapi pull --system <id> [--version <v>] [--out <file>]
  rabbinatix openapi diff <file> --system <id> [--fail-on breaking|any|never]

  pull     The system's OpenAPI 3.1, stamped (x-rabbinatix: system, version, sha256), as Export in the app gives it.
           Leave out --version for the APIs as declared now (labelled <release>-next.<n> when changed since the
           newest release). --out writes it (.yaml or .yml: YAML; else JSON); without it, it is printed.
  diff     What the spec file (JSON or YAML) changes against the system's APIs on the map: operations added, removed,
           and fields changed, each with how bad. --fail-on breaking (default) exits 1 when a change would break
           callers; any: on any change; never: only report.

  --system <id>          the system (its id, or its name)
  --api <url>            the API address (or RABBINATIX_API, or "api" in .rabbinatix/config.json)
  --token-env <name>     the environment variable holding a read token (default RABBINATIX_TOKEN)
  --format <md|json>     what diff prints (default md)
  -h, --help             this help

Sends: pull, the system and version; diff, the spec's openapi, paths and components (not its info, servers or text).
Exit codes: 0 done · 1 --fail-on matched · 2 an error.`;

interface OpenApiArgs { action?: 'pull' | 'diff'; file?: string; system?: string; version?: string; out?: string; failOn: 'breaking' | 'any' | 'never'; api?: string; tokenEnv: string; format: 'md' | 'json'; help: boolean }

export function parseOpenApiArgs(argv: string[]): OpenApiArgs {
  const a: OpenApiArgs = { failOn: 'breaking', tokenEnv: 'RABBINATIX_TOKEN', format: 'md', help: false };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case '--system': a.system = value(i++, f); break;
      case '--version': a.version = value(i++, f); break;
      case '--out': a.out = value(i++, f); break;
      case '--fail-on': { const v = value(i++, f); if (v !== 'breaking' && v !== 'any' && v !== 'never') throw new Error('--fail-on is breaking, any or never.'); a.failOn = v; break; }
      case '--api': a.api = value(i++, f); break;
      case '--token-env': a.tokenEnv = value(i++, f); break;
      case '--format': { const v = value(i++, f); if (v !== 'md' && v !== 'json') throw new Error('--format is md or json.'); a.format = v; break; }
      case '-h': case '--help': a.help = true; break;
      default:
        if (i === 0 && (f === 'pull' || f === 'diff')) { a.action = f; break; }
        if (a.action === 'diff' && !a.file && !f.startsWith('-')) { a.file = f; break; }
        throw new Error(`Unknown option ${f}. See --help.`);
    }
  }
  return a;
}

/** the parts of a spec the diff needs: its operations and the schemas they point at */
export function operationsOf(text: string): Record<string, unknown> {
  const doc = (/^\s*[{[]/.test(text) ? JSON.parse(text) : parse(text)) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object' || (!doc['openapi'] && !doc['swagger'])) throw new Error('not an OpenAPI document (no openapi or swagger key).');
  const out: Record<string, unknown> = { ...(doc['openapi'] ? { openapi: doc['openapi'] } : { swagger: doc['swagger'] }), info: { title: 'spec', version: '0' }, paths: doc['paths'] ?? {} };
  if (doc['components']) out['components'] = doc['components'];
  if (doc['definitions']) out['definitions'] = doc['definitions'];
  return out;
}

interface DiffAnswer { system: { id: string; name: string }; changes: { endpoint: string; kind: string; level: string }[]; lines: { level: string; text: string }[]; breaking: number }
interface PullAnswer { system: { id: string; name: string; slug: string }; version: string; filename: string; hash: string; openapi: Record<string, unknown> }

type Print = (s: string) => void;

export async function mainOpenApi(argv: string[], cwd: string, env: NodeJS.ProcessEnv, log: Print, warn: Print, fetchFn?: Fetch): Promise<number> {
  let a: OpenApiArgs;
  try {
    a = parseOpenApiArgs(argv);
  } catch (e) {
    warn((e as Error).message);
    return 2;
  }
  if (a.help || !a.action) { (a.help ? log : warn)(OPENAPI_HELP); return a.help ? 0 : 2; }
  if (!a.system) { warn('Say which system: --system <id>.'); return 2; }
  if (a.action === 'diff' && !a.file) { warn('Say which spec file: rabbinatix openapi diff <file> --system <id>.'); return 2; }
  let spec: Record<string, unknown> | undefined;
  if (a.action === 'diff') {
    try {
      spec = operationsOf(fs.readFileSync(path.resolve(cwd, a.file!), 'utf8'));
    } catch (e) {
      warn(`Can't read ${a.file}: ${(e as Error).message}`);
      return 2;
    }
  }
  const c = connection(a, env, cwd, 'read');
  if ('missing' in c) { warn(c.missing); return 2; }
  try {
    if (a.action === 'pull') {
      const q = new URLSearchParams({ system: a.system, ...(a.version ? { version: a.version } : {}) });
      const r = await call<PullAnswer>(c, 'GET', `/openapi?${q}`, { fetchFn, warn });
      const yaml = !!a.out && /\.ya?ml$/i.test(a.out);
      const text = yaml ? stringify(r.openapi) : `${JSON.stringify(r.openapi, null, 2)}\n`;
      if (a.out) {
        fs.writeFileSync(path.resolve(cwd, a.out), text);
        log(`Wrote ${a.out}: ${r.system.name} ${r.version}.`);
      } else log(text);
      return 0;
    }
    const r = await call<DiffAnswer>(c, 'POST', '/openapi/diff', { body: { system: a.system, spec }, fetchFn, warn });
    if (a.format === 'json') log(JSON.stringify(r, null, 2));
    else {
      const label: Record<string, string> = { major: 'breaking', minor: 'added', patch: 'small' };
      log([`## ${a.file} against ${r.system.name} on the map: ${r.lines.length ? `${r.lines.length} change${r.lines.length === 1 ? '' : 's'}${r.breaking ? `, ${r.breaking} breaking` : ''}` : 'the same'}`, '',
        ...r.lines.map((l) => `- ${label[l.level] ?? l.level}: ${l.text}`)].join('\n'));
    }
    const failed = a.failOn === 'any' ? r.lines.length > 0 : a.failOn === 'breaking' ? r.breaking > 0 : false;
    if (failed) warn(a.failOn === 'any' ? `The spec differs from the map (${r.lines.length}).` : `The spec would break callers of ${r.system.name} (${r.breaking}).`);
    return failed ? 1 : 0;
  } catch (e) {
    warn((e as Error).message);
    if (e instanceof ApiError && e.status === 403) warn('Make a token with the read scope under Integrations → API tokens.');
    return 2;
  }
}

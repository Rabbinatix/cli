// rabbinatix status: is this repo's code in step with the map? (assistant-and-cli-plan.md § 3.2). Reads the anchors in
// every file (languages/anchors.ts), sends only them (key, revision, file, line) to POST /v1/code-status, and lists:
// anchors behind the map, anchors whose logic is gone, logic of the asked systems with no anchor, and files that declare
// API routes but carry no anchor. `--write-map` rewrites .rabbinatix/code-map.json from the anchors.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { nextStepPrompts } from './from-app/features/assistant/prompts';
import { languageOfFile, readAnchors } from './from-app/languages';
import { ApiError, call, connection, Fetch } from './connect.js';
import { textHandlers } from './routes-text.js';
import { filesOf } from './scan/index.js';

export const STATUS_HELP = `rabbinatix status: is this repo's code in step with the map?

Usage: rabbinatix status [options]

Lists anchors behind the map (FDD:LOGIC-… r9 in the code, r11 on the map), anchors whose logic or step is gone,
logic of the systems you name that no anchor marks yet, and files that declare API routes but carry no anchor.

  --system <id>          also list this system's logic with no anchor in the code (repeat it for more)
  --fail-on <list>       exit 1 when any of these is found: behind, gone, missing, unanchored (comma-separated)
  --write-map            rewrite .rabbinatix/code-map.json from the anchors (the one file the CLI writes, when asked)
  --root <dir>           the repository (default: here)
  --api <url>            the API address (or RABBINATIX_API, or "api" in .rabbinatix/config.json)
  --token-env <name>     the environment variable holding a read token (default RABBINATIX_TOKEN)
  --format <md|json>     what to print (default md) · --out <file>  also write the answer as JSON
  -h, --help             this help

Sends: the anchors' keys and revisions with their file paths and lines. No code.
Exit codes: 0 done · 1 --fail-on matched · 2 an error.`;

const FAIL = ['behind', 'gone', 'missing', 'unanchored'] as const;
type FailOn = (typeof FAIL)[number];

interface StatusArgs { root?: string; systems: string[]; failOn: FailOn[]; writeMap: boolean; api?: string; tokenEnv: string; format: 'md' | 'json'; out?: string; help: boolean }

export function parseStatusArgs(argv: string[]): StatusArgs {
  const a: StatusArgs = { systems: [], failOn: [], writeMap: false, tokenEnv: 'RABBINATIX_TOKEN', format: 'md', help: false };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case '--system': a.systems.push(value(i++, f)); break;
      case '--fail-on': {
        const list = value(i++, f).split(',').map((s) => s.trim()).filter(Boolean);
        const bad = list.filter((x) => !(FAIL as readonly string[]).includes(x));
        if (bad.length) throw new Error(`--fail-on takes ${FAIL.join(', ')} (not ${bad.join(', ')}).`);
        a.failOn = list as FailOn[];
        break;
      }
      case '--write-map': a.writeMap = true; break;
      case '--root': a.root = value(i++, f); break;
      case '--api': a.api = value(i++, f); break;
      case '--token-env': a.tokenEnv = value(i++, f); break;
      case '--format': { const v = value(i++, f); if (v !== 'md' && v !== 'json') throw new Error('--format is md or json.'); a.format = v; break; }
      case '--out': a.out = value(i++, f); break;
      case '-h': case '--help': a.help = true; break;
      default: throw new Error(`Unknown option ${f}. See --help.`);
    }
  }
  return a;
}

export interface RepoAnchor { key: string; revision?: number; file: string; line: number }

/** TypeScript / JavaScript route registrations: Express, Fastify, Koa routers, Hono (`app.get('/…'`) and NestJS (`@Get(`) */
const TS_ROUTE = /\b(?:app|router|server|api|r|routes|fastify|hono)\.(?:get|post|put|patch|delete|all|route)\(\s*(?:['"`]\/|\{\s*method\b)|@(?:Get|Post|Put|Patch|Delete)\(/;
/** Next.js route handlers and API routes: the file is the route */
const NEXT_ROUTE_FILE = /(?:^|\/)(?:src\/)?(?:app\/(?:.*\/)?route|pages\/api\/.*)\.[cm]?[jt]sx?$/;

/** every anchor in the repo, and the files that declare routes but carry none */
export function readRepo(root: string, files = filesOf(root)): { anchors: RepoAnchor[]; unanchored: string[]; files: number } {
  const anchors: RepoAnchor[] = [];
  const unanchored: string[] = [];
  let n = 0;
  for (const file of files.sort()) {
    const lang = languageOfFile(file);
    if (!lang) continue;
    let text: string;
    try {
      const abs = path.join(root, file);
      if (fs.statSync(abs).size > 1_000_000) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    n++;
    const a = readAnchors(text);
    for (const l of a.logic) anchors.push({ key: l.key, ...(l.revision !== undefined ? { revision: l.revision } : {}), file, line: l.line });
    for (const s of a.nodes) anchors.push({ key: s.key, file, line: s.line });
    if (!a.logic.length && !a.nodes.length && !lang.tooling) {
      const routes = lang.id === 'typescript' || lang.id === 'javascript' ? TS_ROUTE.test(text) || NEXT_ROUTE_FILE.test(file) : textHandlers(file, text).length > 0;
      if (routes) unanchored.push(file);
    }
  }
  return { anchors, unanchored, files: n };
}

/** .rabbinatix/code-map.json from the anchors: logic key → revision and places, sorted so it only changes when they do */
export function codeMap(anchors: RepoAnchor[]): { format: 1; logic: Record<string, { revision?: number; places: string[] }> } {
  const logic: Record<string, { revision?: number; places: string[] }> = {};
  for (const a of anchors.filter((x) => x.key.startsWith('LOGIC-')).sort((x, y) => x.key.localeCompare(y.key) || x.file.localeCompare(y.file) || x.line - y.line)) {
    const e = (logic[a.key] ??= { places: [] });
    if (a.revision !== undefined) e.revision = Math.max(e.revision ?? 0, a.revision);
    e.places.push(`${a.file}:${a.line}`);
  }
  return { format: 1, logic };
}

interface StatusAnswer {
  anchors: (RepoAnchor & { state: 'ok' | 'behind' | 'gone' | 'no-revision'; current?: number; name?: string; system?: string })[];
  counts: Record<string, number>;
  missing: { key: string; name: string; system: string; rev: number }[];
  systems: Record<string, string>;
}

type Print = (s: string) => void;

export async function mainStatus(argv: string[], cwd: string, env: NodeJS.ProcessEnv, log: Print, warn: Print, fetchFn?: Fetch, files?: string[]): Promise<number> {
  let a: StatusArgs;
  try {
    a = parseStatusArgs(argv);
  } catch (e) {
    warn((e as Error).message);
    return 2;
  }
  if (a.help) { log(STATUS_HELP); return 0; }
  const root = path.resolve(cwd, a.root ?? '.');
  let repo: ReturnType<typeof readRepo>;
  try {
    repo = readRepo(root, files);
  } catch (e) {
    warn(`Can't list the repository's files: ${(e as Error).message}`);
    return 2;
  }
  if (a.writeMap) {
    const dir = path.join(root, '.rabbinatix');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'code-map.json'), `${JSON.stringify(codeMap(repo.anchors), null, 2)}\n`);
  }
  const c = connection(a, env, root, 'read');
  if ('missing' in c) { warn(c.missing); return 2; }
  let r: StatusAnswer;
  try {
    r = await call<StatusAnswer>(c, 'POST', '/code-status', { body: { anchors: repo.anchors, systems: a.systems }, fetchFn, warn });
  } catch (e) {
    warn((e as Error).message);
    if (e instanceof ApiError && e.status === 403) warn('Make a token with the read scope under Integrations → API tokens.');
    return 2;
  }
  const behind = r.anchors.filter((x) => x.state === 'behind');
  const gone = r.anchors.filter((x) => x.state === 'gone');
  const found: Record<FailOn, number> = { behind: behind.length, gone: gone.length, missing: r.missing.length, unanchored: repo.unanchored.length };
  const result = { ...r, unanchored: repo.unanchored, files: repo.files };
  if (a.out) fs.writeFileSync(path.resolve(cwd, a.out), JSON.stringify(result, null, 2));
  if (a.format === 'json') log(JSON.stringify(result, null, 2));
  else log(statusMarkdown(result, r.systems));
  const failed = a.failOn.filter((k) => found[k] > 0);
  if (failed.length) warn(`Found: ${failed.map((k) => `${found[k]} ${k}`).join(', ')}.`);
  return failed.length ? 1 : 0;
}

export function statusMarkdown(r: StatusAnswer & { unanchored: string[]; files: number }, systems: Record<string, string> = {}): string {
  const sys = (id?: string) => (id ? systems[id] ?? id : '');
  const behind = r.anchors.filter((x) => x.state === 'behind');
  const gone = r.anchors.filter((x) => x.state === 'gone');
  const ok = r.anchors.filter((x) => x.state === 'ok' || x.state === 'no-revision');
  const out = [`## Code and map: ${behind.length || gone.length ? 'out of step' : 'in step'}`, '',
    `${r.files} code file${r.files === 1 ? '' : 's'} read · ${r.anchors.length} anchor${r.anchors.length === 1 ? '' : 's'} · ${ok.length} in step`];
  if (behind.length) {
    out.push('', `### Behind the map (${behind.length})`, '');
    for (const x of behind) out.push(`- ${x.file}:${x.line} ${x.key} r${x.revision} → r${x.current} ${x.name ?? ''} (${sys(x.system)})`);
    out.push('', `AI prompt: ${nextStepPrompts.behind().text}`);
  }
  if (gone.length) {
    out.push('', `### Gone from the map (${gone.length})`, '');
    for (const x of gone) out.push(`- ${x.file}:${x.line} ${x.key}: no such ${x.key.startsWith('NODE-') ? 'step' : 'logic'} on the map any more`);
  }
  if (r.missing.length) {
    out.push('', `### Logic with no anchor in the code (${r.missing.length})`, '');
    for (const m of r.missing) out.push(`- ${m.key} r${m.rev} ${m.name} (${sys(m.system)})`);
  }
  if (r.unanchored.length) {
    out.push('', `### Files with API routes and no anchor (${r.unanchored.length})`, '');
    for (const f of r.unanchored) out.push(`- ${f}`);
    out.push('', `AI prompt: ${nextStepPrompts.unmapped(r.unanchored).text}`);
  }
  return out.join('\n');
}

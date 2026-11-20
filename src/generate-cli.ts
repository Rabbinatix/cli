// rabbinatix generate (assistant-and-cli-plan.md § 3.2): the generated files of some logic or a whole system, as the
// Code panel downloads them. TypeScript is formatted here with Prettier and re-stamped, as the panel does. `--check`
// writes nothing and fails when the repo's generated files are missing or older than the logic. A code version is
// recorded in Rabbinatix only with `--record` (decided 2026-11-07).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileHash, parseStamp } from './from-app/codegen/version';
import type { GeneratedFile } from './from-app/codegen';
import { formatFiles } from './from-app/shared/code/format';
import { restampFiles } from './from-app/codegen/version';
import { CODEGEN_LANGUAGES, CodegenLanguage, isCodegenLanguage } from './from-app/languages/support';
import { languageByName } from './from-app/languages/languages';

/** how the help writes each language: ts, python, csharp, java, go… */
const LANG_NAMES = CODEGEN_LANGUAGES.map((l) => (l === 'typescript' ? 'ts' : l));
const orList = (xs: readonly string[]) => `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
import { ApiError, call, connection, Fetch } from './connect.js';

export const GENERATE_HELP = `rabbinatix generate: the code of logic, generated as the Code panel downloads it

Usage: rabbinatix generate (--logic <key>… | --system <id>) [--language ${LANG_NAMES.join('|')}] [options]

  --logic <key>          a logic (e.g. LOGIC-AUTH-LOGIN-001); repeat it for more (at most 30). The logic it calls
                         comes too.
  --system <id>          every logic of a system
  --language <lang>      ${orList(LANG_NAMES).replace(/^ts/, 'ts (default)')}
  --out-dir <dir>        where the files go (default: here); they keep their paths (src/fdd/<system>/…,
                         in Go internal/fdd/<system>/…, in Kotlin src/main/kotlin/…,
                         in Swift Sources/Rabbinatix<System>/…, in Dart lib/fdd/<system>/…,
                         in PHP src/Fdd/<System>/…, in Ruby lib/fdd/<system>/…,
                         in Rust src/fdd/<system>/…)
  --comments             a comment above each step, as the panel's "Comments" option
  --check                write nothing: exit 1 when a generated file is missing here or older than the logic
  --record               record this generation in Rabbinatix (the code panel's Exported tab), as a download is
  --api <url>            the API address (or RABBINATIX_API, or "api" in .rabbinatix/config.json)
  --token-env <name>     the environment variable holding a read token (default RABBINATIX_TOKEN)
  --format <md|json>     what to print (default md)
  -h, --help             this help

Sends: the keys and the language (and, with --record, each written file's path and sha256). No code.
Exit codes: 0 done · 1 --check found files to regenerate · 2 an error.`;

/** a language as people write it (ts, c#, golang…), if the generator writes it */
const codegenLanguage = (v: string): CodegenLanguage | undefined => {
  const id = languageByName(v)?.id;
  return isCodegenLanguage(id) ? id : undefined;
};

interface GenerateArgs { logic: string[]; system?: string; language: CodegenLanguage; outDir: string; comments: boolean; check: boolean; record: boolean; api?: string; tokenEnv: string; format: 'md' | 'json'; help: boolean }

export function parseGenerateArgs(argv: string[]): GenerateArgs {
  const a: GenerateArgs = { logic: [], language: 'typescript', outDir: '.', comments: false, check: false, record: false, tokenEnv: 'RABBINATIX_TOKEN', format: 'md', help: false };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case '--logic': a.logic.push(value(i++, f)); break;
      case '--system': a.system = value(i++, f); break;
      case '--language': { const l = codegenLanguage(value(i++, f)); if (!l) throw new Error(`--language is ${orList(LANG_NAMES)}.`); a.language = l; break; }
      case '--out-dir': a.outDir = value(i++, f); break;
      case '--comments': a.comments = true; break;
      case '--check': a.check = true; break;
      case '--record': a.record = true; break;
      case '--api': a.api = value(i++, f); break;
      case '--token-env': a.tokenEnv = value(i++, f); break;
      case '--format': { const v = value(i++, f); if (v !== 'md' && v !== 'json') throw new Error('--format is md or json.'); a.format = v; break; }
      case '-h': case '--help': a.help = true; break;
      default: throw new Error(`Unknown option ${f}. See --help.`);
    }
  }
  if (a.check && a.record) throw new Error('--check writes nothing, so there is nothing to --record.');
  return a;
}

interface GenerateAnswer {
  language: string; format: boolean;
  files: Pick<GeneratedFile, 'path' | 'name' | 'content' | 'role' | 'map'>[];
  modules: { key: string; name: string; revision: number }[];
  skipped: { key: string; problem: string }[]; unknown: string[]; warnings: string[];
}

export interface FileCheck { path: string; state: 'same' | 'missing' | 'behind' | 'edited'; here?: number; now?: number }

/** a generated file against the one in the repo: missing, older (its stamp's revision), or a different body */
export function checkFile(root: string, f: { path: string; content: string }): FileCheck {
  let here: string;
  try {
    here = fs.readFileSync(path.join(root, f.path), 'utf8');
  } catch {
    return { path: f.path, state: 'missing' };
  }
  const was = parseStamp(here.split('\n')[0]);
  const now = parseStamp(f.content.split('\n')[0]);
  if (was?.revision !== undefined && now?.revision !== undefined && was.revision < now.revision) return { path: f.path, state: 'behind', here: was.revision, now: now.revision };
  return { path: f.path, state: fileHash(here) === fileHash(f.content) ? 'same' : 'edited' };
}

type Print = (s: string) => void;

export async function mainGenerate(argv: string[], cwd: string, env: NodeJS.ProcessEnv, log: Print, warn: Print, fetchFn?: Fetch): Promise<number> {
  let a: GenerateArgs;
  try {
    a = parseGenerateArgs(argv);
  } catch (e) {
    warn((e as Error).message);
    return 2;
  }
  if (a.help) { log(GENERATE_HELP); return 0; }
  if (!a.logic.length && !a.system) { warn('Say what to generate: --logic <key> or --system <id>.'); return 2; }
  const c = connection(a, env, cwd, 'read');
  if ('missing' in c) { warn(c.missing); return 2; }
  const root = path.resolve(cwd, a.outDir);
  try {
    const r = await call<GenerateAnswer>(c, 'POST', '/generate', { body: { logic: a.logic, ...(a.system ? { system: a.system } : {}), language: a.language, comments: a.comments }, fetchFn, warn, timeoutMs: 120_000 });
    for (const k of r.unknown) warn(`Not on the map: ${k}`);
    for (const s of r.skipped) warn(`Not generated: ${s.key}: ${s.problem}`);
    let files = r.files as GeneratedFile[];
    if (r.format) {
      const f = await formatFiles(files, a.comments);
      if (f.error) warn(f.error);
      files = restampFiles(f.files);
    }
    if (a.check) {
      const checks = files.map((f) => checkFile(root, f));
      const stale = checks.filter((x) => x.state === 'missing' || x.state === 'behind');
      const edited = checks.filter((x) => x.state === 'edited');
      if (a.format === 'json') log(JSON.stringify({ files: checks, modules: r.modules, skipped: r.skipped, unknown: r.unknown }, null, 2));
      else {
        log([`## Generated code: ${stale.length ? `${stale.length} file${stale.length === 1 ? '' : 's'} to regenerate` : 'up to date'}`, '',
          ...stale.map((x) => `- ${x.path}: ${x.state === 'missing' ? 'not here' : `r${x.here} here, r${x.now} now`}`),
          ...edited.map((x) => `- ${x.path}: differs from what Rabbinatix generates (edited by hand, or another generator version)`)].join('\n'));
      }
      if (stale.length) warn(`Regenerate: rabbinatix generate ${a.system ? `--system ${a.system}` : a.logic.map((k) => `--logic ${k}`).join(' ')} --language ${a.language}`);
      return stale.length ? 1 : 0;
    }
    for (const f of files) {
      const to = path.join(root, f.path);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, f.content);
    }
    let recorded: string | undefined;
    if (a.record) {
      const rec = await call<{ id: string }>(c, 'POST', '/generate/record', { body: { logic: a.logic, ...(a.system ? { system: a.system } : {}), language: a.language, comments: a.comments, files: files.map((f) => ({ path: f.path, sha256: fileHash(f.content) })) }, fetchFn, warn });
      recorded = rec.id;
    }
    if (a.format === 'json') log(JSON.stringify({ files: files.map((f) => f.path), modules: r.modules, skipped: r.skipped, unknown: r.unknown, ...(recorded ? { recorded } : {}) }, null, 2));
    else log([`Wrote ${files.length} file${files.length === 1 ? '' : 's'} (${r.modules.map((m) => `${m.key} r${m.revision}`).join(', ')}):`, ...files.map((f) => `- ${f.path}`), ...(recorded ? ['', 'Recorded in Rabbinatix: the code panel’s Exported tab lists it.'] : [])].join('\n'));
    return 0;
  } catch (e) {
    warn((e as Error).message);
    if (e instanceof ApiError && e.status === 403) warn('Make a token with the read scope under Integrations → API tokens.');
    return 2;
  }
}

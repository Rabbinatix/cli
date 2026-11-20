// rabbinatix verify (assistant-and-cli-plan.md § 3.2): the Python, C#, Java, Go, Kotlin, Swift, Dart, PHP, Ruby or Rust build of a
// logic, run against the logic's latest recorded test runs on this machine (python3, dotnet, java, go, kotlinc, swiftc, dart, php, ruby or rustc), and compared the way the app compares the
// TypeScript build in the browser. GET /v1/runs prepares the jobs and every file to build them from (no code generator
// here); the harnesses (harness/) are shipped next to the bundle.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ForeignLanguage, ForeignProgram, ForeignResult, foreignResults, RawOutcome } from './from-app/codegen/testing/foreign-compare';
import { CLI_VERIFY_LANGUAGES, CLI_VERIFY_RUNTIMES, CODEGEN } from './from-app/languages/support';
import { languageById, languageByName } from './from-app/languages/languages';

const VERIFY_NAMES = CLI_VERIFY_LANGUAGES as readonly string[];
const orList = (xs: readonly string[]) => `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
import { ApiError, call, connection, Fetch } from './connect.js';

export const VERIFY_HELP = `rabbinatix verify: the ${orList(CLI_VERIFY_LANGUAGES.map((l) => languageById(l)!.label))} code of a logic, checked against its recorded test runs

Usage: rabbinatix verify --logic <key> --language ${VERIFY_NAMES.join('|')} [options]

Builds the logic's generated code on this machine and runs every step of its latest recorded test runs through it:
the same answers, the same calls to other systems, the same path. TypeScript is verified in the app (Code panel →
Verify). Needs ${CLI_VERIFY_RUNTIMES} for its language.

  --logic <key>          the logic (e.g. LOGIC-AUTH-LOGIN-001)
  --language <lang>      ${orList(VERIFY_NAMES)}
  --keep <dir>           keep the built programs in this folder (default: a temporary one, removed after)
  --api <url>            the API address (or RABBINATIX_API, or "api" in .rabbinatix/config.json)
  --token-env <name>     the environment variable holding a read token (default RABBINATIX_TOKEN)
  --format <md|json>     what to print (default md)
  -h, --help             this help

Sends: the logic's key and the language. Exit codes: 0 every test run matched · 1 one differs · 2 an error.`;

interface VerifyArgs { logic?: string; language?: ForeignLanguage; keep?: string; api?: string; tokenEnv: string; format: 'md' | 'json'; help: boolean }

export function parseVerifyArgs(argv: string[]): VerifyArgs {
  const a: VerifyArgs = { tokenEnv: 'RABBINATIX_TOKEN', format: 'md', help: false };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case '--logic': a.logic = value(i++, f); break;
      case '--language': {
        const id = languageByName(value(i++, f))?.id;
        if (id === 'typescript') throw new Error('TypeScript is verified in the app: Code panel → Verify.');
        if (!id || !VERIFY_NAMES.includes(id)) throw new Error(`--language is ${orList(VERIFY_NAMES)}.`);
        a.language = id as ForeignLanguage;
        break;
      }
      case '--keep': a.keep = value(i++, f); break;
      case '--api': a.api = value(i++, f); break;
      case '--token-env': a.tokenEnv = value(i++, f); break;
      case '--format': { const v = value(i++, f); if (v !== 'md' && v !== 'json') throw new Error('--format is md or json.'); a.format = v; break; }
      case '-h': case '--help': a.help = true; break;
      default: throw new Error(`Unknown option ${f}. See --help.`);
    }
  }
  return a;
}

/** a harness file: next to the bundle (dist/harness), or harness/ when run from the sources */
export function harnessText(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, 'harness', name), path.join(here, '../harness', name)]) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      /* the next place */
    }
  }
  throw new Error(`The ${name} harness is missing from this install of rabbinatix: reinstall it.`);
}

type Exec = typeof spawnSync;
const JAVA = process.env['JAVA_HOME'] ? path.join(process.env['JAVA_HOME'], 'bin') : '';
const DOTNET = process.env['DOTNET_PATH'] || 'dotnet';
const GO = process.env['GO_PATH'] || 'go';
const WINDOWS = process.platform === 'win32';
/** kotlinc is a script (kotlinc.bat on Windows, which only runs through the shell) */
const KOTLINC = process.env['KOTLINC_PATH'] || 'kotlinc';
const SWIFTC = process.env['SWIFTC_PATH'] || 'swiftc';
/** dart is a script on Windows too (dart.bat) */
const DART = process.env['DART_PATH'] || 'dart';
const PHP = process.env['PHP_PATH'] || 'php';
const RUBY = process.env['RUBY_PATH'] || 'ruby';
const RUSTC = process.env['RUSTC_PATH'] || 'rustc';

/** whether the language's tools are on this machine */
export function toolsFor(lang: ForeignLanguage, exec: Exec = spawnSync): string | null {
  const ok = (cmd: string, args: string[]) => exec(cmd, args, { stdio: 'ignore' }).status === 0;
  const has =
    lang === 'python' ? ok('python3', ['--version'])
    : lang === 'csharp' ? ok(DOTNET, ['--version'])
    : lang === 'go' ? ok(GO, ['version'])
    : lang === 'swift' ? ok(SWIFTC, ['--version'])
    : lang === 'rust' ? ok(RUSTC, ['--version'])
    : lang === 'ruby' ? ok(RUBY, ['-e', 'exit(RUBY_VERSION >= "3.1" ? 0 : 1)'])
    : lang === 'php' ? ok(PHP, ['-r', 'exit(function_exists("mb_strtolower") ? 0 : 1);'])
    : lang === 'dart' ? exec(DART, ['--version'], { stdio: 'ignore', shell: WINDOWS }).status === 0
    : lang === 'kotlin' ? exec(KOTLINC, ['-version'], { stdio: 'ignore', shell: WINDOWS }).status === 0 && ok(path.join(JAVA, 'java'), ['-version'])
    : ok(path.join(JAVA, 'javac'), ['-version']) && ok(path.join(JAVA, 'java'), ['-version']);
  return has ? null : `${CODEGEN[lang].runtime!.label} isn't installed here (${CODEGEN[lang].runtime!.command} not found).`;
}

/** where each language's harness goes in the build folder */
const HARNESS: Record<ForeignLanguage, [name: string, at: string]> = {
  python: ['harness.py', 'harness.py'], csharp: ['Harness.cs', 'Harness.cs'], java: ['Harness.java', 'src/fddcheck/Harness.java'],
  go: ['harness.go', 'harness.go'], kotlin: ['Harness.kt', 'src/Harness.kt'], swift: ['harness.swift', 'main.swift'], dart: ['harness.dart', 'harness.dart'],
  php: ['harness.php', 'harness.php'], ruby: ['harness.rb', 'harness.rb'], rust: ['harness.rs', 'harness.rs'],
};

/** write the API's files and the harness, build and run; each job's raw outcome, in order */
export function runJobs(lang: ForeignLanguage, program: ForeignProgram, dir: string, exec: Exec = spawnSync): RawOutcome[] {
  const sh = (cmd: string, args: string[], o: Parameters<Exec>[2] = {}) => {
    const r = exec(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...o });
    if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed:\n${String(r.stdout ?? '')}\n${String(r.stderr ?? '')}`.trim());
    return String(r.stdout);
  };
  const root = path.resolve(dir);
  const write = (rel: string, text: string) => {
    const at = path.resolve(root, rel);
    // a path from the API stays inside the build folder
    if (at !== root && !at.startsWith(root + path.sep)) throw new Error(`The API sent a file outside the build folder: ${rel}`);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, text);
  };
  for (const [rel, text] of Object.entries(program.files)) write(rel, text);
  const [harnessName, harnessAt] = HARNESS[lang];
  write(harnessAt, harnessText(harnessName));
  const p = (rel: string) => path.join(root, rel);
  const ofType = (ext: string) => Object.keys(program.files).filter((f) => f.endsWith(ext)).map(p);
  const jobs = p('jobs.json');
  const run = (out: string) => JSON.parse(out) as RawOutcome[];
  const exe = (name: string) => p(WINDOWS ? `${name}.exe` : name);
  switch (lang) {
    case 'python':
      return run(sh('python3', [p(harnessAt)], { input: program.stdin ?? '[]' }));
    case 'csharp': {
      const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' };
      sh(DOTNET, ['build', '-c', 'Release', '-v', 'q', '-nologo', '-clp:NoSummary;ErrorsOnly'], { cwd: root, env });
      return run(sh(DOTNET, [p('bin/Release/net8.0/harness.dll'), jobs], { cwd: root, env }));
    }
    case 'go': {
      // no download of another Go: the one installed builds it (Go 1.22 or later)
      const env = { ...process.env, GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod' };
      sh(GO, ['build', '-o', exe('harness'), '.'], { cwd: root, env });
      return run(sh(exe('harness'), [jobs], { cwd: root }));
    }
    case 'php':
      return run(sh(PHP, [p(harnessAt), jobs], { cwd: root }));
    case 'ruby':
      return run(sh(RUBY, [p(harnessAt), jobs], { cwd: root }));
    case 'rust':
      sh(RUSTC, ['--edition', '2021', '-A', 'warnings', '-C', 'opt-level=1', '-o', exe('harness'), p(harnessAt)], { cwd: root });
      return run(sh(exe('harness'), [jobs], { cwd: root }));
    case 'dart':
      return run(sh(DART, ['run', p(harnessAt), jobs], { cwd: root, shell: WINDOWS }));
    case 'swift':
      sh(SWIFTC, ['-swift-version', '5', '-suppress-warnings', '-Onone', '-o', exe('harness'), p(harnessAt), ...ofType('.swift')], { cwd: root });
      return run(sh(exe('harness'), [jobs], { cwd: root }));
    case 'kotlin': {
      const jar = p('out.jar');
      sh(KOTLINC, ['-nowarn', '-include-runtime', '-d', jar, p('src')], { cwd: root, shell: WINDOWS });
      return run(sh(path.join(JAVA, 'java'), ['-Xss8m', '-cp', jar, 'fddcheck.HarnessKt', jobs], { cwd: root }));
    }
    case 'java': {
      fs.writeFileSync(p('sources.txt'), [p(harnessAt), ...ofType('.java')].join('\n'));
      sh(path.join(JAVA, 'javac'), ['--release', '17', '-nowarn', '-encoding', 'UTF-8', '-d', p('out'), `@${p('sources.txt')}`], { cwd: root });
      return run(sh(path.join(JAVA, 'java'), ['-Xss8m', '-cp', p('out'), 'fddcheck.Harness', jobs], { cwd: root }));
    }
  }
}

interface JobsAnswer { logic: { key: string; name: string; revision: number }; language: ForeignLanguage; runs: number; jobs: Parameters<typeof foreignResults>[0]; program?: ForeignProgram; notes: string[] }

type Print = (s: string) => void;

export async function mainVerify(argv: string[], cwd: string, env: NodeJS.ProcessEnv, log: Print, warn: Print, fetchFn?: Fetch, exec?: Exec): Promise<number> {
  let a: VerifyArgs;
  try {
    a = parseVerifyArgs(argv);
  } catch (e) {
    warn((e as Error).message);
    return 2;
  }
  if (a.help) { log(VERIFY_HELP); return 0; }
  if (!a.logic || !a.language) { warn(`Say --logic <key> and --language ${VERIFY_NAMES.join('|')}.`); return 2; }
  const missingTools = toolsFor(a.language, exec);
  if (missingTools) { warn(missingTools); return 2; }
  const c = connection(a, env, cwd, 'read');
  if ('missing' in c) { warn(c.missing); return 2; }
  let r: JobsAnswer;
  try {
    r = await call<JobsAnswer>(c, 'GET', `/runs?${new URLSearchParams({ logic: a.logic, language: a.language })}`, { fetchFn, warn, timeoutMs: 120_000 });
  } catch (e) {
    warn((e as Error).message);
    if (e instanceof ApiError && e.status === 403) warn('Make a token with the read scope under Integrations → API tokens.');
    return 2;
  }
  for (const n of r.notes) warn(n);
  if (!r.jobs.length) { log(`Nothing to verify for ${r.logic.key}.`); return 0; }
  if (!r.program) { warn('This Rabbinatix API is older than this CLI: it sent no program files. Try again after it updates.'); return 2; }
  const program = r.program;
  const dir = a.keep ? path.resolve(cwd, a.keep) : fs.mkdtempSync(path.join(os.tmpdir(), 'rabbinatix-verify-'));
  fs.mkdirSync(dir, { recursive: true });
  let results: ForeignResult[];
  try {
    results = foreignResults(r.jobs, runJobs(a.language, program, dir, exec));
  } catch (e) {
    warn((e as Error).message);
    return 2;
  } finally {
    if (!a.keep) fs.rmSync(dir, { recursive: true, force: true });
  }
  const failed = results.filter((x) => x.result.status !== 'pass' && x.result.status !== 'skipped');
  if (a.format === 'json') log(JSON.stringify({ logic: r.logic, language: r.language, results: results.map((x) => ({ run: x.label, ...x.result })) }, null, 2));
  else {
    log([`## ${r.logic.key} r${r.logic.revision} ${r.logic.name} in ${languageById(a.language)?.label ?? a.language}: ${failed.length ? `${failed.length} of ${results.length} test run${results.length === 1 ? '' : 's'} differ` : `all ${results.length} test run${results.length === 1 ? '' : 's'} match`}`, '',
      ...results.map((x) => `- ${x.result.status === 'pass' ? '✅' : x.result.status === 'skipped' ? '·' : '❌'} ${x.label}${x.result.reason ? `: ${x.result.reason}` : ''}${x.result.firstDifferentNode ? ` (at ${x.result.firstDifferentNode})` : ''}`)].join('\n'));
  }
  return failed.length ? 1 : 0;
}

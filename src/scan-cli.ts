// rabbinatix scan: security issues in the code here, on this machine (scan/). Prints them; with --report, sends them to
// Rabbinatix (Security checks → Code scan), where people triage them like the assistant's findings. Only the findings
// leave the machine (file, line, a short snippet with secrets masked); the dependency check sends package names and
// versions to OSV.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { call, connection, Connection } from './connect.js';
import { changeInfo, repoRoot } from './git.js';
import { scan, ScanResult } from './scan/index.js';
import { Finding, rank, Severity, SEVERITIES } from './scan/types.js';

export const SCAN_HELP = `rabbinatix scan: security issues in this repository

Usage: rabbinatix scan [options]

  --report             send the findings to Rabbinatix (Security checks → Code scan); needs a token with the scan scope
  --api <url>          the API address, from Integrations → API & CI (or RABBINATIX_API)
  --token-env <name>   the environment variable holding the API token (default RABBINATIX_TOKEN)
  --fail-on <level>    exit 1 when a finding is this severe or worse: critical, high, medium, low (default: never);
                       with --report, findings dismissed in Rabbinatix don't count
  --format <md|json>   what to print (default md)
  --out <file>         also write the findings as JSON
  --no-deps            don't check dependencies against OSV (it sends package names and versions to osv.dev)
  --semgrep            require Semgrep (default: use it when installed)  · --no-semgrep  never
  --gitleaks           require Gitleaks (default: use it when installed) · --no-gitleaks never
  --osv-scanner        require OSV-Scanner for dependencies (default: use it when installed, it reads every lock file
                       kind; otherwise the built-in reader) · --no-osv-scanner never
  --semgrep-config <c> Semgrep's rules (default: the repo's .semgrep.yml, else p/default)
  -h, --help           this help

What it finds: secrets in known formats, passwords and keys written into the code, risky code (eval, shell and SQL
built from variables, TLS checks turned off, HTML from variables, weak hashes, unsafe deserialisation, JWT mistakes),
vulnerable dependencies (npm, PyPI, Go, RubyGems, crates.io, Packagist, NuGet and Maven lock files), plus whatever
Semgrep and Gitleaks find. Add "rabbinatix-ignore" in a comment on a line to skip it.

It can't see what needs understanding the code, such as a missing access check: ask your AI assistant to scan for that.

Exit codes: 0 done · 1 --fail-on matched · 2 something went wrong (no token, git error, Rabbinatix unreachable).`;

export interface ScanArgs {
  report: boolean; api?: string; tokenEnv: string; failOn?: Severity; format: 'md' | 'json'; out?: string; deps: boolean;
  semgrep: 'auto' | 'on' | 'off'; gitleaks: 'auto' | 'on' | 'off'; osvScanner: 'auto' | 'on' | 'off'; semgrepConfig?: string; help: boolean;
}

export function parseScanArgs(argv: string[]): ScanArgs {
  const a: ScanArgs = { report: false, tokenEnv: 'RABBINATIX_TOKEN', format: 'md', deps: true, semgrep: 'auto', gitleaks: 'auto', osvScanner: 'auto', help: false };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case '--report': a.report = true; break;
      case '--api': a.api = value(i++, f); break;
      case '--token-env': a.tokenEnv = value(i++, f); break;
      case '--fail-on': { const v = value(i++, f) as Severity; if (!SEVERITIES.includes(v)) throw new Error('--fail-on is critical, high, medium or low.'); a.failOn = v; break; }
      case '--format': { const v = value(i++, f); if (v !== 'md' && v !== 'json') throw new Error('--format is md or json.'); a.format = v; break; }
      case '--out': a.out = value(i++, f); break;
      case '--no-deps': a.deps = false; break;
      case '--semgrep': a.semgrep = 'on'; break;
      case '--no-semgrep': a.semgrep = 'off'; break;
      case '--gitleaks': a.gitleaks = 'on'; break;
      case '--no-gitleaks': a.gitleaks = 'off'; break;
      case '--osv-scanner': a.osvScanner = 'on'; break;
      case '--no-osv-scanner': a.osvScanner = 'off'; break;
      case '--semgrep-config': a.semgrepConfig = value(i++, f); break;
      case '-h': case '--help': a.help = true; break;
      default: throw new Error(`Unknown option ${f}. See --help.`);
    }
  }
  return a;
}

const ICON: Record<Severity, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' };

/** the findings as Markdown (also a pull request comment) */
export function scanMarkdown(r: ScanResult, dismissed: ReadonlySet<number> = new Set(), link?: string): string {
  const open = r.findings.filter((_, i) => !dismissed.has(i));
  const counts = SEVERITIES.map((s) => [s, open.filter((f) => f.severity === s).length] as const).filter(([, n]) => n);
  const lines = [
    `### Security scan: ${open.length ? counts.map(([s, n]) => `${n} ${s}`).join(', ') : 'nothing found'}`,
    '',
    `${r.files} files · ${r.ran.join(', ')}${dismissed.size ? ` · ${dismissed.size} dismissed in Rabbinatix, not listed` : ''}`,
  ];
  if (open.length) {
    lines.push('', '| | Where | What | Rule |', '|---|---|---|---|');
    for (const f of open.slice(0, 200)) lines.push(`| ${ICON[f.severity]} ${f.severity} | \`${f.file}:${f.line}\` | ${f.title.replace(/\|/g, '\\|')}${f.fixHint ? `<br>${f.fixHint.replace(/\|/g, '\\|')}` : ''} | \`${f.rule}\` |`);
    if (open.length > 200) lines.push('', `…and ${open.length - 200} more (--format json lists them all).`);
  }
  for (const n of r.notes) lines.push('', `> ${n}`);
  if (link) lines.push('', `Triage them in Rabbinatix: ${link}`);
  return lines.join('\n');
}

/** what POST /v1/code-scan answers, added up over the calls */
interface Reported { new: number; updated: number; again: number; resolved: number; stillDismissed: number; overCap: number; refused: { index: number; message: string }[]; dismissed: number[]; link?: string }

/** the findings to Rabbinatix: 100 a call, the most severe first, `more` on all but the last (the last resolves what
 *  this kind of scan no longer finds) */
export async function report(c: Connection, findings: Finding[], where: Record<string, string | boolean>, fetchFn: typeof fetch = fetch, warn?: (s: string) => void): Promise<Reported> {
  const scanInfo = { ...(where['repo'] ? { repo: where['repo'] } : {}), ...(where['branch'] ? { branch: where['branch'] } : {}), ...(where['commit'] ? { commit: where['commit'] } : {}) };
  const total: Reported = { new: 0, updated: 0, again: 0, resolved: 0, stillDismissed: 0, overCap: 0, refused: [], dismissed: [] };
  const parts = Math.max(1, Math.ceil(findings.length / 100));
  for (let p = 0; p < parts; p++) {
    const chunk = findings.slice(p * 100, (p + 1) * 100);
    const j = await call<Partial<Reported>>(c, 'POST', '/code-scan', { body: { scan: scanInfo, findings: chunk, ...(p < parts - 1 ? { more: true } : {}) }, fetchFn, warn });
    for (const k of ['new', 'updated', 'again', 'resolved', 'stillDismissed', 'overCap'] as const) total[k] += j[k] ?? 0;
    total.refused.push(...(j.refused ?? []).map((x) => ({ ...x, index: x.index + p * 100 })));
    total.dismissed.push(...(j.dismissed ?? []).map((i) => i + p * 100));
    total.link = j.link ?? total.link;
  }
  return total;
}

type Print = (s: string) => void;

export async function mainScan(argv: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env, log: Print, warn: Print, fetchFn: typeof fetch = fetch, exec?: Parameters<typeof scan>[0]['exec']): Promise<number> {
  let a: ScanArgs;
  try {
    a = parseScanArgs(argv);
  } catch (e) {
    warn((e as Error).message);
    return 2;
  }
  if (a.help) { log(SCAN_HELP); return 0; }
  const c = a.report ? connection(a, env, cwd, 'scan') : undefined;
  if (c && 'missing' in c) { warn(c.missing); return 2; }
  try {
    const root = repoRoot(cwd);
    const result = await scan({ root, deps: a.deps, semgrep: a.semgrep, gitleaks: a.gitleaks, osvScanner: a.osvScanner, semgrepConfig: a.semgrepConfig, fetchFn, exec });
    let dismissed = new Set<number>();
    let sent: Reported | undefined;
    if (a.report) {
      sent = await report(c as Connection, result.findings, changeInfo(root, {}, env), fetchFn, warn);
      dismissed = new Set(sent.dismissed);
      for (const x of sent.refused) warn(`note: Rabbinatix didn’t take ${result.findings[x.index]?.file}:${result.findings[x.index]?.line}: ${x.message}`);
      if (sent.overCap) warn(`note: ${sent.overCap} findings weren’t kept: the project has too many open ones. Resolve or dismiss some in Rabbinatix.`);
    }
    const json = { ...result, ...(sent ? { reported: { ...sent, dismissed: undefined }, dismissed: [...dismissed] } : {}) };
    if (a.out) fs.writeFileSync(path.resolve(cwd, a.out), JSON.stringify(json, null, 2));
    log(a.format === 'json' ? JSON.stringify(json, null, 2) : scanMarkdown(result, dismissed, sent?.link));
    if (sent) warn(`Reported: ${sent.new} new, ${sent.updated} again, ${sent.again} back after a fix, ${sent.resolved} resolved, ${sent.stillDismissed} dismissed.`);
    const failing = a.failOn ? result.findings.filter((f, i) => !dismissed.has(i) && rank(f.severity) <= rank(a.failOn!)) : [];
    if (failing.length) warn(`Failing: ${failing.length} finding${failing.length === 1 ? ' is' : 's are'} ${a.failOn} or worse.`);
    return failing.length ? 1 : 0;
  } catch (e) {
    const err = e as Error & { stderr?: Buffer | string };
    warn(err.stderr ? String(err.stderr).trim() || err.message : err.message);
    return 2;
  }
}

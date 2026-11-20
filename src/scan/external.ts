// Semgrep and Gitleaks, when they are installed: their findings are added to the built-in ones. Run with an argument
// list (no shell), their JSON read back. Secrets are redacted by Gitleaks itself (--redact) and masked again here.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { masked } from './rules.js';
import { depFindings, OsvVuln } from './deps.js';
import type { Finding, Severity } from './types.js';

export type Run = (cmd: string, args: string[], cwd: string) => { status: number | null; stdout: string; stderr: string; error?: Error };
export const run: Run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 15 * 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
};

/** whether a command is installed (`<cmd> --version` answers) */
export const installed = (cmd: string, exec: Run = run, cwd = process.cwd()) => {
  const r = exec(cmd, ['--version'], cwd);
  return !r.error && r.status === 0;
};

const rel = (root: string, file: string) => (path.isAbsolute(file) ? path.relative(root, file) : file).split(path.sep).join('/').replace(/^\.\//, '');
const lineAt = (root: string, file: string, line: number) => {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8').split('\n')[line - 1] ?? '';
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------- Gitleaks

interface GitleaksHit { RuleID?: string; Description?: string; File?: string; StartLine?: number; Secret?: string; Match?: string }

/** Gitleaks over the working tree (v8: `gitleaks dir`, older `gitleaks detect --no-git`) */
export function gitleaks(root: string, exec: Run = run): { findings: Finding[]; note?: string } {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-gitleaks-')), 'report.json');
  try {
    const common = ['--report-format', 'json', '--report-path', out, '--redact', '--no-banner', '--exit-code', '0'];
    let r = exec('gitleaks', ['dir', root, ...common], root);
    if (r.status !== 0) r = exec('gitleaks', ['detect', '--no-git', '--source', root, ...common], root);
    if (r.status !== 0) return { findings: [], note: `Gitleaks didn’t run: ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}` };
    const hits = JSON.parse(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') || '[]' : '[]') as GitleaksHit[];
    return { findings: hits.filter((h) => h.File && h.StartLine).map((h) => gitleaksFinding(root, h)) };
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
}

export function gitleaksFinding(root: string, h: GitleaksHit): Finding {
  const file = rel(root, h.File!);
  const line = h.StartLine!;
  // the line from the file, the secret masked (Gitleaks' own Match is redacted already)
  const secret = h.Secret && h.Secret !== 'REDACTED' ? h.Secret : undefined;
  const text = lineAt(root, file, line);
  return {
    file, line, category: 'secret', severity: 'high', title: `${h.Description || h.RuleID || 'A secret'} in the code`.slice(0, 160),
    snippet: secret ? masked(text, secret) : masked(h.Match || text), rule: `gitleaks:${h.RuleID ?? 'secret'}`, cwe: 'CWE-798', owasp: 'A07:2021',
    fixHint: 'Revoke it where it was issued, make a new one, and keep it out of the code: an environment variable or a secret store.',
  };
}

// ---------------------------------------------------------------- Semgrep

interface SemgrepResult {
  check_id: string;
  path: string;
  start: { line: number };
  end?: { line: number };
  extra: { message?: string; severity?: string; lines?: string; metadata?: { cwe?: string | string[]; owasp?: string | string[]; vulnerability_class?: string[]; category?: string; impact?: string; confidence?: string } };
}

/** Semgrep with the repository's own config (`.semgrep.yml`, `.semgrep/`), else `config` (default p/default) */
export function semgrep(root: string, config: string | undefined, exec: Run = run): { findings: Finding[]; note?: string } {
  const own = ['.semgrep.yml', '.semgrep.yaml', '.semgrep'].find((f) => fs.existsSync(path.join(root, f)));
  const cfg = config ?? (own ? path.join(root, own) : 'p/default');
  const r = exec('semgrep', ['scan', '--config', cfg, '--json', '--quiet', '--metrics=off', '--disable-version-check', root], root);
  if (r.status !== 0 && r.status !== 1) return { findings: [], note: `Semgrep didn’t run: ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}` };
  let results: SemgrepResult[] = [];
  try {
    results = (JSON.parse(r.stdout || '{}') as { results?: SemgrepResult[] }).results ?? [];
  } catch {
    return { findings: [], note: 'Semgrep’s answer wasn’t JSON.' };
  }
  // only security findings (not style or best practice)
  return { findings: results.filter((x) => !x.extra.metadata?.category || x.extra.metadata.category === 'security').map((x) => semgrepFinding(root, x)) };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const SEMGREP_SEVERITY: Record<string, Severity> = { ERROR: 'high', WARNING: 'medium', INFO: 'low' };

export function semgrepFinding(root: string, x: SemgrepResult): Finding {
  const file = rel(root, x.path);
  const meta = x.extra.metadata ?? {};
  const cwe = /CWE-\d+/.exec(first(meta.cwe) ?? '')?.[0];
  const owasp = /A\d{2}:\d{4}/.exec(first(meta.owasp) ?? '')?.[0];
  const cls = meta.vulnerability_class?.[0];
  let severity = SEMGREP_SEVERITY[x.extra.severity ?? ''] ?? 'medium';
  if (severity === 'high' && meta.impact === 'HIGH' && meta.confidence === 'HIGH') severity = 'critical';
  const message = (x.extra.message ?? x.check_id).replace(/\s+/g, ' ').trim();
  const title = message.split(/(?<=\.)\s/)[0].slice(0, 160);
  const text = x.extra.lines && !/requires login/i.test(x.extra.lines) ? x.extra.lines.split('\n')[0] : lineAt(root, file, x.start.line);
  return {
    file, line: x.start.line, category: (cls ?? x.check_id.split('.').pop() ?? 'semgrep').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'semgrep',
    severity, title, ...(message.length > title.length ? { detail: message.slice(0, 600) } : {}),
    snippet: masked(text), rule: `semgrep:${x.check_id}`.slice(0, 100), ...(cwe ? { cwe } : {}), ...(owasp ? { owasp } : {}),
  };
}

// ---------------------------------------------------------------- OSV-Scanner

interface OsvScannerOut {
  results?: { source?: { path?: string }; packages?: { package?: { name?: string; version?: string; ecosystem?: string }; vulnerabilities?: OsvVuln[] }[] }[];
}

/** OSV-Scanner over the repository: every lock file it knows (all of the languages config's ecosystems), the same
 *  advisories as our own reader asks OSV for. v2 (`scan source`), else v1. */
export function osvScanner(root: string, exec: Run = run): { findings: Finding[]; note?: string; files: number; packages: number } {
  const args = ['--format', 'json', '--recursive', root];
  let r = exec('osv-scanner', ['scan', 'source', ...args], root);
  if (r.status !== 0 && r.status !== 1) r = exec('osv-scanner', args, root);
  // 0: nothing found, 1: vulnerabilities found, 128: no packages found
  if (r.status === 128) return { findings: [], files: 0, packages: 0 };
  if (r.status !== 0 && r.status !== 1) return { findings: [], note: `OSV-Scanner didn’t run: ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}`, files: 0, packages: 0 };
  let out: OsvScannerOut;
  try {
    out = JSON.parse(r.stdout || '{}') as OsvScannerOut;
  } catch {
    return { findings: [], note: 'OSV-Scanner’s answer wasn’t JSON.', files: 0, packages: 0 };
  }
  const findings: Finding[] = [];
  let packages = 0;
  for (const res of out.results ?? []) {
    const file = rel(root, res.source?.path ?? '');
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      // the line stays 1
    }
    const pinned = (res.packages ?? []).filter((p) => p.package?.name && p.package.version).map((p) => {
      const name = p.package!.name!;
      const at = text.indexOf(name);
      return { ecosystem: p.package!.ecosystem ?? '', name, version: p.package!.version!, file, line: at < 0 ? 1 : text.slice(0, at).split('\n').length };
    });
    packages += pinned.length;
    const vulns = new Map<string, OsvVuln>();
    const ids = (res.packages ?? []).filter((p) => p.package?.name && p.package.version).map((p) => (p.vulnerabilities ?? []).map((v) => (vulns.set(v.id, v), v.id)));
    findings.push(...depFindings(pinned, ids, vulns));
  }
  return { findings, files: (out.results ?? []).length, packages };
}

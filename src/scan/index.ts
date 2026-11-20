// `rabbinatix scan`: the repository's files (what git tracks, plus new files not ignored), the built-in rules on each,
// the lock files against OSV, and Semgrep and Gitleaks when installed. One list, each issue once, worst first.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { git } from '../git.js';
import { depFindings, Fetch, LOCK_FILES, osvLookup, pinnedIn, podNote, podRepos } from './deps.js';
import { gitleaks, installed, osvScanner, Run, run, semgrep } from './external.js';
import { scanText } from './rules.js';
import { Finding, rank } from './types.js';

export interface ScanOptions {
  root: string;
  /** look up dependencies on OSV (network) */
  deps: boolean;
  /** use Semgrep / Gitleaks when installed ('auto'), always (fail when missing: 'on'), never ('off') */
  semgrep: 'auto' | 'on' | 'off';
  gitleaks: 'auto' | 'on' | 'off';
  /** dependencies through OSV-Scanner when installed (every ecosystem); our own reader otherwise */
  osvScanner?: 'auto' | 'on' | 'off';
  semgrepConfig?: string;
  fetchFn?: Fetch;
  exec?: Run;
}

export interface ScanResult {
  findings: Finding[];
  /** what ran, for the summary line */
  ran: string[];
  /** what didn't, and why */
  notes: string[];
  files: number;
}

/** vendored code, minified files and lock files: not the project's own code (only tracked files are read, so build
 *  output that git ignores never is) */
const SKIP = /(?:^|\/)(?:node_modules|vendor|third[_-]party)\/|\.min\.(?:js|css)$|\.(?:map|lock)$|(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|packages\.lock\.json|gradle\.lockfile|go\.sum)$/;
const BINARY = /\.(?:png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|jar|war|class|dll|exe|so|dylib|woff2?|ttf|eot|mp[34]|mov|webm|wasm|bin|db|sqlite)$/i;
const MAX_BYTES = 1_000_000;

/** the files to look at: tracked ones and new ones git doesn't ignore */
export function filesOf(root: string): string[] {
  const out = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return [...new Set(out.split('\0').filter(Boolean))];
}

export async function scan(o: ScanOptions): Promise<ScanResult> {
  const exec = o.exec ?? run;
  const files = filesOf(o.root);
  const notes: string[] = [];
  const ran = ['built-in rules'];
  const found: Finding[] = [];
  const locks: { file: string; text: string }[] = [];
  for (const file of files) {
    const abs = path.join(o.root, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_BYTES || BINARY.test(file)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    if (text.slice(0, 8000).includes('\u0000')) continue;
    if (LOCK_FILES.test(file)) locks.push({ file, text });
    if (!SKIP.test(file)) found.push(...scanText(file, text));
  }

  const viaScanner = o.deps && (o.osvScanner ?? 'auto') !== 'off' && installed('osv-scanner', exec, o.root);
  if (o.deps && o.osvScanner === 'on' && !viaScanner) throw new Error('osv-scanner isn’t installed (asked for with --osv-scanner). Install it, or leave the flag out to use it only when it is there.');
  if (viaScanner) {
    const r = osvScanner(o.root, exec);
    if (r.note) notes.push(r.note);
    else {
      found.push(...r.findings);
      ran.push(`OSV-Scanner (${r.packages} packages in ${r.files} lock file${r.files === 1 ? '' : 's'})`);
    }
  }
  // OSV-Scanner has no CocoaPods data either: pods are checked here in both cases
  const ours = viaScanner ? locks.filter((l) => /(^|\/)Podfile\.lock$/.test(l.file)) : locks;
  if (o.deps && ours.length) {
    let pinned = ours.flatMap((l) => pinnedIn(l.file, l.text));
    if (pinned.length) {
      try {
        const pods = pinned.filter((p) => p.ecosystem === 'CocoaPods').length;
        let unresolved: string[] = [];
        if (pods) ({ pinned, unresolved } = await podRepos(pinned, ours, o.fetchFn));
        const note = podNote(pods - unresolved.length, unresolved);
        if (note) notes.push(note);
        if (pinned.length) {
          const { ids, vulns } = await osvLookup(pinned, o.fetchFn);
          found.push(...depFindings(pinned, ids, vulns));
          ran.push(`OSV (${pinned.length} packages in ${ours.length} lock file${ours.length === 1 ? '' : 's'})`);
        }
      } catch (e) {
        notes.push(`The dependency check didn’t run: ${(e as Error).message} (--no-deps skips it)`);
      }
    }
  }

  for (const [tool, mode, go] of [
    ['gitleaks', o.gitleaks, () => gitleaks(o.root, exec)],
    ['semgrep', o.semgrep, () => semgrep(o.root, o.semgrepConfig, exec)],
  ] as const) {
    if (mode === 'off') continue;
    if (!installed(tool, exec, o.root)) {
      if (mode === 'on') throw new Error(`${tool} isn’t installed (asked for with --${tool}). Install it, or leave the flag out to use it only when it is there.`);
      continue;
    }
    const r = go();
    if (r.note) notes.push(r.note);
    else ran.push(tool === 'gitleaks' ? 'Gitleaks' : 'Semgrep');
    found.push(...r.findings);
  }

  return { findings: merged(found), ran, notes, files: files.length };
}

/** each issue once: the same category on the same line of the same file (a tool's rule before the built-in one), worst
 *  first, then by file and line */
export function merged(list: Finding[]): Finding[] {
  const by = new Map<string, Finding>();
  const builtIn = (f: Finding) => f.rule.startsWith('rabbinatix:');
  for (const f of list) {
    const k = `${f.file}:${f.line}:${f.category === 'hardcoded-credential' ? 'secret' : f.category}`;
    const had = by.get(k);
    if (!had || (builtIn(had) && !builtIn(f)) || (builtIn(had) === builtIn(f) && rank(f.severity) < rank(had.severity))) by.set(k, f);
  }
  return [...by.values()].sort((a, b) => rank(a.severity) - rank(b.severity) || a.file.localeCompare(b.file) || a.line - b.line);
}

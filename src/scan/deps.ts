// Dependencies with known vulnerabilities: the packages pinned in the repository's lock files, checked against OSV
// (https://osv.dev, the open database GitHub, PyPI, Go, RubyGems, crates.io and others publish to). Only package names
// and versions are sent to OSV, never code. `--no-deps` skips it (offline).
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { ecosystemOfLockFile } from '../from-app/languages';
import type { Finding, Severity } from './types.js';
import { rank } from './types.js';

export interface Pkg { ecosystem: string; name: string; version: string }
interface SwiftPin { location?: string; repositoryURL?: string; state?: { version?: string | null } }
/** a pinned package; `lookup` is what OSV is asked about when it isn't the package itself (a pod: its repository) */
interface Pinned extends Pkg { file: string; line: number; lookup?: Pkg }

/** the line a text first appears on (1 when it doesn't) */
const lineOf = (text: string, needle: string) => {
  const i = text.indexOf(needle);
  return i < 0 ? 1 : text.slice(0, i).split('\n').length;
};
const base = (file: string) => file.slice(file.lastIndexOf('/') + 1);

/** the lock files this reads itself: the ecosystems marked `read` in the languages config */
export const LOCK_FILES = { test: (file: string) => !!ecosystemOfLockFile(file)?.read };

/** the packages a lock file pins */
export function pinnedIn(file: string, text: string): Pinned[] {
  const out: Pinned[] = [];
  const add = (ecosystem: string, name: string, version: string, near = name) => {
    if (name && version && /^[0-9]/.test(version)) out.push({ ecosystem, name, version, file, line: lineOf(text, near) });
  };
  try {
    switch (base(file)) {
      case 'package-lock.json':
      case 'npm-shrinkwrap.json': {
        const j = JSON.parse(text) as { packages?: Record<string, { version?: string; link?: boolean }>; dependencies?: Record<string, { version?: string; dependencies?: unknown }> };
        if (j.packages) {
          for (const [k, v] of Object.entries(j.packages)) {
            if (!k || v.link || !v.version) continue;
            const name = k.slice(k.lastIndexOf('node_modules/') + 'node_modules/'.length);
            add('npm', name, v.version, `"${k}"`);
          }
        } else {
          const walk = (deps: Record<string, { version?: string; dependencies?: unknown }> | undefined) => {
            for (const [name, v] of Object.entries(deps ?? {})) {
              if (v.version) add('npm', name, v.version, `"${name}"`);
              walk(v.dependencies as never);
            }
          };
          walk(j.dependencies);
        }
        break;
      }
      case 'yarn.lock': {
        // `"name@^1", name@^1.2:` then `  version "1.2.3"` (classic) or `  version: 1.2.3` (berry)
        let names: string[] = [];
        for (const raw of text.split('\n')) {
          if (/^\S/.test(raw) && raw.trim().endsWith(':')) {
            names = raw.replace(/:$/, '').split(',').map((s) => s.trim().replace(/^"|"$/g, '')).map((s) => s.slice(0, s.lastIndexOf('@') > 0 ? s.lastIndexOf('@') : undefined).replace(/@npm$/, ''));
          } else {
            const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(raw);
            if (m && names.length) {
              add('npm', names[0], m[1], names[0]);
              names = [];
            }
          }
        }
        break;
      }
      case 'pnpm-lock.yaml': {
        const y = YAML.parse(text) as { packages?: Record<string, unknown> };
        for (const k of Object.keys(y?.packages ?? {})) {
          // `/name@1.2.3`, `/@scope/name@1.2.3(peer@x)`, `/name/1.2.3` (old)
          const key = k.replace(/^\//, '').replace(/\(.*$/, '');
          const at = key.lastIndexOf('@');
          if (at > 0) add('npm', key.slice(0, at), key.slice(at + 1), k);
          else {
            const slash = key.lastIndexOf('/');
            if (slash > 0) add('npm', key.slice(0, slash), key.slice(slash + 1), k);
          }
        }
        break;
      }
      case 'poetry.lock':
      case 'Cargo.lock': {
        const eco = base(file) === 'poetry.lock' ? 'PyPI' : 'crates.io';
        for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
          const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
          const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
          if (name && version) add(eco, name, version, `name = "${name}"`);
        }
        break;
      }
      case 'Pipfile.lock': {
        const j = JSON.parse(text) as Record<string, Record<string, { version?: string }>>;
        for (const part of ['default', 'develop']) for (const [name, v] of Object.entries(j[part] ?? {})) if (v.version) add('PyPI', name, v.version.replace(/^==/, ''), `"${name}"`);
        break;
      }
      case 'go.sum': {
        const seen = new Set<string>();
        for (const l of text.split('\n')) {
          const m = /^(\S+)\s+v([^\s/]+?)(?:\/go\.mod)?\s+h1:/.exec(l);
          if (!m || seen.has(`${m[1]}@${m[2]}`)) continue;
          seen.add(`${m[1]}@${m[2]}`);
          add('Go', m[1], m[2].replace(/\+incompatible$/, ''), m[1]);
        }
        break;
      }
      case 'Gemfile.lock': {
        let inSpecs = false;
        for (const l of text.split('\n')) {
          if (/^\s{2}specs:/.test(l)) inSpecs = true;
          else if (/^\S/.test(l)) inSpecs = false;
          const m = inSpecs ? /^\s{4}([A-Za-z0-9_.-]+) \(([^)]+)\)$/.exec(l) : null;
          if (m) add('RubyGems', m[1], m[2], `    ${m[1]} (`);
        }
        break;
      }
      case 'composer.lock': {
        const j = JSON.parse(text) as { packages?: { name: string; version: string }[]; 'packages-dev'?: { name: string; version: string }[] };
        for (const p of [...(j.packages ?? []), ...(j['packages-dev'] ?? [])]) add('Packagist', p.name, p.version.replace(/^v/, ''), `"${p.name}"`);
        break;
      }
      case 'packages.lock.json': {
        const j = JSON.parse(text) as { dependencies?: Record<string, Record<string, { resolved?: string }>> };
        for (const tfm of Object.values(j.dependencies ?? {})) for (const [name, v] of Object.entries(tfm)) if (v.resolved) add('NuGet', name, v.resolved, `"${name}"`);
        break;
      }
      case 'gradle.lockfile': {
        for (const l of text.split('\n')) {
          const m = /^([\w.-]+):([\w.-]+):([^=\s]+)=/.exec(l);
          if (m) add('Maven', `${m[1]}:${m[2]}`, m[3], l);
        }
        break;
      }
      case 'libs.versions.toml': {
        // a Gradle version catalog: [versions] name = "1.2" and [libraries] x = "g:a:1.2" | { module = "g:a", version.ref = "name" }
        // | { group = "g", name = "a", version = "1.2" }
        const versions = new Map<string, string>();
        let section = '';
        const lines = text.split('\n');
        for (const l of lines) {
          const sec = /^\s*\[([\w-]+)\]\s*$/.exec(l);
          if (sec) { section = sec[1]; continue; }
          const v = section === 'versions' ? /^\s*([\w.-]+)\s*=\s*"([^"]+)"/.exec(l) : null;
          if (v) versions.set(v[1], v[2]);
        }
        section = '';
        for (const l of lines) {
          const sec = /^\s*\[([\w-]+)\]\s*$/.exec(l);
          if (sec) { section = sec[1]; continue; }
          if (section !== 'libraries') continue;
          const str = (key: string) => new RegExp(`(?:^|[{,\\s])${key.replace('.', '\\.')}\\s*=\\s*"([^"]+)"`).exec(l)?.[1];
          const short = /^\s*[\w.-]+\s*=\s*"([^":]+):([^":]+):([^"]+)"/.exec(l);
          if (short) { add('Maven', `${short[1]}:${short[2]}`, short[3], l.trim()); continue; }
          const module = str('module') ?? (str('group') && str('name') ? `${str('group')}:${str('name')}` : undefined);
          const version = str('version') ?? versions.get(str('version.ref') ?? '');
          if (module && version) add('Maven', module, version, l.trim());
        }
        break;
      }
      case 'pubspec.lock': {
        const y = YAML.parse(text) as { packages?: Record<string, { version?: string; source?: string }> };
        for (const [name, v] of Object.entries(y?.packages ?? {})) if (v?.version && v.source !== 'sdk') add('Pub', name, String(v.version), `  ${name}:`);
        break;
      }
      case 'Package.resolved': {
        // version 1: object.pins[{ package, repositoryURL, state }]; versions 2 and 3: pins[{ identity, location, state }]
        const j = JSON.parse(text) as { pins?: SwiftPin[]; object?: { pins?: SwiftPin[] } };
        for (const pin of j.pins ?? j.object?.pins ?? []) {
          const url = pin.location ?? pin.repositoryURL;
          // OSV names a Swift package by its address without the scheme and .git: github.com/apple/swift-nio
          if (url && pin.state?.version) add('SwiftURL', url.replace(/^[a-z+]+:\/\//i, '').replace(/^git@([^:]+):/, '$1/').replace(/\.git$/, ''), pin.state.version, url);
        }
        break;
      }
      case 'Podfile.lock': {
        // PODS: ["Name (1.2.3)" | { "Name/Subspec (1.2.3)": [deps] }]; a subspec is its pod
        const y = YAML.parse(text) as { PODS?: (string | Record<string, unknown>)[] };
        for (const entry of y?.PODS ?? []) {
          const m = /^([^\s/(]+)(?:\/\S+)?\s+\(([^)]+)\)$/.exec(typeof entry === 'string' ? entry : Object.keys(entry)[0] ?? '');
          if (m) add('CocoaPods', m[1], m[2], `  - ${m[1]}`);
        }
        break;
      }
      default:
        if (/^requirements[^/]*\.txt$/.test(base(file))) {
          for (const l of text.split('\n')) {
            const m = /^\s*([A-Za-z0-9_.\-[\]]+?)(?:\[[^\]]*\])?\s*==\s*([0-9][^\s;#]*)/.exec(l);
            if (m) add('PyPI', m[1], m[2], l.trim());
          }
        }
    }
  } catch {
    // a lock file that doesn't parse: nothing from it (the note says so)
    return [];
  }
  // each package and version once per file
  const seen = new Set<string>();
  return out.filter((p) => !seen.has(`${p.ecosystem}|${p.name}|${p.version}`) && !!seen.add(`${p.ecosystem}|${p.name}|${p.version}`));
}

// ---------------------------------------------------------------- CocoaPods

const CDN = 'https://cdn.cocoapods.org/Specs';

/** OSV's name for a repository: its address without the scheme and .git (github.com/Alamofire/Alamofire) */
export const repoName = (url: string) => url.trim().replace(/^[a-z+]+:\/\//i, '').replace(/^git@([^:]+):/, '$1/').replace(/^[^@/]+@/, '').replace(/\/+$/, '').replace(/\.git$/, '');

/** the git repositories a Podfile.lock names itself (EXTERNAL SOURCES and CHECKOUT OPTIONS: `:git:`) */
function lockRepos(text: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const y = YAML.parse(text) as Record<string, Record<string, Record<string, string>> | undefined>;
    for (const part of ['CHECKOUT OPTIONS', 'EXTERNAL SOURCES']) for (const [pod, o] of Object.entries(y?.[part] ?? {})) if (o?.[':git'] && !out.has(pod)) out.set(pod, o[':git']);
  } catch {
    // read already (pinnedIn)
  }
  return out;
}

/**
 * Pods have no data of their own in OSV: each is checked as its source repository's Swift package (SwiftURL). The
 * repository comes from the Podfile.lock (a :git source) or from the pod's spec on the CocoaPods CDN (only the pod's
 * name and version are sent). Returns the pins with `lookup` set, and the pods whose repository wasn't found.
 */
export async function podRepos(pinned: Pinned[], locks: { file: string; text: string }[], fetchFn: Fetch = fetch): Promise<{ pinned: Pinned[]; unresolved: string[] }> {
  const named = new Map(locks.filter((l) => base(l.file) === 'Podfile.lock').map((l) => [l.file, lockRepos(l.text)]));
  const unresolved: string[] = [];
  const spec = async (p: Pinned): Promise<string | undefined> => {
    const own = named.get(p.file)?.get(p.name);
    if (own) return own;
    const h = createHash('md5').update(p.name).digest('hex');
    const r = await fetchFn(`${CDN}/${h[0]}/${h[1]}/${h[2]}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.version)}/${encodeURIComponent(p.name)}.podspec.json`, { headers: { 'user-agent': 'rabbinatix' } }).catch(() => undefined);
    if (!r?.ok) return undefined;
    const j = (await r.json().catch(() => undefined)) as { source?: { git?: string } } | undefined;
    return j?.source?.git;
  };
  const out = [...pinned];
  const pods = out.map((p, i) => [p, i] as const).filter(([p]) => p.ecosystem === 'CocoaPods');
  // a few at a time
  for (let k = 0; k < pods.length; k += 8) {
    await Promise.all(pods.slice(k, k + 8).map(async ([p, i]) => {
      const git = await spec(p);
      // a repository address OSV can name (a host and a path), not a local path
      if (git && /^(https?:\/\/|git@|ssh:\/\/)/i.test(git)) out[i] = { ...p, lookup: { ecosystem: 'SwiftURL', name: repoName(git), version: p.version } };
      else unresolved.push(p.name);
    }));
  }
  return { pinned: out.filter((p) => p.ecosystem !== 'CocoaPods' || p.lookup), unresolved: unresolved.sort() };
}

/** what a scan says about pods: how they were checked, and the ones that couldn't be */
export function podNote(checked: number, unresolved: string[]): string | undefined {
  if (!checked && !unresolved.length) return undefined;
  const parts = [`CocoaPods: ${checked} pod${checked === 1 ? '' : 's'} checked through ${checked === 1 ? 'its' : 'their'} source repositor${checked === 1 ? 'y' : 'ies'} in OSV's Swift data; pods written only in Objective-C rarely have advisories there.`];
  if (unresolved.length) parts.push(`Not checked (a local or private pod, or no public repository found): ${unresolved.slice(0, 10).join(', ')}${unresolved.length > 10 ? ` and ${unresolved.length - 10} more` : ''}.`);
  return parts.join(' ');
}

// ---------------------------------------------------------------- OSV

export interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  database_specific?: { severity?: string; cwe_ids?: string[] };
  severity?: { type: string; score: string }[];
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { events?: { introduced?: string; fixed?: string }[] }[] }[];
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const OSV = 'https://api.osv.dev/v1';

/** the vulnerability ids of each package (one call per 1000 packages), then each vulnerability once (at most `max`) */
export async function osvLookup(pkgs: Pkg[], fetchFn: Fetch = fetch, max = 300): Promise<{ ids: string[][]; vulns: Map<string, OsvVuln> }> {
  const ids: string[][] = [];
  for (let i = 0; i < pkgs.length; i += 1000) {
    const part = pkgs.slice(i, i + 1000);
    const r = await fetchFn(`${OSV}/querybatch`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'rabbinatix' },
      body: JSON.stringify({ queries: part.map((p) => { const q = (p as Pinned).lookup ?? p; return { package: { name: q.name, ecosystem: q.ecosystem }, version: q.version }; }) }),
    });
    if (!r.ok) throw new Error(`OSV answered ${r.status}.`);
    const j = (await r.json()) as { results?: { vulns?: { id: string }[] }[] };
    part.forEach((_, k) => ids.push((j.results?.[k]?.vulns ?? []).map((v) => v.id)));
  }
  const unique = [...new Set(ids.flat())].slice(0, max);
  const vulns = new Map<string, OsvVuln>();
  // a few at a time
  for (let i = 0; i < unique.length; i += 8) {
    await Promise.all(unique.slice(i, i + 8).map(async (id) => {
      const r = await fetchFn(`${OSV}/vulns/${encodeURIComponent(id)}`, { headers: { 'user-agent': 'rabbinatix' } });
      if (r.ok) vulns.set(id, (await r.json()) as OsvVuln);
    }));
  }
  return { ids, vulns };
}

/** a vulnerability's severity: the advisory's own word (GitHub's LOW/MODERATE/HIGH/CRITICAL), else the CVSS score's band */
export function severityOf(v: OsvVuln): Severity {
  const word = v.database_specific?.severity?.toUpperCase();
  if (word === 'CRITICAL') return 'critical';
  if (word === 'HIGH') return 'high';
  if (word === 'MODERATE' || word === 'MEDIUM') return 'medium';
  if (word === 'LOW') return 'low';
  const score = Number(v.severity?.find((s) => /^\d+(\.\d+)?$/.test(s.score))?.score);
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score > 0 && score < 4) return 'low';
  return 'medium';
}

/** the lowest version that fixes it for this package, when the advisory says */
export function fixedIn(v: OsvVuln, p: Pkg): string | undefined {
  const fixes = (v.affected ?? []).filter((a) => !a.package?.name || a.package.name.toLowerCase() === p.name.toLowerCase())
    .flatMap((a) => (a.ranges ?? []).flatMap((r) => (r.events ?? []).map((e) => e.fixed).filter((x): x is string => !!x)));
  return fixes.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
}

/** one finding per vulnerable package and version: the worst severity of its advisories */
export function depFindings(pinned: Pinned[], ids: string[][], vulns: Map<string, OsvVuln>): Finding[] {
  const out: Finding[] = [];
  pinned.forEach((p, i) => {
    const list = (ids[i] ?? []).map((id) => vulns.get(id) ?? { id }).filter(Boolean) as OsvVuln[];
    if (!list.length) return;
    const worst = list.map(severityOf).sort((a, b) => rank(a) - rank(b))[0];
    const fixes = list.map((v) => fixedIn(v, p.lookup ?? p)).filter((x): x is string => !!x).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const named = (v: OsvVuln) => [...(v.aliases ?? []).filter((a) => a.startsWith('CVE-')).slice(0, 1), v.id].join(' / ');
    const detail = list.slice(0, 5).map((v) => `${named(v)}: ${v.summary ?? 'see the advisory'}`).join(' · ') + (list.length > 5 ? ` · and ${list.length - 5} more` : '');
    const cwe = list.flatMap((v) => v.database_specific?.cwe_ids ?? [])[0];
    out.push({
      file: p.file, line: p.line, category: 'vulnerable-dependency', severity: worst,
      title: `${p.name} ${p.version} has ${list.length} known vulnerabilit${list.length === 1 ? 'y' : 'ies'}`,
      detail, snippet: `${p.name}@${p.version}`, rule: `osv:${list[0].id}`, owasp: 'A06:2021',
      ...(cwe ? { cwe } : {}), ...(fixes[0] ? { fixHint: `Upgrade ${p.name} to ${fixes[0]} or later.` } : { fixHint: 'No fixed version is published yet: see the advisory for a workaround.' }),
    });
  });
  return out;
}

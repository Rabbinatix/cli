// Where a change lands (docs/04-roadmap/code-impact-plan.md § Phase B). For every changed line of TypeScript or
// JavaScript: the function it is in, then outward through enclosing functions, then backwards through the code that
// calls it (the TypeScript language service's references), until an `FDD:` anchor or a route registration is found.
// Other languages: anchors only. Nothing found: the line is "not on the map". Reads the repo; runs none of its code.
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { CALL_FOLLOWING, CodeAnchors as Anchors, isTestFile, languageOfFile, readAnchors } from './from-app/languages';
import { ChangedFile, changedLines, onlyComments, rangesText } from './diff.js';
import { specChanges, SpecChange, looksLikeSpec } from './openapi.js';
import { Call, callsAt, callsIn } from './calls-text.js';
import { functionAt, functionsIn, Handler, handlersAt, joinPath as joinRoute, refMatches, textHandlers, textIncludes } from './routes-text.js';

export interface CodeHop { file: string; line: number; name: string }
export interface Reached { ref: string; revision?: number; steps: string[]; via: CodeHop[]; how: 'sure' | 'likely' }
export interface RouteHit { method: string; path: string; via: CodeHop[] }
/** an API call the change reaches (calls-text.ts): the call itself, or the function that makes it */
export type CallHit = RouteHit;
export interface Found {
  reached: Reached[];
  routes: RouteHit[];
  calls: CallHit[];
  specs: SpecChange[];
  unmapped: { file: string; lines?: string }[];
  tests: string[];
  /** files whose change is only comments or blank lines */
  commentsOnly: string[];
  /** files left out on purpose (docs, lock files, build output) */
  ignored: string[];
  /** what the analysis couldn't do, in words */
  notes: string[];
}

export interface AnalyzeOptions {
  root: string;
  files: ChangedFile[];
  /** a file's content at the base, or null (deleted or new) */
  readBase: (file: string) => string | null;
  tsconfig?: string;
  maxDepth?: number;
  maxNodes?: number;
}

// the languages config (app/src/app/languages): TypeScript and JavaScript are followed through their calls; other code
// is read for anchors and routes; scripts and infrastructure are left out
const isTsLike = (f: string) => { const l = languageOfFile(f); return !!l && CALL_FOLLOWING.includes(l.id); };
const isOtherCode = (f: string) => { const l = languageOfFile(f); return !!l && !l.tooling && !CALL_FOLLOWING.includes(l.id); };
const IGNORED = /(?:^|\/)(?:node_modules|dist|build|coverage|\.angular|\.next|out)\/|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$|\.(?:md|mdx|txt|png|jpe?g|gif|svg|webp|ico|pdf|lock)$|(?:^|\/)\.rabbinatix\/code-map\.json$|(?:^|\/)(?:LICENSE|CHANGELOG)[^/]*$/i;
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const NEST_METHODS: Record<string, string> = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', Head: 'HEAD', Options: 'OPTIONS', All: 'ALL' };

export { isTestFile };

export function analyze(o: AnalyzeOptions): Found {
  const found: Found = { reached: [], routes: [], calls: [], specs: [], unmapped: [], tests: [], commentsOnly: [], ignored: [], notes: [] };
  const maxDepth = o.maxDepth ?? 6, maxNodes = o.maxNodes ?? 500;
  const reached = new Map<string, Reached>();
  const addReached = (r: Reached) => {
    const had = reached.get(r.ref);
    if (!had) return void reached.set(r.ref, { ...r, steps: [...new Set(r.steps)] });
    had.steps = [...new Set([...had.steps, ...r.steps])];
    if (r.how === 'sure') had.how = 'sure';
    if (r.via.length < had.via.length) had.via = r.via;
  };
  const callKeys = new Set<string>();
  const addCall = (r: CallHit) => {
    const k = `${r.method} ${r.path}`;
    if (!callKeys.has(k)) { callKeys.add(k); found.calls.push(r); }
  };
  /** changed lines that reach an API call, per file: not "off the map" */
  const callLines = new Map<string, Set<number>>();
  const routeKeys = new Set<string>();
  const addRoute = (r: RouteHit) => {
    const k = `${r.method} ${r.path}`;
    if (!routeKeys.has(k)) { routeKeys.add(k); found.routes.push(r); }
  };
  const tests = new Set<string>();

  const tsFiles: ChangedFile[] = [];
  const registry = routeRegistry(o.root);
  for (const f of o.files) {
    const rel = f.path.replace(/\\/g, '/');
    if (IGNORED.test(rel)) { found.ignored.push(rel); continue; }
    if (isTestFile(rel)) { if (f.status !== 'deleted') tests.add(rel); continue; }
    const head = f.status === 'deleted' ? null : readText(path.join(o.root, rel));
    const base = f.status === 'added' ? null : o.readBase(f.oldPath ?? rel);
    if (/\.(?:ya?ml|json)$/i.test(rel) && (looksLikeSpec(head) || looksLikeSpec(base))) {
      found.specs.push(...specChanges(base, head, rel));
      continue;
    }
    if (f.status !== 'deleted' && onlyComments(f)) { found.commentsOnly.push(rel); continue; }
    if (f.status === 'deleted') {
      // a deleted file: the logic its anchors named loses its code
      const a = base ? readAnchors(base) : { logic: [], nodes: [] };
      const gone = base && isOtherCode(rel) ? registry.handlersOf(rel, base) : [];
      if (a.logic.length) for (const l of a.logic) addReached({ ref: l.key, revision: l.revision, steps: [], via: [{ file: rel, line: l.line, name: '(file removed)' }], how: 'sure' });
      else if (gone.length) for (const h of gone) addRoute({ method: h.method, path: h.path, via: [{ file: rel, line: h.start, name: `${h.name} (file removed)` }] });
      else if (isTsLike(rel) || isOtherCode(rel)) found.unmapped.push({ file: rel, lines: 'removed' });
      else found.unmapped.push({ file: rel });
      continue;
    }
    // the API calls the changed lines make, or that the function they are in makes
    if (head !== null && (isTsLike(rel) || isOtherCode(rel))) {
      const cs = callsIn(rel, head);
      if (cs.length) {
        const fns = functionsIn(rel, head);
        const reached = new Set<number>();
        for (const line of changedLines(f)) {
          let hits = callsAt(cs, line);
          let name = '';
          if (!hits.length) {
            const fn = functionAt(fns, line);
            if (fn) { hits = cs.filter((c) => c.start >= fn.start && c.end <= fn.end); name = fn.owner ? `${fn.owner}.${fn.name}` : fn.name; }
          }
          for (const c of hits) addCall({ method: c.method, path: c.path, via: [{ file: rel, line, name: name ? `${name} → ${c.name}` : c.name }] });
          if (hits.length) reached.add(line);
        }
        if (reached.size) callLines.set(rel, reached);
      }
    }
    // a call to an interface method that declares an API call (Retrofit, Feign, Refit), anywhere in the repo
    if (head !== null && (isTsLike(rel) || isOtherCode(rel)) && registry.hasDeclared(rel)) {
      const lines = head.split(/\r?\n/);
      const reached = callLines.get(rel) ?? new Set<number>();
      for (const line of changedLines(f)) {
        for (const m of (lines[line - 1] ?? '').matchAll(/\.(\w+)\s*\(/g)) {
          for (const d of registry.declared(rel, m[1])) {
            addCall({ method: d.c.method, path: d.c.path, via: [{ file: rel, line, name: `${m[1]}()` }, { file: d.file, line: d.c.start, name: d.c.name }] });
            reached.add(line);
          }
        }
      }
      if (reached.size) callLines.set(rel, reached);
    }
    if (isTsLike(rel)) { tsFiles.push(f); continue; }
    if (isOtherCode(rel) && head !== null) {
      // anchors only: the logic anchor above each changed line, and the step anchor between it and the line
      // then the API route of the handler the line is in (routes-text.ts), or of the registrations elsewhere in the repo
      // that name the function the line is in (`r.GET("/orders/:id", h.GetOrder)` in routes.go, the line in GetOrder)
      const a = readAnchors(head);
      const handlers = registry.handlersOf(rel, head);
      const fns = functionsIn(rel, head);
      const missed: number[] = [];
      for (const line of changedLines(f)) {
        const hit = anchorAbove(a, line);
        const hs = hit ? [] : handlersAt(handlers, line);
        const fn = hit || hs.length ? undefined : functionAt(fns, line);
        const named = fn ? registry.naming(rel, fn) : [];
        if (hit) addReached({ ref: hit.key, revision: hit.revision, steps: hit.step ? [hit.step] : [], via: [{ file: rel, line, name: '' }], how: 'sure' });
        else if (hs.length) for (const h of hs) addRoute({ method: h.method, path: h.path, via: [{ file: rel, line, name: h.name }] });
        else if (named.length) for (const r of named) addRoute({ method: r.h.method, path: r.h.path, via: [{ file: rel, line, name: fn!.owner ? `${fn!.owner}.${fn!.name}` : fn!.name }, { file: r.file, line: r.h.start, name: `${r.h.method} ${r.h.path}` }] });
        else if (!callLines.get(rel)?.has(line)) missed.push(line);
      }
      if (missed.length) found.unmapped.push({ file: rel, lines: rangesText(missed) });
      continue;
    }
    // configuration and anything else that may change behaviour: not on the map
    found.unmapped.push({ file: rel, lines: rangesText(changedLines(f)) });
  }

  // each file with the nearest tsconfig.json above it (a monorepo has several), unless one was named
  const groups = new Map<string, ChangedFile[]>();
  const root = path.resolve(o.root);
  for (const f of tsFiles) {
    const cfg = o.tsconfig ? path.resolve(root, o.tsconfig) : ts.findConfigFile(path.dirname(path.join(root, f.path)), ts.sys.fileExists, 'tsconfig.json');
    const inRepo = cfg && path.resolve(cfg).startsWith(root + path.sep) ? path.resolve(cfg) : '';
    groups.set(inRepo, [...(groups.get(inRepo) ?? []), f]);
  }
  for (const [cfg, list] of groups) walkTypeScript({ ...o, tsconfig: cfg || undefined }, list, { maxDepth, maxNodes, addReached, addRoute, tests, found, callLines });
  found.reached = [...reached.values()];
  found.tests = [...tests].sort();
  return found;
}

/**
 * The route registrations of the repo's code in each language, read once when a changed line needs them: which name a
 * function (`ref`), and the prefixes Django's include() mounts a urls.py under.
 */
function routeRegistry(root: string) {
  const byLang = new Map<string, { file: string; h: Handler }[]>();
  let includes: { from: string; prefix: string; module: string }[] | null = null;
  const pyIncludes = () => {
    if (includes) return includes;
    includes = [];
    for (const file of listFiles(root, (f) => /(?:^|\/)urls\.py$/.test(f))) {
      const text = readText(path.join(root, file));
      if (text) for (const x of textIncludes(file, text)) includes.push({ from: file, ...x });
    }
    return includes;
  };
  /** the prefix include() mounts a urls.py under ('' for the root one), followed up to 5 levels */
  const mountOf = (file: string, depth = 0): string => {
    if (depth > 5 || !/(?:^|\/)urls\.py$/.test(file)) return '';
    const inc = pyIncludes().find((x) => file.endsWith(`${x.module.replace(/\./g, '/')}.py`) && x.from !== file);
    return inc ? joinRoute(mountOf(inc.from, depth + 1), inc.prefix) : '';
  };
  const handlersOf = (file: string, text: string): Handler[] => {
    const hs = textHandlers(file, text);
    const mount = mountOf(file);
    return mount ? hs.map((h) => ({ ...h, path: joinRoute(mount, h.path) })) : hs;
  };
  const registrations = (lang: string) => {
    let list = byLang.get(lang);
    if (list) return list;
    list = [];
    for (const file of listFiles(root, (f) => languageOfFile(f)?.id === lang && !isTestFile(f))) {
      const text = readText(path.join(root, file));
      if (text) for (const h of handlersOf(file, text)) if (h.ref) list.push({ file, h });
    }
    byLang.set(lang, list);
    return list;
  };
  const declaredBy = new Map<string, { file: string; c: Call }[]>();
  /** the interface methods that declare API calls in this language's files (Retrofit, Feign, Refit) */
  const declaredIn = (lang: string) => {
    let list = declaredBy.get(lang);
    if (list) return list;
    list = [];
    // Java and Kotlin call each other's interfaces (an Android app has both)
    const family = lang === 'java' || lang === 'kotlin' ? ['java', 'kotlin'] : lang === 'csharp' ? ['csharp'] : [];
    if (family.length) {
      for (const file of listFiles(root, (f) => family.includes(languageOfFile(f)?.id ?? '') && !isTestFile(f))) {
        const text = readText(path.join(root, file));
        if (text && /@(?:GET|POST|PUT|PATCH|DELETE|HTTP)\b|@FeignClient|\[(?:Get|Post|Put|Patch|Delete)\(/.test(text)) for (const c of callsIn(file, text)) if (c.declares) list.push({ file, c });
      }
    }
    declaredBy.set(lang, list);
    return list;
  };
  return {
    handlersOf,
    hasDeclared: (file: string) => { const l = languageOfFile(file)?.id; return !!l && declaredIn(l).length > 0; },
    declared: (file: string, name: string) => { const l = languageOfFile(file)?.id; return l ? declaredIn(l).filter((d) => d.c.declares === name) : []; },
    /** the registrations that name this function as their handler */
    naming: (file: string, fn: { name: string; owner?: string }) => {
      const lang = languageOfFile(file)?.id;
      return lang ? registrations(lang).filter((r) => refMatches(r.h.ref!, fn as never)) : [];
    },
  };
}

/** the repo's files (relative, at most 5000) that pass `keep`, outside dependencies and build output */
function listFiles(root: string, keep: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= 5000) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || ['node_modules', 'dist', 'build', 'coverage', 'vendor', 'target', 'venv', '__pycache__', 'Pods'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).replace(/\\/g, '/');
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && keep(rel)) out.push(rel);
    }
  };
  walk(root);
  return out;
}

function readText(p: string): string | null {
  try {
    const st = fs.lstatSync(p);
    // never follow a link out of the repo, never read something huge
    if (st.isSymbolicLink() || !st.isFile() || st.size > 4_000_000) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** the logic anchor nearest above `line` and the step anchor between them */
function anchorAbove(a: Anchors, line: number): { key: string; revision?: number; step?: string } | null {
  const logic = [...a.logic].filter((l) => l.line <= line).sort((x, y) => y.line - x.line)[0];
  if (!logic) return null;
  const step = a.nodes.filter((n) => n.line > logic.line && n.line <= line).sort((x, y) => y.line - x.line)[0];
  return { key: logic.key, revision: logic.revision, ...(step ? { step: step.key } : {}) };
}

// ---------------------------------------------------------------- TypeScript

interface Walk {
  maxDepth: number;
  maxNodes: number;
  addReached: (r: Reached) => void;
  addRoute: (r: RouteHit) => void;
  /** lines already placed on an API call */
  callLines: Map<string, Set<number>>;
  tests: Set<string>;
  found: Found;
}

type Unit = ts.FunctionLikeDeclaration | ts.ClassDeclaration | ts.ClassExpression;

function walkTypeScript(o: AnalyzeOptions, changed: ChangedFile[], w: Walk) {
  const root = path.resolve(o.root);
  const service = languageService(root, changed.map((f) => path.join(root, f.path)), o.tsconfig, w.found.notes);
  const program = service.getProgram();
  if (!program) { for (const f of changed) w.found.unmapped.push({ file: f.path, lines: rangesText(changedLines(f)) }); return; }
  const anchorsCache = new Map<string, Anchors>();
  const anchorsOf = (sf: ts.SourceFile) => anchorsCache.get(sf.fileName) ?? anchorsCache.set(sf.fileName, readAnchors(sf.text)).get(sf.fileName)!;
  const relOf = (abs: string) => path.relative(root, abs).replace(/\\/g, '/');
  let nodes = 0;
  /** what following a function's callers found: true, false, or still being followed (a cycle finds nothing new) */
  const seen = new Map<string, boolean | 'walking'>();

  for (const f of changed) {
    const sf = program.getSourceFile(path.join(root, f.path));
    if (!sf) { w.found.unmapped.push({ file: f.path, lines: rangesText(changedLines(f)) }); continue; }
    const missed: number[] = [];
    // lines grouped by the function they are in: each function is walked once
    const byUnit = new Map<ts.Node | undefined, number[]>();
    for (const line of changedLines(f)) {
      if (line > sf.getLineStarts().length) continue;
      const pos = firstCharOf(sf, line);
      const u = unitAt(sf, pos);
      byUnit.set(u, [...(byUnit.get(u) ?? []), line]);
    }
    for (const [unit, lines] of byUnit) {
      const hit = resolveFrom(sf, lines, unit, 0, [{ file: f.path, line: lines[0], name: nameOf(unit) }]);
      if (!hit) missed.push(...lines.filter((l) => !w.callLines.get(f.path)?.has(l)));
    }
    if (missed.length) w.found.unmapped.push({ file: f.path, lines: rangesText(missed.sort((a, b) => a - b)) });
  }

  /** whether something on the map was found from here (anchors, routes, or through callers) */
  function resolveFrom(sf: ts.SourceFile, lines: number[], unit: ts.Node | undefined, depth: number, via: CodeHop[]): boolean {
    const how: Reached['how'] = depth === 0 ? 'sure' : 'likely';
    const anchors = anchorsOf(sf);
    // a generated file says which logic it is on its first line
    const stamp = anchors.logic.find((l) => l.generated);
    // outward through the enclosing functions: the first with an anchor or a route registration answers
    for (let u: ts.Node | undefined = unit; ; u = enclosingUnit(u)) {
      const anchored = u ? anchorFor(sf, anchors, u) : stamp ?? null;
      if (anchored) {
        const steps = depth === 0 && u ? stepsFor(sf, anchors, u, lines) : depth === 0 && stamp ? stepsInFile(anchors, lines) : [];
        w.addReached({ ref: anchored.key, revision: anchored.revision, steps, via, how });
        return true;
      }
      const route = u ? routeOf(sf, u) : null;
      if (route) { w.addRoute({ ...route, via }); return true; }
      if (!u) break;
    }
    // a line inside a route registration's handler written in place (`app.get('/x', (req, res) => …)`)
    for (const line of lines) {
      const r = routeAround(sf, firstCharOf(sf, line));
      if (r) { w.addRoute({ ...r, via }); return true; }
    }
    if (depth >= w.maxDepth || !unit) return false;
    // backwards through who calls it: the innermost named function, else the next one out
    let any = false;
    for (let u: ts.Node | undefined = unit; u && !any; u = enclosingUnit(u)) {
      const name = nameNodeOf(u);
      if (!name) continue;
      const key = `${sf.fileName}:${name.getStart(sf)}`;
      const had = seen.get(key);
      if (had !== undefined) { any = had === true; continue; }
      seen.set(key, 'walking');
      const refs = service.findReferences(sf.fileName, name.getStart(sf)) ?? [];
      for (const group of refs) {
        for (const ref of group.references) {
          if (ref.isDefinition) continue;
          if (++nodes > w.maxNodes) {
            if (!w.found.notes.some((n) => n.startsWith('Stopped'))) w.found.notes.push(`Stopped following callers after ${w.maxNodes} places: the rest counts as not on the map.`);
            return any;
          }
          const rel = relOf(ref.fileName);
          if (rel.startsWith('..') || /(?:^|\/)node_modules\//.test(rel)) continue;
          if (isTestFile(rel)) { w.tests.add(rel); any = true; continue; }
          const rsf = program!.getSourceFile(ref.fileName);
          if (!rsf) continue;
          const line = rsf.getLineAndCharacterOfPosition(ref.textSpan.start).line + 1;
          const ru = unitAt(rsf, ref.textSpan.start);
          if (resolveFrom(rsf, [line], ru, depth + 1, [...via, { file: rel, line, name: nameOf(ru) }].slice(0, 8))) any = true;
        }
      }
      seen.set(key, any);
    }
    return any;
  }
}

function languageService(root: string, changed: string[], tsconfig: string | undefined, notes: string[]): ts.LanguageService {
  const cfgPath = tsconfig ? path.resolve(root, tsconfig) : undefined;
  let options: ts.CompilerOptions = { allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  let names: string[] = [];
  if (cfgPath && fs.existsSync(cfgPath) && path.resolve(cfgPath).startsWith(root)) {
    const read = ts.readConfigFile(cfgPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, path.dirname(cfgPath));
    // a solution file (references only): its projects' files
    names = parsed.fileNames;
    for (const r of parsed.projectReferences ?? []) {
      const sub = ts.getParsedCommandLineOfConfigFile(ts.resolveProjectReferencePath(r), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
      if (sub) names.push(...sub.fileNames);
    }
    options = { ...parsed.options, allowJs: true, noEmit: true, skipLibCheck: true };
  } else {
    if (!notes.some((n) => n.startsWith('No tsconfig'))) notes.push('No tsconfig.json found for some files: read the repo’s TypeScript and JavaScript files with default settings.');
    names = listCode(root);
  }
  const files = [...new Set([...names, ...changed.filter((f) => isTsLike(f))])];
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: () => '1',
    getScriptSnapshot: (f) => {
      const text = readText(f);
      return text === null ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

/** the repo's code files, when there is no tsconfig (at most 5,000) */
function listCode(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= 5000) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build' || e.name === 'coverage') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && isTsLike(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(root);
  return out;
}

const firstCharOf = (sf: ts.SourceFile, line: number) => {
  const start = sf.getLineStarts()[line - 1] ?? sf.text.length;
  const m = /\S/.exec(sf.text.slice(start, sf.getLineStarts()[line] ?? sf.text.length));
  return start + (m ? m.index : 0);
};

const isUnit = (n: ts.Node): n is Unit => ts.isFunctionLike(n) && 'body' in n || ts.isClassDeclaration(n) || ts.isClassExpression(n);

/** the innermost function, method or class around a position */
function unitAt(sf: ts.SourceFile, pos: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node) => {
    if (pos < n.getFullStart() || pos > n.getEnd()) return;
    if (isUnit(n) && pos >= n.getStart(sf)) found = n;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

function enclosingUnit(n: ts.Node | undefined): ts.Node | undefined {
  for (let p = n?.parent; p; p = p.parent) if (isUnit(p)) return p;
  return undefined;
}

/** what refers to a unit: its own name, or the variable or property it is assigned to */
function nameNodeOf(u: ts.Node): ts.Node | undefined {
  const n = (u as { name?: ts.Node }).name;
  if (n && (ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteral(n))) return n;
  const p = u.parent;
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && ts.isIdentifier(p.name)) return p.name;
  return undefined;
}

const nameOf = (u: ts.Node | undefined) => (u ? (nameNodeOf(u) as ts.Identifier | undefined)?.text ?? '(anonymous)' : '(top level)');

/** the line a statement-like node starts on: a function assigned to a variable starts at its `const` */
function statementOf(u: ts.Node): ts.Node {
  let s: ts.Node = u;
  while (s.parent && (ts.isVariableDeclaration(s.parent) || ts.isVariableDeclarationList(s.parent) || ts.isVariableStatement(s.parent) || ts.isExportAssignment(s.parent) || ts.isPropertyAssignment(s.parent) || ts.isPropertyDeclaration(s.parent))) s = s.parent;
  return s;
}

/** a logic anchor in the comment lines right above the unit (or on its first line) */
function anchorFor(sf: ts.SourceFile, a: Anchors, u: ts.Node): { key: string; revision?: number } | null {
  const s = statementOf(u);
  const fullLine = sf.getLineAndCharacterOfPosition(s.getFullStart()).line + 1;
  const start = sf.getLineAndCharacterOfPosition(s.getStart(sf)).line + 1;
  // decorators and comments sit between the full start and the start
  const hit = a.logic.filter((l) => !l.generated && l.line >= Math.min(fullLine, start - 1) && l.line <= start).sort((x, y) => y.line - x.line)[0];
  return hit ? { key: hit.key, revision: hit.revision } : null;
}

/** the step anchors inside the unit that cover the lines: each from its line to the next one's */
function stepsFor(sf: ts.SourceFile, a: Anchors, u: ts.Node, lines: number[]): string[] {
  const from = sf.getLineAndCharacterOfPosition(u.getStart(sf)).line + 1, to = sf.getLineAndCharacterOfPosition(u.getEnd()).line + 1;
  const inside = a.nodes.filter((n) => n.line >= from && n.line <= to).sort((x, y) => x.line - y.line);
  const out = new Set<string>();
  for (const line of lines) {
    const n = inside.filter((x) => x.line <= line).pop();
    if (n) out.add(n.key);
  }
  return [...out];
}

function stepsInFile(a: Anchors, lines: number[]): string[] {
  const out = new Set<string>();
  for (const line of lines) {
    const n = a.nodes.filter((x) => x.line <= line).sort((x, y) => y.line - x.line)[0];
    if (n) out.add(n.key);
  }
  return [...out];
}

const literal = (e: ts.Expression | undefined) => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined);
const joinPath = (a: string, b: string) => `/${[a, b].map((x) => x.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;

/**
 * Next.js route files: `app/orders/[id]/route.ts` exporting GET, POST … (route groups `(x)` and slots `@x` left out,
 * `[...slug]` a parameter), and `pages/api/orders/[id].ts`'s default export, which answers every method
 */
export function nextRoute(file: string, exportName: string | undefined): { method: string; path: string } | null {
  const f = file.replace(/\\/g, '/');
  const seg = (p: string) => p.split('/').filter((x) => x && !/^\(.*\)$/.test(x) && !x.startsWith('@')).map((x) => x.replace(/^\[{1,2}(?:\.\.\.)?(\w+)\]{1,2}$/, '{$1}')).join('/');
  const app = /(?:^|\/)(?:src\/)?app\/(.*?)\/?route\.[cm]?[jt]sx?$/.exec(f);
  if (app && exportName && NEXT_METHODS.has(exportName)) return { method: exportName, path: `/${seg(app[1])}`.replace(/\/$/, '') || '/' };
  const pages = /(?:^|\/)(?:src\/)?pages\/api\/(.*)\.[cm]?[jt]sx?$/.exec(f);
  if (pages && exportName === 'default') return { method: 'ALL', path: `/api/${seg(pages[1].replace(/(?:^|\/)index$/, ''))}`.replace(/\/$/, '') };
  return null;
}
const NEXT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** the name a function is exported under: `export function GET`, `export const GET = …`, `export default function` */
function exportedName(u: ts.Node): string | undefined {
  const mods = (n: ts.Node) => (ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : []);
  const isExported = (n: ts.Node) => mods(n).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  if (ts.isFunctionDeclaration(u) && isExported(u)) return mods(u).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : u.name?.text;
  if ((ts.isArrowFunction(u) || ts.isFunctionExpression(u)) && ts.isVariableDeclaration(u.parent) && ts.isIdentifier(u.parent.name)) {
    const stmt = u.parent.parent?.parent;
    if (stmt && ts.isVariableStatement(stmt) && isExported(stmt)) return u.parent.name.text;
  }
  if ((ts.isArrowFunction(u) || ts.isFunctionExpression(u)) && ts.isExportAssignment(u.parent)) return 'default';
  return undefined;
}

/** a NestJS handler: `@Get('x')` on a method of a `@Controller('prefix')` class; a Next.js route handler */
function routeOf(sf: ts.SourceFile, u: ts.Node): { method: string; path: string } | null {
  const next = nextRoute(sf.fileName, exportedName(u));
  if (next) return next;
  if (!ts.isMethodDeclaration(u)) return routeAround(sf, u.getStart(sf), u);
  for (const d of ts.getDecorators(u) ?? []) {
    if (!ts.isCallExpression(d.expression) || !ts.isIdentifier(d.expression.expression)) continue;
    const method = NEST_METHODS[d.expression.expression.text];
    if (!method) continue;
    const cls = u.parent;
    const ctl = ts.isClassDeclaration(cls) ? (ts.getDecorators(cls) ?? []).find((x) => ts.isCallExpression(x.expression) && ts.isIdentifier(x.expression.expression) && x.expression.expression.text === 'Controller') : undefined;
    const prefix = ctl && ts.isCallExpression(ctl.expression) ? literal(ctl.expression.arguments[0]) ?? '' : '';
    return { method, path: joinPath(prefix, literal(d.expression.arguments[0]) ?? '') };
  }
  return null;
}

/** `app.get('/path', …)` / `router.post('/path', …)` around a position (a handler written in place, or the unit is
 *  passed to one: `app.get('/x', handler)` is found from the reference, which sits in the call) */
function routeAround(sf: ts.SourceFile, pos: number, within?: ts.Node): { method: string; path: string } | null {
  let node: ts.Node | undefined = within ?? tokenAt(sf, pos);
  for (; node; node = node.parent) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && HTTP_METHODS.has(node.expression.name.text)) {
      const p = literal(node.arguments[0]);
      if (p !== undefined && p.startsWith('/') && node.arguments.length >= 2) return { method: node.expression.name.text.toUpperCase(), path: p };
    }
    // Fastify: `fastify.route({ method: 'GET', url: '/x', handler })` (the first method of a list)
    const opts = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'route' ? node.arguments[0] : undefined;
    if (opts && ts.isObjectLiteralExpression(opts)) {
      const prop = (name: string) => opts.properties.find((x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && x.name.text === name)?.initializer;
      const url = literal(prop('url') ?? prop('path'));
      const m = prop('method');
      const method = m && ts.isArrayLiteralExpression(m) ? literal(m.elements[0] as ts.Expression) : literal(m);
      if (url?.startsWith('/') && method) return { method: method.toUpperCase(), path: url };
    }
  }
  return null;
}

function tokenAt(sf: ts.SourceFile, pos: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node) => {
    if (pos < n.getStart(sf) || pos >= n.getEnd()) return;
    found = n;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

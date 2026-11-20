// API routes declared in code other than TypeScript/JavaScript, read from the text (no compiler): the handler a changed
// line is in, and the method and path it answers (docs/04-roadmap/code-impact-plan.md § Phase B; more frameworks
// 2026-11-07, languages-plan.md § Final scope).
//   C#      ASP.NET controllers ([Route] on the class, [HttpGet("…")] … on the method) and minimal APIs
//           (app.MapGet("…", …), MapGroup prefixes)
//   Java,   Spring (@RequestMapping on the class, @GetMapping / @RequestMapping(method = …) on the method) and JAX-RS
//   Kotlin  (@Path on the class, @GET + @Path on the method); Ktor (routing { route("/api") { get("/x") { … } } })
//   Python  FastAPI (@app.get, @router.post, APIRouter(prefix=…)), Flask (@app.route(…, methods=[…]), @bp.get,
//           Blueprint(url_prefix=…)), Django (urls.py path()/re_path(), include() prefixes, DRF router.register)
//   Go      net/http (HandleFunc, "GET /x/{id}" patterns), gorilla/mux (.Methods), gin, echo, fiber (Group), chi (Route)
//   Ruby    Rails (config/routes.rb: resources, resource, namespace, scope, get … to:) and Sinatra (get '/x' do)
//   PHP     Laravel (Route::get, prefix()->group, resource/apiResource; routes/api.php under /api) and Symfony #[Route]
//   Rust    axum (.route("/x", get(h).post(h2))), actix-web (#[get("/x")], web::resource, .to(h)) and Rocket
//   Swift   Vapor (app.get("orders", ":id"), grouped/group, use: handler)
//   Dart    shelf_router (router.get('/x', h), @Route.get) and Dart Frog (routes/…/[id].dart)
// Where a route is registered in one place and handled by a function named there (most of the newer frameworks), the
// handler carries `ref`: code impact finds the function a changed line is in (functionsIn) and the registrations that
// name it, in any file of the repo (analyze.ts). Paths come back with `{name}` parameters; the server lowercases them
// and matches parameters by position. A route that answers every method has the method ALL.
import { languageOfFile } from './from-app/languages';

export interface Handler {
  method: string;
  path: string;
  /** the function or method */
  name: string;
  /** first line of the handler (its first attribute or decorator), 1-based */
  start: number;
  /** its last line */
  end: number;
  /** the function that handles it, when the registration names one: `h.GetOrder` → { name: 'GetOrder' },
   *  `[OrderController::class, 'show']` → { owner: 'OrderController', name: 'show' }; name '*' is every method of owner */
  ref?: Ref;
}

export interface Ref { name: string; owner?: string }

const VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export function textHandlers(file: string, content: string): Handler[] {
  const lines = content.split(/\r?\n/);
  // the frameworks each reader covers: app/src/app/languages/frameworks.ts
  const f = file.replace(/\\/g, '/');
  switch (languageOfFile(file)?.id) {
    case 'csharp': return [...csharpControllers(lines), ...minimalApis(lines)];
    case 'kotlin': return [...jvmHandlers(lines), ...(/\bio\.ktor\b/.test(content) ? ktorHandlers(lines) : [])];
    case 'java': case 'groovy': case 'scala': return jvmHandlers(lines);
    case 'python': return /(?:^|\/)urls\.py$/.test(f) ? djangoHandlers(lines) : pythonHandlers(lines);
    case 'go': return goHandlers(lines);
    case 'ruby': return /(?:^|\/)routes\.rb$/.test(f) ? railsHandlers(lines) : sinatraHandlers(lines);
    case 'php': return [...laravelHandlers(lines, /(?:^|\/)routes\/api\.php$/.test(f) ? 'api' : ''), ...symfonyHandlers(lines)];
    case 'rust': return rustHandlers(lines);
    case 'swift': return /\bimport\s+Vapor\b/.test(content) ? vaporHandlers(lines) : [];
    case 'dart': return dartHandlers(f, lines);
    default: return [];
  }
}

/** the handlers a line is in (one per method it answers) */
export const handlersAt = (hs: Handler[], line: number) => hs.filter((h) => line >= h.start && line <= h.end);

// ---------- shared ----------

/** a line without its string literals and comments (for counting brackets) */
const bare = (s: string) => s.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""').replace(/\/\/.*$|#.*$/, '');
const strings = (s: string) => [...s.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g)].map((m) => m[1] ?? m[2]);
const count = (s: string, c: string) => s.split(c).length - 1;

/** `{id:int}`, `{id?}`, `{*rest}`, `<int:id>`, `<id>`, `:id` → `{id}` */
export function cleanPath(p: string) {
  return p
    .replace(/<(?:[^:<>]+:)?([^<>]+)>/g, '{$1}')
    .replace(/(^|\/):([A-Za-z_]\w*)(?=\/|$)/g, '$1{$2}')
    .replace(/\{\*{0,2}([A-Za-z_][\w]*)[^}]*\}/g, '{$1}');
}
export function joinPath(prefix: string, p: string) {
  const out = `/${[prefix, p].map((x) => x.replace(/^~?\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
  return cleanPath(out);
}

interface Decl { attrs: string; start: number; line: number; text: string }

/**
 * Declarations with the attributes/annotations/decorators written above them (`[…]` in C#, `@…` elsewhere), an
 * attribute that runs over several lines included.
 */
function declarations(lines: string[], attrStart: RegExp): Decl[] {
  const out: Decl[] = [];
  let attrs = '';
  let start = 0;
  let open = 0;
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith('//') || (t.startsWith('#') && !t.startsWith('#['))) return;
    if (open > 0 || attrStart.test(t)) {
      if (!attrs) start = i + 1;
      attrs += ` ${t}`;
      const b = bare(t);
      open += count(b, '(') - count(b, ')') + count(b, '[') - count(b, ']');
      if (open < 0) open = 0;
      // C#: `[HttpGet] public IActionResult Get()` on one line
      const after = /^\[[^\]]*\]\s*(.+)$/.exec(t);
      if (open === 0 && after && !attrStart.test(after[1]) && /\(/.test(after[1])) {
        out.push({ attrs, start, line: i + 1, text: after[1] });
        attrs = '';
      }
      return;
    }
    out.push({ attrs, start: attrs ? start : i + 1, line: i + 1, text: t });
    attrs = '';
  });
  return out;
}

/** the last line of a `{ … }` body opening at or after `from` (0-based); an expression body ends at its `;` */
function braceEnd(lines: string[], from: number): number {
  let depth = 0;
  let opened = false;
  for (let i = from; i < lines.length; i++) {
    const b = bare(lines[i]);
    if (!opened && /=>/.test(b) && !b.includes('{') && i <= from + 2) {
      for (let j = i; j < lines.length; j++) if (bare(lines[j]).includes(';')) return j + 1;
      return i + 1;
    }
    for (const c of b) {
      if (c === '{') { depth++; opened = true; }
      else if (c === '}') { depth--; if (opened && depth === 0) return i + 1; }
    }
    if (!opened && i > from + 3) return from + 1;
  }
  return lines.length;
}

const methodName = (sig: string) => /([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/.exec(sig.replace(/^(?:fun|def|async\s+def)\s+/, ''))?.[1] ?? '';

// ---------- C# ----------

function csharpControllers(lines: string[]): Handler[] {
  const out: Handler[] = [];
  const decls = declarations(lines, /^\[/);
  for (let k = 0; k < decls.length; k++) {
    const d = decls[k];
    const cls = /\bclass\s+(\w+)/.exec(d.text);
    if (!cls) continue;
    const end = braceEnd(lines, d.line - 1);
    const prefix = strings(/\[[^\]]*?\bRoute\s*\(([^)]*)\)/.exec(d.attrs)?.[1] ?? '')[0] ?? '';
    const controller = cls[1].replace(/Controller$/, '');
    for (const m of decls.slice(k + 1).filter((x) => x.line > d.line && x.line <= end && x.attrs)) {
      if (/\bclass\s/.test(m.text)) continue;
      const name = methodName(m.text);
      const route = strings(/\bRoute\s*\(([^)]*)\)/.exec(m.attrs)?.[1] ?? '')[0];
      const verbs = [...m.attrs.matchAll(/\bHttp(Get|Post|Put|Delete|Patch|Head|Options)\s*(?:\(([^)]*)\))?/g)];
      for (const v of verbs) {
        const own = strings(v[2] ?? '')[0] ?? route ?? '';
        const abs = own.startsWith('/') || own.startsWith('~/');
        const p = (abs ? own : joinPath(prefix, own)).replace(/\[controller\]/gi, controller).replace(/\[action\]/gi, name);
        out.push({ method: v[1].toUpperCase(), path: joinPath('', p), name: `${cls[1]}.${name}`, start: m.start, end: braceEnd(lines, m.line - 1) });
      }
    }
  }
  return out;
}

/** `app.MapGet("/orders/{id}", …)`, and groups: `var g = app.MapGroup("/api"); g.MapPost("/orders", …)` */
function minimalApis(lines: string[]): Handler[] {
  const groups = new Map<string, string>();
  const out: Handler[] = [];
  lines.forEach((raw, i) => {
    const g = /(\w+)\s*=\s*(\w+)\s*\.\s*MapGroup\s*\(\s*"([^"]*)"/.exec(raw);
    if (g) groups.set(g[1], joinPath(groups.get(g[2]) ?? '', g[3]));
    for (const m of raw.matchAll(/(\w+)\s*\.\s*Map(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]*)"/g)) {
      // the call's end: where its parentheses close
      let depth = 0;
      let end = i;
      for (let j = i; j < lines.length; j++) {
        const b = bare(j === i ? lines[j].slice(m.index) : lines[j]);
        depth += count(b, '(') - count(b, ')');
        end = j;
        if (depth <= 0) break;
      }
      out.push({ method: m[2].toUpperCase(), path: joinPath(groups.get(m[1]) ?? '', m[3]), name: `Map${m[2]} ${m[3]}`, start: i + 1, end: end + 1 });
    }
  });
  return out;
}

// ---------- Java / Kotlin: Spring and JAX-RS ----------

function annotationArgs(attrs: string, name: string): string | null {
  const m = new RegExp(`@${name}\\b\\s*(\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\))?`).exec(attrs);
  return m ? (m[2] ?? '') : null;
}
/** the path of a mapping annotation: its first string (`value =`, `path =` or alone) */
const pathOf = (args: string | null) => (args === null ? null : (strings(/(?:value|path)\s*=\s*\{?\s*("[^"]*"|'[^']*')/.exec(args)?.[1] ?? args)[0] ?? ''));

function jvmHandlers(lines: string[]): Handler[] {
  const out: Handler[] = [];
  const decls = declarations(lines, /^@/);
  for (let k = 0; k < decls.length; k++) {
    const d = decls[k];
    const cls = /\b(?:class|interface|object)\s+(\w+)/.exec(d.text);
    if (!cls) continue;
    // a Feign client's mappings are the calls it makes (calls-text.ts), not routes this system answers
    if (/@FeignClient\b/.test(d.attrs)) continue;
    const end = braceEnd(lines, d.line - 1);
    const prefix = pathOf(annotationArgs(d.attrs, 'RequestMapping')) ?? pathOf(annotationArgs(d.attrs, 'Path')) ?? '';
    for (const m of decls.slice(k + 1).filter((x) => x.line > d.line && x.line <= end && x.attrs)) {
      if (/\b(?:class|interface|object)\s/.test(m.text)) continue;
      const name = `${cls[1]}.${methodName(m.text)}`;
      const body = braceEnd(lines, m.line - 1);
      const hits: { method: string; path: string }[] = [];
      for (const v of ['Get', 'Post', 'Put', 'Delete', 'Patch']) {
        const p = pathOf(annotationArgs(m.attrs, `${v}Mapping`));
        if (p !== null) hits.push({ method: v.toUpperCase(), path: p });
      }
      const rm = annotationArgs(m.attrs, 'RequestMapping');
      if (rm !== null) {
        const verbs = [...rm.matchAll(/RequestMethod\.(\w+)/g)].map((x) => x[1].toUpperCase());
        for (const v of verbs.length ? verbs : ['GET']) hits.push({ method: v, path: pathOf(rm) ?? '' });
      }
      // JAX-RS: @GET … with an optional @Path
      for (const v of VERBS) if (new RegExp(`@${v}\\b(?!\\w)`).test(m.attrs)) hits.push({ method: v, path: pathOf(annotationArgs(m.attrs, 'Path')) ?? '' });
      for (const h of hits) out.push({ method: h.method, path: joinPath(prefix, h.path), name, start: m.start, end: body });
    }
  }
  return out;
}

// ---------- Python: FastAPI and Flask ----------

function pythonHandlers(lines: string[]): Handler[] {
  // router / blueprint prefixes in this file
  const prefixes = new Map<string, string>();
  for (const raw of lines) {
    const r = /^\s*(\w+)\s*(?::[^=]+)?=\s*(?:\w+\.)?(APIRouter|Blueprint)\s*\((.*)\)\s*$/.exec(raw);
    if (r) prefixes.set(r[1], strings(/(?:prefix|url_prefix)\s*=\s*("[^"]*"|'[^']*')/.exec(r[3])?.[1] ?? '')[0] ?? '');
  }
  const out: Handler[] = [];
  for (const d of declarations(lines, /^@/)) {
    const def = /^(?:async\s+)?def\s+(\w+)/.exec(d.text);
    if (!def || !d.attrs) continue;
    const indent = lines[d.line - 1].search(/\S/);
    let end = d.line;
    for (let j = d.line; j < lines.length; j++) {
      const t = lines[j];
      if (!t.trim()) continue;
      if (t.search(/\S/) <= indent) break;
      end = j + 1;
    }
    for (const m of d.attrs.matchAll(/@(\w+)\.(get|post|put|delete|patch|route|api_route)\s*\(([^)]*(?:\[[^\]]*\][^)]*)?)\)/g)) {
      const path = strings(m[3])[0] ?? '';
      const listed = /methods\s*=\s*\[([^\]]*)\]/.exec(m[3]);
      const verbs = m[2] === 'route' || m[2] === 'api_route' ? (listed ? strings(listed[1]).map((x) => x.toUpperCase()) : ['GET']) : [m[2].toUpperCase()];
      for (const v of verbs) out.push({ method: v, path: joinPath(prefixes.get(m[1]) ?? '', path), name: def[1], start: d.start, end });
    }
  }
  return out;
}


// ---------- registrations: a method, a path and the function that handles it ----------

const last = (s: string, sep: RegExp = /[.:\\]+/) => s.split(sep).filter(Boolean).pop() ?? s;
const KEYWORDS = new Set(['func', 'function', 'fn', 'nil', 'null', 'None', 'true', 'false', 'self', 'this', 'async', 'move', 'new', 'return', 'await']);

/** the function a registration's handler argument names (see Handler.ref), or undefined for one written in place */
export function refOf(arg: string): Ref | undefined {
  let m = /^\s*\[\s*\\?([\w\\]+)::class\s*,\s*['"](\w+)['"]\s*\]/.exec(arg);
  if (m) return { owner: last(m[1]), name: m[2] };
  m = /^\s*['"]([\w\\]+)@(\w+)['"]/.exec(arg);
  if (m) return { owner: last(m[1]), name: m[2] };
  m = /^\s*([A-Za-z_][\w.]*)\.as_view\s*\(/.exec(arg);
  if (m) return { owner: last(m[1]), name: '*' };
  m = /^\s*\\?([\w\\]+)::class\b/.exec(arg);
  if (m) return { owner: last(m[1]), name: '__invoke' };
  m = /^\s*(?:use:\s*)?&?(?:self\.)?([A-Za-z_]\w*(?:(?:\.|::)[A-Za-z_]\w*)*)/.exec(arg);
  if (!m) return undefined;
  const name = last(m[1]);
  return KEYWORDS.has(m[1]) || KEYWORDS.has(name) ? undefined : { name };
}

/** the 0-based line where a call opened on line i at column col closes */
function callEnd(lines: string[], i: number, col = 0): number {
  let depth = 0;
  for (let j = i; j < lines.length; j++) {
    const b = bare(j === i ? lines[j].slice(col) : lines[j]);
    depth += count(b, '(') - count(b, ')');
    if (depth <= 0) return j;
  }
  return i;
}

/** a registration on line i: the handler written in place (its body is the handler) or named (`ref`) */
function registered(lines: string[], i: number, col: number, method: string, path: string, rest: string, label: string): Handler {
  const inline = /^\s*(?:func\s*\(|async\s*(?:\(|\{|move)|\([^()]*(?:\([^()]*\)[^()]*)*\)\s*(?:async\s*)?(?:=>|\{|->)|\{|function\s*\(|fn\s*\(|\|[^|]*\|)/.test(rest);
  const ref = inline ? undefined : refOf(rest);
  const end = inline ? braceEnd(lines, i) : callEnd(lines, i, col) + 1;
  return { method, path: joinPath('', path), name: ref ? (ref.owner ? `${ref.owner}.${ref.name}` : ref.name) : label, start: i + 1, end, ...(ref ? { ref } : {}) };
}

/** prefixes opened by a block (`r.Route("/api", func(r chi.Router) {`, `route("/api") {`, `->group(function () {`):
 *  the prefix in force on each line, by brace depth */
function blockPrefixes(lines: string[], opens: (raw: string, inForce: string) => string | null): string[] {
  const stack: { prefix: string; depth: number }[] = [];
  let depth = 0;
  return lines.map((raw) => {
    while (stack.length && depth < stack[stack.length - 1].depth) stack.pop();
    const inForce = stack.length ? stack[stack.length - 1].prefix : '';
    const b = bare(raw);
    const p = opens(raw, inForce);
    const before = depth;
    depth += count(b, '{') - count(b, '}');
    if (p !== null && depth > before) stack.push({ prefix: p, depth });
    return inForce;
  });
}

// ---------- Go: net/http, gorilla/mux, gin, echo, fiber, chi ----------

const GO_VERB: Record<string, string> = { GET: 'GET', POST: 'POST', PUT: 'PUT', DELETE: 'DELETE', PATCH: 'PATCH', HEAD: 'HEAD', OPTIONS: 'OPTIONS', Any: 'ALL', All: 'ALL', Get: 'GET', Post: 'POST', Put: 'PUT', Delete: 'DELETE', Patch: 'PATCH', Head: 'HEAD', Options: 'OPTIONS' };

function goHandlers(lines: string[]): Handler[] {
  const groups = new Map<string, string>();
  const out: Handler[] = [];
  const inForce = blockPrefixes(lines, (raw, cur) => {
    const r = /\b\w+\.Route\(\s*"([^"]*)"\s*,\s*func\b/.exec(raw);
    return r ? joinPath(cur, r[1]) : null;
  });
  lines.forEach((raw, i) => {
    const code = raw.replace(/\/\/.*$/, '');
    const g = /(\w+)\s*:?=\s*(\w+)\.Group\(\s*"([^"]*)"/.exec(code);
    if (g) groups.set(g[1], joinPath(groups.get(g[2]) ?? inForce[i], g[3]));
    const prefixOf = (v: string) => groups.get(v) ?? inForce[i];
    for (const m of code.matchAll(/\b(\w+)\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|All|Get|Post|Put|Delete|Patch|Head|Options)\(\s*"(\/[^"]*)"\s*,/g)) {
      out.push(registered(lines, i, m.index!, GO_VERB[m[2]], joinPath(prefixOf(m[1]), m[3]), code.slice(m.index! + m[0].length), `${m[2]} ${m[3]}`));
    }
    for (const m of code.matchAll(/\b(\w+)\.(?:HandleFunc|Handle)\(\s*"(?:([A-Z]+)\s+)?((?:[\w.-]+)?\/[^"]*)"\s*,/g)) {
      const path = m[3].replace(/^[\w.-]+(?=\/)/, '');
      const listed = /\.Methods\(([^)]*)\)/.exec(code.slice(m.index!));
      const verbs = m[2] ? [m[2]] : listed ? strings(listed[1]).map((x) => x.toUpperCase()) : ['ALL'];
      for (const v of verbs) out.push(registered(lines, i, m.index!, v, joinPath(prefixOf(m[1]), path), code.slice(m.index! + m[0].length), `HandleFunc ${m[3]}`));
    }
  });
  return out;
}

// ---------- Ruby: Rails routes.rb and Sinatra ----------

const camel = (s: string) => s.split(/[_/]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const singular = (s: string) => s.replace(/ies$/, 'y').replace(/(?:ss|x|ch|sh)es$/, (m) => m.slice(0, -2)).replace(/(?<!s)s$/, '');
const RAILS_ACTIONS: Record<string, [string, string][]> = {
  index: [['GET', '']], create: [['POST', '']], new: [['GET', 'new']], show: [['GET', ':id']], edit: [['GET', ':id/edit']],
  update: [['PATCH', ':id'], ['PUT', ':id']], destroy: [['DELETE', ':id']],
};
const symbols = (s: string | undefined) => (s ? [...s.matchAll(/:(\w+)|['"](\w+)['"]/g)].map((m) => m[1] ?? m[2]) : []);

/** a Ruby line without its comment: a `#` outside quotes (not `#{`) */
function rubyCode(line: string): string {
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = ''; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '#' && line[i + 1] !== '{') return line.slice(0, i);
  }
  return line;
}

function railsHandlers(lines: string[]): Handler[] {
  const out: Handler[] = [];
  const stack: { path: string; module: string; member?: string }[] = [{ path: '', module: '' }];
  const top = () => stack[stack.length - 1];
  lines.forEach((raw, i) => {
    const t = rubyCode(raw).trim();
    if (!t) return;
    if (/^end\b/.test(t)) { if (stack.length > 1) stack.pop(); return; }
    const opens = /\bdo(?:\s*\|[^|]*\|)?\s*$/.test(t);
    const cur = top();
    const ns = /^namespace\s+:(\w+)/.exec(t);
    if (ns) { if (opens) stack.push({ path: joinPath(cur.path, ns[1]), module: `${cur.module}${camel(ns[1])}::` }); return; }
    const sc = /^scope\s*\(?\s*(?:['"]([^'"]*)['"]|path:\s*['"]([^'"]*)['"])?(?:.*?module:\s*:?['"]?(\w+))?/.exec(t);
    if (/^scope\b/.test(t) && sc) { if (opens) stack.push({ path: joinPath(cur.path, sc[1] ?? sc[2] ?? ''), module: sc[3] ? `${cur.module}${camel(sc[3])}::` : cur.module }); return; }
    const res = /^(resources|resource)\s+:(\w+)(.*)$/.exec(t);
    if (res) {
      const plural = res[1] === 'resources';
      // `resource :profile` is answered by ProfilesController too
      const ctl = `${cur.module}${camel(plural || res[2].endsWith('s') ? res[2] : `${res[2]}s`)}Controller`;
      const only = symbols(/only:\s*(\[[^\]]*\]|:\w+)/.exec(res[3])?.[1]);
      const except = symbols(/except:\s*(\[[^\]]*\]|:\w+)/.exec(res[3])?.[1]);
      const base = joinPath(cur.path, res[2]);
      for (const [action, routes] of Object.entries(RAILS_ACTIONS)) {
        if ((only.length && !only.includes(action)) || except.includes(action) || (!plural && action === 'index')) continue;
        for (const [method, sub] of routes) {
          const p = plural ? sub : sub.replace(/^:id\/?/, '');
          out.push({ method, path: joinPath(base, p), name: `${last(ctl)}#${action}`, start: i + 1, end: i + 1, ref: { owner: last(ctl), name: action } });
        }
      }
      if (opens) stack.push({ path: plural ? joinPath(base, `:${singular(res[2])}_id`) : base, module: cur.module, member: plural ? base : undefined });
      return;
    }
    const verb = /^(get|post|put|patch|delete|match|root)\b\s*\(?\s*(?:['"]([^'"]*)['"])?(.*)$/.exec(t);
    if (verb) {
      const to = /(?:to:\s*|=>\s*)['"]([\w/]+)#(\w+)['"]/.exec(t) ?? (verb[1] === 'root' ? /['"]([\w/]+)#(\w+)['"]/.exec(t) : null);
      const path = verb[1] === 'root' ? '' : (verb[2] ?? '');
      const via = verb[1] === 'match' ? symbols(/via:\s*(\[[^\]]*\]|:\w+)/.exec(t)?.[1]).map((x) => (x === 'all' ? 'ALL' : x.toUpperCase())) : [verb[1] === 'root' ? 'GET' : verb[1].toUpperCase()];
      if (to) {
        const owner = `${camel(last(to[1], /\//))}Controller`;
        for (const method of via.length ? via : ['ALL']) out.push({ method, path: joinPath(cur.path, path), name: `${owner}#${to[2]}`, start: i + 1, end: i + 1, ref: { owner, name: to[2] } });
      }
      if (opens) stack.push({ ...cur });
      return;
    }
    if (opens) stack.push({ ...cur });
  });
  return out;
}

function sinatraHandlers(lines: string[]): Handler[] {
  const out: Handler[] = [];
  lines.forEach((raw, i) => {
    const m = /^(\s*)(get|post|put|patch|delete|options)\s*\(?\s*['"](\/[^'"]*)['"]\s*\)?\s*do\b/.exec(raw);
    if (!m) return;
    const end = rubyEnd(lines, i, m[1].length);
    out.push({ method: m[2].toUpperCase(), path: joinPath('', m[3]), name: `${m[2]} ${m[3]}`, start: i + 1, end });
  });
  return out;
}

/** the 1-based line of the `end` that closes a block opened on line i at this indent */
function rubyEnd(lines: string[], i: number, indent: number): number {
  for (let j = i + 1; j < lines.length; j++) if (/^\s*end\b/.test(lines[j]) && lines[j].search(/\S/) <= indent) return j + 1;
  return lines.length;
}

// ---------- PHP: Laravel and Symfony ----------

function laravelHandlers(lines: string[], base: string): Handler[] {
  const out: Handler[] = [];
  const inForce = blockPrefixes(lines, (raw, cur) => {
    const g = /Route::(?:prefix\(\s*['"]([^'"]*)['"]\s*\)|group\(\s*\[\s*['"]prefix['"]\s*=>\s*['"]([^'"]*)['"])[^;]*?function\s*\(/.exec(raw);
    return g ? joinPath(cur, g[1] ?? g[2] ?? '') : /Route::\w+\([^;]*->group\(\s*function\s*\(/.test(raw) ? cur : null;
  });
  lines.forEach((raw, i) => {
    const prefix = joinPath(base, inForce[i]);
    for (const m of raw.matchAll(/Route::(get|post|put|patch|delete|options|any)\(\s*['"]([^'"]*)['"]\s*,\s*/g)) {
      out.push(registered(lines, i, m.index!, m[1] === 'any' ? 'ALL' : m[1].toUpperCase(), joinPath(prefix, m[2]), raw.slice(m.index! + m[0].length), `Route::${m[1]} ${m[2]}`));
    }
    for (const m of raw.matchAll(/Route::match\(\s*\[([^\]]*)\]\s*,\s*['"]([^'"]*)['"]\s*,\s*/g)) {
      for (const v of strings(m[1])) out.push(registered(lines, i, m.index!, v.toUpperCase(), joinPath(prefix, m[2]), raw.slice(m.index! + m[0].length), `Route::match ${m[2]}`));
    }
    const res = /Route::(apiResource|resource)\(\s*['"]([^'"]*)['"]\s*,\s*\\?([\w\\]+)::class\s*\)(.*)$/.exec(raw);
    if (res) {
      const owner = last(res[3]);
      const only = /->only\(\s*\[([^\]]*)\]/.exec(res[4]);
      const except = /->except\(\s*\[([^\]]*)\]/.exec(res[4]);
      const param = `{${singular(last(res[2], /[./]/))}}`;
      const actions: [string, string, string][] = [['index', 'GET', ''], ['store', 'POST', ''], ['show', 'GET', param], ['update', 'PUT', param], ['update', 'PATCH', param], ['destroy', 'DELETE', param]];
      if (res[1] === 'resource') actions.push(['create', 'GET', 'create'], ['edit', 'GET', `${param}/edit`]);
      for (const [action, method, sub] of actions) {
        if ((only && !strings(only[1]).includes(action)) || (except && strings(except[1]).includes(action))) continue;
        out.push({ method, path: joinPath(joinPath(prefix, res[2].replace(/\./g, '/')), sub), name: `${owner}.${action}`, start: i + 1, end: i + 1, ref: { owner, name: action } });
      }
    }
  });
  return out;
}

function symfonyHandlers(lines: string[]): Handler[] {
  const out: Handler[] = [];
  const routeOf = (attrs: string) => /#\[Route\(\s*(?:path:\s*)?['"]([^'"]*)['"](.*?)\)\]/.exec(attrs);
  const decls = declarations(lines, /^#\[/);
  for (let k = 0; k < decls.length; k++) {
    const d = decls[k];
    const cls = /\bclass\s+(\w+)/.exec(d.text);
    if (!cls) continue;
    const end = braceEnd(lines, d.line - 1);
    const prefix = routeOf(d.attrs)?.[1] ?? '';
    for (const m of decls.slice(k + 1).filter((x) => x.line > d.line && x.line <= end && x.attrs)) {
      const fn = /\bfunction\s+(\w+)\s*\(/.exec(m.text);
      const r = routeOf(m.attrs);
      if (!fn || !r) continue;
      const methods = /methods:\s*\[([^\]]*)\]|methods:\s*['"](\w+)['"]/.exec(r[2]);
      const verbs = methods ? (methods[2] ? [methods[2]] : strings(methods[1])).map((x) => x.toUpperCase()) : ['ALL'];
      for (const v of verbs) out.push({ method: v, path: joinPath(prefix, r[1]), name: `${cls[1]}.${fn[1]}`, start: m.start, end: braceEnd(lines, m.line - 1) });
    }
  }
  return out;
}

// ---------- Rust: axum, actix-web, Rocket ----------

function rustHandlers(lines: string[]): Handler[] {
  const out: Handler[] = [];
  // attribute macros on the handler: #[get("/x")] (actix, Rocket), #[route("/x", method = "GET", method = "POST")]
  for (const d of declarations(lines, /^#\[/)) {
    const fn = /\bfn\s+(\w+)/.exec(d.text);
    if (!fn || !d.attrs) continue;
    for (const m of d.attrs.matchAll(/#\[(?:actix_web::|rocket::)?(get|post|put|patch|delete|head|options|route)\(\s*"([^"]*)"([^\]]*)\)\]/g)) {
      const verbs = m[1] === 'route' ? [...m[3].matchAll(/method\s*=\s*"(\w+)"/g)].map((x) => x[1].toUpperCase()) : [m[1].toUpperCase()];
      for (const v of verbs.length ? verbs : ['ALL']) out.push({ method: v, path: joinPath('', m[2].replace(/<(\w+)(?:\.\.)?>/g, '{$1}')), name: fn[1], start: d.start, end: braceEnd(lines, d.line - 1) });
    }
  }
  lines.forEach((raw, i) => {
    // axum `.route("/x", get(a).post(b))`, actix `.route("/x", web::get().to(a))`, `web::resource("/x").route(web::post().to(b))`
    for (const m of raw.matchAll(/\.route\(\s*"([^"]*)"\s*,|web::resource\(\s*"([^"]*)"\s*\)/g)) {
      const to = callEnd(lines, i, m.index! + 1);
      const text = [raw.slice(m.index!), ...lines.slice(i + 1, Math.max(to, i) + 1)].join(' ');
      const path = m[1] ?? m[2];
      for (const h of text.matchAll(/(?<![\w:])(get|post|put|patch|delete|head|options|any)\(\s*([A-Za-z_][\w:]*)\s*\)/g)) {
        out.push({ method: h[1] === 'any' ? 'ALL' : h[1].toUpperCase(), path: joinPath('', path), name: last(h[2]), start: i + 1, end: to + 1, ref: { name: last(h[2]) } });
      }
      for (const h of text.matchAll(/web::(get|post|put|patch|delete|head)\(\)\s*\.to\(\s*([A-Za-z_][\w:]*)\s*\)/g)) {
        out.push({ method: h[1].toUpperCase(), path: joinPath('', path), name: last(h[2]), start: i + 1, end: to + 1, ref: { name: last(h[2]) } });
      }
    }
  });
  return out;
}

// ---------- Swift: Vapor ----------

/** Vapor path components: "orders", ":id", .catchall, .parameter("id") → orders/{id} */
const vaporPath = (args: string) => [...args.matchAll(/"([^"]*)"|\.parameter\(\s*"(\w+)"\s*\)|\.(catchall|anything)\b/g)]
  .map((m) => m[1] ?? (m[2] ? `:${m[2]}` : '**')).join('/');

function vaporHandlers(lines: string[]): Handler[] {
  const groups = new Map<string, string>();
  const out: Handler[] = [];
  lines.forEach((raw, i) => {
    const code = raw.replace(/\/\/.*$/, '');
    const g = /(\w+)\s*=\s*(\w+)\.grouped\(([^)]*)\)/.exec(code);
    if (g) groups.set(g[1], joinPath(groups.get(g[2]) ?? '', vaporPath(g[3])));
    const gc = /(\w+)\.group\(([^)]*)\)\s*\{\s*(\w+)\s+in/.exec(code);
    if (gc) groups.set(gc[3], joinPath(groups.get(gc[1]) ?? '', vaporPath(gc[2])));
    for (const m of code.matchAll(/\b(\w+)\.(get|post|put|patch|delete|on)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
      let args = m[3];
      let method = m[2].toUpperCase();
      if (m[2] === 'on') {
        const v = /^\s*\.(\w+)\s*,?/.exec(args);
        if (!v) continue;
        method = v[1].toUpperCase();
        args = args.slice(v[0].length);
      }
      const use = /\buse:\s*([\w.]+(?:\(\))?(?:\.\w+)*)/.exec(args);
      if (!use && !/^\s*\{/.test(code.slice(m.index! + m[0].length))) continue;
      const path = joinPath(groups.get(m[1]) ?? '', vaporPath(use ? args.slice(0, use.index) : args));
      out.push(use ? { method, path, name: last(use[1]), start: i + 1, end: i + 1, ref: { name: last(use[1]) } } : { method, path, name: `${m[2]} ${path}`, start: i + 1, end: braceEnd(lines, i) });
    }
  });
  return out;
}

// ---------- Dart: shelf_router and Dart Frog ----------

function dartHandlers(file: string, lines: string[]): Handler[] {
  const out: Handler[] = [];
  // Dart Frog: the file is the route (routes/orders/[id].dart → /orders/{id}); onRequest answers every method
  const frog = /(?:^|\/)routes\/(.+)\.dart$/.exec(file);
  if (frog && lines.some((l) => /\bonRequest\s*\(/.test(l))) {
    const p = frog[1].replace(/(?:^|\/)index$/, '').replace(/\[(\w+)\]/g, '{$1}').replace(/^_middleware$/, '');
    if (!/_middleware$/.test(frog[1])) out.push({ method: 'ALL', path: joinPath('', p), name: 'onRequest', start: 1, end: lines.length });
  }
  lines.forEach((raw, i) => {
    const code = raw.replace(/\/\/.*$/, '');
    // `router.get(…)`, and the cascade `..get(…)` under `Router()`
    for (const m of code.matchAll(/(?:\b(\w+)|\.)\.(get|post|put|patch|delete|head|options|all)\(\s*'(\/[^']*)'\s*,\s*/g)) {
      out.push(registered(lines, i, m.index!, m[2] === 'all' ? 'ALL' : m[2].toUpperCase(), m[3], code.slice(m.index! + m[0].length), `${m[2]} ${m[3]}`));
    }
  });
  // shelf_router's generator: @Route.get('/x') on a method
  for (const d of declarations(lines, /^@/)) {
    const r = /@Route\.(get|post|put|patch|delete|head|options|all)\(\s*'([^']*)'\s*\)/.exec(d.attrs);
    const fn = /(\w+)\s*\(/.exec(d.text);
    if (r && fn) out.push({ method: r[1] === 'all' ? 'ALL' : r[1].toUpperCase(), path: joinPath('', r[2]), name: fn[1], start: d.start, end: braceEnd(lines, d.line - 1) });
  }
  return out;
}

// ---------- Kotlin: Ktor ----------

function ktorHandlers(lines: string[]): Handler[] {
  const out: Handler[] = [];
  const inForce = blockPrefixes(lines, (raw, cur) => {
    const r = /\broute\(\s*"([^"]*)"\s*(?:,\s*HttpMethod\.\w+\s*)?\)\s*\{/.exec(raw);
    return r ? joinPath(cur, r[1]) : null;
  });
  lines.forEach((raw, i) => {
    const code = raw.replace(/\/\/.*$/, '');
    const m = /(?<![\w.])(get|post|put|patch|delete|head|options)\s*(?:\(\s*"([^"]*)"\s*\))?\s*\{/.exec(code);
    const viaRoute = /\broute\(\s*"([^"]*)"\s*,\s*HttpMethod\.(\w+)\s*\)\s*\{/.exec(code);
    if (m) out.push({ method: m[1].toUpperCase(), path: joinPath(inForce[i], m[2] ?? ''), name: `${m[1]} ${joinPath(inForce[i], m[2] ?? '')}`, start: i + 1, end: braceEnd(lines, i) });
    else if (viaRoute) out.push({ method: viaRoute[2].toUpperCase(), path: joinPath(inForce[i], viaRoute[1]), name: `route ${viaRoute[1]}`, start: i + 1, end: braceEnd(lines, i) });
  });
  return out;
}

// ---------- Python: Django urls.py ----------

/** `re_path(r'^orders/(?P<pk>\d+)/$')` → orders/{pk} */
const djangoRe = (p: string) => p.replace(/^\^/, '').replace(/\$$/, '').replace(/\(\?P<(\w+)>[^)]*\)/g, '{$1}').replace(/\\/g, '');

function djangoHandlers(lines: string[]): Handler[] {
  const out: Handler[] = [];
  const routers = new Map<string, string>();
  for (const raw of lines) {
    const inc = /\b(?:re_)?path\(\s*r?['"]([^'"]*)['"]\s*,\s*include\(\s*(\w+)\.urls\b/.exec(raw);
    if (inc) routers.set(inc[2], djangoRe(inc[1]));
  }
  lines.forEach((raw, i) => {
    const code = raw.replace(/#.*$/, '');
    const m = /\b(re_)?path\(\s*r?['"]([^'"]*)['"]\s*,(?!\s*include\()\s*([^,)]+(?:\([^)]*\))?)/.exec(code);
    if (m) {
      const ref = refOf(m[3]);
      if (ref) out.push({ method: 'ALL', path: joinPath('', m[1] ? djangoRe(m[2]) : m[2]), name: ref.owner ? `${ref.owner}.${ref.name}` : ref.name, start: i + 1, end: callEnd(lines, i, m.index!) + 1, ref });
    }
    const reg = /\b(\w+)\.register\(\s*r?['"]([^'"]*)['"]\s*,\s*(\w+)/.exec(code);
    if (reg) {
      const base = joinPath(routers.get(reg[1]) ?? '', reg[2]);
      const actions: [string, string, string][] = [['list', 'GET', ''], ['create', 'POST', ''], ['retrieve', 'GET', '{pk}'], ['update', 'PUT', '{pk}'], ['partial_update', 'PATCH', '{pk}'], ['destroy', 'DELETE', '{pk}']];
      for (const [action, method, sub] of actions) out.push({ method, path: joinPath(base, sub), name: `${reg[3]}.${action}`, start: i + 1, end: i + 1, ref: { owner: reg[3], name: action } });
    }
  });
  return out;
}

/** Django's `path('api/', include('orders.urls'))`: the prefix another urls module is mounted under */
export function textIncludes(file: string, content: string): { prefix: string; module: string }[] {
  if (!/(?:^|\/)urls\.py$/.test(file.replace(/\\/g, '/'))) return [];
  return [...content.matchAll(/\b(re_)?path\(\s*r?['"]([^'"]*)['"]\s*,\s*include\(\s*(?:\(\s*)?['"]([\w.]+)['"]/g)].map((m) => ({ prefix: m[1] ? djangoRe(m[2]) : m[2], module: m[3] }));
}

// ---------- the functions in a file, for the handler a changed line is in ----------

export interface Fn { name: string; owner?: string; start: number; end: number }

const JVM_METHOD = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|static|final|async|override|virtual|abstract|synchronized|sealed|default)\s+)+(?:<[^>]*>\s*)?[\w.]+(?:<[^()]*>)?(?:\[\])*\??\s+()(\w+)\s*\(/;
const BRACE_FN: Partial<Record<string, RegExp>> = {
  typescript: /^\s*(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*(?:function\s*\*?\s*()(\w+)\s*[<(]|(?:const|let|var)\s+()(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|\w+\s*=>)|()(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)?[^;=]*\{\s*$)/,
  java: JVM_METHOD,
  csharp: JVM_METHOD,
  go: /^\s*func\s+(?:\(\s*\w*\s*\*?\s*(\w+)[^)]*\)\s*)?(\w+)\s*[([]/,
  rust: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+()(\w+)/,
  swift: /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|fileprivate|internal|open|static|class|final|override|mutating|nonisolated)\s+)*func\s+()(\w+)/,
  kotlin: /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|override|suspend|inline|open|abstract|operator|infix|tailrec)\s+)*fun\s+(?:<[^>]*>\s*)?(?:([\w.]+)\.)?(\w+)\s*\(/,
  php: /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+()(\w+)\s*\(/,
  dart: /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:static|final|external)\s+)*(?:(?:Future|FutureOr|Stream)(?:<.*>)?|[A-Z]\w*(?:<.*>)?\??|void|int|bool|String|double|dynamic)\s+()(\w+)\s*\(/,
};
const OWNER: Partial<Record<string, RegExp>> = {
  typescript: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/,
  java: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial)\s+)*(?:class|interface|record|struct|enum)\s+(\w+)/,
  csharp: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial)\s+)*(?:class|interface|record|struct|enum)\s+(\w+)/,
  rust: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([\w:]+)/,
  swift: /^\s*(?:(?:public|private|fileprivate|internal|open|final)\s+)*(?:class|struct|extension|enum|actor)\s+(\w+)/,
  kotlin: /^\s*(?:(?:public|private|internal|open|abstract|data|sealed|inner)\s+)*(?:class|object|interface)\s+(\w+)/,
  php: /^\s*(?:(?:abstract|final|readonly)\s+)*class\s+(\w+)/,
  dart: /^\s*(?:abstract\s+)?(?:class|mixin|extension)\s+(\w+)/,
};

/** the named functions and methods of a file, with the type they belong to */
export function functionsIn(file: string, content: string): Fn[] {
  const lines = content.split(/\r?\n/);
  const lang = languageOfFile(file)?.id ?? '';
  const out: Fn[] = [];
  if (lang === 'python' || lang === 'ruby') {
    const def = lang === 'python' ? /^(\s*)(?:async\s+)?def\s+(\w+)/ : /^(\s*)def\s+(?:self\.)?(\w+[?!]?)/;
    const cls = lang === 'python' ? /^(\s*)class\s+(\w+)/ : /^(\s*)class\s+([\w:]+)/;
    const classes: { name: string; indent: number; end: number }[] = [];
    const endOf = (i: number, indent: number) => {
      if (lang === 'ruby') return rubyEnd(lines, i, indent);
      let end = i + 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        if (lines[j].search(/\S/) <= indent) break;
        end = j + 1;
      }
      return end;
    };
    lines.forEach((raw, i) => {
      const c = cls.exec(raw);
      if (c) classes.push({ name: last(c[2]), indent: c[1].length, end: endOf(i, c[1].length) });
      const d = def.exec(raw);
      if (!d) return;
      const owner = classes.filter((k) => k.indent < d[1].length && k.end > i).pop();
      out.push({ name: d[2], ...(owner ? { owner: owner.name } : {}), start: i + 1, end: endOf(i, d[1].length) });
    });
    return out;
  }
  const re = BRACE_FN[lang === 'javascript' ? 'typescript' : lang];
  if (!re) return out;
  const owners: { name: string; start: number; end: number }[] = [];
  lines.forEach((raw, i) => {
    const o = OWNER[lang === 'javascript' ? 'typescript' : lang]?.exec(raw);
    if (o && /\{/.test(bare(lines.slice(i, i + 3).join(' ')))) owners.push({ name: last(o[1]), start: i + 1, end: braceEnd(lines, i) });
    const f = re.exec(raw);
    if (!f || /^\s*(?:if|for|while|switch|return|else|catch|await|new|throw)\b/.test(raw)) return;
    const end = braceEnd(lines, i);
    if (end === i + 1 && !/\{|=>/.test(bare(raw))) return;
    // the TypeScript pattern has three forms, each with its own (owner, name) pair of groups
    const name = f[2] ?? f[4] ?? f[6];
    if (!name) return;
    const owner = f[1] || owners.filter((k) => k.start <= i + 1 && k.end > i + 1).pop()?.name;
    out.push({ name, ...(owner ? { owner: last(owner) } : {}), start: i + 1, end });
  });
  return out;
}

/** the innermost function a line is in */
export const functionAt = (fns: Fn[], line: number) => fns.filter((f) => line >= f.start && line <= f.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];

/** whether a registration's handler is this function */
export const refMatches = (ref: Ref, fn: Fn) => (ref.name === '*' || ref.name === fn.name) && (!ref.owner || ref.owner === fn.owner);

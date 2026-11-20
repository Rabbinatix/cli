// The API calls an app's code makes, read from the text (languages-plan.md § Final scope, step 2): the method and path
// of each call, and the lines it spans, so code impact can say which API a changed call (or the function making it)
// talks to. The other half of routes-text.ts: routes are what a system answers, calls what it asks of others.
//   TypeScript, JavaScript   fetch(url, { method }), axios / ky / Angular HttpClient (`http.get<T>(…)`)
//   Java, Kotlin             Retrofit (@GET("…") on an interface), Feign (@FeignClient), OkHttp (Request.Builder),
//                            java.net.http (HttpRequest.newBuilder), WebClient, RestTemplate, Ktor client
//   Swift                    URLSession (URLRequest + httpMethod), Alamofire (AF.request(…, method: .post))
//   Dart                     Dio, package:http (http.get(Uri.parse(…)))
//   Python                   requests, httpx, aiohttp sessions
//   Go                       http.Get / http.Post, http.NewRequest(WithContext)
//   C#                       HttpClient (GetAsync, PostAsJsonAsync, GetFromJsonAsync …, HttpRequestMessage), Refit
//   PHP                      Guzzle ($client->get, ->request), Laravel Http::get
//   Ruby                     Faraday, HTTParty, Net::HTTP::Post.new(URI(…))
//   Rust                     reqwest (client.get(…), reqwest::get, .request(Method::PATCH, …))
// A base address held in a variable or written out (`${BASE}/orders/${id}`, `https://api.x.com/v1/orders`) leaves only
// its path: `/orders/{}`, `/v1/orders`. A URL held entirely in a variable can't be read and is skipped.
import { languageOfFile } from './from-app/languages';

export interface Call {
  method: string;
  /** with `{}` for each part filled at run time */
  path: string;
  /** what was read (the client and the method), for the report */
  name: string;
  /** 1-based lines the call spans */
  start: number;
  end: number;
  /** a call declared on an interface method (Retrofit, Feign, Refit): the method's name, which the app's code calls */
  declares?: string;
}

const VERB = /^(get|post|put|patch|delete|head|options)$/i;
const HOLE = '\u0000';

/** the text of a string literal's content with its interpolations as holes, by the forms every language uses */
function holes(content: string): string {
  return content
    .replace(/\$\{[^}]*\}|\\\([^)]*\)|#\{[^}]*\}|\$\w+(?:\.\w+)*|\{[^}]*\}|%[sdvfiqx]|%\([^)]*\)s/g, HOLE);
}

/** one argument's text as a URL template: its string literals' contents, with anything between them a hole */
export function templateOf(arg: string): string | undefined {
  // Uri.https('host', '/path') / Uri.http(…): the path is the second string
  const uri = /\bUri\.https?\(\s*(['"])[^'"]*\1\s*,\s*(['"])([^'"]*)\2/.exec(arg);
  if (uri) return holes(uri[3]);
  let out = '';
  let found = false;
  let i = 0;
  let gap = false;
  let depth = 0;
  let litDepth = -1;
  while (i < arg.length) {
    const c = arg[i];
    const prefix = /^(?:[rbuf]{1,2}|@|\$@?|@\$)?(['"`])/i.exec(arg.slice(i));
    // a string literal (with a Python f/r prefix, C# $ or @, a JS template)
    if (prefix && (prefix[0].length === 1 || !/\w/.test(arg[i - 1] ?? ''))) {
      const q = prefix[1];
      let j = i + prefix[0].length;
      let s = '';
      while (j < arg.length && arg[j] !== q) {
        if (arg[j] === '\\' && q !== '`' && arg[j + 1] !== '(') { s += arg[j + 1] ?? ''; j += 2; continue; }
        s += arg[j];
        j++;
      }
      if (gap && found) out += HOLE;
      out += holes(s);
      if (!found) litDepth = depth;
      found = true;
      gap = false;
      i = j + 1;
      // "{}/orders".format(base), "…".to_string(): the string is the whole URL
      if (/^\s*\.(?:format|to_string|toString|ToString|trim|encode|into)\b/.test(arg.slice(i))) break;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    // the arguments after a format string fill its holes (fmt.Sprintf("%s/x", base)): not more URL
    else if (c === ',' && found && depth === litDepth) break;
    else if (/[\w$]/.test(c)) { if (found) gap = true; else out += HOLE; }
    i++;
  }
  if (!found) return undefined;
  // something after the last string (`'/orders/' + id`)
  if (gap) out += HOLE;
  return out.replace(new RegExp(`${HOLE}+`, 'g'), HOLE);
}

/** a URL template as a path: no scheme, host or base address, no query; holes and `{name}` as `{}` */
export function pathOfTemplate(t: string | undefined): string | undefined {
  if (t === undefined) return undefined;
  let p = t.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  // a base address in a variable: whatever comes before the first `/`
  const slash = p.indexOf('/');
  if (slash > 0 && !p.slice(0, slash).includes('/') && /[\u0000]/.test(p.slice(0, slash))) p = p.slice(slash);
  else if (slash < 0 && p.startsWith(HOLE)) return undefined;
  p = p.split(/[?#]/)[0];
  if (p.includes(HOLE) && p.replace(new RegExp(HOLE, 'g'), '').replace(/\//g, '') === '') return undefined;
  const segs = p.split('/').filter(Boolean).map((s) => (s.includes(HOLE) || /^\{[^}]*\}$|^:\w+$/.test(s) ? '{}' : s));
  if (!segs.length || segs.every((s) => s === '{}')) return undefined;
  // a host written without a scheme, or a relative file: not an API path
  if (/\.(?:com|net|org|io|dev|app)$/i.test(segs[0]) || /\.(?:json|html|png|jpe?g|svg|css|js)$/i.test(segs[segs.length - 1])) return undefined;
  return `/${segs.join('/')}`;
}

// ---------- reading the code ----------

/** the 0-based index where the call's parentheses opened at `open` close, skipping strings */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      for (i++; i < text.length && text[i] !== q; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; }
  }
  return text.length - 1;
}

/** the arguments of a call opened at `open` (index of its `(`), split at top-level commas */
function argsAt(text: string, open: number): string[] {
  const close = closeOf(text, open);
  const inner = text.slice(open + 1, close);
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let j = i + 1;
      for (; j < inner.length && inner[j] !== q; j++) if (inner[j] === '\\') j++;
      cur += inner.slice(i, j + 1);
      i = j;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const lineAt = (starts: number[], index: number) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
};

/** text with comments blanked out (same length, so positions stay) */
function blankComments(text: string, hash: boolean): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let j = i + 1;
      for (; j < text.length && text[j] !== q && !(q !== '`' && text[j] === '\n'); j++) if (text[j] === '\\') j++;
      out += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); const end = e < 0 ? text.length : e; out += ' '.repeat(end - i); i = end - 1; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? text.length : e + 2; out += text.slice(i, end).replace(/[^\n]/g, ' '); i = end - 1; continue; }
    if (hash && c === '#' && text[i + 1] !== '{' && text[i + 1] !== '[') { const e = text.indexOf('\n', i); const end = e < 0 ? text.length : e; out += ' '.repeat(end - i); i = end - 1; continue; }
    out += c;
  }
  return out;
}

/** receivers that are HTTP clients, not routers or maps (`http`, `axios`, `api`, `client`, `this.http`, `_dio` …) */
const CLIENT = /(?:^|[._$])(?:https?|axios|api|apiClient|client|httpClient|session|requests|httpx|ky|dio|conn|connection|faraday|rest|restClient|instance|request|agent|guzzle|webClient|service)$/i;
const ROUTER = /^(?:app|router|server|fastify|hono|routes|r|e|g|mux|api(?:Router|Routes)|v\d)$/;

export function callsIn(file: string, content: string): Call[] {
  const def = languageOfFile(file);
  const lang = def?.id;
  if (!def || !lang) return [];
  const text = blankComments(content, def.comments.line.includes('#'));
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const out: Call[] = [];
  const add = (method: string | undefined, urlArg: string | undefined, at: number, open: number, name: string, declares?: string) => {
    const path = pathOfTemplate(urlArg === undefined ? undefined : templateOf(urlArg));
    if (!path || !method) return;
    out.push({ method: method.toUpperCase(), path, name, start: lineAt(starts, at), end: lineAt(starts, closeOf(text, open)), ...(declares ? { declares } : {}) });
  };
  /** the interface method an annotation at `open` sits on: `suspend fun order(`, `Call<Order> order(`, `Task<User> GetUser(` */
  const declared = (open: number) => /(?:fun\s+|[\w<>?,\[\]\s]+\s)(\w+)\s*\(/.exec(text.slice(closeOf(text, open) + 1, closeOf(text, open) + 400).replace(/^\s*(?:@\w+(?:\([^)]*\))?\s*|\[\w+(?:\([^)]*\))?\]\s*)*/, ''))?.[1];
  const methodWord = (s: string | undefined) => {
    if (!s) return undefined;
    const m = /(?:HttpMethod\.|Method::|http\.Method|\.|^['"]?)(get|post|put|patch|delete|head|options)\b/i.exec(s.trim());
    return m ? m[1].toUpperCase() : undefined;
  };
  /** the method a request builder chain sets after `from`, up to its build/send (OkHttp, java.net.http, URLRequest) */
  const chainMethod = (from: number, re: RegExp, stop: RegExp) => {
    const rest = text.slice(from, from + 600);
    const s = stop.exec(rest);
    const m = re.exec(s ? rest.slice(0, s.index + s[0].length) : rest);
    return m ? (m[1] ?? m[2]).toUpperCase() : 'GET';
  };
  const each = (re: RegExp, f: (m: RegExpExecArray, open: number) => void) => {
    for (const m of text.matchAll(re)) f(m as RegExpExecArray, m.index! + m[0].length - 1);
  };
  const viaClient = (allow: RegExp = CLIENT) => each(/(?<![\w$])((?:this\.|self\.|\$this->|@)?[\w$]+(?:(?:\.|->)[\w$]+)*)(?:\.|->|::)(get|post|put|patch|delete|head|options)(?:<[^>()]*>)?\s*\(/gi, (m, open) => {
    const recv = m[1].replace(/^(?:this\.|self\.|\$this->|@)/, '');
    if (ROUTER.test(recv) || !allow.test(recv)) return;
    const args = argsAt(text, open);
    // a route registration (`api.get('/x', (req, res) => …)`, `api.get('/users/:id', getUser)`), not a call
    if (/^['"`][^'"`]*\/:\w/.test(args[0] ?? '')) return;
    if (args.slice(1).some((a) => /^(?:async\s*)?\(?[\w\s,:{}]*\)?\s*=>|^function\b|^func\b|Handler$|Controller\b/.test(a))) return;
    add(m[2], args[0], m.index!, open, `${recv}.${m[2]}`);
  });

  switch (lang) {
    case 'typescript':
    case 'javascript':
      each(/(?<![\w$.])fetch\s*\(/g, (m, open) => {
        const args = argsAt(text, open);
        add(methodWord(/method\s*:\s*(['"`]\w+['"`])/.exec(args[1] ?? '')?.[1]) ?? 'GET', args[0], m.index!, open, 'fetch');
      });
      viaClient();
      // axios({ method: 'post', url: … })
      each(/(?<![\w$.])(?:axios|ky)\s*\(\s*\{/g, (m) => {
        const paren = text.indexOf('(', m.index!);
        const obj = argsAt(text, paren)[0] ?? '';
        const url = /url\s*:\s*([^,\n}]+)/.exec(obj)?.[1];
        add(methodWord(/method\s*:\s*(['"`]\w+['"`])/.exec(obj)?.[1]) ?? 'GET', url, m.index!, paren, 'axios');
      });
      each(/\b(?:this\.)?http\.request\s*(?:<[^>()]*>)?\s*\(/g, (m, open) => {
        const args = argsAt(text, open);
        add(methodWord(args[0]), args[1], m.index!, open, 'http.request');
      });
      break;
    case 'java':
    case 'kotlin':
      // Retrofit: @GET("users/{id}") on an interface method; @HTTP(method = "DELETE", path = "…")
      each(/@(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g, (m, open) => {
        const args = argsAt(text, open);
        const sig = text.slice(closeOf(text, open) + 1, closeOf(text, open) + 300);
        if (!/^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:suspend\s+)?(?:fun\s+\w+|[\w<>?,\s]+\s+\w+)\s*\(/.test(sig)) return;
        add(m[1], (args.find((a) => /^(?:value|path)\s*=/.test(a)) ?? args[0])?.replace(/^(?:value|path)\s*=\s*/, ''), m.index!, open, `@${m[1]}`, declared(open));
      });
      each(/@HTTP\s*\(/g, (m, open) => {
        const args = argsAt(text, open).join(',');
        add(methodWord(/method\s*=\s*("\w+")/.exec(args)?.[1]), /path\s*=\s*("[^"]*")/.exec(args)?.[1], m.index!, open, '@HTTP', declared(open));
      });
      // Feign: Spring mappings inside a @FeignClient interface
      if (/@FeignClient\b/.test(text)) {
        each(/@(Get|Post|Put|Patch|Delete)Mapping\s*\(/g, (m, open) => {
          const args = argsAt(text, open);
          add(m[1], (args.find((a) => /^(?:value|path)\s*=/.test(a)) ?? args[0])?.replace(/^(?:value|path)\s*=\s*\{?/, ''), m.index!, open, `Feign ${m[1]}Mapping`, declared(open));
        });
      }
      // OkHttp: Request.Builder().url(…) then .post(body) / .delete() … up to .build()
      each(/\bRequest\.Builder\(\)\s*\.url\s*\(/g, (m, open) => {
        add(chainMethod(open, /\.(get|post|put|patch|delete|head)\s*\(|\.method\(\s*"(\w+)"/i, /\.build\(\)/), argsAt(text, open)[0], m.index!, open, 'OkHttp');
      });
      // java.net.http: HttpRequest.newBuilder(URI.create(…)) or .uri(URI.create(…)), then .POST(…) / .method("PATCH", …)
      each(/\bHttpRequest\.newBuilder\s*\(/g, (m, open) => {
        let args = argsAt(text, open);
        let at = open;
        if (!args.length) {
          const u = /\.uri\s*\(/.exec(text.slice(open, open + 200));
          if (!u) return;
          at = open + u.index + u[0].length - 1;
          args = argsAt(text, at);
        }
        add(chainMethod(open, /\.(GET|POST|PUT|DELETE)\s*\(|\.method\(\s*"(\w+)"/, /\.build\(\)/), args[0], m.index!, at, 'HttpRequest');
      });
      // WebClient: client.get().uri("/x/{id}", id)
      each(/\.(get|post|put|patch|delete)\(\)\s*\.uri\s*\(/gi, (m, open) => add(m[1], argsAt(text, open)[0], m.index!, open, `WebClient ${m[1]}`));
      // RestTemplate: getForObject(url, …), postForEntity, exchange(url, HttpMethod.PUT, …)
      each(/\b\w+\.(get|post|put|patch|delete)For(?:Object|Entity|Location)\s*\(/g, (m, open) => add(m[1], argsAt(text, open)[0], m.index!, open, `RestTemplate ${m[1]}`));
      each(/\b\w+\.exchange\s*\(/g, (m, open) => { const a = argsAt(text, open); add(methodWord(a[1]), a[0], m.index!, open, 'RestTemplate exchange'); });
      if (lang === 'kotlin') viaClient();
      break;
    case 'swift':
      // URLRequest(url: URL(string: "…")!) then request.httpMethod = "POST"
      each(/\bURLRequest\s*\(\s*url\s*:\s*URL\s*\(\s*string\s*:\s*/g, (m) => {
        const open = text.indexOf('(', text.indexOf('URL', m.index! + 10));
        const url = argsAt(text, open)[0]?.replace(/^string\s*:\s*/, '');
        add(chainMethod(open, /httpMethod\s*=\s*"(\w+)"/, /\b(?:dataTask|data|upload|download)\s*\(|\bresume\(\)/), url, m.index!, open, 'URLRequest');
      });
      each(/\b(?:AF|Alamofire|session|Session\.default)\.request\s*\(/g, (m, open) => {
        const args = argsAt(text, open);
        add(methodWord(args.find((a) => /^method\s*:/.test(a))?.replace(/^method\s*:\s*/, '')) ?? 'GET', args[0], m.index!, open, 'Alamofire');
      });
      break;
    case 'dart':
      viaClient(/(?:^|[._])(?:https?|dio|client|api|apiClient|httpClient)$/i);
      break;
    case 'python':
      viaClient(/(?:^|[._])(?:requests|httpx|session|client|http|api|aiohttp|s)$/i);
      each(/\b(?:requests|httpx|session|client)\.request\s*\(/g, (m, open) => { const a = argsAt(text, open); add(methodWord(a[0]), a[1], m.index!, open, 'request'); });
      break;
    case 'go':
      each(/\bhttp\.(Get|Post|Head)\s*\(/g, (m, open) => add(m[1], argsAt(text, open)[0], m.index!, open, `http.${m[1]}`));
      each(/\bhttp\.NewRequest(WithContext)?\s*\(/g, (m, open) => {
        const a = argsAt(text, open).slice(m[1] ? 1 : 0);
        add(methodWord(a[0]?.replace(/^http\.Method/, '')), a[1], m.index!, open, 'http.NewRequest');
      });
      break;
    case 'csharp':
      each(/\b[\w.]+\.(Get|Post|Put|Patch|Delete)(?:FromJson|AsJson|String|ByteArray|Stream)?Async\s*(?:<[^>()]*>)?\s*\(/g, (m, open) => add(m[1], argsAt(text, open)[0], m.index!, open, `HttpClient ${m[1]}`));
      each(/\bnew\s+HttpRequestMessage\s*\(/g, (m, open) => { const a = argsAt(text, open); add(methodWord(a[0]), a[1], m.index!, open, 'HttpRequestMessage'); });
      // Refit: [Get("/users/{id}")] on an interface method
      each(/\[(Get|Post|Put|Patch|Delete)\s*\(/g, (m, open) => add(m[1], argsAt(text, open)[0], m.index!, open, `Refit ${m[1]}`, declared(open + 0)));
      break;
    case 'php':
      viaClient(/(?:client|http|guzzle|api)$/i);
      each(/\bHttp::(?:\w+\([^)]*\)->)*(get|post|put|patch|delete)\s*\(/g, (m, open) => add(m[1], argsAt(text, open)[0], m.index!, open, `Http::${m[1]}`));
      each(/->request\s*\(/g, (m, open) => { const a = argsAt(text, open); add(methodWord(a[0]), a[1], m.index!, open, 'Guzzle request'); });
      break;
    case 'ruby':
      viaClient(/(?:conn|connection|client|http|faraday|api|HTTParty|class)$/i);
      each(/\bNet::HTTP::(Get|Post|Put|Patch|Delete)\.new\s*\(/g, (m, open) => add(m[1], argsAt(text, open)[0]?.replace(/^URI\(|\)$/g, ''), m.index!, open, `Net::HTTP::${m[1]}`));
      break;
    case 'rust':
      viaClient(/(?:client|http|reqwest|api)$/i);
      each(/\.request\s*\(\s*(?:reqwest::)?Method::(\w+)\s*,/g, (m) => {
        const open = text.indexOf('(', m.index!);
        add(m[1], argsAt(text, open)[1], m.index!, open, 'reqwest request');
      });
      break;
  }
  // each call once (a pattern can see a call another one read too)
  const seen = new Set<string>();
  return out.filter((c) => !seen.has(`${c.start}|${c.method}|${c.path}`) && !!seen.add(`${c.start}|${c.method}|${c.path}`)).sort((a, b) => a.start - b.start);
}

export const callsAt = (cs: Call[], line: number) => cs.filter((c) => line >= c.start && line <= c.end);

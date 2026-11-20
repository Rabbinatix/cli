// A request as code to copy, in cURL or a language from the config's snippet languages (support.ts SNIPPET_LANGUAGES):
// Test APIs “Copy as …”, the health signal snippets, the docs. Only the language's standard library, so it runs as
// pasted, except Rust, which has no HTTP client of its own: reqwest, the one most use (its Cargo.toml line is in the
// first comment). Pure.
import { languageById } from './languages';
import { SNIPPET_LANGUAGES, SnippetLanguage } from './support';

export type SnippetTarget = 'curl' | SnippetLanguage;
export const SNIPPET_TARGETS: readonly SnippetTarget[] = ['curl', ...SNIPPET_LANGUAGES];

export const snippetLabel = (t: SnippetTarget) =>
  t === 'curl' ? 'cURL' : t === 'javascript' ? 'JavaScript / TypeScript' : (languageById(t)?.label ?? t);

export interface SnippetRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** a double-quoted literal that JavaScript, Python, C#, Java and Go all read the same way */
const dq = (s: string) => JSON.stringify(s);
/** a single-quoted literal for PHP and Ruby (no interpolation): ' and \ escaped */
const sq = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
/** a double-quoted literal for languages that read fewer escapes than JSON writes (Kotlin, Rust, Swift, Dart): \\, ",
 *  newlines and tabs escaped, other control characters as the language's unicode escape, plus its own (`$` in Kotlin
 *  and Dart, which would start a template) */
const lit = (s: string, unicode: (code: number) => string, own: Record<string, string> = {}) =>
  `"${[...s].map((ch) => {
    const code = ch.codePointAt(0)!;
    if (own[ch]) return own[ch];
    if (ch === '\\' || ch === '"') return `\\${ch}`;
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 ? unicode(code) : ch;
  }).join('')}"`;
const hex4 = (c: number) => `\\u${c.toString(16).padStart(4, '0')}`;
const braces = (c: number) => `\\u{${c.toString(16)}}`;
const kt = (s: string) => lit(s, hex4, { $: '\\$' });
const rs = (s: string) => lit(s, braces);
const swift = (s: string) => lit(s, braces);
const dart = (s: string) => lit(s, braces, { $: '\\$' });
/** a POSIX shell single-quoted word */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function requestSnippet(target: SnippetTarget, r: SnippetRequest): string {
  const m = r.method.toUpperCase();
  const headers = Object.entries(r.headers);
  const hasBody = r.body !== undefined && r.body !== '';
  switch (target) {
    case 'curl': {
      const lines = [`curl${m === 'GET' ? '' : ` -X ${m}`} ${sh(r.url)}`, ...headers.map(([k, v]) => `-H ${sh(`${k}: ${v}`)}`)];
      if (hasBody) lines.push(`--data-raw ${sh(r.body!)}`);
      return lines.join(' \\\n  ');
    }
    case 'javascript': {
      const opts = [`  method: ${dq(m)},`];
      if (headers.length) opts.push(`  headers: {\n${headers.map(([k, v]) => `    ${dq(k)}: ${dq(v)},`).join('\n')}\n  },`);
      if (hasBody) opts.push(`  body: ${dq(r.body!)},`);
      return [`const res = await fetch(${dq(r.url)}, {`, ...opts, '});', 'console.log(res.status, await res.text());'].join('\n');
    }
    case 'python':
      return [
        'import urllib.request',
        '',
        `req = urllib.request.Request(${dq(r.url)}, method=${dq(m)}${hasBody ? `, data=${dq(r.body!)}.encode()` : ''}, headers={`,
        ...headers.map(([k, v]) => `    ${dq(k)}: ${dq(v)},`),
        '})',
        'with urllib.request.urlopen(req) as res:',
        '    print(res.status, res.read().decode())',
      ].join('\n');
    case 'csharp': {
      const lines = [
        'using var http = new HttpClient();',
        `using var req = new HttpRequestMessage(new HttpMethod(${dq(m)}), ${dq(r.url)});`,
      ];
      const ct = headers.find(([k]) => k.toLowerCase() === 'content-type');
      for (const [k, v] of headers) if (k.toLowerCase() !== 'content-type') lines.push(`req.Headers.TryAddWithoutValidation(${dq(k)}, ${dq(v)});`);
      if (hasBody) {
        lines.push(`req.Content = new StringContent(${dq(r.body!)});`);
        if (ct) lines.push(`req.Content.Headers.ContentType = System.Net.Http.Headers.MediaTypeHeaderValue.Parse(${dq(ct[1])});`);
      }
      lines.push('using var res = await http.SendAsync(req);', 'Console.WriteLine($"{(int)res.StatusCode} {await res.Content.ReadAsStringAsync()}");');
      return lines.join('\n');
    }
    case 'java':
      return [
        'var http = java.net.http.HttpClient.newHttpClient();',
        `var req = java.net.http.HttpRequest.newBuilder(java.net.URI.create(${dq(r.url)}))`,
        ...headers.map(([k, v]) => `    .header(${dq(k)}, ${dq(v)})`),
        `    .method(${dq(m)}, ${hasBody ? `java.net.http.HttpRequest.BodyPublishers.ofString(${dq(r.body!)})` : 'java.net.http.HttpRequest.BodyPublishers.noBody()'})`,
        '    .build();',
        'var res = http.send(req, java.net.http.HttpResponse.BodyHandlers.ofString());',
        'System.out.println(res.statusCode() + " " + res.body());',
      ].join('\n');
    case 'go':
      return [
        'package main',
        '',
        'import (',
        '\t"fmt"',
        '\t"io"',
        '\t"net/http"',
        ...(hasBody ? ['\t"strings"'] : []),
        ')',
        '',
        'func main() {',
        `\treq, err := http.NewRequest(${dq(m)}, ${dq(r.url)}, ${hasBody ? `strings.NewReader(${dq(r.body!)})` : 'nil'})`,
        '\tif err != nil {',
        '\t\tpanic(err)',
        '\t}',
        ...headers.map(([k, v]) => `\treq.Header.Set(${dq(k)}, ${dq(v)})`),
        '\tres, err := http.DefaultClient.Do(req)',
        '\tif err != nil {',
        '\t\tpanic(err)',
        '\t}',
        '\tdefer res.Body.Close()',
        '\tbody, _ := io.ReadAll(res.Body)',
        '\tfmt.Println(res.StatusCode, string(body))',
        '}',
      ].join('\n');
    case 'php':
      return [
        '<?php',
        `$ch = curl_init(${sq(r.url)});`,
        'curl_setopt_array($ch, [',
        `    CURLOPT_CUSTOMREQUEST => ${sq(m)},`,
        '    CURLOPT_RETURNTRANSFER => true,',
        `    CURLOPT_HTTPHEADER => [${headers.map(([k, v]) => sq(`${k}: ${v}`)).join(', ')}],`,
        ...(hasBody ? [`    CURLOPT_POSTFIELDS => ${sq(r.body!)},`] : []),
        ']);',
        '$body = curl_exec($ch);',
        "echo curl_getinfo($ch, CURLINFO_HTTP_CODE), ' ', $body, PHP_EOL;",
      ].join('\n');
    case 'ruby': {
      const cls = { GET: 'Get', POST: 'Post', PUT: 'Put', PATCH: 'Patch', DELETE: 'Delete', HEAD: 'Head', OPTIONS: 'Options' }[m];
      return [
        "require 'net/http'",
        '',
        `uri = URI(${sq(r.url)})`,
        cls ? `req = Net::HTTP::${cls}.new(uri)` : `req = Net::HTTPGenericRequest.new(${sq(m)}, ${hasBody}, true, uri)`,
        ...headers.map(([k, v]) => `req[${sq(k)}] = ${sq(v)}`),
        ...(hasBody ? [`req.body = ${sq(r.body!)}`] : []),
        "res = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == 'https') { |http| http.request(req) }",
        'puts "#{res.code} #{res.body}"',
      ].join('\n');
    }
    case 'kotlin':
      return [
        'import java.net.URI',
        'import java.net.http.HttpClient',
        'import java.net.http.HttpRequest',
        'import java.net.http.HttpResponse',
        '',
        'fun main() {',
        `    val req = HttpRequest.newBuilder(URI.create(${kt(r.url)}))`,
        ...headers.map(([k, v]) => `        .header(${kt(k)}, ${kt(v)})`),
        `        .method(${kt(m)}, ${hasBody ? `HttpRequest.BodyPublishers.ofString(${kt(r.body!)})` : 'HttpRequest.BodyPublishers.noBody()'})`,
        '        .build()',
        '    val res = HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString())',
        '    println("${res.statusCode()} ${res.body()}")',
        '}',
      ].join('\n');
    case 'rust':
      return [
        '// Cargo.toml: reqwest = { version = "0.12", features = ["blocking"] }',
        'fn main() -> Result<(), Box<dyn std::error::Error>> {',
        '    let res = reqwest::blocking::Client::new()',
        `        .request(reqwest::Method::from_bytes(${rs(m)}.as_bytes())?, ${rs(r.url)})`,
        ...headers.map(([k, v]) => `        .header(${rs(k)}, ${rs(v)})`),
        ...(hasBody ? [`        .body(${rs(r.body!)})`] : []),
        '        .send()?;',
        '    let status = res.status().as_u16();',
        '    println!("{} {}", status, res.text()?);',
        '    Ok(())',
        '}',
      ].join('\n');
    case 'swift':
      return [
        'import Foundation',
        '#if canImport(FoundationNetworking)',
        'import FoundationNetworking',
        '#endif',
        '',
        `var req = URLRequest(url: URL(string: ${swift(r.url)})!)`,
        `req.httpMethod = ${swift(m)}`,
        ...headers.map(([k, v]) => `req.setValue(${swift(v)}, forHTTPHeaderField: ${swift(k)})`),
        ...(hasBody ? [`req.httpBody = Data(${swift(r.body!)}.utf8)`] : []),
        'let (data, res) = try await URLSession.shared.data(for: req)',
        'print((res as! HTTPURLResponse).statusCode, String(decoding: data, as: UTF8.self))',
      ].join('\n');
    case 'dart':
      return [
        "import 'dart:convert';",
        "import 'dart:io';",
        '',
        'Future<void> main() async {',
        '  final client = HttpClient();',
        `  final req = await client.openUrl(${dart(m)}, Uri.parse(${dart(r.url)}));`,
        ...headers.map(([k, v]) => `  req.headers.set(${dart(k)}, ${dart(v)});`),
        ...(hasBody ? [`  final body = utf8.encode(${dart(r.body!)});`, '  req.contentLength = body.length;', '  req.add(body);'] : []),
        '  final res = await req.close();',
        "  print('${res.statusCode} ${await res.transform(utf8.decoder).join()}');",
        '  client.close();',
        '}',
      ].join('\n');
  }
}

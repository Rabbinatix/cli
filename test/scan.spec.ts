import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { depFindings, osvLookup, OsvVuln, pinnedIn, podNote, podRepos, repoName, severityOf } from '../src/scan/deps.js';
import { gitleaksFinding, Run, semgrepFinding } from '../src/scan/external.js';
import { merged } from '../src/scan/index.js';
import { scanText } from '../src/scan/rules.js';
import { mainScan, parseScanArgs, report } from '../src/scan-cli.js';
import type { Finding } from '../src/scan/types.js';

const rules = (file: string, text: string) => scanText(file, text).map((f) => f.rule.replace('rabbinatix:', ''));
// test values built at run time, so this file itself holds no secret-shaped text
const AWS = 'AKIA' + 'Q3R7ZK2MW9VTPLHD';
const PEM = '-----BEGIN RSA ' + 'PRIVATE KEY-----';
const GH = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

describe('scan: the built-in rules', () => {
  it('finds secrets in known formats, anywhere (tests too), masked in the snippet', () => {
    const [f] = scanText('src/config.ts', `const key = "${AWS}";`);
    expect(f).toMatchObject({ rule: 'rabbinatix:aws-access-key', severity: 'critical', category: 'secret', line: 1 });
    expect(f.snippet).toBe('const key = "AKIA•••";');
    expect(rules('test/fixtures.ts', `token: '${GH}'`)).toEqual(['github-token']);
    expect(rules('k.pem', PEM)).toEqual(['private-key']);
    // made-up values in tests and docs aren't secrets
    expect(rules('a.ts', `key = "${'AKIA' + 'IOSFODNN7EXAMPLE'}"`)).toEqual([]);
    expect(rules('a.ts', `key = "${'AKIA' + 'ABCDEFGHIJKLMNOP'}"`)).toEqual([]);
    // a Firebase web key: the softer Google key finding, not also a password
    expect(rules('src/environments/environment.prod.ts', `  apiKey: '${'AIza' + 'SyD3kR9xQ2mVt7LpW4nB8cZ1fH6jK0sYuEo'}',`)).toEqual(['google-api-key']);
  });

  it('a password written into the code, but not placeholders, references or repeated characters', () => {
    expect(rules('src/db.py', 'password = "Tr0ub4dor&3xq9"')).toEqual(['hardcoded-credential']);
    expect(scanText('src/db.py', 'password = "Tr0ub4dor&3xq9"')[0].snippet).toBe('password = "Tr0u•••"');
    expect(rules('src/db.py', 'password = "your_password_here"')).toEqual([]);
    expect(rules('src/db.ts', 'apiKey: "${process.env.KEY}"')).toEqual([]);
    expect(rules('src/db.ts', 'secret = "aaaaaaaaaaaaaaaa"')).toEqual([]);
    expect(rules('test/db.spec.ts', 'password = "Tr0ub4dor&3xq9"')).toEqual([]);
    expect(rules('catalog/login.ts', "input: { password: 'wrong-password-1' }")).toEqual([]);
    expect(rules('src/env.ts', "apiKey: 'demo-api-key-local'")).toEqual([]);
  });

  it('risky code by language, not in tests or comments, and not on a rabbinatix-ignore line', () => {
    expect(rules('a.ts', 'const v = eval(input);')).toEqual(['eval']);
    expect(rules('a.ts', 'const v = obj.eval(input);')).toEqual([]);
    expect(rules('a.ts', '// eval(input) was here')).toEqual([]);
    expect(rules('a.spec.ts', 'eval(input)')).toEqual([]);
    expect(rules('a.ts', 'eval(input) // rabbinatix-ignore: a sandbox')).toEqual([]);
    expect(rules('a.go', 'eval(input)')).toEqual([]);
    expect(rules('a.py', 'subprocess.run(cmd, shell=True)')).toEqual(['python-shell-true']);
    expect(rules('a.py', 'requests.get(url, verify=False)')).toEqual(['tls-off-python']);
    expect(rules('a.py', 'yaml.load(text)')).toEqual(['yaml-load']);
    expect(rules('a.py', 'yaml.load(text, Loader=yaml.SafeLoader)')).toEqual([]);
    expect(rules('a.ts', 'db.query(`SELECT * FROM users WHERE id = ${id}`)')).toEqual(['sql-concat']);
    expect(rules('a.ts', 'db.query("SELECT * FROM users WHERE id = $1", [id])')).toEqual([]);
    expect(rules('Repo.java', 'stmt.execute("SELECT * FROM t WHERE id=" + id);')).toEqual(['sql-concat']);
    expect(rules('a.cs', 'var q = $"SELECT * FROM t WHERE id={id}";')).toEqual(['sql-concat']);
    expect(rules('a.ts', 'agent = new https.Agent({ rejectUnauthorized: false })')).toEqual(['tls-off-node']);
    expect(rules('a.ts', 'el.innerHTML = html;')).toEqual(['inner-html']);
    expect(rules('a.ts', "el.innerHTML = '';")).toEqual([]);
    expect(rules('a.ts', `root.innerHTML = '<div role="alert">Failed</div>';`)).toEqual([]);
    // the word, not SQL: catalog data, docstrings
    expect(rules('a.ts', "{ kind: 'insert', input: `${NAME}: string` }")).toEqual([]);
    expect(rules('a.ts', 'queryText: `SELECT id FROM users WHERE email = :${EMAIL}`')).toEqual([]);
    expect(rules('a.ts', 'msg = `Select the findings from the list, then ${verb}`')).toEqual([]);
    expect(rules('a.ts', 'q = `select id, name from users where id = ${id}`')).toEqual(['sql-concat']);
    expect(rules('a.py', 'cur.execute(f"SELECT name FROM users WHERE id = {uid}")')).toEqual(['sql-concat']);
    expect(rules('a.py', `    """sha256, sha1 or md5 ("SHA-256" too)."""`)).toEqual([]);
    expect(rules('a.php', '$h = md5($pw);')).toEqual(['weak-hash-php']);
    expect(rules('a.ts', 'exec(`git log ${branch}`)')).toEqual(['shell-from-input']);
    expect(rules('a.ts', "createHash('md5')")).toEqual(['weak-hash']);
  });
});

describe('scan: the rules for more languages and for mobile apps', () => {
  it('command injection, unsafe deserialization and weak hashes in Go, Ruby, PHP, Rust, Kotlin/Java, C#', () => {
    expect(rules('main.go', 'exec.Command("sh", "-c", "git log "+branch)')).toEqual(['go-shell']);
    expect(rules('main.go', 'exec.Command("sh", "-c", "make build")')).toEqual([]);
    expect(rules('main.go', 'h := md5.Sum(data)')).toEqual(['weak-hash-more']);
    expect(rules('a.rb', 'system("tar xf #{file}")')).toEqual(['ruby-shell']);
    expect(rules('a.rb', 'system("tar", "xf", file)')).toEqual([]);
    expect(rules('a.rb', 'obj = Marshal.load(data)')).toEqual(['ruby-marshal']);
    expect(rules('a.rb', 'Digest::MD5.hexdigest(x)')).toEqual(['weak-hash-more']);
    expect(rules('a.php', 'shell_exec("ls " . $dir);')).toEqual(['php-shell']);
    expect(rules('a.php', '$o = unserialize($_COOKIE["cart"]);')).toEqual(['php-unserialize']);
    expect(rules('a.php', '$q = "SELECT * FROM users WHERE id = $id";')).toEqual(['sql-interpolation']);
    expect(rules('src/main.rs', 'let q = format!("SELECT * FROM users WHERE id = {}", id);')).toEqual(['sql-concat']);
    expect(rules('src/main.rs', 'Command::new("sh").arg("-c").arg(format!("ls {}", dir))')).toEqual(['rust-shell']);
    expect(rules('src/main.rs', 'let c = Client::builder().danger_accept_invalid_certs(true).build()?;')).toEqual(['tls-off-rust']);
    expect(rules('src/main.rs', 'let mut h = Md5::new();')).toEqual(['weak-hash-more']);
    expect(rules('Repo.kt', 'val q = "SELECT * FROM users WHERE id = $id"')).toEqual(['sql-interpolation']);
    expect(rules('Repo.kt', 'val q = "SELECT * FROM users WHERE id = ?"')).toEqual([]);
    expect(rules('Run.java', 'Runtime.getRuntime().exec("ping " + host);')).toEqual(['jvm-runtime-exec']);
    expect(rules('Run.java', 'Object o = new ObjectInputStream(in).readObject();')).toEqual(['java-object-input']);
    expect(rules('Cart.cs', 'var f = new BinaryFormatter();')).toEqual(['dotnet-binaryformatter']);
  });

  it('iOS: certificate checks off, App Transport Security off, SQL in an interpolated string, tokens in UserDefaults', () => {
    expect(rules('Net.swift', 'completionHandler(.useCredential, URLCredential(trust: challenge.protectionSpace.serverTrust!))')).toEqual(['tls-off-swift']);
    expect(rules('Net.swift', 'completionHandler(.performDefaultHandling, nil)')).toEqual([]);
    expect(rules('Net.swift', 'let s = Session(serverTrustManager: ServerTrustManager(evaluators: ["api.x.com": DisabledTrustEvaluator()]))')).toEqual(['tls-off-swift']);
    expect(rules('Db.swift', 'let q = "SELECT * FROM notes WHERE id = \\(id)"')).toEqual(['sql-interpolation']);
    expect(rules('Auth.swift', 'UserDefaults.standard.set(token, forKey: "authToken")')).toEqual(['mobile-plain-storage']);
    expect(rules('Auth.swift', 'UserDefaults.standard.set(true, forKey: "seenIntro")')).toEqual([]);
    expect(rules('Hash.swift', 'let d = Insecure.MD5.hash(data: data)')).toEqual(['weak-hash-more']);
    expect(rules('App/Info.plist', '\t<key>NSAllowsArbitraryLoads</key>\n\t<true/>'.split('\n')[0] + '\n\t<true/>')).toEqual(['ios-arbitrary-loads']);
    expect(rules('App/Info.plist', '\t<key>NSAllowsArbitraryLoads</key>\n\t<false/>')).toEqual([]);
    expect(rules('App/Info.plist', '<key>NSAllowsArbitraryLoads</key><true/>')).toEqual(['ios-arbitrary-loads']);
    expect(rules('App/Info.plist', '<key>NSAllowsLocalNetworking</key><true/>')).toEqual([]);
    expect(rules('notes.txt', '<key>NSAllowsArbitraryLoads</key><true/>')).toEqual([]);
  });

  it('Android: trust-all and hostname checks, cleartext, debuggable, WebView bridges, keys in resources, tokens in SharedPreferences', () => {
    expect(rules('TrustAll.kt', '    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}')).toEqual(['tls-off-jvm']);
    expect(rules('TrustAll.java', '  public void checkServerTrusted(X509Certificate[] c, String a) throws CertificateException {}')).toEqual(['tls-off-jvm']);
    expect(rules('Http.kt', '    .hostnameVerifier { _, _ -> true }')).toEqual(['tls-off-jvm']);
    expect(rules('Web.kt', '        handler?.proceed()')).toEqual(['tls-off-jvm']);
    expect(rules('Web.kt', '        handler?.cancel()')).toEqual([]);
    expect(rules('Web.kt', 'webView.addJavascriptInterface(Bridge(), "app")')).toEqual(['android-webview-bridge']);
    expect(rules('app/src/main/AndroidManifest.xml', '<application android:usesCleartextTraffic="true"')).toEqual(['android-cleartext']);
    expect(rules('app/src/main/AndroidManifest.xml', '<application android:usesCleartextTraffic="false"')).toEqual([]);
    expect(rules('app/src/main/res/xml/network_security_config.xml', '<base-config cleartextTrafficPermitted="true">')).toEqual(['android-cleartext']);
    expect(rules('app/src/main/AndroidManifest.xml', '    android:debuggable="true"')).toEqual(['android-debuggable']);
    const key = 'sk_' + 'Q7mZ2xK9vB4nR8tW1yP3';
    expect(rules('app/src/main/res/values/strings.xml', `<string name="payments_api_key">${key}</string>`)).toEqual(['android-resource-secret']);
    expect(scanText('app/src/main/res/values/strings.xml', `<string name="payments_api_key">${key}</string>`)[0].snippet).toBe('<string name="payments_api_key">sk_Q•••</string>');
    expect(rules('app/src/main/res/values/strings.xml', '<string name="password_hint">Enter your password here</string>')).toEqual([]);
    expect(rules('app/src/main/res/values/strings.xml', '<string name="api_key">YOUR_API_KEY_GOES_HERE</string>')).toEqual([]);
    expect(rules('Prefs.kt', 'prefs.edit().putString("access_token", token).apply()')).toEqual(['mobile-plain-storage']);
  });

  it('Flutter: certificate checks off, tokens in SharedPreferences, weak hashes', () => {
    expect(rules('lib/api.dart', '  client.badCertificateCallback = (cert, host, port) => true;')).toEqual(['tls-off-dart']);
    expect(rules('lib/auth.dart', "  await prefs.setString('refreshToken', token);")).toEqual(['mobile-plain-storage']);
    expect(rules('lib/auth.dart', "  await prefs.setString('theme', 'dark');")).toEqual([]);
    expect(rules('lib/hash.dart', 'final d = md5.convert(bytes);')).toEqual(['weak-hash-more']);
    expect(rules('lib/db.dart', "final q = 'SELECT * FROM notes WHERE id = $id';")).toEqual(['sql-interpolation']);
  });
});

describe('scan: dependencies against OSV', () => {
  it('reads the packages each lock file pins', () => {
    const npm = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/lodash': { version: '4.17.20' }, 'node_modules/a/node_modules/@x/y': { version: '1.0.0' }, 'node_modules/local': { link: true } } }, null, 2);
    expect(pinnedIn('package-lock.json', npm).map((p) => `${p.name}@${p.version}:${p.line}`)).toEqual(['lodash@4.17.20:7', '@x/y@1.0.0:10']);
    expect(pinnedIn('web/requirements.txt', 'django==3.2.0  # pinned\nrequests>=2\nflask[async]==2.0.1').map((p) => `${p.ecosystem}:${p.name}@${p.version}`)).toEqual(['PyPI:django@3.2.0', 'PyPI:flask@2.0.1']);
    expect(pinnedIn('yarn.lock', '"lodash@^4.17.0", lodash@^4.17.20:\n  version "4.17.20"\n\n"@babel/core@^7.0.0":\n  version "7.1.0"\n').map((p) => `${p.name}@${p.version}`)).toEqual(['lodash@4.17.20', '@babel/core@7.1.0']);
    expect(pinnedIn('go.sum', 'golang.org/x/net v0.7.0 h1:abc=\ngolang.org/x/net v0.7.0/go.mod h1:def=\n').map((p) => `${p.ecosystem}:${p.name}@${p.version}`)).toEqual(['Go:golang.org/x/net@0.7.0']);
    expect(pinnedIn('Gemfile.lock', 'GEM\n  specs:\n    rack (2.0.1)\n      json (>= 1)\n\nPLATFORMS\n').map((p) => `${p.name}@${p.version}`)).toEqual(['rack@2.0.1']);
    expect(pinnedIn('package-lock.json', '{ not json')).toEqual([]);
    // Flutter, SwiftPM (versions 1 and 2) and an Android version catalog
    expect(pinnedIn('pubspec.lock', 'packages:\n  http:\n    dependency: direct\n    source: hosted\n    version: "0.13.0"\n  flutter:\n    source: sdk\n    version: "0.0.0"\n').map((p) => `${p.ecosystem}:${p.name}@${p.version}:${p.line}`)).toEqual(['Pub:http@0.13.0:2']);
    expect(pinnedIn('App.xcworkspace/xcshareddata/swiftpm/Package.resolved', JSON.stringify({ pins: [{ identity: 'alamofire', location: 'https://github.com/Alamofire/Alamofire.git', state: { version: '5.4.0' } }, { identity: 'x', location: 'https://github.com/a/x', state: { branch: 'main', version: null } }], version: 2 })).map((p) => `${p.ecosystem}:${p.name}@${p.version}`)).toEqual(['SwiftURL:github.com/Alamofire/Alamofire@5.4.0']);
    expect(pinnedIn('Package.resolved', JSON.stringify({ object: { pins: [{ package: 'swift-nio', repositoryURL: 'git@github.com:apple/swift-nio.git', state: { version: '2.40.0' } }] }, version: 1 })).map((p) => `${p.name}@${p.version}`)).toEqual(['github.com/apple/swift-nio@2.40.0']);
    const toml = '[versions]\nokhttp = "4.9.0"\n\n[libraries]\nokhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }\ngson = "com.google.code.gson:gson:2.8.5"\nretrofit = { group = "com.squareup.retrofit2", name = "retrofit", version = "2.9.0" }\nbom = { module = "androidx.compose:compose-bom" }\n\n[plugins]\nandroid = { id = "com.android.application", version = "8.1.0" }\n';
    expect(pinnedIn('gradle/libs.versions.toml', toml).map((p) => `${p.ecosystem}:${p.name}@${p.version}:${p.line}`)).toEqual(['Maven:com.squareup.okhttp3:okhttp@4.9.0:5', 'Maven:com.google.code.gson:gson@2.8.5:6', 'Maven:com.squareup.retrofit2:retrofit@2.9.0:7']);
  });

  it('asks OSV in one batch, reads each advisory once, and makes one finding per package with the worst severity and the fix', async () => {
    const calls: string[] = [];
    const vulns: Record<string, OsvVuln> = {
      'GHSA-1': { id: 'GHSA-1', aliases: ['CVE-2021-23337'], summary: 'Command injection', database_specific: { severity: 'HIGH', cwe_ids: ['CWE-77'] }, affected: [{ package: { name: 'lodash' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }] },
      'GHSA-2': { id: 'GHSA-2', summary: 'ReDoS', database_specific: { severity: 'MODERATE' } },
    };
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/querybatch')) {
        const q = JSON.parse(String(init!.body)) as { queries: { package: { name: string } }[] };
        return new Response(JSON.stringify({ results: q.queries.map((x) => (x.package.name === 'lodash' ? { vulns: [{ id: 'GHSA-1' }, { id: 'GHSA-2' }] } : {})) }));
      }
      return new Response(JSON.stringify(vulns[url.split('/').pop()!]));
    }) as typeof fetch;
    const pinned = pinnedIn('package-lock.json', JSON.stringify({ packages: { 'node_modules/lodash': { version: '4.17.20' }, 'node_modules/ok': { version: '1.0.0' } } }));
    const { ids, vulns: got } = await osvLookup(pinned, fetchFn);
    expect(calls.filter((c) => c.endsWith('/querybatch'))).toHaveLength(1);
    const [f, ...rest] = depFindings(pinned, ids, got);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ category: 'vulnerable-dependency', severity: 'high', rule: 'osv:GHSA-1', cwe: 'CWE-77', fixHint: 'Upgrade lodash to 4.17.21 or later.', title: 'lodash 4.17.20 has 2 known vulnerabilities' });
    expect(f.detail).toContain('CVE-2021-23337 / GHSA-1: Command injection');
    expect(severityOf({ id: 'x', severity: [{ type: 'CVSS_V3', score: '9.8' }] })).toBe('critical');
  });

  it('CocoaPods: each pod is checked as its source repository in OSV\'s Swift data; local and unknown pods are named', async () => {
    const lock = [
      'PODS:', '  - AFNetworking (2.5.1):', '    - AFNetworking/NSURLConnection (= 2.5.1)', '  - AFNetworking/NSURLConnection (2.5.1)', '  - Local (1.0.0)',
      '  - Forked (3.0.0)', '  - ZIPFoundation (0.9.11)', '  - Gone (9.9.9)', '', 'EXTERNAL SOURCES:', '  Local:', '    :path: "../Local"', '  Forked:',
      '    :git: git@github.com:me/forked.git', '', 'COCOAPODS: 1.15.2', '',
    ].join('\n');
    const pinned = pinnedIn('ios/Podfile.lock', lock);
    // a subspec is its pod, once
    expect(pinned.map((p) => `${p.ecosystem}:${p.name}@${p.version}:${p.line}`)).toEqual(['CocoaPods:AFNetworking@2.5.1:2', 'CocoaPods:Local@1.0.0:5', 'CocoaPods:Forked@3.0.0:6', 'CocoaPods:ZIPFoundation@0.9.11:7', 'CocoaPods:Gone@9.9.9:8']);
    const asked: string[] = [];
    const specs: Record<string, string> = { AFNetworking: 'https://github.com/AFNetworking/AFNetworking.git', ZIPFoundation: 'https://github.com/weichsel/ZIPFoundation.git' };
    const fetchFn = (async (url: string, init?: RequestInit) => {
      asked.push(url);
      if (url.startsWith('https://cdn.cocoapods.org/')) {
        const name = url.split('/').at(-3)!;
        return specs[name] ? new Response(JSON.stringify({ source: { git: specs[name], tag: '1' } })) : new Response('', { status: 404 });
      }
      if (url.endsWith('/querybatch')) {
        const q = JSON.parse(String(init!.body)) as { queries: { package: { name: string; ecosystem: string } }[] };
        expect(q.queries.every((x) => x.package.ecosystem === 'SwiftURL')).toBe(true);
        return new Response(JSON.stringify({ results: q.queries.map((x) => (x.package.name === 'github.com/weichsel/ZIPFoundation' ? { vulns: [{ id: 'GHSA-z' }] } : {})) }));
      }
      return new Response(JSON.stringify({ id: 'GHSA-z', summary: 'Path traversal', database_specific: { severity: 'HIGH' }, affected: [{ package: { name: 'github.com/weichsel/ZIPFoundation' }, ranges: [{ events: [{ fixed: '0.9.18' }] }] }] }));
    }) as typeof fetch;
    const r = await podRepos(pinned, [{ file: 'ios/Podfile.lock', text: lock }], fetchFn);
    // the CDN path is sharded by the md5 of the name; a :git source isn't looked up
    expect(asked).toContain('https://cdn.cocoapods.org/Specs/1/6/1/ZIPFoundation/0.9.11/ZIPFoundation.podspec.json');
    expect(asked.some((u) => u.includes('/Forked/'))).toBe(false);
    expect(r.unresolved).toEqual(['Gone', 'Local']);
    expect(r.pinned.map((p) => p.lookup!.name)).toEqual(['github.com/AFNetworking/AFNetworking', 'github.com/me/forked', 'github.com/weichsel/ZIPFoundation']);
    const { ids, vulns } = await osvLookup(r.pinned, fetchFn);
    expect(depFindings(r.pinned, ids, vulns)).toMatchObject([{ file: 'ios/Podfile.lock', line: 7, title: 'ZIPFoundation 0.9.11 has 1 known vulnerability', fixHint: 'Upgrade ZIPFoundation to 0.9.18 or later.' }]);
    expect(podNote(3, r.unresolved)).toMatch(/^CocoaPods: 3 pods checked .* Not checked \(a local or private pod, or no public repository found\): Gone, Local\.$/);
    expect(repoName('ssh://git@gitlab.com/a/b.git/')).toBe('gitlab.com/a/b');
  });
});

describe('scan: Semgrep and Gitleaks', () => {
  it('turns their results into findings, secrets masked', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-scan-'));
    fs.writeFileSync(path.join(root, 'cfg.ts'), `x\nconst t = "${GH}";\n`);
    expect(gitleaksFinding(root, { RuleID: 'github-pat', Description: 'GitHub Personal Access Token', File: path.join(root, 'cfg.ts'), StartLine: 2, Secret: GH })).toMatchObject({
      file: 'cfg.ts', line: 2, category: 'secret', rule: 'gitleaks:github-pat', snippet: 'const t = "ghp_•••";', title: 'GitHub Personal Access Token in the code',
    });
    expect(semgrepFinding(root, {
      check_id: 'javascript.express.security.audit.xss.direct-response-write', path: 'cfg.ts', start: { line: 1 },
      extra: { message: 'Detected user input flowing into a response. This could lead to XSS.', severity: 'ERROR', lines: 'res.send(req.query.q)', metadata: { cwe: ['CWE-79: Improper Neutralization'], owasp: ['A03:2021 - Injection'], vulnerability_class: ['Cross-Site-Scripting (XSS)'], category: 'security' } },
    })).toMatchObject({ category: 'cross-site-scripting-xss', severity: 'high', cwe: 'CWE-79', owasp: 'A03:2021', title: 'Detected user input flowing into a response.', rule: 'semgrep:javascript.express.security.audit.xss.direct-response-write' });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('each issue once: a tool’s finding wins over the built-in one on the same line, worst first', () => {
    const f = (o: Partial<Finding>): Finding => ({ file: 'a.ts', line: 1, category: 'secret', severity: 'high', title: 't', rule: 'rabbinatix:x', ...o });
    const out = merged([f({ severity: 'critical' }), f({ rule: 'gitleaks:aws' }), f({ category: 'hardcoded-credential', line: 1 }), f({ line: 5, category: 'xss', severity: 'low' })]);
    expect(out.map((x) => `${x.rule}:${x.line}`)).toEqual(['gitleaks:aws:1', 'rabbinatix:x:5']);
  });
});

describe('scan: the command', () => {
  let dir = '';
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));
  const repo = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-scan-repo-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 'T');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/app.ts'), `const key = "${AWS}";\nconst v = eval(input);\n`);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n');
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist/app.js'), 'eval(x)');
    g('add', '.');
    g('commit', '-qm', 'one');
    return dir;
  };
  const none: Run = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') });
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, log: (s: string) => void out.push(s), warn: (s: string) => void err.push(s) };
  };

  it('prints what it finds (not ignored build output), and --fail-on sets the exit code', async () => {
    const root = repo();
    const p = io();
    expect(await mainScan(['--no-deps'], root, {}, p.log, p.warn, fetch, none)).toBe(0);
    expect(p.out[0]).toContain('### Security scan: 1 critical, 1 high');
    expect(p.out[0]).toContain('`src/app.ts:1`');
    expect(p.out[0]).not.toContain('dist/');
    expect(p.out[0]).not.toContain('Q3EXAMPLEKEY');
    expect(await mainScan(['--no-deps', '--fail-on', 'critical'], root, {}, p.log, p.warn, fetch, none)).toBe(1);
    expect(await mainScan(['--no-deps', '--gitleaks'], root, {}, p.log, p.warn, fetch, none)).toBe(2);
    expect(p.err.at(-1)).toContain('gitleaks isn’t installed');
  });

  it('--report sends 100 a call with the repo, branch and commit, and findings dismissed in Rabbinatix don’t fail the build', async () => {
    const root = repo();
    const sent: { url: string; auth: string; body: { scan: Record<string, string>; findings: Finding[]; more?: boolean } }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      sent.push({ url, auth: (init!.headers as Record<string, string>)['authorization'], body });
      // the critical secret was dismissed as a false alarm in the app
      return new Response(JSON.stringify({ new: 1, updated: 0, again: 0, resolved: 0, stillDismissed: 1, refused: [], dismissed: body.findings.flatMap((f: Finding, i: number) => (f.category === 'secret' ? [i] : [])), link: 'https://app/security' }));
    }) as typeof fetch;
    const p = io();
    const code = await mainScan(['--no-deps', '--report', '--fail-on', 'critical'], root, { RABBINATIX_API: 'https://api.example/v1/', RABBINATIX_TOKEN: 'cm_live_x' }, p.log, p.warn, fetchFn, none);
    expect(code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: 'https://api.example/v1/code-scan', auth: 'Bearer cm_live_x', body: { scan: { branch: 'main' } } });
    expect(sent[0].body.scan['commit']).toMatch(/^[0-9a-f]{40}$/);
    expect(sent[0].body.more).toBeUndefined();
    expect(p.out[0]).toContain('1 dismissed in Rabbinatix, not listed');
    expect(p.out[0]).toContain('Triage them in Rabbinatix: https://app/security');
    // without a token: told how to make one
    expect(await mainScan(['--report'], root, { RABBINATIX_API: 'https://x' }, p.log, p.warn, fetchFn, none)).toBe(2);
    expect(p.err.at(-1)).toContain('scan scope');
  });

  it('a long list goes in parts, `more` on all but the last, the answers added up', async () => {
    const bodies: { more?: boolean; findings: unknown[] }[] = [];
    const fetchFn = (async (_: string, init?: RequestInit) => {
      const b = JSON.parse(String(init!.body));
      bodies.push(b);
      return new Response(JSON.stringify({ new: b.findings.length, refused: [], dismissed: bodies.length === 2 ? [0] : [] }));
    }) as typeof fetch;
    const many = Array.from({ length: 230 }, (_, i): Finding => ({ file: 'a.ts', line: i + 1, category: 'xss', severity: 'low', title: 't', rule: 'rabbinatix:inner-html' }));
    const r = await report({ api: 'https://x/v1', token: 't' }, many, {}, fetchFn);
    expect(bodies.map((b) => [b.findings.length, !!b.more])).toEqual([[100, true], [100, true], [30, false]]);
    expect(r).toMatchObject({ new: 230, dismissed: [100] });
    expect(() => parseScanArgs(['--fail-on', 'huge'])).toThrow('critical, high, medium or low');
  });
});

describe('scan: the languages config', () => {
  it('the built-in rules cover exactly the languages the config says (support.ts SCAN_RULES)', async () => {
    const { RULES } = await import('../src/scan/rules.js');
    const { SCAN_RULES } = await import('../src/from-app/languages');
    const covered = new Set(RULES.flatMap((r) => r.langs ?? []));
    expect([...covered].sort()).toEqual([...SCAN_RULES].sort());
  });

  it('OSV-Scanner, when installed, reads every lock file kind instead of the built-in reader', async () => {
    const { osvScanner } = await import('../src/scan/external.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-osv-'));
    fs.writeFileSync(path.join(root, 'pubspec.lock'), 'packages:\n  http:\n    version: "0.13.0"\n');
    const out = { results: [{ source: { path: path.join(root, 'pubspec.lock') }, packages: [{ package: { name: 'http', version: '0.13.0', ecosystem: 'Pub' }, vulnerabilities: [{ id: 'GHSA-x', summary: 'Header injection', database_specific: { severity: 'HIGH' }, affected: [{ package: { name: 'http' }, ranges: [{ events: [{ fixed: '0.13.3' }] }] }] }] }] }] };
    const exec: Run = (cmd, args) => (cmd === 'osv-scanner' && args[0] === 'scan' ? { status: 1, stdout: JSON.stringify(out), stderr: '' } : { status: 2, stdout: '', stderr: 'no' });
    const r = osvScanner(root, exec);
    expect(r).toMatchObject({ files: 1, packages: 1 });
    expect(r.findings[0]).toMatchObject({ file: 'pubspec.lock', line: 2, severity: 'high', rule: 'osv:GHSA-x', fixHint: 'Upgrade http to 0.13.3 or later.' });
    expect(osvScanner(root, () => ({ status: 128, stdout: '', stderr: '' })).findings).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// The built-in rules of `rabbinatix scan`: leaked secrets in known formats, and a few risky code patterns. Each runs on
// one line at a time. They work anywhere Node runs; Semgrep and Gitleaks, when installed, add theirs (external.ts).
// A line with `rabbinatix-ignore` on it (in a comment) is skipped; a dismissed finding stays dismissed in Rabbinatix.
import { isCommentLine, isTestOrExampleFile, LanguageId, languageOfFile } from '../from-app/languages';
import type { Finding, Severity } from './types.js';

interface Rule {
  id: string;
  category: string;
  severity: Severity;
  title: string;
  re: RegExp;
  /** which languages (ids from the languages config); none: every text file */
  langs?: readonly LanguageId[];
  /** which files, by name (configuration files that aren't a language: Info.plist, AndroidManifest.xml) */
  files?: RegExp;
  /** a secret: the match is masked in the snippet, and it runs in test files too */
  secret?: boolean;
  /** a match that is a placeholder or a reference, not a value; `next` is the following line (a plist's value) */
  unless?: (match: string, line: string, next: string) => boolean;
  detail?: string;
  fixHint?: string;
  cwe?: string;
  owasp?: string;
}

// by language id (app/src/app/languages; support.ts SCAN_RULES lists them, and a test keeps the two in step)
const JS: LanguageId[] = ['typescript', 'javascript'];
const PY: LanguageId[] = ['python'];
const CS: LanguageId[] = ['csharp'];
const JAVA: LanguageId[] = ['java', 'kotlin', 'scala'];
const GO: LanguageId[] = ['go'];
const PHP: LanguageId[] = ['php'];
const RB: LanguageId[] = ['ruby'];
const RS: LanguageId[] = ['rust'];
const SWIFT: LanguageId[] = ['swift', 'objective-c'];
const DART: LanguageId[] = ['dart'];
/** Android and other JVM code */
const JVM: LanguageId[] = ['java', 'kotlin'];
const PLIST = /(?:^|\/)[^/]*\.plist$/;
const ANDROID_XML = /(?:^|\/)(?:AndroidManifest|network_security_config)\.xml$/;
const ANDROID_RES = /(?:^|\/)res\/values[^/]*\/[^/]+\.xml$/;
const STORAGE_HINT = 'Keep tokens and passwords in the Keychain (iOS), EncryptedSharedPreferences or the Android Keystore, or flutter_secure_storage: not in plain app storage, which backups and rooted phones can read.';

/** SQL as a statement (not just the word “insert”, nor an English “select … from”): SELECT … FROM, INSERT INTO,
 *  UPDATE … SET, DELETE FROM, in capitals, or in lower case with only names between the words */
const SQL = String.raw`(?:SELECT\s[^;]*?\sFROM\s|select\s+[\w*.,\s"]+?\s+from\s+\w|INSERT\s+INTO\s|insert\s+into\s+\w|UPDATE\s+[\w."\[\]]+\s+SET\s|update\s+\w+\s+set\s+\w|DELETE\s+FROM\s|delete\s+from\s+\w)`;
const SECRET_HINT = 'Revoke it where it was issued, make a new one, and keep it out of the code: an environment variable or a secret store.';
const PLACEHOLDER = /example|sample|dummy|changeme|change_me|your[_-]|xxx|\*\*\*|<[^>]*>|\$\{|\{\{|process\.env|os\.environ|getenv|config\[|todo|placeholder|redacted|fake|test/i;
/** few distinct characters: a placeholder (`aaaaaaaa`, `12345678`), not a secret */
const lowEntropy = (s: string) => new Set(s).size < 8;
/** a made-up value: the documented examples (AWS's `…EXAMPLE`) or a run of the alphabet or digits (`ABCDEFGH`, `123456`) */
export const fakeValue = (v: string) => /EXAMPLE|abcdefg|bcdefgh|cdefghi|123456|xxxxxx/i.test(v) || lowEntropy(v.replace(/^[a-z_]+[-_]/i, ''));

export const RULES: readonly Rule[] = [
  // ---- secrets in formats that are always a secret
  { id: 'aws-access-key', category: 'secret', severity: 'critical', title: 'AWS access key in the code', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, secret: true, cwe: 'CWE-798', owasp: 'A07:2021', fixHint: SECRET_HINT },
  { id: 'private-key', category: 'secret', severity: 'critical', title: 'Private key in the code', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/, secret: true, cwe: 'CWE-321', owasp: 'A02:2021', fixHint: SECRET_HINT },
  { id: 'github-token', category: 'secret', severity: 'critical', title: 'GitHub token in the code', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/, secret: true, cwe: 'CWE-798', owasp: 'A07:2021', fixHint: SECRET_HINT },
  { id: 'gitlab-token', category: 'secret', severity: 'critical', title: 'GitLab token in the code', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/, secret: true, cwe: 'CWE-798', owasp: 'A07:2021', fixHint: SECRET_HINT },
  { id: 'slack-token', category: 'secret', severity: 'high', title: 'Slack token in the code', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, secret: true, cwe: 'CWE-798', owasp: 'A07:2021', fixHint: SECRET_HINT },
  { id: 'slack-webhook', category: 'secret', severity: 'high', title: 'Slack webhook address in the code', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/, secret: true, cwe: 'CWE-798', owasp: 'A07:2021', fixHint: SECRET_HINT },
  { id: 'stripe-secret-key', category: 'secret', severity: 'critical', title: 'Stripe secret key in the code', re: /\b[sr]k_live_[0-9a-zA-Z]{20,}\b/, secret: true, cwe: 'CWE-798', owasp: 'A07:2021', fixHint: SECRET_HINT },
  { id: 'sendgrid-key', category: 'secret', severity: 'high', title: 'SendGrid key in the code', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, secret: true, cwe: 'CWE-798', owasp: 'A07:2021', fixHint: SECRET_HINT },
  { id: 'npm-token', category: 'secret', severity: 'high', title: 'npm token in the code', re: /\bnpm_[A-Za-z0-9]{36}\b/, secret: true, cwe: 'CWE-798', owasp: 'A07:2021', fixHint: SECRET_HINT },
  { id: 'anthropic-key', category: 'secret', severity: 'critical', title: 'Anthropic API key in the code', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/, secret: true, cwe: 'CWE-798', owasp: 'A07:2021', fixHint: SECRET_HINT },
  { id: 'openai-key', category: 'secret', severity: 'critical', title: 'OpenAI API key in the code', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}/, secret: true, unless: (m) => m.startsWith('sk-ant-'), cwe: 'CWE-798', owasp: 'A07:2021', fixHint: SECRET_HINT },
  { id: 'rabbinatix-token', category: 'secret', severity: 'critical', title: 'Rabbinatix API token in the code', re: /\bcm_live_[A-Za-z0-9]{24,}\b/, secret: true, cwe: 'CWE-798', owasp: 'A07:2021', fixHint: 'Revoke it under Integrations → API tokens, make a new one, and keep it in the CI secrets.' },
  {
    id: 'google-api-key', category: 'secret', severity: 'medium', title: 'Google API key in the code', re: /\bAIza[0-9A-Za-z_-]{35}\b/, secret: true, cwe: 'CWE-798', owasp: 'A07:2021',
    detail: 'A Firebase web app’s API key is meant to be in the app’s code and is not a secret: dismiss it as a false alarm then. Any other Google API key is.',
    fixHint: 'If it isn’t a Firebase web key: restrict it in the Google Cloud console, or make a new one and keep it out of the code.',
  },
  {
    id: 'hardcoded-credential', category: 'hardcoded-credential', severity: 'high', title: 'A password or key written into the code',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i,
    unless: (m, line) => {
      const value = m.replace(/^[^"']*["']|["']$/g, '');
      return PLACEHOLDER.test(m) || PLACEHOLDER.test(line) || /password|secret|demo|wrong|invalid|incorrect|bad[-_]/i.test(value) || lowEntropy(value);
    },
    secret: true, cwe: 'CWE-798', owasp: 'A07:2021', fixHint: SECRET_HINT,
  },

  // ---- risky code
  { id: 'eval', category: 'code-injection', severity: 'high', title: 'eval runs text as code', re: /(?<![\w.$])eval\s*\(/, langs: [...JS, ...PY, ...PHP, ...RB], cwe: 'CWE-95', owasp: 'A03:2021', fixHint: 'Parse the data (JSON.parse, a lookup table) instead of running it.' },
  { id: 'new-function', category: 'code-injection', severity: 'medium', title: 'new Function runs text as code', re: /\bnew\s+Function\s*\(/, langs: JS, cwe: 'CWE-95', owasp: 'A03:2021', fixHint: 'Avoid building code from text; use a function written in the code.' },
  {
    id: 'shell-from-input', category: 'command-injection', severity: 'high', title: 'Shell command built from a variable', re: /\b(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+)/, langs: JS, cwe: 'CWE-78', owasp: 'A03:2021',
    fixHint: 'Use execFile/spawn with the arguments as a list, so nothing is read by a shell.',
  },
  { id: 'python-shell-true', category: 'command-injection', severity: 'high', title: 'subprocess with shell=True', re: /\bsubprocess\.\w+\([^)]*shell\s*=\s*True/, langs: PY, cwe: 'CWE-78', owasp: 'A03:2021', fixHint: 'Pass the command as a list without shell=True.' },
  { id: 'python-os-system', category: 'command-injection', severity: 'medium', title: 'os.system with a built command', re: /\bos\.(?:system|popen)\s*\(\s*(?:f["']|["'][^"']*["']\s*[+%])/, langs: PY, cwe: 'CWE-78', owasp: 'A03:2021', fixHint: 'Use subprocess.run with a list of arguments.' },
  {
    id: 'sql-concat', category: 'sql-injection', severity: 'high', title: 'SQL built from a variable',
    re: new RegExp([
      `\`\\s*${SQL}[^\`]*(?<![:@])\\$\\{`, // JS template: `SELECT … FROM t WHERE id=${id}` (`:${NAME}` builds a placeholder) rabbinatix-ignore
      `["'\`]\\s*${SQL}[^"'\`]*["'\`]\\s*\\+\\s*\\w`, // "SELECT … WHERE id=" + id
      `\\bf["']\\s*${SQL}[^"']*\\{`, // Python f-string
      `\\$@?"\\s*${SQL}[^"]*\\{`, // C# interpolation
      `["']\\s*${SQL}[^"']*%s[^"']*["']\\s*%\\s*[\\w(]`, // Python "… %s" % x
      `\\bfmt\\.Sprintf\\(\\s*"\\s*${SQL}`, // Go
      `\\bformat!\\(\\s*"\\s*${SQL}[^"]*\\{`, // Rust
    ].join('|')),
    langs: [...JS, ...PY, ...CS, ...JAVA, ...GO, ...PHP, ...RB, ...RS], cwe: 'CWE-89', owasp: 'A03:2021',
    fixHint: 'Pass the values as query parameters (placeholders), never in the SQL text.',
  },
  { id: 'tls-off-node', category: 'tls-verification-off', severity: 'high', title: 'TLS certificates aren’t checked', re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/, langs: JS, cwe: 'CWE-295', owasp: 'A07:2021', fixHint: 'Keep certificate checks on; trust a private CA with the ca option instead.' },
  { id: 'tls-off-python', category: 'tls-verification-off', severity: 'high', title: 'TLS certificates aren’t checked', re: /\bverify\s*=\s*False\b/, langs: PY, cwe: 'CWE-295', owasp: 'A07:2021', fixHint: 'Remove verify=False; point verify at a CA bundle if the server uses a private CA.' },
  { id: 'tls-off-go', category: 'tls-verification-off', severity: 'high', title: 'TLS certificates aren’t checked', re: /InsecureSkipVerify\s*:\s*true/, langs: GO, cwe: 'CWE-295', owasp: 'A07:2021', fixHint: 'Keep verification on; add the private CA to RootCAs instead.' },
  { id: 'tls-off-dotnet', category: 'tls-verification-off', severity: 'high', title: 'TLS certificates aren’t checked', re: /ServerCertificate(?:Custom)?ValidationCallback\s*=\s*\([^)]*\)\s*=>\s*true|DangerousAcceptAnyServerCertificateValidator/, langs: CS, cwe: 'CWE-295', owasp: 'A07:2021', fixHint: 'Remove the callback that accepts every certificate.' },
  { id: 'inner-html', category: 'xss', severity: 'medium', title: 'HTML set from a variable', re: /\.(?:innerHTML|outerHTML)\s*=(?!\s*(?:'[^']*'|"[^"]*"|`[^`$]*`)\s*;?\s*$)\s*\S/, langs: JS, cwe: 'CWE-79', owasp: 'A03:2021', fixHint: 'Set textContent, or sanitise the HTML first.' },
  { id: 'react-dangerous-html', category: 'xss', severity: 'medium', title: 'dangerouslySetInnerHTML', re: /dangerouslySetInnerHTML\s*=/, langs: JS, cwe: 'CWE-79', owasp: 'A03:2021', fixHint: 'Render the text, or sanitise the HTML (DOMPurify) before setting it.' },
  { id: 'angular-bypass', category: 'xss', severity: 'medium', title: 'Angular’s sanitising turned off', re: /\bbypassSecurityTrust(?:Html|Script|Style|Url|ResourceUrl)\s*\(/, langs: JS, cwe: 'CWE-79', owasp: 'A03:2021', fixHint: 'Only for values your code made, never for input.' },
  { id: 'weak-hash', category: 'weak-crypto', severity: 'medium', title: 'MD5 or SHA-1 used', re: /createHash\(\s*["'](?:md5|sha1)["']|hashlib\.(?:md5|sha1)\(|MessageDigest\.getInstance\(\s*"(?:MD5|SHA-?1)"|\b(?:MD5|SHA1)\.Create\(\)/, langs: [...JS, ...PY, ...JAVA, ...CS], cwe: 'CWE-327', owasp: 'A02:2021', fixHint: 'Use SHA-256 for checksums; bcrypt, scrypt or Argon2 for passwords.' },
  { id: 'weak-hash-php', category: 'weak-crypto', severity: 'medium', title: 'MD5 or SHA-1 used', re: /(?<![\w>$])(?:md5|sha1)\s*\(/, langs: PHP, cwe: 'CWE-327', owasp: 'A02:2021', fixHint: 'Use SHA-256 for checksums; bcrypt, scrypt or Argon2 for passwords.' },
  { id: 'pickle', category: 'insecure-deserialization', severity: 'medium', title: 'pickle reads untrusted data as code', re: /\bpickle\.loads?\s*\(/, langs: PY, cwe: 'CWE-502', owasp: 'A08:2021', fixHint: 'Use JSON for data from outside.' },
  { id: 'yaml-load', category: 'insecure-deserialization', severity: 'medium', title: 'yaml.load without a safe loader', re: /\byaml\.load\s*\((?![^)]*(?:SafeLoader|safe_load|CSafeLoader))/, langs: PY, cwe: 'CWE-502', owasp: 'A08:2021', fixHint: 'Use yaml.safe_load.' },
  { id: 'jwt-none', category: 'broken-auth', severity: 'high', title: 'JWT “none” algorithm allowed', re: /algorithms?\s*[:=]\s*\[?[^\]\n]*["']none["']/i, langs: [...JS, ...PY], cwe: 'CWE-347', owasp: 'A07:2021', fixHint: 'Allow only the algorithm the tokens are signed with.' },
  { id: 'jwt-no-verify', category: 'broken-auth', severity: 'high', title: 'JWT read without checking the signature', re: /jwt\.decode\([^)]*verify\s*=\s*False|options\s*=\s*\{\s*["']verify_signature["']\s*:\s*False/, langs: PY, cwe: 'CWE-347', owasp: 'A07:2021', fixHint: 'Verify the signature (jwt.decode with the key and algorithms).' },
  {
    id: 'sql-interpolation', category: 'sql-injection', severity: 'high', title: 'SQL built from a variable',
    // "SELECT … $id" / "${id}" (Kotlin, Dart, PHP, Ruby's #{}), "\(id)" (Swift)
    re: new RegExp(`["']\\s*${SQL}[^"']*(?:\\$\\{?[A-Za-z_]|#\\{|\\\\\\()`),
    langs: ['kotlin', 'scala', ...PHP, ...RB, ...SWIFT, ...DART], cwe: 'CWE-89', owasp: 'A03:2021',
    fixHint: 'Pass the values as query parameters (placeholders), never in the SQL text.',
  },
  { id: 'go-shell', category: 'command-injection', severity: 'high', title: 'Shell command built from a variable', re: /\bexec\.Command(?:Context)?\(\s*(?:ctx\s*,\s*)?"(?:sh|bash|cmd)"\s*,\s*"(?:-c|\/c)"\s*,(?!\s*"[^"]*"\s*\))/, langs: GO, cwe: 'CWE-78', owasp: 'A03:2021', fixHint: 'Run the program itself with its arguments as a list, without a shell.' },
  { id: 'jvm-runtime-exec', category: 'command-injection', severity: 'medium', title: 'Shell command built from a variable', re: /\bRuntime\.getRuntime\(\)\.exec\(\s*(?:"[^"]*"\s*\+|[a-z_$][\w$]*\s*\)|"[^"]*\$)/, langs: JAVA, cwe: 'CWE-78', owasp: 'A03:2021', fixHint: 'Use ProcessBuilder with the arguments as a list.' },
  { id: 'ruby-shell', category: 'command-injection', severity: 'high', title: 'Shell command built from a variable', re: /(?:\b(?:system|exec|spawn|%x)\s*\(?\s*"[^"]*#\{|`[^`]*#\{)/, langs: RB, cwe: 'CWE-78', owasp: 'A03:2021', fixHint: 'Pass the command and its arguments separately: system("prog", arg).' },
  { id: 'php-shell', category: 'command-injection', severity: 'high', title: 'Shell command built from a variable', re: /\b(?:system|exec|shell_exec|passthru|popen|proc_open)\s*\(\s*(?:\$|["'][^"']*["']\s*\.\s*\$|"[^"]*\$)/, langs: PHP, cwe: 'CWE-78', owasp: 'A03:2021', fixHint: 'Avoid the shell; if you must, wrap each value in escapeshellarg().' },
  { id: 'rust-shell', category: 'command-injection', severity: 'high', title: 'Shell command built from a variable', re: /Command::new\(\s*"(?:sh|bash|cmd)"\s*\)[^;]*\.arg\(\s*"(?:-c|\/C)"\s*\)[^;]*\.arg\(\s*&?(?:format!|[a-z_])/, langs: RS, cwe: 'CWE-78', owasp: 'A03:2021', fixHint: 'Run the program itself: Command::new(program).args([...]).' },
  { id: 'php-unserialize', category: 'insecure-deserialization', severity: 'high', title: 'unserialize on request data', re: /\bunserialize\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE)/, langs: PHP, cwe: 'CWE-502', owasp: 'A08:2021', fixHint: 'Use json_decode for data from outside.' },
  { id: 'ruby-marshal', category: 'insecure-deserialization', severity: 'medium', title: 'Marshal.load reads untrusted data as code', re: /\bMarshal\.load\s*\(/, langs: RB, cwe: 'CWE-502', owasp: 'A08:2021', fixHint: 'Use JSON for data from outside.' },
  { id: 'dotnet-binaryformatter', category: 'insecure-deserialization', severity: 'high', title: 'BinaryFormatter reads untrusted data as code', re: /\bnew\s+(?:BinaryFormatter|NetDataContractSerializer|LosFormatter)\s*\(/, langs: CS, cwe: 'CWE-502', owasp: 'A08:2021', fixHint: 'Use System.Text.Json.' },
  { id: 'java-object-input', category: 'insecure-deserialization', severity: 'medium', title: 'Java serialization reads untrusted data as code', re: /\bnew\s+ObjectInputStream\s*\(/, langs: JAVA, cwe: 'CWE-502', owasp: 'A08:2021', fixHint: 'Use JSON for data from outside, or an ObjectInputFilter that allows only your classes.' },
  { id: 'weak-hash-more', category: 'weak-crypto', severity: 'medium', title: 'MD5 or SHA-1 used', re: /\b(?:md5|sha1)\.(?:New|Sum)\(|\bDigest::(?:MD5|SHA1)\b|\bInsecure\.(?:MD5|SHA1)\b|\bCC_(?:MD5|SHA1)\s*\(|\b(?:md5|sha1)\.convert\(|\b(?:Md5|Sha1)::new\(\)|\bmd5::compute\(/, langs: [...GO, ...RB, ...SWIFT, ...DART, ...RS], cwe: 'CWE-327', owasp: 'A02:2021', fixHint: 'Use SHA-256 for checksums; bcrypt, scrypt or Argon2 for passwords.' },

  // ---- certificate checks turned off (mobile apps and Rust)
  { id: 'tls-off-rust', category: 'tls-verification-off', severity: 'high', title: 'TLS certificates aren’t checked', re: /\.danger_accept_invalid_(?:certs|hostnames)\(\s*true\s*\)|\.dangerous\(\)\s*\.set_certificate_verifier\(/, langs: RS, cwe: 'CWE-295', owasp: 'A07:2021', fixHint: 'Keep verification on; add the private CA with add_root_certificate instead.' },
  { id: 'tls-off-dart', category: 'tls-verification-off', severity: 'high', title: 'TLS certificates aren’t checked', re: /badCertificateCallback\s*=\s*\([^)]*\)\s*(?:=>\s*true|\{\s*return\s+true)/, langs: DART, cwe: 'CWE-295', owasp: 'A07:2021', fixHint: 'Remove the badCertificateCallback that accepts every certificate; trust a private CA with SecurityContext instead.' },
  { id: 'tls-off-swift', category: 'tls-verification-off', severity: 'high', title: 'TLS certificates aren’t checked', re: /completionHandler\(\s*\.useCredential\s*,\s*URLCredential\(\s*trust:|\bDisabled(?:Trust)?Evaluator\(\)|\ballowInvalidCertificates\s*=\s*YES/, langs: SWIFT, cwe: 'CWE-295', owasp: 'A07:2021', fixHint: 'Let URLSession check the server’s certificate (call completionHandler(.performDefaultHandling, nil)); pin a certificate instead of trusting all.' },
  {
    id: 'tls-off-jvm', category: 'tls-verification-off', severity: 'high', title: 'TLS certificates aren’t checked',
    re: /\bcheckServerTrusted\s*\([^)]*\)\s*(?::\s*Unit\s*)?(?:(?:throws\s+[\w.,\s]+)?\{\s*\}|=\s*Unit\b)|hostnameVerifier\s*\{\s*_\s*,\s*_\s*->\s*true\s*\}|\(\s*\w+\s*,\s*\w+\s*\)\s*->\s*true\s*\)|\bALLOW_ALL_HOSTNAME_VERIFIER\b|\bNoopHostnameVerifier\b|\bhandler\??\.proceed\(\)/,
    langs: JVM, cwe: 'CWE-295', owasp: 'A07:2021', fixHint: 'Remove the trust manager, hostname verifier or onReceivedSslError that accepts everything; trust a private CA with a network security config instead.',
  },
  {
    id: 'ios-arbitrary-loads', category: 'tls-verification-off', severity: 'medium', title: 'App Transport Security turned off', re: /<key>NSAllows(?:Arbitrary|Local)?Loads(?:InWebContent|ForMedia)?<\/key>/,
    unless: (m, line, next) => /NSAllowsLocalNetworking/.test(m) || /<false\s*\/>/.test(line.slice(line.indexOf(m) + m.length)) || (!/<true\s*\/>/.test(line.slice(line.indexOf(m) + m.length)) && /<false\s*\/>/.test(next)),
    files: PLIST, cwe: 'CWE-319', owasp: 'A02:2021', fixHint: 'Remove NSAllowsArbitraryLoads; add an exception domain only for a server that can’t use HTTPS yet.',
  },
  { id: 'android-cleartext', category: 'tls-verification-off', severity: 'medium', title: 'Unencrypted HTTP allowed', re: /\b(?:android:usesCleartextTraffic|cleartextTrafficPermitted)\s*=\s*"true"/, files: ANDROID_XML, cwe: 'CWE-319', owasp: 'A02:2021', fixHint: 'Use HTTPS; allow cleartext only for a debug build’s local address in a network security config.' },
  { id: 'android-debuggable', category: 'misconfiguration', severity: 'medium', title: 'The app is debuggable', re: /\bandroid:debuggable\s*=\s*"true"/, files: ANDROID_XML, cwe: 'CWE-489', owasp: 'A05:2021', fixHint: 'Remove android:debuggable; the build type sets it for debug builds only.' },
  { id: 'android-webview-bridge', category: 'xss', severity: 'medium', title: 'Web page given access to app code', re: /\baddJavascriptInterface\s*\(/, langs: JVM, cwe: 'CWE-749', owasp: 'A03:2021', fixHint: 'Only for pages your app ships; never for a page loaded from the web.' },

  // ---- secrets in mobile app files and plain app storage
  {
    id: 'android-resource-secret', category: 'hardcoded-credential', severity: 'high', title: 'A key or password in the app’s resources',
    re: /<string\s+name="([^"]*(?:api_?key|secret|token|password)[^"]*)"[^>]*>([^<\s]{12,})<\/string>/i,
    unless: (m) => /name="google_(?:api_key|crash_reporting_api_key|app_id)"|name="[^"]*(?:hint|label|title|error|message|prompt)[^"]*"/i.test(m) || PLACEHOLDER.test(/>([^<]*)</.exec(m)?.[1] ?? ''),
    files: ANDROID_RES, secret: true, cwe: 'CWE-798', owasp: 'A07:2021', fixHint: `Anything in an app can be read out of it. ${SECRET_HINT} Keep server keys on your server and call it.`,
  },
  {
    id: 'mobile-plain-storage', category: 'sensitive-data-exposure', severity: 'medium', title: 'A token or password kept in plain app storage',
    re: /\bUserDefaults\b[^\n]*\.set\([^)]*forKey:\s*"[^"]*(?:token|password|secret|pin)[^"]*"|\.putString\(\s*"[^"]*(?:token|password|secret)[^"]*"|\.setString\(\s*['"][^'"]*(?:token|password|secret)[^'"]*['"]/i,
    langs: [...SWIFT, ...JVM, ...DART], cwe: 'CWE-312', owasp: 'A04:2021', fixHint: STORAGE_HINT,
  },
  { id: 'insecure-random', category: 'weak-random', severity: 'low', title: 'Math.random for a secret value', re: /\b(?:token|secret|password|nonce|salt|otp)\w*\s*[:=][^;\n]*Math\.random\(\)/i, langs: JS, cwe: 'CWE-338', owasp: 'A02:2021', fixHint: 'Use crypto.randomBytes or crypto.getRandomValues.' },
];

/** the line with each secret shortened to its first four characters and dots, cut to 300 characters */
export function masked(line: string, secret?: string): string {
  let out = line.trim();
  if (secret) out = out.split(secret).join(`${secret.slice(0, 4)}•••`);
  return out.length > 300 ? `${out.slice(0, 297)}…` : out;
}

/** the built-in rules on one file's text */
export function scanText(file: string, text: string): Finding[] {
  const lang = languageOfFile(file)?.id;
  const testish = isTestOrExampleFile(file);
  const out: Finding[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line.length > 2000 || line.includes('rabbinatix-ignore')) return;
    let knownSecret = false;
    for (const r of RULES) {
      if (r.langs && (!lang || !r.langs.includes(lang))) continue;
      if (r.files && !r.files.test(file.replace(/\\/g, '/'))) continue;
      if (!r.secret && (testish || isCommentLine(file, line))) continue;
      if ((r.id === 'hardcoded-credential' || r.id === 'android-resource-secret') && testish) continue;
      const m = r.re.exec(line);
      if (!m) continue;
      if (r.unless?.(m[0], line, lines[i + 1] ?? '')) continue;
      const value = r.secret ? (m[2] ?? m[1] ?? m[0]) : undefined;
      if (value && r.id !== 'private-key' && fakeValue(value)) continue;
      // a key in a known format is reported as that (e.g. a Firebase web key as a Google API key), not as a password too
      if (r.id === 'hardcoded-credential' && knownSecret) continue;
      if (r.secret) knownSecret = true;
      out.push({
        file, line: i + 1, category: r.category, severity: r.severity, title: r.title, snippet: masked(line, value), rule: `rabbinatix:${r.id}`,
        ...(r.detail ? { detail: r.detail } : {}), ...(r.fixHint ? { fixHint: r.fixHint } : {}), ...(r.cwe ? { cwe: r.cwe } : {}), ...(r.owasp ? { owasp: r.owasp } : {}),
      });
    }
  });
  return out;
}

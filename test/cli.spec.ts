import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, parseArgs } from '../src/cli.js';
import { isCommentOrBlank, parseDiff, rangesText } from '../src/diff.js';
import { safeRemote } from '../src/git.js';
import { repo, TSCONFIG } from './repo.js';

let r: ReturnType<typeof repo> | undefined;
let server: http.Server | undefined;
afterEach(() => {
  r?.done();
  server?.close();
});

const LOGIN = `// FDD:LOGIC-AUTH-LOGIN-001 r9 Sign in\nexport function login(email: string) {\n  // FDD:NODE-AUTH-LOGIN-007 Find the user\n  return { email };\n}\n`;
const SECRET = 'const API_KEY = "sk_live_should_never_leave";';

function changed() {
  r = repo({ 'tsconfig.json': TSCONFIG, 'src/login.ts': LOGIN, 'src/other.ts': 'export const x = 1;\n' });
  r.write('src/login.ts', LOGIN.replace('return { email };', `${SECRET}\n  return { email, k: API_KEY };`));
  return r;
}

/** a fake Rabbinatix: records what it was sent, answers `answer` */
function fakeApi(answer: unknown, status = 200): Promise<{ url: string; got: { body?: unknown; auth?: string }[] }> {
  const got: { body?: unknown; auth?: string }[] = [];
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      got.push({ body: JSON.parse(data), auth: req.headers.authorization });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  return new Promise((ok) => server!.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server!.address() as { port: number }).port}/api/v1`, got })));
}

const report = (o: { mustLook?: boolean; critical?: number } = {}) => ({
  report: { starts: [{}], triage: [{ kind: 'contract', mustLook: !!o.mustLook }], dimensions: { far: { criticalFlows: o.critical ?? 0 } } },
  markdown: '### Rabbinatix · what this change affects\n\nCheckout (critical)',
});

const capture = () => {
  const out: string[] = [], err: string[] = [];
  return { out, err, log: (s: string) => out.push(s), warn: (s: string) => err.push(s) };
};

describe('the command', () => {
  it('--dry-run prints what would be sent: keys, names, paths and lines, never the code', async () => {
    const x = changed();
    const c = capture();
    expect(await main(['--base', 'main', '--dry-run'], x.dir, {}, c.log, c.warn)).toBe(0);
    const sent = c.out.join('\n');
    expect(JSON.parse(sent).reached).toEqual([expect.objectContaining({ ref: 'LOGIC-AUTH-LOGIN-001', revision: 9, steps: ['NODE-AUTH-LOGIN-007'] })]);
    expect(sent).not.toContain('sk_live');
    expect(sent).not.toContain('return');
  });

  it('one call with the token; prints the words and writes the comment and the JSON', async () => {
    const x = changed();
    const api = await fakeApi(report());
    const c = capture();
    const code = await main(['--base', 'main', '--api', api.url, '--comment', 'c.md', '--out', 'o.json', '--title', 'Lock accounts'], x.dir, { RABBINATIX_TOKEN: 'cm_live_t' }, c.log, c.warn);
    expect(code).toBe(0);
    expect(api.got).toHaveLength(1);
    expect(api.got[0].auth).toBe('Bearer cm_live_t');
    expect((api.got[0].body as { change: { title: string } }).change.title).toBe('Lock accounts');
    expect(JSON.stringify(api.got[0].body)).not.toContain('sk_live');
    expect(c.out.join('\n')).toContain('Checkout (critical)');
    expect(fs.readFileSync(path.join(x.dir, 'c.md'), 'utf8')).toContain('Checkout');
    expect(JSON.parse(fs.readFileSync(path.join(x.dir, 'o.json'), 'utf8')).report).toBeTruthy();
  });

  it('the policy decides the exit code: breaks fails on a contract to look at, critical also on a critical flow', async () => {
    const x = changed();
    const env = { RABBINATIX_TOKEN: 't' };
    let api = await fakeApi(report({ mustLook: true }));
    expect(await main(['--base', 'main', '--api', api.url, '--fail-on', 'breaks'], x.dir, env, () => {}, () => {})).toBe(1);
    expect(await main(['--base', 'main', '--api', api.url], x.dir, env, () => {}, () => {})).toBe(0);
    server!.close();
    api = await fakeApi(report({ critical: 1 }));
    expect(await main(['--base', 'main', '--api', api.url, '--fail-on', 'breaks'], x.dir, env, () => {}, () => {})).toBe(0);
    expect(await main(['--base', 'main', '--api', api.url, '--fail-on', 'critical'], x.dir, env, () => {}, () => {})).toBe(1);
    const c = capture();
    expect(await main(['--base', 'main', '--api', api.url, '--fail-on', 'warn'], x.dir, env, c.log, c.warn)).toBe(0);
    expect(c.out.join('\n')).toContain('⚠');
    // a critical flow alone breaks nothing: no “fix what this change broke” prompt
    expect(c.out.join('\n')).not.toContain('AI prompt (fix what this change broke)');
    server!.close();
    // a contract that may break, and changed code not on the map: both prompts, printed but not in the comment
    api = await fakeApi({ ...report({ mustLook: true }), report: { ...report({ mustLook: true }).report, notMapped: [{ file: 'src/util/date.ts' }] } });
    const d = capture();
    expect(await main(['--base', 'main', '--api', api.url, '--comment', 'c.md'], x.dir, env, d.log, d.warn)).toBe(0);
    expect(d.out.join('\n')).toContain('AI prompt (fix what this change broke): In Rabbinatix, read the impact of my change');
    expect(d.out.join('\n')).toContain('AI prompt (put the changed code that isn’t on the map on it):');
    expect(d.out.join('\n')).toContain('src/util/date.ts');
    expect(fs.readFileSync(path.join(x.dir, 'c.md'), 'utf8')).not.toContain('AI prompt');
  });

  it('nothing on the map: answered here, no call, no token needed', async () => {
    r = repo({ 'tsconfig.json': TSCONFIG, 'src/other.ts': 'export const x = 1;\n' });
    r.write('src/other.ts', 'export const x = 2;\n');
    const api = await fakeApi(report());
    const c = capture();
    expect(await main(['--base', 'main', '--api', api.url], r.dir, {}, c.log, c.warn)).toBe(0);
    expect(api.got).toHaveLength(0);
    expect(c.out.join('\n')).toContain('run all tests');
    expect(c.out.join('\n')).toContain('src/other.ts:1');
  });

  it('says what is missing: no token, no address, an error from Rabbinatix', async () => {
    const x = changed();
    const c = capture();
    expect(await main(['--base', 'main', '--api', 'http://127.0.0.1:1/api/v1'], x.dir, {}, c.log, c.warn)).toBe(2);
    expect(c.err.join('\n')).toContain('RABBINATIX_TOKEN');
    expect(await main(['--base', 'main'], x.dir, { RABBINATIX_TOKEN: 't' }, c.log, c.warn)).toBe(2);
    expect(c.err.join('\n')).toContain('RABBINATIX_API');
    const api = await fakeApi({ error: 'This token lacks the read scope.' }, 403);
    expect(await main(['--base', 'main', '--api', api.url], x.dir, { RABBINATIX_TOKEN: 't' }, c.log, c.warn)).toBe(2);
    expect(c.err.join('\n')).toContain('read scope');
  });

  it('refuses unknown options and bad values', () => {
    expect(() => parseArgs(['--nope'])).toThrow('Unknown option');
    expect(() => parseArgs(['--fail-on', 'always'])).toThrow('--fail-on');
    expect(() => parseArgs(['--depth', '99'])).toThrow('--depth');
    expect(parseArgs(['--store', '--format', 'json'])).toMatchObject({ store: true, format: 'json', failOn: 'inform' });
  });
});

describe('small parts', () => {
  it('reads a diff: added ranges, pure removals, renames, deletions', () => {
    const d = parseDiff([
      'diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -3,0 +4,2 @@', '+x', '+y', '@@ -9,2 +10,0 @@', '-p', '-q',
      'diff --git a/old.ts b/new.ts', 'similarity index 90%', 'rename from old.ts', 'rename to new.ts', '--- a/old.ts', '+++ b/new.ts', '@@ -1 +1 @@', '-a', '+b',
      'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-z',
    ].join('\n'));
    expect(d.map((f) => [f.path, f.status])).toEqual([['a.ts', 'modified'], ['new.ts', 'renamed'], ['gone.ts', 'deleted']]);
    expect(d[0].added).toEqual([[4, 5]]);
    expect(d[0].removedAt).toEqual([11]);
    expect(d[1].oldPath).toBe('old.ts');
  });

  it('comment lines, ranges, and a remote without its credentials', () => {
    expect(['// x', ' * y', '', '# z', '/* a */'].every(isCommentOrBlank)).toBe(true);
    expect(isCommentOrBlank('const a = 1; // x')).toBe(false);
    expect(rangesText([1, 2, 3, 7, 9, 10])).toBe('1-3, 7, 9-10');
    expect(safeRemote('https://user:ghp_secret@github.com/acme/shop.git')).toBe('https://github.com/acme/shop');
  });
});

describe('comparing two commits or branches (code-impact-compare-plan.md part A)', () => {
  const OTHER = (n: number) => `// FDD:LOGIC-OTHER-001 r2 Other\nexport function other() {\n  return ${n};\n}\n`;
  /** main: login at r9; feature/login: login changed and committed; main moves on with other.ts; checkout back on main */
  function branches() {
    r = repo({ 'tsconfig.json': TSCONFIG, 'src/login.ts': LOGIN, 'src/other.ts': OTHER(1) });
    r.git('checkout', '-q', '-b', 'feature/login');
    r.write('src/login.ts', LOGIN.replace('return { email };', 'return { email, at: Date.now() };'));
    r.commit('change login');
    r.git('checkout', '-q', 'main');
    r.write('src/other.ts', OTHER(2));
    r.commit('change other');
    return r;
  }
  const sent = (c: ReturnType<typeof capture>) => JSON.parse(c.out.join('\n')) as { reached: { ref: string }[]; change: Record<string, unknown> };
  const worktrees = (x: ReturnType<typeof repo>) => x.git('worktree', 'list').trim().split('\n').length;

  it('--head reads a branch that isn’t checked out, from where it left the base; the checkout is untouched', async () => {
    const x = branches();
    const c = capture();
    expect(await main(['--base', 'main', '--head', 'feature/login', '--dry-run'], x.dir, {}, c.log, c.warn)).toBe(0);
    const b = sent(c);
    expect(b.reached.map((y) => y.ref)).toEqual(['LOGIC-AUTH-LOGIN-001']);
    expect(b.change).toMatchObject({ kind: 'compare', base: 'main', head: 'feature/login', title: 'main → feature/login', branch: 'feature/login' });
    expect(b.change['baseCommit']).toBe(x.git('rev-parse', 'main').trim());
    expect(b.change['headCommit']).toBe(x.git('rev-parse', 'feature/login').trim());
    expect(b.change['commit']).toBe(b.change['headCommit']);
    expect(b.change['straight']).toBeUndefined();
    expect(x.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(fs.readFileSync(path.join(x.dir, 'src/login.ts'), 'utf8')).toBe(LOGIN);
    expect(worktrees(x)).toBe(1);
    expect(c.err.join('\n')).toContain('temporary copy');
  });

  it('--straight compares both sides directly: the base’s own changes count too', async () => {
    const x = branches();
    const c = capture();
    expect(await main(['--base', 'main', '--head', 'feature/login', '--straight', '--dry-run'], x.dir, {}, c.log, c.warn)).toBe(0);
    const b = sent(c);
    expect(b.reached.map((y) => y.ref).sort()).toEqual(['LOGIC-AUTH-LOGIN-001', 'LOGIC-OTHER-001']);
    expect(b.change['straight']).toBe(true);
  });

  it('git’s range words: a...b from where they split, a..b directly', async () => {
    expect(parseArgs(['main...feature/login'])).toMatchObject({ base: 'main', head: 'feature/login', straight: false });
    expect(parseArgs(['v1.2.0..v1.3.0', '--store'])).toMatchObject({ base: 'v1.2.0', head: 'v1.3.0', straight: true, store: true });
    expect(() => parseArgs(['main'])).toThrow('Unknown option');
    const x = branches();
    const c = capture();
    expect(await main(['main..feature/login', '--dry-run'], x.dir, {}, c.log, c.warn)).toBe(0);
    expect(sent(c).reached).toHaveLength(2);
  });

  it('a head that is this checkout, unchanged, is read in place (no temporary copy)', async () => {
    const x = branches();
    x.git('checkout', '-q', 'feature/login');
    const c = capture();
    expect(await main(['--base', 'main', '--head', 'HEAD', '--dry-run'], x.dir, {}, c.log, c.warn)).toBe(0);
    expect(sent(c).reached.map((y) => y.ref)).toEqual(['LOGIC-AUTH-LOGIN-001']);
    expect(c.err.join('\n')).not.toContain('temporary copy');
  });

  it('the temporary copy is removed after an error too', async () => {
    const x = branches();
    const c = capture();
    // no token and no --dry-run: the call fails after the analysis
    expect(await main(['--base', 'main', '--head', 'feature/login', '--api', 'http://127.0.0.1:9/api/v1'], x.dir, {}, c.log, c.warn)).toBe(2);
    expect(worktrees(x)).toBe(1);
  });

  it('an unknown ref, --straight without --head: exit 2 with words that say what to do', async () => {
    const x = branches();
    let c = capture();
    expect(await main(['--base', 'main', '--head', 'nope', '--dry-run'], x.dir, {}, c.log, c.warn)).toBe(2);
    expect(c.err.join('\n')).toContain('git fetch origin nope');
    c = capture();
    expect(await main(['--base', 'main', '--straight'], x.dir, {}, c.log, c.warn)).toBe(2);
    expect(c.err.join('\n')).toContain('--straight needs --head');
  });

  it('no shared history (a shallow clone): says to fetch more, or compare directly', async () => {
    const x = branches();
    x.git('checkout', '-q', '--orphan', 'alone');
    x.commit('alone');
    const c = capture();
    expect(await main(['--base', 'main', '--head', 'alone', '--dry-run'], x.dir, {}, c.log, c.warn)).toBe(2);
    expect(c.err.join('\n')).toContain('git fetch --unshallow');
  });

  it('the kind of change and who ran it: work in progress, a pull request in CI, an assistant', async () => {
    const x = changed();
    let c = capture();
    await main(['--base', 'main', '--dry-run'], x.dir, {}, c.log, c.warn);
    expect(sent(c).change).toMatchObject({ kind: 'work-in-progress' });
    expect(sent(c).change['ranBy']).toBeUndefined();
    c = capture();
    await main(['--base', 'main', '--dry-run'], x.dir, { CI_MERGE_REQUEST_IID: '4', CLAUDECODE: '1' }, c.log, c.warn);
    expect(sent(c).change).toMatchObject({ kind: 'pull-request', ranBy: 'assistant' });
    c = capture();
    await main(['--base', 'main', '--run-by', 'assistant', '--dry-run'], x.dir, {}, c.log, c.warn);
    expect(sent(c).change['ranBy']).toBe('assistant');
    expect(() => parseArgs(['--run-by', 'robot'])).toThrow('--run-by');
  });
});

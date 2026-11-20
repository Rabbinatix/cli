// The few git commands the CLI runs (no shell: arguments are passed as a list).
import { execFileSync } from 'node:child_process';

export const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (cwd: string, args: string[]) => {
  try {
    return git(cwd, args).trim();
  } catch {
    return '';
  }
};

export const repoRoot = (cwd: string) => git(cwd, ['rev-parse', '--show-toplevel']).trim();

/** the base to compare with: given, the pull request's target in CI, else origin's default branch, else main/master */
export function defaultBase(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const ci = env['GITHUB_BASE_REF'] || env['CI_MERGE_REQUEST_TARGET_BRANCH_NAME'];
  if (ci) return `origin/${ci}`;
  const head = tryGit(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head) return head.replace(/^refs\/remotes\//, '');
  for (const b of ['origin/main', 'origin/master', 'origin/develop', 'main', 'master']) if (tryGit(cwd, ['rev-parse', '--verify', '--quiet', b])) return b;
  return 'HEAD';
}

/** the commit the change starts from: where the branch left the base */
export const mergeBase = (cwd: string, base: string) => tryGit(cwd, ['merge-base', base, 'HEAD']) || git(cwd, ['rev-parse', base]).trim();

/** the change: the base's commit against the working tree (what is committed and what isn't yet), or against `head` */
export const diffText = (cwd: string, from: string, head?: string) => git(cwd, ['-c', 'core.quotepath=off', 'diff', '--unified=0', '--no-color', '--no-ext-diff', '-M', from, ...(head ? [head] : []), '--']);

/** a branch, tag or commit as its commit id; a clear error when it isn't here */
export function commitOf(cwd: string, ref: string): string {
  const sha = ref.startsWith('-') ? '' : tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!sha) throw new Error(`No commit or branch called “${ref}” here. Fetch it first: git fetch origin ${ref}`);
  return sha;
}

/** where `head` left `base`; a clear error when the history isn't there (a shallow clone in CI) */
export function splitPoint(cwd: string, base: string, head: string): string {
  const at = tryGit(cwd, ['merge-base', base, head]);
  if (!at) throw new Error('Not enough history to compare these two. In CI, fetch more first: git fetch --unshallow (GitLab: GIT_DEPTH: 0; GitHub: fetch-depth: 0). Or compare them directly with --straight.');
  return at;
}

/** `base..head` (directly) or `base...head` (from where they split) as git writes ranges, or null */
export function parseRange(arg: string): { base: string; head: string; straight: boolean } | null {
  const m = /^([^.\s][^\s]*?)(\.\.\.?)([^.\s][^\s]*)$/.exec(arg);
  return m ? { base: m[1], head: m[3], straight: m[2] === '..' } : null;
}

/** the files of `commit`, to read: the repo itself when it is checked out there with nothing changed (its installed
 *  packages stay readable), else a temporary detached worktree; `done` removes it (call it in a finally) */
export function checkoutOf(root: string, commit: string, tmpDir: string): { dir: string; temporary: boolean; done: () => void } {
  const clean = tryGit(root, ['rev-parse', 'HEAD']) === commit && tryGit(root, ['status', '--porcelain', '--untracked-files=no']) === '';
  if (clean) return { dir: root, temporary: false, done: () => undefined };
  git(root, ['worktree', 'add', '--detach', '--quiet', tmpDir, commit]);
  return {
    dir: tmpDir, temporary: true,
    done: () => {
      try {
        git(root, ['worktree', 'remove', '--force', tmpDir]);
      } catch {
        // already gone: still drop git's note of it
        tryGit(root, ['worktree', 'prune']);
      }
    },
  };
}

/** a file as it was at a commit, or null */
export function showAt(cwd: string, commit: string, file: string): string | null {
  try {
    return git(cwd, ['show', `${commit}:${file}`]);
  } catch {
    return null;
  }
}

/** a remote URL without credentials (`https://user:token@host/x` → `https://host/x`) */
export const safeRemote = (url: string) => url.replace(/^(\w+:\/\/)[^@/]+@/, '$1').replace(/\.git$/, '');

/** two commits or branches compared: both sides as typed, their commits, and how */
export interface Compared { base: string; head: string; baseCommit: string; headCommit: string; straight: boolean }

/** an AI assistant runs this CLI: its tool's own variable (Claude Code sets CLAUDECODE=1) */
export const ranByAssistant = (env: NodeJS.ProcessEnv) => env['CLAUDECODE'] === '1';

/** where the change is: title, branch, commit and repo, from the flags, the CI environment, then git; what kind of
 *  change it is (a pull request, two commits or branches, the work in this checkout); both sides of a comparison */
export function changeInfo(cwd: string, o: { title?: string; url?: string; compared?: Compared; ranBy?: 'assistant' }, env: NodeJS.ProcessEnv = process.env): Record<string, string | boolean> {
  const c = o.compared;
  const inPr = !!(env['GITHUB_HEAD_REF'] || env['CI_MERGE_REQUEST_IID'] || env['CI_MERGE_REQUEST_SOURCE_BRANCH_NAME']);
  const branch = c ? c.head : env['GITHUB_HEAD_REF'] || env['CI_MERGE_REQUEST_SOURCE_BRANCH_NAME'] || tryGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const commit = c ? c.headCommit : env['GITHUB_SHA'] && !env['GITHUB_HEAD_REF'] ? env['GITHUB_SHA'] : tryGit(cwd, ['rev-parse', 'HEAD']);
  const title = o.title || (c ? `${c.base} → ${c.head}` : env['CI_MERGE_REQUEST_TITLE'] || tryGit(cwd, ['log', '-1', '--pretty=%s']));
  const remote = tryGit(cwd, ['remote', 'get-url', 'origin']);
  const kind = c ? 'compare' : o.url || inPr ? 'pull-request' : 'work-in-progress';
  return Object.fromEntries(Object.entries({
    title, branch, commit, url: o.url, repo: remote ? safeRemote(remote) : '', kind,
    ...(c ? { base: c.base, head: c.head, baseCommit: c.baseCommit, headCommit: c.headCommit, ...(c.straight ? { straight: true } : {}) } : {}),
    ...(o.ranBy ? { ranBy: o.ranBy } : {}),
  }).filter(([, v]) => !!v)) as Record<string, string | boolean>;
}

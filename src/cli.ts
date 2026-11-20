// rabbinatix impact: what a code change affects, in behaviour (docs/04-roadmap/code-impact-plan.md § Phase B).
// Reads the diff and the code here, on this machine; sends Rabbinatix only keys, names, file paths and line numbers;
// makes one call per run, or none when the change reaches nothing on the map.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyze } from './analyze.js';
import { postImpact } from './api.js';
import { connection } from './connect.js';
import { parseDiff } from './diff.js';
import { changeInfo, checkoutOf, commitOf, Compared, defaultBase, diffText, mergeBase, parseRange, ranByAssistant, repoRoot, showAt, splitPoint } from './git.js';
import { fails, localMarkdown, Policy, requestBody, worthAsking } from './output.js';
import { impactPrompts } from './from-app/features/assistant/prompts';

const HELP = `rabbinatix impact: what this change affects in Rabbinatix (flows, contracts, test cases to run)

Usage: rabbinatix impact [options]
       rabbinatix impact <base>...<head>   what <head> adds since it left <base> (from where they split)
       rabbinatix impact <base>..<head>    every difference between the two (compared directly)

  --base <ref>         the older side: a branch, tag or commit (default: the PR's target in CI, else origin's default branch)
  --head <ref>         the newer side (default: this checkout, with what isn't committed yet). Read from a temporary
                       copy of the repo when it isn't checked out here; your checkout is never touched
  --straight           compare --base and --head directly, not from where they split
  --run-by assistant   say that an AI assistant ran this (shown on the report; Claude Code is found by itself)
  --api <url>          the API address, from Integrations → API & CI (or RABBINATIX_API)
  --token-env <name>   the environment variable holding the API token (default RABBINATIX_TOKEN)
  --store              keep the report in Rabbinatix (the token needs the deploy scope); prints its link
  --format <md|json>   what to print (default md)
  --out <file>         also write the answer as JSON (default: none)
  --comment <file>     also write the Markdown, for a pull request comment
  --fail-on <policy>   inform (default): never fail · warn: never fail, headline says so ·
                       breaks: fail when a contract may break · critical: also when a critical flow is affected
  --title <text>       the change's title (default: the last commit's subject)
  --url <url>          the pull request's address, shown in Rabbinatix
  --tsconfig <file>    the tsconfig.json to read the code with (default: the one at the repo root)
  --depth <n>          how many callers back to follow (default 6)
  --dry-run            print what would be sent and send nothing
  -h, --help           this help

Examples:
  rabbinatix impact --base main                          your work in progress against main
  rabbinatix impact --base main --head feature/login     what the branch adds to main
  rabbinatix impact v1.2.0..v1.3.0 --store               everything between two releases, kept in Rabbinatix

Exit codes: 0 done · 1 the policy failed · 2 something went wrong (no token, git error, Rabbinatix unreachable).`;

interface Args {
  base?: string; head?: string; straight: boolean; ranBy?: 'assistant'; api?: string; tokenEnv: string; store: boolean; format: 'md' | 'json'; out?: string; comment?: string;
  failOn: Policy; title?: string; url?: string; tsconfig?: string; depth: number; dryRun: boolean; help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { straight: false, tokenEnv: 'RABBINATIX_TOKEN', store: false, format: 'md', failOn: 'inform', depth: 6, dryRun: false, help: false };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case '--base': a.base = value(i++, f); break;
      case '--head': a.head = value(i++, f); break;
      case '--straight': a.straight = true; break;
      case '--run-by': { if (value(i++, f) !== 'assistant') throw new Error('--run-by takes: assistant.'); a.ranBy = 'assistant'; break; }
      case '--api': a.api = value(i++, f); break;
      case '--token-env': a.tokenEnv = value(i++, f); break;
      case '--store': a.store = true; break;
      case '--format': { const v = value(i++, f); if (v !== 'md' && v !== 'json') throw new Error('--format is md or json.'); a.format = v; break; }
      case '--out': a.out = value(i++, f); break;
      case '--comment': a.comment = value(i++, f); break;
      case '--fail-on': { const v = value(i++, f); if (!['inform', 'warn', 'breaks', 'critical'].includes(v)) throw new Error('--fail-on is inform, warn, breaks or critical.'); a.failOn = v as Policy; break; }
      case '--title': a.title = value(i++, f); break;
      case '--url': a.url = value(i++, f); break;
      case '--tsconfig': a.tsconfig = value(i++, f); break;
      case '--depth': { const n = Number(value(i++, f)); if (!Number.isInteger(n) || n < 0 || n > 12) throw new Error('--depth is a number from 0 to 12.'); a.depth = n; break; }
      case '--dry-run': a.dryRun = true; break;
      case '-h': case '--help': a.help = true; break;
      default: {
        const r = !f.startsWith('-') && a.base === undefined && a.head === undefined ? parseRange(f) : null;
        if (!r) throw new Error(`Unknown option ${f}. See --help.`);
        a.base = r.base; a.head = r.head; a.straight = r.straight;
      }
    }
  }
  return a;
}

type Print = (s: string) => void;
const stdout: Print = (s) => void process.stdout.write(`${s}\n`);
const stderr: Print = (s) => void process.stderr.write(`${s}\n`);

export async function main(argv: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env, log: Print = stdout, warn: Print = stderr): Promise<number> {
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (e) {
    warn((e as Error).message);
    return 2;
  }
  if (a.help) { log(HELP); return 0; }
  if (a.straight && !a.head) { warn('--straight needs --head: say which two to compare.'); return 2; }
  let checkout: ReturnType<typeof checkoutOf> | undefined;
  try {
    const root = repoRoot(cwd);
    const base = a.base ?? defaultBase(root, env);
    let from: string, compared: Compared | undefined;
    if (a.head) {
      const baseCommit = commitOf(root, base), headCommit = commitOf(root, a.head);
      from = a.straight ? baseCommit : splitPoint(root, baseCommit, headCommit);
      compared = { base, head: a.head, baseCommit, headCommit, straight: a.straight };
    } else {
      from = mergeBase(root, base);
    }
    const files = parseDiff(diffText(root, from, compared?.headCommit));
    // the newer side's files, to follow calls in: this checkout, or a temporary copy of `head`
    checkout = compared ? checkoutOf(root, compared.headCommit, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-head-')), 'repo')) : undefined;
    const found = analyze({ root: checkout?.dir ?? root, files, readBase: (f) => showAt(root, from, f), tsconfig: a.tsconfig, maxDepth: a.depth });
    if (checkout?.temporary) found.notes.push(`Read ${compared!.head} from a temporary copy without its installed packages: calls through them may be missed.`);
    for (const n of found.notes) warn(`note: ${n}`);
    const ranBy = a.ranBy ?? (ranByAssistant(env) ? 'assistant' as const : undefined);
    const body = requestBody(found, changeInfo(root, { title: a.title, url: a.url, compared, ranBy }, env), a.store);
    if (a.dryRun) { log(JSON.stringify(body, null, 2)); return 0; }
    const write = (file: string | undefined, text: string) => file && fs.writeFileSync(path.resolve(cwd, file), text);

    if (!worthAsking(found)) {
      // nothing on the map: answered here, no call
      const md = localMarkdown(found);
      write(a.out, JSON.stringify({ report: null, markdown: md, found }, null, 2));
      write(a.comment, md);
      log(a.format === 'json' ? JSON.stringify({ report: null, markdown: md, found }, null, 2) : md);
      return 0;
    }
    const c = connection(a, env, cwd, a.store ? 'read and deploy' : 'read');
    if ('missing' in c) { warn(c.missing); return 2; }
    const answer = await postImpact(c, body, warn);
    write(a.out, JSON.stringify(answer, null, 2));
    const failed = fails(answer.report, a.failOn);
    const headline = a.failOn === 'warn' && fails(answer.report, 'critical') ? '> ⚠ This change may break a contract or affects a critical flow.\n\n' : '';
    write(a.comment, headline + answer.markdown);
    // the AI prompts for what needs judgement next (printed, not in the pull request comment)
    const prompts = impactPrompts(answer.report, answer.id);
    log(a.format === 'json' ? JSON.stringify(answer, null, 2) : headline + answer.markdown + prompts.map((p) => `\nAI prompt (${p.label.toLowerCase()}): ${p.text}`).join('\n'));
    if (failed) warn(`Failing: the policy is “${a.failOn}” and this change ${a.failOn === 'breaks' ? 'may break a contract' : 'may break a contract or affects a critical flow'}.`);
    return failed ? 1 : 0;
  } catch (e) {
    const err = e as Error & { stderr?: Buffer | string };
    warn(err.stderr ? String(err.stderr).trim() || err.message : err.message);
    return 2;
  } finally {
    if (checkout?.temporary) {
      checkout.done();
      fs.rmSync(path.dirname(checkout.dir), { recursive: true, force: true });
    }
  }
}

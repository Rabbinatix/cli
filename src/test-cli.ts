// rabbinatix test: the flows' test cases, simulated in Rabbinatix as the app's Run does (assistant-and-cli-plan.md
// § 3.2). POST /v1/test with the flows asked for; `--affected impact.json` takes them from `rabbinatix impact --out`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { nextStepPrompts } from './from-app/features/assistant/prompts';
import { ApiError, call, connection, Fetch } from './connect.js';

export const TEST_HELP = `rabbinatix test: the flows' test cases, simulated (test data answers every call; nothing reaches the network)

Usage: rabbinatix test [options]

  --flow <key>            a flow (its key, e.g. FLOW-CHECKOUT-001, or its id); repeat it for more
  --system <id>           the flows that start in this system; repeat it for more
  --affected <file>       the flows a change affects: the JSON of rabbinatix impact --out <file>
                          (none affected: nothing runs, exit 0)
  (none of these: every flow, critical ones first, at most 50 a call)
  --fail-on <when>        failed (default): exit 1 when a test case fails · critical: only in a critical flow · never
  --api <url>             the API address (or RABBINATIX_API, or "api" in .rabbinatix/config.json)
  --token-env <name>      the environment variable holding a read token (default RABBINATIX_TOKEN)
  --format <md|json>      what to print (default md) · --out <file>  also write the answer as JSON
  -h, --help              this help

Sends: the flow keys and system ids asked for. Exit codes: 0 done · 1 --fail-on matched · 2 an error.`;

type FailOn = 'failed' | 'critical' | 'never';
interface TestArgs { flows: string[]; systems: string[]; affected?: string; failOn: FailOn; api?: string; tokenEnv: string; format: 'md' | 'json'; out?: string; help: boolean }

export function parseTestArgs(argv: string[]): TestArgs {
  const a: TestArgs = { flows: [], systems: [], failOn: 'failed', tokenEnv: 'RABBINATIX_TOKEN', format: 'md', help: false };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case '--flow': a.flows.push(value(i++, f)); break;
      case '--system': a.systems.push(value(i++, f)); break;
      case '--affected': a.affected = value(i++, f); break;
      case '--fail-on': { const v = value(i++, f); if (v !== 'failed' && v !== 'critical' && v !== 'never') throw new Error('--fail-on is failed, critical or never.'); a.failOn = v; break; }
      case '--api': a.api = value(i++, f); break;
      case '--token-env': a.tokenEnv = value(i++, f); break;
      case '--format': { const v = value(i++, f); if (v !== 'md' && v !== 'json') throw new Error('--format is md or json.'); a.format = v; break; }
      case '--out': a.out = value(i++, f); break;
      case '-h': case '--help': a.help = true; break;
      default: throw new Error(`Unknown option ${f}. See --help.`);
    }
  }
  return a;
}

/** the flows an impact answer (rabbinatix impact --out) says the change affects */
export function affectedFlows(json: string): string[] {
  const j = JSON.parse(json) as { report?: { flows?: { id: string }[] } | null };
  if (!j || typeof j !== 'object' || !('report' in j)) throw new Error('That is not the JSON of rabbinatix impact --out.');
  return [...new Set((j.report?.flows ?? []).map((f) => f.id))];
}

interface FlowResult { flow: string; key?: string; name: string; critical: boolean; result: string; passed: number; failed: number; failures: { scenario: string; name: string; reason?: string; step?: string }[]; message?: string }
interface TestAnswer { flows: FlowResult[]; passed: number; failed: number; unknown: string[]; stopped: boolean; capped: number }

type Print = (s: string) => void;

export async function mainTest(argv: string[], cwd: string, env: NodeJS.ProcessEnv, log: Print, warn: Print, fetchFn?: Fetch): Promise<number> {
  let a: TestArgs;
  try {
    a = parseTestArgs(argv);
  } catch (e) {
    warn((e as Error).message);
    return 2;
  }
  if (a.help) { log(TEST_HELP); return 0; }
  let flows = a.flows;
  if (a.affected) {
    try {
      flows = [...flows, ...affectedFlows(fs.readFileSync(path.resolve(cwd, a.affected), 'utf8'))];
    } catch (e) {
      warn(`Can't read ${a.affected}: ${(e as Error).message}`);
      return 2;
    }
    if (!flows.length && !a.systems.length) { log('No flow is affected by this change: no test cases to run.'); return 0; }
  }
  const c = connection(a, env, cwd, 'read');
  if ('missing' in c) { warn(c.missing); return 2; }
  let r: TestAnswer;
  try {
    r = await call<TestAnswer>(c, 'POST', '/test', { body: { ...(flows.length ? { flows } : {}), ...(a.systems.length ? { systems: a.systems } : {}) }, fetchFn, warn, timeoutMs: 120_000 });
  } catch (e) {
    warn((e as Error).message);
    if (e instanceof ApiError && e.status === 403) warn('Make a token with the read scope under Integrations → API tokens.');
    return 2;
  }
  if (a.out) fs.writeFileSync(path.resolve(cwd, a.out), JSON.stringify(r, null, 2));
  log(a.format === 'json' ? JSON.stringify(r, null, 2) : testMarkdown(r));
  const bad = r.flows.filter((f) => f.result === 'failed' || f.result === 'error');
  const failed = a.failOn === 'never' ? [] : a.failOn === 'critical' ? bad.filter((f) => f.critical) : bad;
  if (failed.length) warn(`Failing: ${failed.length} flow${failed.length === 1 ? '' : 's'} with failed test cases${a.failOn === 'critical' ? ' (critical)' : ''}.`);
  return failed.length ? 1 : 0;
}

export function testMarkdown(r: TestAnswer): string {
  const icon: Record<string, string> = { passed: '✅', failed: '❌', error: '⚠️', 'no test cases': '·', 'not run': '⏸' };
  const out = [`## Test cases: ${r.failed ? `${r.failed} failed` : 'all passed'} · ${r.passed} passed`, ''];
  for (const f of r.flows) {
    out.push(`- ${icon[f.result] ?? ''} ${f.key ?? f.flow} ${f.name}${f.critical ? ' (critical)' : ''}: ${f.result === 'passed' || f.result === 'failed' ? `${f.passed} passed, ${f.failed} failed` : f.message ? `${f.result}: ${f.message}` : f.result}`);
    for (const x of f.failures) out.push(`  - ${x.scenario} ${x.name}${x.step ? ` at ${x.step}` : ''}${x.reason ? `: ${x.reason}` : ''}`);
  }
  if (r.unknown.length) out.push('', `Not on the map: ${r.unknown.join(', ')}`);
  if (r.capped) out.push('', `${r.capped} more flow${r.capped === 1 ? '' : 's'} not run (50 a call): name them with --flow or --system.`);
  if (r.stopped) out.push('', 'Out of time for this call: the flows marked ⏸ did not run. Run them with --flow.');
  const failing = r.flows.flatMap((f) => f.failures.map((x) => x.scenario));
  if (failing.length) out.push('', `AI prompt: ${nextStepPrompts.failing(failing).text}`);
  return out.join('\n');
}

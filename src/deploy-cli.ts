// rabbinatix deploy check | record: the safety check before a deployment, and recording it after
// (assistant-and-cli-plan.md § 3.2). `check` exits 1 when the deployment would break a contract; `record` writes the
// deployment (or asks for a promotion where the environment needs approval). Sends the system, version and environment.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { nextStepPrompts } from './from-app/features/assistant/prompts';
import { ApiError, call, connection, Fetch } from './connect.js';

export const DEPLOY_HELP = `rabbinatix deploy: the safety check before a deployment, and recording it after

Usage:
  rabbinatix deploy check  --system <id> --version <v> --env <id> [options]
  rabbinatix deploy record --system <id> --version <v> --env <id> [options]

  check    May this release go to that environment? Prints the check's lines; exits 1 when it would break a contract
           (the same check as Deployments → Safe to deploy?). Leave out --version to check the system as declared now.
  record   Records the deployment after your deploy step. An environment that asks for approval first gets a promotion
           request instead (exit 0; it waits for an approver in Rabbinatix), unless you send --no-approval or it has
           no approvers: then it is recorded at once, marked "without approval".

  --system <id>        the system's id (GET /v1/systems lists them)
  --version <v>        the release's version, as under Releases
  --env <id>           the environment's id (dev, staging, prod, or your own)
  --api <url>          the API address (or RABBINATIX_API, or "api" in .rabbinatix/config.json)
  --token-env <name>   the environment variable holding the token (default RABBINATIX_TOKEN): read for check,
                       deploy for record
  --allow-missing-signoff <why>
                       record: move although affected teams haven't signed off (an environment that requires it)
                       or during a no-release period that stops moves; the reason is recorded with the deployment
  --no-approval        record: record it now where approval is asked first; the deployment says nobody approved it
  --format <md|json>   what to print (default md) · --out <file>  also write the answer as JSON
  -h, --help           this help

Sends: the system, version and environment (and the reason, with --allow-missing-signoff; "approval": "none" with --no-approval). Exit codes: 0 done · 1 check: blocked · 2 an error.`;

interface DeployArgs { action?: 'check' | 'record'; system?: string; version?: string; env?: string; allowMissingSignoff?: string; noApproval?: boolean; api?: string; tokenEnv: string; format: 'md' | 'json'; out?: string; help: boolean }

export function parseDeployArgs(argv: string[]): DeployArgs {
  const a: DeployArgs = { tokenEnv: 'RABBINATIX_TOKEN', format: 'md', help: false };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case 'check': case 'record': if (i === 0) { a.action = f; break; } throw new Error(`Unknown option ${f}. See --help.`);
      case '--system': a.system = value(i++, f); break;
      case '--version': a.version = value(i++, f); break;
      case '--env': a.env = value(i++, f); break;
      case '--allow-missing-signoff': a.allowMissingSignoff = value(i++, f); break;
      case '--no-approval': a.noApproval = true; break;
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

interface CheckAnswer { approved: boolean; system: string; version: string; env: string; blocking: unknown[]; warnings: unknown[]; output: string }
type RecordAnswer = { id: string; systemId: string; envId: string; at: string; withoutApproval?: true } | { promotion: string; status: string; to: string; message: string };

type Print = (s: string) => void;

export async function mainDeploy(argv: string[], cwd: string, env: NodeJS.ProcessEnv, log: Print, warn: Print, fetchFn?: Fetch): Promise<number> {
  let a: DeployArgs;
  try {
    a = parseDeployArgs(argv);
  } catch (e) {
    warn((e as Error).message);
    return 2;
  }
  if (a.help || !a.action) { (a.help ? log : warn)(DEPLOY_HELP); return a.help ? 0 : 2; }
  if (a.allowMissingSignoff !== undefined && a.action !== 'record') { warn('--allow-missing-signoff is for deploy record.'); return 2; }
  if (a.noApproval && a.action !== 'record') { warn('--no-approval is for deploy record.'); return 2; }
  if (a.allowMissingSignoff !== undefined && !a.allowMissingSignoff.trim()) { warn('--allow-missing-signoff needs the reason.'); return 2; }
  const missing = (['system', 'env', ...(a.action === 'record' ? ['version'] : [])] as ('system' | 'env' | 'version')[]).filter((k) => !a[k]);
  if (missing.length) { warn(`Say ${missing.map((k) => `--${k}`).join(' and ')}.`); return 2; }
  const c = connection(a, env, cwd, a.action === 'check' ? 'read' : 'deploy');
  if ('missing' in c) { warn(c.missing); return 2; }
  const write = (data: unknown) => a.out && fs.writeFileSync(path.resolve(cwd, a.out), JSON.stringify(data, null, 2));
  try {
    if (a.action === 'check') {
      const q = new URLSearchParams({ system: a.system!, env: a.env!, ...(a.version ? { version: a.version } : {}) });
      const r = await call<CheckAnswer>(c, 'GET', `/can-i-deploy?${q}`, { fetchFn, warn });
      write(r);
      if (a.format === 'json') log(JSON.stringify(r, null, 2));
      else {
        log(r.output);
        if (!r.approved) log(`\nAI prompt (to understand it): ${nextStepPrompts.blocked(a.system!, r.version ?? a.version ?? '', a.env!).text}`);
      }
      if (!r.approved) warn(`Blocked: ${a.system} ${r.version ?? ''} can't go to ${a.env} (${r.blocking.length} contract${r.blocking.length === 1 ? '' : 's'}).`);
      return r.approved ? 0 : 1;
    }
    const r = await call<RecordAnswer>(c, 'POST', '/deployments', { body: { system: a.system, version: a.version, env: a.env, ...(a.allowMissingSignoff ? { allowMissingSignoff: a.allowMissingSignoff.trim() } : {}), ...(a.noApproval ? { approval: 'none' } : {}) }, fetchFn, warn });
    write(r);
    if (a.format === 'json') log(JSON.stringify(r, null, 2));
    else log('promotion' in r ? `${r.message} It waits for an approver in Rabbinatix (promotion ${r.promotion}).` : `Recorded: ${a.system} ${a.version} → ${a.env}${'withoutApproval' in r && r.withoutApproval ? ' (without approval)' : ''}.`);
    return 0;
  } catch (e) {
    warn((e as Error).message);
    if (e instanceof ApiError && e.status === 403) warn('Make a token with the needed scope under Integrations → API tokens.');
    if (e instanceof ApiError && e.status === 409 && /allowMissingSignoff/.test(e.message)) warn('To move it anyway, run again with --allow-missing-signoff "<why>": the reason is recorded.');
    return 2;
  }
}

import { describe, expect, it } from 'vitest';
import { mainDeploy, parseDeployArgs } from '../src/deploy-cli.js';

const env = { RABBINATIX_API: 'https://api.example/v1', RABBINATIX_TOKEN: 'cm_live_t' };
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (s: string) => void out.push(s), warn: (s: string) => void err.push(s) };
};
const answering = (status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) =>
  (async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

describe('rabbinatix deploy', () => {
  it('check: prints the check’s lines, exits 0 when approved', async () => {
    const p = io();
    const seen: { url?: string } = {};
    const code = await mainDeploy(['check', '--system', 'orders', '--version', '1.4.0', '--env', 'prod'], '/', env, p.log, p.warn,
      answering(200, { approved: true, system: 'orders', version: '1.4.0', env: 'prod', blocking: [], warnings: [], output: 'Orders 1.4.0 → Production: safe' }, seen));
    expect(code).toBe(0);
    expect(seen.url).toBe('https://api.example/v1/can-i-deploy?system=orders&env=prod&version=1.4.0');
    expect(p.out).toEqual(['Orders 1.4.0 → Production: safe']);
  });

  it('check: blocked exits 1 and prints the AI prompt to understand it', async () => {
    const p = io();
    const code = await mainDeploy(['check', '--system', 'orders', '--version', '1.4.0', '--env', 'prod'], '/', env, p.log, p.warn,
      answering(200, { approved: false, system: 'orders', version: '1.4.0', env: 'prod', blocking: [{}], warnings: [], output: 'Orders 1.4.0 → Production: blocked' }));
    expect(code).toBe(1);
    expect(p.out.join('\n')).toContain('AI prompt (to understand it): In Rabbinatix, explain why orders 1.4.0 can\'t go to prod');
    expect(p.err).toEqual(['Blocked: orders 1.4.0 can\'t go to prod (1 contract).']);
  });

  it('record: writes the deployment, or says a promotion waits for approval', async () => {
    const p = io();
    const seen: { init?: RequestInit } = {};
    expect(await mainDeploy(['record', '--system', 'orders', '--version', '1.4.0', '--env', 'staging'], '/', env, p.log, p.warn, answering(201, { id: 'd1', systemId: 'orders', envId: 'staging', at: 'x' }, seen))).toBe(0);
    expect(JSON.parse(String(seen.init!.body))).toEqual({ system: 'orders', version: '1.4.0', env: 'staging' });
    expect(p.out).toEqual(['Recorded: orders 1.4.0 → staging.']);
    expect(await mainDeploy(['record', '--system', 'orders', '--version', '1.4.0', '--env', 'prod'], '/', env, p.log, p.warn, answering(202, { promotion: 'p1', status: 'requested', to: 'prod', message: 'Production asks for approval: promotion requested.' }))).toBe(0);
    expect(p.out.at(-1)).toContain('waits for an approver');
    // approvals never block: --no-approval records it at once, and says so
    const seen2: { init?: RequestInit } = {};
    expect(await mainDeploy(['record', '--system', 'orders', '--version', '1.4.0', '--env', 'prod', '--no-approval'], '/', env, p.log, p.warn, answering(201, { id: 'd2', systemId: 'orders', envId: 'prod', at: 'x', withoutApproval: true }, seen2))).toBe(0);
    expect(JSON.parse(String(seen2.init!.body))).toEqual({ system: 'orders', version: '1.4.0', env: 'prod', approval: 'none' });
    expect(p.out.at(-1)).toBe('Recorded: orders 1.4.0 → prod (without approval).');
  });

  it('record --allow-missing-signoff: sends the reason; refused for sign-off, it says how to move anyway', async () => {
    const p = io();
    const seen: { init?: RequestInit } = {};
    expect(await mainDeploy(['record', '--system', 'orders', '--version', '1.4.0', '--env', 'prod', '--allow-missing-signoff', 'hotfix for the outage'], '/', env, p.log, p.warn, answering(201, { id: 'd1', systemId: 'orders', envId: 'prod', at: 'x' }, seen))).toBe(0);
    expect(JSON.parse(String(seen.init!.body))).toEqual({ system: 'orders', version: '1.4.0', env: 'prod', allowMissingSignoff: 'hotfix for the outage' });
    const q = io();
    expect(await mainDeploy(['record', '--system', 'orders', '--version', '1.4.0', '--env', 'prod'], '/', env, q.log, q.warn,
      answering(409, { error: 'Waiting for sign-off from Web. From a pipeline: send "allowMissingSignoff": "<why>".' }))).toBe(2);
    expect(q.err.join('\n')).toContain('run again with --allow-missing-signoff');
    const r = io();
    expect(await mainDeploy(['check', '--system', 'orders', '--env', 'prod', '--allow-missing-signoff', 'x'], '/', env, r.log, r.warn)).toBe(2);
    expect(r.err).toEqual(['--allow-missing-signoff is for deploy record.']);
  });

  it('says what is missing, and a missing scope', async () => {
    const p = io();
    expect(await mainDeploy(['record', '--system', 'orders', '--env', 'prod'], '/', env, p.log, p.warn)).toBe(2);
    expect(p.err.at(-1)).toBe('Say --version.');
    expect(await mainDeploy(['record', '--system', 'o', '--version', '1', '--env', 'prod'], '/', env, p.log, p.warn, answering(403, { error: 'This token lacks the deploy scope.' }))).toBe(2);
    expect(p.err.slice(-2)).toEqual(['Rabbinatix answered 403: This token lacks the deploy scope.', 'Make a token with the needed scope under Integrations → API tokens.']);
    expect(() => parseDeployArgs(['check', 'record'])).toThrow('Unknown option record');
    expect(await mainDeploy([], '/', env, p.log, p.warn)).toBe(2);
  });
});

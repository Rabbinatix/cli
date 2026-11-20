import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { affectedFlows, mainTest, parseTestArgs } from '../src/test-cli.js';

const env = { RABBINATIX_API: 'https://api.example/v1', RABBINATIX_TOKEN: 't' };
const answer = {
  flows: [
    { flow: 'f1', key: 'FLOW-PAY-001', name: 'Pay', critical: true, result: 'failed', passed: 1, failed: 1, failures: [{ scenario: 'SCN-PAY-002', name: 'Declined card', step: 'NODE-PAY-004', reason: 'expected 402, got 200' }] },
    { flow: 'f2', key: 'FLOW-CART-001', name: 'Cart', critical: false, result: 'passed', passed: 3, failed: 0, failures: [] },
  ],
  passed: 4, failed: 1, unknown: [], stopped: false, capped: 0,
};
const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, log: (s: string) => void out.push(s), warn: (s: string) => void err.push(s) }; };

describe('rabbinatix test', () => {
  it('sends the flows asked for, prints each, fails on a failed test case with the AI prompt', async () => {
    let sent: unknown;
    const fetchFn = (async (_u: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(JSON.stringify(answer), { status: 200 }); }) as unknown as typeof fetch;
    const p = io();
    expect(await mainTest(['--flow', 'FLOW-PAY-001', '--system', 'shop'], '/', env, p.log, p.warn, fetchFn)).toBe(1);
    expect(sent).toEqual({ flows: ['FLOW-PAY-001'], systems: ['shop'] });
    const md = p.out.join('\n');
    expect(md).toContain('- ❌ FLOW-PAY-001 Pay (critical): 1 passed, 1 failed');
    expect(md).toContain('  - SCN-PAY-002 Declined card at NODE-PAY-004: expected 402, got 200');
    expect(md).toContain('AI prompt: In Rabbinatix, run the test cases of SCN-PAY-002');
    expect(p.err).toEqual(['Failing: 1 flow with failed test cases.']);
    expect(await mainTest(['--fail-on', 'never'], '/', env, p.log, p.warn, fetchFn)).toBe(0);
  });

  it('--affected: the flows of an impact answer; none affected runs nothing', async () => {
    expect(affectedFlows(JSON.stringify({ report: { flows: [{ id: 'f1' }, { id: 'f1' }, { id: 'f9' }] } }))).toEqual(['f1', 'f9']);
    expect(() => affectedFlows('{"x":1}')).toThrow('not the JSON');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-test-'));
    fs.writeFileSync(path.join(dir, 'impact.json'), JSON.stringify({ report: null, markdown: '' }));
    const p = io();
    expect(await mainTest(['--affected', 'impact.json'], dir, env, p.log, p.warn, (() => { throw new Error('no call'); }) as unknown as typeof fetch)).toBe(0);
    expect(p.out).toEqual(['No flow is affected by this change: no test cases to run.']);
  });

  it('refuses bad flags', () => {
    expect(() => parseTestArgs(['--fail-on', 'sometimes'])).toThrow('failed, critical or never');
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeMap, mainStatus, parseStatusArgs, readRepo } from '../src/status-cli.js';

const repo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-status-'));
  const put = (f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); };
  put('src/users.ts', '// FDD:LOGIC-USR-001 r3 Find user\nexport function find() {\n  // FDD:NODE-USR-001 Read it\n}\n');
  put('src/orders.py', '# FDD:LOGIC-ORD-002 r2 Place order\ndef place(): pass\n');
  put('src/routes.ts', "app.get('/health', (req, res) => res.send('ok'));\n");
  put('api/Payments.cs', '[Route("pay")]\npublic class PayController {\n  [HttpPost("charge")]\n  public IActionResult Charge() { return Ok(); }\n}\n');
  put('README.md', '# hello');
  return { root, files: ['src/users.ts', 'src/orders.py', 'src/routes.ts', 'api/Payments.cs', 'README.md'] };
};
const env = { RABBINATIX_API: 'https://api.example/v1', RABBINATIX_TOKEN: 't' };

describe('rabbinatix status', () => {
  it('reads every anchor and the route files without one', () => {
    const { root, files } = repo();
    const r = readRepo(root, files);
    expect(r.anchors).toEqual([
      { key: 'LOGIC-ORD-002', revision: 2, file: 'src/orders.py', line: 1 },
      { key: 'LOGIC-USR-001', revision: 3, file: 'src/users.ts', line: 1 },
      { key: 'NODE-USR-001', file: 'src/users.ts', line: 3 },
    ]);
    expect(r.unanchored).toEqual(['api/Payments.cs', 'src/routes.ts']);
    expect(codeMap(r.anchors)).toEqual({ format: 1, logic: { 'LOGIC-ORD-002': { revision: 2, places: ['src/orders.py:1'] }, 'LOGIC-USR-001': { revision: 3, places: ['src/users.ts:1'] } } });
  });

  it('sends only the anchors, prints what is out of step, fails on what was asked, writes the map when asked', async () => {
    const { root, files } = repo();
    let sent: { anchors: unknown[]; systems: string[] } | undefined;
    const fetchFn = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        anchors: [
          { key: 'LOGIC-ORD-002', revision: 2, file: 'src/orders.py', line: 1, state: 'gone' },
          { key: 'LOGIC-USR-001', revision: 3, file: 'src/users.ts', line: 1, state: 'behind', current: 5, name: 'Find user', system: 'users' },
          { key: 'NODE-USR-001', file: 'src/users.ts', line: 3, state: 'ok' },
        ],
        counts: { ok: 1, behind: 1, gone: 1, 'no-revision': 0 }, missing: [], systems: { users: 'Users' },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const out: string[] = [];
    const err: string[] = [];
    const code = await mainStatus(['--system', 'users', '--fail-on', 'behind,missing', '--write-map'], root, env, (s) => out.push(s), (s) => err.push(s), fetchFn, files);
    expect(code).toBe(1);
    expect(sent!.systems).toEqual(['users']);
    expect(JSON.stringify(sent)).not.toContain('export function');
    const md = out.join('\n');
    expect(md).toContain('- src/users.ts:1 LOGIC-USR-001 r3 → r5 Find user (Users)');
    expect(md).toContain('AI prompt: In Rabbinatix, bring this repo');
    expect(md).toContain('### Files with API routes and no anchor (2)');
    expect(err).toEqual(['Found: 1 behind.']);
    expect(JSON.parse(fs.readFileSync(path.join(root, '.rabbinatix/code-map.json'), 'utf8')).format).toBe(1);
  });

  it('refuses unknown --fail-on values', () => {
    expect(() => parseStatusArgs(['--fail-on', 'behind,late'])).toThrow('not late');
  });
});

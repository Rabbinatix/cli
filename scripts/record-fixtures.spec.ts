// Records the API answers test/generate-verify.spec.ts replays (test/fixtures/api), from the Rabbinatix app's own code.
// Run it after the app's /v1/generate or /v1/runs answer changes:  APP_DIR=../path/to/app npm run record-fixtures
// (APP_DIR is the app folder: the one holding src/app and fixtures/). The tests themselves never need the app.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'vitest';
import { mainGenerate } from '../src/generate-cli.js';

const APP = process.env['APP_DIR'];
const OUT = path.join(__dirname, '../test/fixtures/api');
const LANGUAGES = ['python', 'csharp', 'java', 'go', 'kotlin', 'swift', 'dart', 'php', 'ruby', 'rust'] as const;

it.skipIf(!APP)('records the generate and runs answers', async () => {
  const app = path.resolve(APP!);
  const load = (p: string) => import(path.join(app, p));
  const { freshAcme } = await load('fixtures/acme');
  const { workspaceFrom } = await load('src/app/assistant-engine/testing');
  const { envOf } = await load('src/app/assistant-engine/formats');
  const { runFlow } = await load('src/app/flow-engine');
  const { generateFor, readGenerateAsk } = await load('src/app/codegen/generate-api');
  const { verifyJobsFor } = await load('src/app/codegen/verify-api');
  const ws = workspaceFrom(freshAcme());
  const login = ws.blueprints.find((b: { id: string }) => b.id === 'bp-auth-login');
  fs.mkdirSync(OUT, { recursive: true });
  const save = (name: string, v: unknown) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(v, null, 1) + '\n');
  save('login.json', { key: login.key, revision: login.revision });

  // generate: the answers to exactly what the CLI sends
  for (const language of ['typescript', 'python']) {
    let answer: unknown;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/generate')) answer = generateFor(ws, readGenerateAsk(JSON.parse(String(init!.body))));
      return new Response(JSON.stringify(answer ?? { id: 'x' }), { status: 200 });
    }) as unknown as typeof fetch;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-rec-'));
    await mainGenerate(['--logic', login.key, '--language', language], dir, { RABBINATIX_API: 'https://api.example/v1', RABBINATIX_TOKEN: 't' }, () => {}, () => {}, fetchFn);
    fs.rmSync(dir, { recursive: true, force: true });
    save(`generate-${language}.json`, answer);
  }

  // runs: one recorded run of the sign-in flow, as each language's jobs and files
  const sc = ws.scenarios.find((s: { key: string }) => s.key === 'SCENARIO-AUTH-LOGIN-001');
  const flow = ws.flows.find((f: { id: string }) => f.id === sc.flowId);
  const run = runFlow({ flow, scenario: sc, env: envOf(ws), mode: 'simulation', responseBlueprints: ws.responseBlueprints, dataBlueprints: ws.dataBlueprints, by: 't', key: 'RUN-T-001', id: 'r' });
  for (const language of LANGUAGES) save(`runs-${language}.json`, verifyJobsFor(ws, [run], { logic: login.key, language }));
}, 120_000);

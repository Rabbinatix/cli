// assistant-and-cli-plan.md § 1.2: the CLI never calls an AI model. No model SDK among its dependencies, and no
// model endpoint or SDK import in what it bundles (its sources and the app code they import).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

const SDK = /^(?:@anthropic-ai\/|openai$|@google\/generative-ai|@google\/genai|@mistralai\/|cohere-ai|ollama|langchain|@langchain\/|ai$|@ai-sdk\/)/;
const ENDPOINT = /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.cohere\.ai/;

const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));

describe('the CLI calls no AI model', () => {
  it('has no model SDK among its dependencies', () => {
    const deps = Object.keys({ ...pkg.dependencies, ...(pkg as { optionalDependencies?: object }).optionalDependencies });
    expect(deps.filter((d) => SDK.test(d))).toEqual([]);
  });

  it('its sources import no model SDK and name no model endpoint', () => {
    for (const f of walk(path.join(__dirname, '../src')).filter((x) => x.endsWith('.ts'))) {
      const text = fs.readFileSync(f, 'utf8');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(imports.filter((i) => SDK.test(i)), f).toEqual([]);
      expect(ENDPOINT.test(text), f).toBe(false);
    }
  });

  it.skipIf(!fs.existsSync(path.join(__dirname, '../dist/rabbinatix.js')))('the bundle names no model endpoint', () => {
    expect(ENDPOINT.test(fs.readFileSync(path.join(__dirname, '../dist/rabbinatix.js'), 'utf8'))).toBe(false);
  });
});

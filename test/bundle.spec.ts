// The published CLI holds no code generator: `generate` and `verify` get their files from the API
// (codegen/generate-api.ts, codegen/verify-api.ts), so the bundle must not pull the emitters, printers or runtimes in.
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('the bundle', () => {
  it('has no code generator in it, and stays small', async () => {
    const r = await build({
      entryPoints: ['src/bin/rabbinatix.ts'], bundle: true, platform: 'node', target: 'node20', format: 'esm',
      external: ['typescript', 'yaml', 'prettier', 'prettier/*'], write: false, metafile: true, outfile: 'out.js', logLevel: 'silent',
    });
    const inputs = Object.keys(r.metafile.outputs['out.js'].inputs);
    const generator = inputs.filter((f) => /app\/src\/app\/(codegen\/(adapters|lower|ir|printers?)\/|codegen\/index\.ts|codegen\/testing\/foreign-jobs\.ts|flow-engine\/)/.test(f));
    expect(generator).toEqual([]);
    expect(r.outputFiles[0].contents.length).toBeLessThan(500_000);
  });
});

// Bundles the commands with esbuild, with the code shared with the Rabbinatix app (src/from-app, see
// scripts/sync-from-app.mjs), so the CLI and the app give the same answers. typescript, yaml and prettier stay dependencies.
import { build } from 'esbuild';
import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
const bins = ['rabbinatix'];
await build({
  entryPoints: Object.fromEntries(bins.map((b) => [b, `src/bin/${b}.ts`])),
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: ['typescript', 'yaml', 'prettier', 'prettier/*'],
  banner: { js: '#!/usr/bin/env node\n// rabbinatix: see LICENSE. https://rabbinatix.com/docs/rabbinatix-cli' },
  // the published CLI is closed source: minified, no source maps, no comments carried over
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'warning',
});
for (const b of bins) chmodSync(`dist/${b}.js`, 0o755);
// rabbinatix verify: the harnesses, next to the bundle (verify-cli.ts harnessText)
mkdirSync('dist/harness', { recursive: true });
for (const f of ['harness.py', 'Harness.cs', 'Harness.java', 'harness.go', 'Harness.kt', 'harness.swift', 'harness.dart', 'harness.php', 'harness.rb', 'harness.rs']) copyFileSync(`harness/${f}`, `dist/harness/${f}`);

// The code this CLI shares with the Rabbinatix app: src/from-app mirrors the app's src/app, and harness/ mirrors its
// src/app/codegen/testing harnesses, so the CLI and the app give the same answers.
//   APP_DIR=../path/to/app node scripts/sync-from-app.mjs           list what differs (exit 1 if anything does)
//   APP_DIR=../path/to/app node scripts/sync-from-app.mjs --write   copy the app's versions in
// Files that start with "TYPE STAND-IN" are this repo's own (only the types of a much larger app file) and are skipped.
// After --write, run `npm run typecheck`: a new import in an app file shows up as a missing module, to copy or stand in for.
import fs from 'node:fs';
import path from 'node:path';

const app = process.env.APP_DIR;
if (!app) {
  console.error('Set APP_DIR to the Rabbinatix app folder (the one holding src/app).');
  process.exit(2);
}
const write = process.argv.includes('--write');
const here = path.resolve(import.meta.dirname, '..');
const pairs = [];
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
for (const f of walk(path.join(here, 'src/from-app'))) {
  if (fs.readFileSync(f, 'utf8').startsWith('// TYPE STAND-IN')) continue;
  pairs.push([f, path.join(app, 'src/app', path.relative(path.join(here, 'src/from-app'), f))]);
}
for (const f of walk(path.join(here, 'harness'))) pairs.push([f, path.join(app, 'src/app/codegen/testing', path.basename(f))]);

let differ = 0;
for (const [mine, theirs] of pairs) {
  const rel = path.relative(here, mine);
  if (!fs.existsSync(theirs)) { console.log(`gone from the app: ${rel}`); differ++; continue; }
  if (fs.readFileSync(mine, 'utf8') === fs.readFileSync(theirs, 'utf8')) continue;
  differ++;
  if (write) { fs.copyFileSync(theirs, mine); console.log(`updated ${rel}`); } else console.log(`differs: ${rel}`);
}
console.log(differ ? `${differ} of ${pairs.length} files ${write ? 'handled' : 'differ'}` : `all ${pairs.length} files match the app`);
process.exit(differ && !write ? 1 : 0);

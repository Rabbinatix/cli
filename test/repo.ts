// A throwaway git repo for specs: files committed as the base, then changed in the working tree.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function repo(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-impact-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'spec@example.com');
  git('config', 'user.name', 'Spec');
  git('config', 'commit.gpgsign', 'false');
  const write = (f: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  };
  for (const [f, t] of Object.entries(files)) write(f, t);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return {
    dir,
    write,
    remove: (f: string) => fs.rmSync(path.join(dir, f)),
    commit: (msg: string) => { git('add', '-A'); git('commit', '-q', '-m', msg); },
    git,
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export const TSCONFIG = JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, experimentalDecorators: true, allowJs: true }, include: ['src/**/*'] });

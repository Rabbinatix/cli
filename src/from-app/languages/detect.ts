// A file's language, test files and comments, from languages.ts. Paths use forward slashes, from the repository root.
import { LanguageDef, LanguageId, LANGUAGES, languageById } from './languages';

const BY_EXT = new Map<string, LanguageDef>();
const BY_NAME = new Map<string, LanguageDef>();
for (const l of LANGUAGES) {
  for (const e of l.extensions) if (!BY_EXT.has(e)) BY_EXT.set(e, l);
  for (const f of l.filenames ?? []) BY_NAME.set(f, l);
}

const norm = (p: string) => p.replace(/\\/g, '/');
const baseName = (p: string) => norm(p).slice(norm(p).lastIndexOf('/') + 1);

/** the language of a file, by its name, then its extension (the longest that fits), or undefined */
export function languageOfFile(file: string): LanguageDef | undefined {
  const b = baseName(file);
  const named = BY_NAME.get(b);
  if (named) return named;
  const lower = b.toLowerCase();
  for (let i = lower.indexOf('.'); i >= 0; i = lower.indexOf('.', i + 1)) {
    const l = BY_EXT.get(lower.slice(i));
    if (l) return l;
  }
  return undefined;
}

/** a glob (`**` any folders, `*` within a name, `?` one character, `{a,b}` either) as a regular expression */
export function globRe(glob: string, flags = ''): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        out += '(?:.*/)?';
      } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      out += `(?:${glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
      i = end;
    } else out += c.replace(/[.+^$()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, flags);
}

/** test folders in every language: __tests__, e2e, test, tests, spec, and .NET's `X.Tests` projects (any case) */
const TEST_FOLDER = /(?:^|\/)(?:__tests__|e2e|tests?|spec|[^/]+\.tests?)\//i;
const TEST_RES = LANGUAGES.flatMap((l) => l.tests.map((g) => globRe(g)));

/** a test file, in any language */
export const isTestFile = (file: string) => {
  const f = norm(file);
  return TEST_FOLDER.test(f) || TEST_RES.some((r) => r.test(f));
};

/** test files plus fixtures, examples and mocks: code that holds risky code on purpose (the scan's code rules skip it) */
const EXAMPLE_FOLDER = /(?:^|\/)(?:fixtures?|examples?|mocks?|__mocks__|testdata)\//i;
export const isTestOrExampleFile = (file: string) => isTestFile(file) || EXAMPLE_FOLDER.test(norm(file));

/** the line comment to write in a file (anchors, the generated stamp): the language's first, else `//` */
export function lineCommentOf(file: string): string {
  return languageOfFile(file)?.comments.line[0] ?? '//';
}

/** a line comment for a language id, or a one-line block comment when it has none (`(* … *)`): [open, close] */
export function commentFor(id: LanguageId): [string, string] {
  const l = languageById(id);
  if (l?.comments.line[0]) return [l.comments.line[0], ''];
  const b = l?.comments.block[0];
  return b ? [b[0], ` ${b[1]}`] : ['//', ''];
}

/** a comment-only line in a file's language (the scan's code rules skip it) */
export function isCommentLine(file: string, line: string): boolean {
  const l = languageOfFile(file);
  const t = line.trimStart();
  if (!t) return false;
  const opens = l ? [...l.comments.line, ...l.comments.block.map((b) => b[0])] : ['//', '#', '/*', '--', '<!--'];
  // `*` continues a /* … */ block
  return opens.some((o) => t.startsWith(o)) || (!!l?.comments.block.some((b) => b[0] === '/*') && t.startsWith('*'));
}

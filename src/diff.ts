// A unified diff (`git diff --unified=0`) as changed files and line ranges. Pure.

export interface ChangedFile {
  /** the path after the change (before it, for a deleted file) */
  path: string;
  /** the path before a rename */
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** lines added or changed, in the new file (1-based, inclusive) */
  added: [number, number][];
  /** where lines were only removed: the new file's line just after them (a removal has no new lines of its own) */
  removedAt: number[];
  /** the text of each added and removed line, to tell comment-only changes apart */
  addedText: string[];
  removedText: string[];
}

const unquote = (p: string) => (p.startsWith('"') ? JSON.parse(p) as string : p);
const strip = (p: string) => unquote(p).replace(/^[ab]\//, '');

export function parseDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let f: ChangedFile | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      f = { path: '', status: 'modified', added: [], removedAt: [], addedText: [], removedText: [] };
      files.push(f);
      continue;
    }
    if (!f) continue;
    if (line.startsWith('new file mode')) f.status = 'added';
    else if (line.startsWith('deleted file mode')) f.status = 'deleted';
    else if (line.startsWith('rename from ')) { f.oldPath = line.slice(12); f.status = 'renamed'; }
    else if (line.startsWith('rename to ')) f.path = line.slice(10);
    else if (line.startsWith('--- ')) { const p = line.slice(4); if (p !== '/dev/null') f.oldPath ??= strip(p); }
    else if (line.startsWith('+++ ')) { const p = line.slice(4); f.path = p === '/dev/null' ? (f.oldPath ?? '') : strip(p); }
    else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const newStart = +m[3], newCount = m[4] === undefined ? 1 : +m[4];
      if (newCount > 0) f.added.push([newStart, newStart + newCount - 1]);
      else f.removedAt.push(Math.max(1, newStart + 1));
    }
    else if (line.startsWith('+')) f.addedText.push(line.slice(1));
    else if (line.startsWith('-')) f.removedText.push(line.slice(1));
  }
  for (const x of files) if (x.oldPath === x.path && x.status !== 'renamed') delete x.oldPath;
  return files.filter((x) => x.path);
}

/** a line that is blank or only a comment (in the languages this reads) */
export const isCommentOrBlank = (s: string) => /^\s*$/.test(s) || /^\s*(\/\/|\/\*|\*\/?|#(?!!)|<!--|-->)/.test(s);

/** the change to this file is only comments and blank lines (nothing that runs changed) */
export const onlyComments = (f: ChangedFile) => f.status !== 'deleted' && [...f.addedText, ...f.removedText].every(isCommentOrBlank);

/** every changed line of the new file: added lines and the spots where lines were removed */
export const changedLines = (f: ChangedFile): number[] => [...new Set([...f.added.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)), ...f.removedAt])].sort((a, b) => a - b);

/** "3-7, 12" */
export function rangesText(lines: number[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    out.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

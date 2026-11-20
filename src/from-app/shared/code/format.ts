// Prettier formatting for generated files (F46), loaded lazily on first use.
// Formatting moves lines, so the source map is rebuilt from `// FDD:` markers the printer emits in a pre-pass.
import type { GeneratedFile, SourceMapEntry } from '../../codegen';

const MARKER = /^(\s*)\/\/ FDD:(\S+?)(\+)?(?: .*)?$/;

/** Rebuild the map from marker comments and strip them (titled ones are kept when comments are on). */
export function rebuildMap(content: string, keepComments: boolean): { content: string; map: SourceMapEntry[] } {
  const lines = content.split('\n');
  const indent = (s: string) => s.length - s.trimStart().length;
  const isMarker = (i: number) => MARKER.test(lines[i] ?? '');
  const ranges: { key: string; start: number; end: number }[] = [];
  lines.forEach((l, i) => {
    const m = MARKER.exec(l);
    if (!m) return;
    let start = i + 1;
    while (start < lines.length && isMarker(start)) start++;
    if (start >= lines.length) return;
    const ind = m[1].length;
    let k = start + 1;
    while (k < lines.length && (isMarker(k) ? indent(lines[k]) > ind : !lines[k].trim() || indent(lines[k]) > ind || (indent(lines[k]) === ind && /^[)\]}]/.test(lines[k].trim())))) k++;
    ranges.push({ key: m[2], start, end: k - 1 });
  });
  const keep = lines.map((l) => {
    const m = MARKER.exec(l);
    return !m || (keepComments && !m[3]);
  });
  const newIndex: number[] = [];
  let n = 0;
  keep.forEach((k, i) => (newIndex[i] = k ? n++ : -1));
  const at = (i: number, dir: 1 | -1) => {
    for (let j = i; j >= 0 && j < lines.length; j += dir) if (newIndex[j] >= 0) return newIndex[j];
    return -1;
  };
  const map = ranges.map((r) => ({ nodeKey: r.key, startLine: at(r.start, 1) + 1, endLine: at(r.end, -1) + 1 })).filter((e) => e.startLine > 0 && e.endLine >= e.startLine);
  return { content: lines.filter((_, i) => keep[i]).join('\n'), map };
}

/** Format TypeScript files with Prettier. `markers`: the files were printed with FDD markers (see CodegenOptions). */
export async function formatFiles(files: GeneratedFile[], keepComments: boolean): Promise<{ files: GeneratedFile[]; error?: string }> {
  const [prettier, ts, estree] = await Promise.all([import('prettier/standalone'), import('prettier/plugins/typescript'), import('prettier/plugins/estree')]);
  const out: GeneratedFile[] = [];
  let error: string | undefined;
  for (const f of files) {
    if (!f.name.endsWith('.ts')) {
      out.push(f);
      continue;
    }
    try {
      const formatted = await prettier.format(f.content, { parser: 'typescript', plugins: [ts, estree], printWidth: 100, singleQuote: true });
      const r = rebuildMap(formatted, keepComments);
      out.push({ ...f, content: r.content, map: f.map.length ? r.map : [] });
    } catch (e) {
      // a Prettier parse error means the printer produced invalid syntax (a bug with a test)
      error ??= `Syntax check failed in ${f.name}: ${(e as Error).message.split('\n')[0]}`;
      const r = rebuildMap(f.content, keepComments);
      out.push({ ...f, content: r.content, map: f.map.length ? r.map : [] });
    }
  }
  return { files: out, error };
}

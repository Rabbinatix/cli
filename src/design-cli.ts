// rabbinatix design (docs/04-roadmap/screen-design-handoff-plan.md Phase 5): a screen's design pack in a folder, for
// building it pixel-perfect by hand or with a coding agent: the page as plain HTML with its styles, the theme as design
// tokens, and, when one is stored, the picture and every widget's box and styles. Sends the screen's key, the width and
// whether its layout goes around it; nothing from the repository.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ApiError, call, connection, Fetch } from './connect.js';

export const DESIGN_HELP = `rabbinatix design: a screen's design, to build it pixel-perfect

Usage: rabbinatix design <screen> [--width phone|tablet|desktop] [--no-layout] [--out <dir>]

  <screen>               the screen's key (SCREEN-WEB-LOGIN-001)
  --width <w>            phone (390 px), tablet (768 px) or desktop (1200 px, the default)
  --no-layout            the screen alone, without the layout around it
  --out <dir>            where to write it (default design/<screen>-<width>)
  --api <url>            the API address (or RABBINATIX_API, or "api" in .rabbinatix/config.json)
  --token-env <name>     the environment variable holding a read token (default RABBINATIX_TOKEN)
  -h, --help             this help

Writes page.html (open it in a browser), tokens.json (the theme in the W3C design tokens format), widgets.json, and
when a picture of the screen is stored (from a whiteboard, a design pack or a release): picture.png and layout.json
(each widget's box and styles in CSS px). README.md says how to use them; point your AI assistant at the folder.
Sends: the screen's key, the width and the layout choice.
Exit codes: 0 done · 2 an error.`;

type Width = 'phone' | 'tablet' | 'desktop';
interface DesignArgs { screen?: string; width: Width; layout: boolean; out?: string; api?: string; tokenEnv: string; help: boolean }

export function parseDesignArgs(argv: string[]): DesignArgs {
  const a: DesignArgs = { width: 'desktop', layout: true, tokenEnv: 'RABBINATIX_TOKEN', help: false };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case '--width': { const v = value(i++, f); if (v !== 'phone' && v !== 'tablet' && v !== 'desktop') throw new Error('--width is phone, tablet or desktop.'); a.width = v; break; }
      case '--no-layout': a.layout = false; break;
      case '--out': a.out = value(i++, f); break;
      case '--api': a.api = value(i++, f); break;
      case '--token-env': a.tokenEnv = value(i++, f); break;
      case '-h': case '--help': a.help = true; break;
      default:
        if (!f.startsWith('-') && !a.screen) { a.screen = f; break; }
        throw new Error(`Unknown option ${f}. See --help.`);
    }
  }
  return a;
}

export interface DesignAnswer {
  ref: string; name: string; route: string; revision: number; system: string; width: Width; widthLabel: string; px: number; minHeight: number; layout?: string;
  tokens: Record<string, unknown>; widgets: Record<string, { type: string; name: string; layout?: boolean }>; html: string;
  picture: null | { revision: number; current: boolean; width: string; inLayout: boolean; size: { w: number; h: number }; notes: string[]; warning?: string };
  boxes?: unknown[]; howTo: string[]; png?: string;
}

/** the files of the folder, by name (picture.png as bytes) */
export function designFiles(r: DesignAnswer): Record<string, string | Buffer> {
  const out: Record<string, string | Buffer> = {
    'page.html': r.html,
    'tokens.json': `${JSON.stringify(r.tokens, null, 2)}\n`,
    'widgets.json': `${JSON.stringify(r.widgets, null, 2)}\n`,
  };
  if (r.picture && r.boxes) out['layout.json'] = `${JSON.stringify({ screen: r.ref, revision: r.picture.revision, width: r.picture.width, px: r.picture.size.w, height: r.picture.size.h, notes: r.picture.notes, nodes: r.boxes }, null, 2)}\n`;
  if (r.png) out['picture.png'] = Buffer.from(r.png, 'base64');
  out['README.md'] = [
    `# ${r.name}: design`,
    '',
    `\`${r.ref}\` (revision ${r.revision}) on ${r.system}, at ${r.widthLabel} width (${r.px} px)${r.layout ? `, inside its layout \`${r.layout}\`` : ''}. Made by \`rabbinatix design\`; run it again after the screen changes.`,
    '',
    '- `page.html`: the screen as plain HTML with its styles. Every widget has `data-key="WIDGET-…"`.',
    '- `tokens.json`: the theme (colours, font, corner radius, spacing step) in the W3C design tokens format.',
    '- `widgets.json`: each `WIDGET-…` key with its type and name.',
    ...(r.png ? [`- \`picture.png\`: how it looks${r.picture && !r.picture.current ? ` at revision ${r.picture.revision} (older than the screen: trust page.html)` : ''}.`] : []),
    ...(out['layout.json'] ? ['- `layout.json`: each widget\'s box (`x`, `y`, `w`, `h` in CSS px from the top-left; `inner`: the control itself) and its styles.'] : []),
    '',
    '## How to build it',
    ...r.howTo.map((h) => `- ${h}`),
    ...(r.picture?.notes.length ? ['', '## Notes', ...r.picture.notes.map((n) => `- ${n}`)] : []),
    '',
  ].join('\n');
  return out;
}

type Print = (s: string) => void;

export async function mainDesign(argv: string[], cwd: string, env: NodeJS.ProcessEnv, log: Print, warn: Print, fetchFn?: Fetch): Promise<number> {
  let a: DesignArgs;
  try {
    a = parseDesignArgs(argv);
  } catch (e) {
    warn((e as Error).message);
    return 2;
  }
  if (a.help) { log(DESIGN_HELP); return 0; }
  if (!a.screen) { warn(`Say which screen: rabbinatix design SCREEN-….\n\n${DESIGN_HELP}`); return 2; }
  const c = connection(a, env, cwd, 'read');
  if ('missing' in c) { warn(c.missing); return 2; }
  try {
    const r = await call<DesignAnswer>(c, 'POST', '/design', { body: { screen: a.screen, width: a.width, layout: a.layout }, fetchFn, warn });
    const dir = path.resolve(cwd, a.out ?? path.join('design', `${r.ref.toLowerCase()}-${a.width}`));
    fs.mkdirSync(dir, { recursive: true });
    const files = designFiles(r);
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    log(`Wrote ${path.relative(cwd, dir) || '.'}: ${r.name} (${r.ref} r${r.revision}) at ${r.widthLabel} width, ${Object.keys(files).length} files.`);
    if (!r.picture) log('No picture of this screen is stored yet: open it in Rabbinatix → Inspect → Download design pack (or put it on a whiteboard) to add one.');
    else if (!r.picture.current) log(`note: the picture shows revision ${r.picture.revision}; the screen is at ${r.revision}. page.html is current.`);
    return 0;
  } catch (e) {
    warn(e instanceof ApiError ? `Rabbinatix answered ${e.status}: ${e.message}` : `Couldn't reach Rabbinatix: ${(e as Error).message}`);
    return 2;
  }
}

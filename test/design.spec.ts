import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DesignAnswer, designFiles, mainDesign, parseDesignArgs } from '../src/design-cli.js';

const env = { RABBINATIX_API: 'https://api.example/v1', RABBINATIX_TOKEN: 't' };
const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, log: (s: string) => void out.push(s), warn: (s: string) => void err.push(s) }; };
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-design-'));

const answer = (more: Partial<DesignAnswer> = {}): DesignAnswer => ({
  ref: 'SCREEN-WEB-LOGIN-001', name: 'Login', route: '/login', revision: 7, system: 'Web', width: 'phone', widthLabel: 'Phone', px: 390, minHeight: 844, layout: 'LAYOUT-WEB-MAIN-001',
  tokens: { color: { primary: { $type: 'color', $value: '#4f46e5' } } }, widgets: { 'WIDGET-WEB-LOGIN-002': { type: 'textBox', name: 'Email' } }, html: '<!doctype html><p>Sign in</p>',
  picture: { revision: 7, current: true, width: 'phone', inLayout: true, size: { w: 390, h: 844 }, notes: ['Font Inter shown as the next font.'] },
  boxes: [{ key: 'WIDGET-WEB-LOGIN-002', x: 16, y: 80, w: 358, h: 58 }], howTo: ['Build it at 390 px wide.'], png: Buffer.from('png-bytes').toString('base64'),
  ...more,
});

describe('rabbinatix design', () => {
  it('reads its options', () => {
    expect(parseDesignArgs(['SCREEN-1', '--width', 'phone', '--no-layout', '--out', 'x'])).toMatchObject({ screen: 'SCREEN-1', width: 'phone', layout: false, out: 'x' });
    expect(parseDesignArgs([])).toMatchObject({ width: 'desktop', layout: true });
    expect(() => parseDesignArgs(['S', '--width', 'watch'])).toThrow('--width is phone, tablet or desktop.');
    expect(() => parseDesignArgs(['S', 'T'])).toThrow('Unknown option T');
  });

  it('sends only the screen, width and layout choice, and writes the folder with the picture', async () => {
    const d = dir();
    let sent: unknown;
    const fetchFn = (async (u: string, init: RequestInit) => {
      expect(u).toBe('https://api.example/v1/design');
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify(answer()), { status: 200 });
    }) as unknown as typeof fetch;
    const p = io();
    expect(await mainDesign(['SCREEN-WEB-LOGIN-001', '--width', 'phone'], d, env, p.log, p.warn, fetchFn)).toBe(0);
    expect(sent).toEqual({ screen: 'SCREEN-WEB-LOGIN-001', width: 'phone', layout: true });
    const out = path.join(d, 'design', 'screen-web-login-001-phone');
    expect(fs.readdirSync(out).sort()).toEqual(['README.md', 'layout.json', 'page.html', 'picture.png', 'tokens.json', 'widgets.json']);
    expect(fs.readFileSync(path.join(out, 'picture.png'), 'utf8')).toBe('png-bytes');
    expect(JSON.parse(fs.readFileSync(path.join(out, 'layout.json'), 'utf8'))).toMatchObject({ screen: 'SCREEN-WEB-LOGIN-001', revision: 7, px: 390, nodes: [{ key: 'WIDGET-WEB-LOGIN-002' }] });
    expect(p.out).toEqual(['Wrote design/screen-web-login-001-phone: Login (SCREEN-WEB-LOGIN-001 r7) at Phone width, 6 files.']);
  });

  it('says when no picture is stored, or when it is older than the screen', () => {
    const none = designFiles(answer({ picture: null, boxes: undefined, png: undefined }));
    expect(Object.keys(none).sort()).toEqual(['README.md', 'page.html', 'tokens.json', 'widgets.json']);
    const old = designFiles(answer({ picture: { ...answer().picture!, revision: 5, current: false } }));
    expect(String(old['README.md'])).toContain('at revision 5 (older than the screen: trust page.html)');
  });

  it('needs a screen and a token, and reports what the API answered', async () => {
    const p = io();
    expect(await mainDesign([], dir(), env, p.log, p.warn)).toBe(2);
    expect(p.err[0]).toContain('Say which screen');
    expect(await mainDesign(['S'], dir(), { RABBINATIX_API: 'https://a' }, p.log, p.warn)).toBe(2);
    const fetchFn = (async () => new Response(JSON.stringify({ error: { message: 'No screen S.' } }), { status: 404 })) as unknown as typeof fetch;
    const q = io();
    expect(await mainDesign(['S'], dir(), env, q.log, q.warn, fetchFn)).toBe(2);
    expect(q.err.join('\n')).toContain('404');
  });
});

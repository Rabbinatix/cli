// What the CLI prints and how it exits. Pure.
import type { Found } from './analyze.js';
import type { ImpactResponse } from './api.js';

export type Policy = 'inform' | 'warn' | 'breaks' | 'critical';

/** whether the change reaches anything a call could tell more about */
export const worthAsking = (f: Found) => f.reached.length > 0 || f.routes.length > 0 || f.calls.length > 0 || f.specs.some((s) => s.change !== 'added');

/** the body sent: only what the map is matched on */
export function requestBody(f: Found, change: Record<string, string | boolean>, store: boolean) {
  return {
    reached: f.reached.map((r) => ({ ref: r.ref, revision: r.revision, ...(r.steps.length ? { steps: r.steps } : {}), via: r.via, how: r.how })),
    routes: f.routes.map((r) => ({ method: r.method, path: r.path, via: r.via })),
    ...(f.calls.length ? { calls: f.calls.map((r) => ({ method: r.method, path: r.path, via: r.via })) } : {}),
    specs: f.specs.map((s) => ({ method: s.method, path: s.path, change: s.change, file: s.file })),
    unmapped: f.unmapped,
    tests: f.tests,
    change,
    ...(store ? { store: true } : {}),
  };
}

/** the answer without asking Rabbinatix: nothing the change touches is on the map */
export function localMarkdown(f: Found): string {
  const out = ['### Rabbinatix · what this change affects', ''];
  if (!f.unmapped.length && !f.specs.length) {
    out.push(f.commentsOnly.length ? 'Only comments and blank lines changed: nothing runs differently.' : 'Nothing this change touches runs code on the map.');
  } else {
    out.push('Nothing this change touches is on the map, so what it affects is unknown: run all tests.');
    if (f.unmapped.length) out.push('', `**Code not on the map:** ${f.unmapped.slice(0, 10).map((u) => `\`${u.file}${u.lines ? `:${u.lines}` : ''}\``).join(', ')}${f.unmapped.length > 10 ? ` and ${f.unmapped.length - 10} more` : ''}`);
    if (f.specs.length) out.push('', `**New APIs in specs:** ${f.specs.map((s) => `${s.method} ${s.path}`).join(', ')}`);
  }
  if (f.tests.length) out.push('', `**Repo tests that reach the change:** ${f.tests.slice(0, 10).map((t) => `\`${t}\``).join(', ')}`);
  return out.join('\n');
}

export function fails(r: ImpactResponse['report'], policy: Policy): boolean {
  if (policy === 'inform' || policy === 'warn') return false;
  const breaks = r.triage.some((t) => t.kind === 'contract' && t.mustLook);
  return policy === 'breaks' ? breaks : breaks || r.dimensions.far.criticalFlows > 0;
}

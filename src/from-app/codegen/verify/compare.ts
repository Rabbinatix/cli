// How a frame's run of the generated code compares with what the simulator recorded (F47). Pure, with no sandbox: the
// app's verification, the Python / C# / Java harnesses and `rabbinatix verify` all decide pass or fail here.
import type { FrameData } from './frames';

export type FrameStatus = 'pass' | 'fail' | 'error' | 'timeout' | 'skipped';

export interface VerifyFrameResult {
  frameId: string;
  blueprintId: string;
  blueprintKey: string;
  status: FrameStatus;
  reason?: string;
  /** NODE key where the generated code first behaved differently */
  firstDifferentNode?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface FrameOutcome {
  result?: unknown;
  error?: { code: string; message: string };
  path: string[];
  requestIssues: string[];
  /** verification itself stopped (unexpected call, step limit) */
  abort?: string;
}

/** JSON-normalised copy: drops undefined, and empty pathParams/query/headers maps. */
export function normalize(v: unknown): unknown {
  if (v === undefined) return undefined;
  const j = JSON.parse(JSON.stringify(v)) as unknown;
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    for (const k of ['pathParams', 'query', 'headers']) {
      const x = (j as Record<string, unknown>)[k];
      if (x && typeof x === 'object' && !Object.keys(x).length) delete (j as Record<string, unknown>)[k];
    }
  }
  return j;
}

/** a request to another system, normalised: a null body or auth is the same as none (a missing input sends no body) */
export function normalizeRequest(v: unknown): unknown {
  const j = normalize(v);
  if (j && typeof j === 'object' && !Array.isArray(j)) for (const k of ['body', 'auth']) if ((j as Record<string, unknown>)[k] === null) delete (j as Record<string, unknown>)[k];
  return j;
}

export function firstDifference(a: unknown, b: unknown, path = ''): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], Array.isArray(a) ? `${path}[${k}]` : path ? `${path}.${k}` : k);
      if (d !== null) return d;
    }
    // every key the same, in another order (as Firestore gives a stored run back): the same value
    return null;
  }
  return path || '$';
}

export function compare(f: FrameData, a: FrameOutcome): Omit<VerifyFrameResult, 'frameId' | 'blueprintId' | 'blueprintKey'> {
  if (a.abort) return { status: /steps|timed out/i.test(a.abort) ? 'timeout' : 'fail', reason: a.abort, firstDifferentNode: divergence(f.path, a.path, true), expected: f.path, actual: a.path };
  const exp = f.expected;
  if (exp.kind === 'return') {
    if (a.error) return { status: 'fail', reason: `Threw ${a.error.code} (${a.error.message}); the simulator returned`, expected: exp.value, actual: a.error };
    const pick = (v: unknown) => {
      if (f.kind !== 'endpoint' || !v || typeof v !== 'object') return normalize(v);
      const r = v as Record<string, unknown>;
      const withHeaders = a.result && typeof a.result === 'object' && 'headers' in (a.result as object);
      return normalize({ status: r['status'], body: r['body'] ?? null, ...(withHeaders ? { headers: r['headers'] ?? {} } : {}) });
    };
    const e = pick(exp.value), r = pick(a.result);
    const d = firstDifference(e, r);
    if (d !== null) return { status: 'fail', reason: `Result differs at ${d}`, expected: e, actual: r, firstDifferentNode: divergence(f.path, a.path) };
  } else if (exp.kind === 'error') {
    if (!a.error) return { status: 'fail', reason: `Returned normally; the simulator failed with ${exp.code}`, expected: exp, actual: normalize(a.result) };
    if (a.error.code !== exp.code) return { status: 'fail', reason: `Failed with ${a.error.code}; the simulator failed with ${exp.code}`, expected: exp, actual: a.error };
  } else if (a.error && !(f.kind === 'endpoint' && a.error.code === 'MISSING_RETURN')) {
    return { status: 'fail', reason: `Threw ${a.error.code}; the simulator ended without a return`, actual: a.error };
  }
  const at = divergence(f.path, a.path);
  if (at !== undefined) {
    const n = Math.max(f.path.length, a.path.length);
    let i = 0;
    while (i < n && f.path[i] === a.path[i]) i++;
    const after = i > 0 ? `After ${f.path[i - 1]}, ` : '';
    const reason = i >= f.path.length
      ? `${after}the generated code ran ${a.path[i]}; the simulator had stopped`
      : a.path[i] ? `${after}the generated code ran ${a.path[i]}; the simulator ran ${f.path[i]}` : `${after}the generated code stopped; the simulator ran ${f.path[i]}`;
    return { status: 'fail', reason, firstDifferentNode: at, expected: f.path, actual: a.path };
  }
  if (a.requestIssues.length) return { status: 'fail', reason: a.requestIssues[0] };
  return { status: 'pass' };
}

/**
 * Where two paths split: the last node both ran (the decision that went differently), or the first node when they
 * differ from the start. With `prefix`, a shorter actual path (verification stopped early) only counts where it disagrees.
 */
function divergence(expected: string[], actual: string[], prefix = false): string | undefined {
  const n = prefix ? actual.length : Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) if (expected[i] !== actual[i]) return i > 0 ? expected[i - 1] : expected[0] ?? actual[0];
  return undefined;
}


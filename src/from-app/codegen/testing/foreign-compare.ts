// The light half of the verification jobs (no code generator): the shapes the API sends `rabbinatix verify`, and what a
// job's raw outcome means, with the same compare() as the app's verification. The CLI bundles this file only.
import { compare, firstDifference, FrameOutcome, normalizeRequest, VerifyFrameResult } from '../verify/compare';
import type { FrameData } from '../verify/frames';

export type ForeignLanguage = 'python' | 'csharp' | 'java' | 'go' | 'kotlin' | 'swift' | 'dart' | 'php' | 'ruby' | 'rust';
export interface ForeignJob { frame: FrameData; source: string; root: string; async: boolean; deps: { name: string; kind: string; methods: string[] }[]; label: string }
export interface ForeignResult { label: string; frame: FrameData; result: VerifyFrameResult; source: string }
export interface RawOutcome extends Omit<FrameOutcome, 'requestIssues'> { sent: { label: string; key: string; index: number; request: unknown }[] }
/** the files to write before building (paths in the build folder) and Python's stdin (foreign-jobs.ts foreignProgram) */
export interface ForeignProgram { files: Record<string, string>; stdin?: string }

function outcome(job: ForeignJob, raw: RawOutcome): FrameOutcome {
  const requestIssues: string[] = [];
  for (const s of raw.sent ?? []) {
    const recorded = job.frame.boundaries[s.key]?.[s.index]?.request;
    const d = firstDifference(normalizeRequest(s.request), normalizeRequest(recorded));
    if (d !== null) requestIssues.push(`${s.label} at ${s.key}: request differs at ${d}`);
  }
  return { result: raw.result, error: raw.error, abort: raw.abort, path: raw.path ?? [], requestIssues };
}

/** what each job's run means: the same compare() as the app's verification */
export function foreignResults(list: ForeignJob[], raws: RawOutcome[]): ForeignResult[] {
  return list.map((j, i) => {
    const base = { frameId: j.frame.frameId, blueprintId: j.frame.blueprintId, blueprintKey: j.frame.blueprintKey };
    return { label: j.label, frame: j.frame, source: j.source, result: { ...base, ...compare(j.frame, outcome(j, raws[i])) } };
  });
}

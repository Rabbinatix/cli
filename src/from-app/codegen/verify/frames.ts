// TYPE STAND-IN (scripts/sync-from-app.mjs): only the FrameData shape of the app's codegen/verify/frames.ts, which the
// CLI receives from the API. The app's file also builds frames from runs, which the CLI never does.
export interface FrameData {
  frameId: string;
  blueprintId: string;
  blueprintKey: string;
  revision: number;
  kind: string;
  input: unknown;
  expected: { kind: 'return'; value: unknown } | { kind: 'error'; code: string; message: string } | { kind: 'none' };
  /** impure node keys the interpreter recorded, in order */
  path: string[];
  /** boundary answers (or errors) by node key, in call order; includes called functions' frames */
  boundaries: Record<string, { request: unknown; status?: number; response: unknown; headers?: unknown; error?: { code: string; message: string } }[]>;
  /** recorded now/uuid/random values by node key */
  nondet: Record<string, unknown[]>;
}

// TYPE STAND-IN (scripts/sync-from-app.mjs): only the file shape of the app's TypeScript emitter, which the API sends
// `rabbinatix generate`. The emitter itself stays on the server.
export interface SourceMapEntry { nodeKey: string; startLine: number; endLine: number }
export type FileRole = 'handler' | 'types' | 'deps' | 'runtime' | 'index' | 'map' | 'readme';
export interface GeneratedFile { path: string; name: string; role: FileRole; content: string; map: SourceMapEntry[]; blueprintId?: string }

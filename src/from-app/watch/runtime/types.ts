// Contract watcher (F57): types shared by the export (in the app) and the runtime (in the user's frontend).
// Pure TypeScript. The runtime folder is bundled into `rabbinatix-watch.js`; keep it free of Angular and app imports
// (only `../../engine` is allowed).
import { MismatchCode, RequestSpec, ResponseSpec } from '../../engine/types';

export const WATCH_FORMAT = 'rabbinatix-watch/1';

/** One API the watched system calls: its own expectation and, when resolved, the provider's declaration. */
export interface WatchApi {
  key: string;
  method: string;
  path: string;
  summary?: string;
  provider: { id: string; name: string };
  expects: { request: RequestSpec; responses: ResponseSpec[] };
  provides?: { request: RequestSpec; responses: ResponseSpec[] };
  link?: string;
}

/** What Rabbinatix exports for one system and embeds in the downloaded watcher. */
export interface WatchContracts {
  format: typeof WATCH_FORMAT;
  generatedAt: string;
  /** hash of `apis`: tells a download apart from the current contracts */
  fingerprint: string;
  org: { name: string; slug: string };
  system: { id: string; name: string; kind: string };
  link?: string;
  /** origin or host → provider system id; "/" is the page's own origin */
  hosts: Record<string, string>;
  apis: WatchApi[];
  /** where findings are reported (F58): Rabbinatix's API and this download's key; absent: they stay local */
  report?: { url: string; key: string };
}

export type FindingLevel = 'breaking' | 'warning' | 'info';
export type FindingCode = MismatchCode | 'UNDECLARED_CALL' | 'NOT_JSON';

export interface Finding {
  level: FindingLevel;
  code: FindingCode;
  /** checked against the consumer's own contract, or against the provider's declaration (its spec) */
  against: 'expectation' | 'provider';
  method: string;
  url: string;
  path?: string;
  apiKey?: string;
  provider?: string;
  /** the provider system the call's host maps to (an undeclared call has no API to say it) */
  providerId?: string;
  pointer: string;
  expected: string;
  actual: string;
  /** a short, truncated value, shown locally only */
  sample?: string;
  message: string;
  link?: string;
  /** the screens showing when the calls behind it were made (exported screens: SCREEN-… keys) */
  screens?: string[];
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface WatchOptions {
  /** origin or host → system id; overrides the downloaded table */
  hosts?: Record<string, string>;
  /** report findings at this level and above (default "warning") */
  warnOn?: FindingLevel;
  /** findings at this level and above make `failed()` true (default "never") */
  failOn?: FindingLevel | 'never';
  /** where findings go (default console and overlay) */
  report?: ('console' | 'overlay')[];
  /** calls never checked: path globs ("/api/*\/metrics") or regular expressions on the full URL */
  ignore?: (string | RegExp)[];
  /** send findings to Rabbinatix (default true when the download has a report address): the connection page shows
   *  them as drift, undeclared calls as "Declare this API?". Only what was expected and found is sent, never the values
   *  seen (`sample`); with them the calls checked (API, status, timing), which become the flows' observed traces. */
  share?: boolean;
  /** share of calls checked, 0–1 (default 1) */
  sample?: number;
  /** larger bodies are skipped (default 1 MB) */
  maxBodyBytes?: number;
  /** report calls to mapped hosts that match no contract (default true) */
  undeclared?: boolean;
  onFinding?: (f: Finding) => void;
}

export interface WatchHandle {
  stop(): void;
  findings(): Finding[];
  clear(): void;
  failed(): boolean;
}

/** One observed call, as the interceptor hands it to the checks. */
export interface ObservedCall {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  /** a body was sent but couldn't be read (Blob, FormData, a stream…): the request body isn't checked */
  requestBodyUnread?: boolean;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody?: string;
  /** the response body wasn't recorded (an OpenTelemetry span): its shape isn't checked */
  responseBodyUnread?: boolean;
  /** the request's headers weren't recorded (an OpenTelemetry span): required headers and auth aren't checked */
  requestHeadersUnread?: boolean;
  /** when the request started (ms since the epoch) and how long until its response came (F58: observed traces) */
  startedAt?: number;
  durationMs?: number;
  /** the screen showing when it started (`data-screen` of an exported screen) */
  screen?: string;
}

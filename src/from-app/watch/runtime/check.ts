// Check one real call against its contract: the response against the consumer's expectation and the provider's
// declaration, the request against the provider's declaration. Uses the contract engine's compareShape; only flags
// what one sample proves (required field missing, wrong type, null, unhandled enum value, undeclared status).
import { compareShape } from '../../engine/compare';
import { DEFAULT_SEVERITY } from '../../engine/messages';
import { Mismatch, ResponseSpec, Severity, Shape } from '../../engine/types';
import { isJsonType, observeShape, parseBody, valueAt } from './observe';
import { Finding, FindingCode, FindingLevel, ObservedCall, WatchApi } from './types';

/** a finding before it is counted and timed */
export type RawFinding = Omit<Finding, 'count' | 'firstSeen' | 'lastSeen'>;

const LEVEL: Record<Severity, FindingLevel> = { BREAKING: 'breaking', WARNING: 'warning', INFO: 'info' };

/** "response.body.user.id" → "response.user.id" */
export const readablePointer = (p: string) => p.replace(/^(request|response)\.body(\.|$)/, '$1$2').replace(/\.\[\]/g, '[]');

function sampleOf(root: unknown, pointer: string): string | undefined {
  const v = valueAt(root, pointer);
  if (v === undefined) return undefined;
  const s = JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

function describe(code: FindingCode, against: 'expectation' | 'provider', pointer: string, expected: string, actual: string): string {
  const f = readablePointer(pointer);
  const whose = against === 'expectation' ? 'your contract' : "the provider's declaration";
  switch (code) {
    case 'FIELD_MISSING': return pointer.startsWith('request') ? `${f} is required by the provider but was not sent` : `${f} is required by ${whose} but was missing`;
    case 'TYPE_MISMATCH': return `${f}: expected ${expected}, got ${actual}`;
    case 'NULLABILITY': return `${f} was null; ${whose} does not allow null`;
    case 'ENUM_VALUE_UNHANDLED': return `${f} was ${actual}; ${whose} only handles ${expected}`;
    case 'FIELD_EXTRA': return `${f} is not in ${whose} (new field?)`;
    case 'FIELD_UNKNOWN': return `${f} was sent but the provider does not accept it`;
    case 'STATUS_UNHANDLED': return `status ${actual} is not declared in your contract (declared: ${expected})`;
    case 'ERROR_STATUS_UNDECLARED': return `status ${actual} is not in the provider's declaration (declared: ${expected})`;
    case 'QUERY_PARAM_MISSING': return `query parameter ${f.split('.').pop()} is required by the provider but was not sent`;
    case 'HEADER_MISSING': return `header ${f.split('.').pop()} is required by the provider but was not sent`;
    case 'AUTH_MISSING': return `the provider requires ${expected} authentication; no Authorization header was sent`;
    case 'NOT_JSON': return `the response is not JSON; ${whose} expects a JSON body`;
    case 'UNDECLARED_CALL': return 'no contract covers this call';
    default: return `${f}: expected ${expected}, got ${actual}`;
  }
}

function add(out: RawFinding[], api: WatchApi, call: ObservedCall, against: 'expectation' | 'provider', code: FindingCode, level: FindingLevel, pointer: string, expected: string, actual: string, root?: unknown) {
  out.push({
    level, code, against, method: call.method.toUpperCase(), url: call.url, path: api.path, apiKey: api.key, provider: api.provider.name,
    pointer: readablePointer(pointer), expected, actual, sample: root !== undefined ? sampleOf(root, pointer) : undefined,
    message: describe(code, against, pointer, expected, actual), link: api.link,
  });
}

/** Walk the observed body against a declared shape and collect findings. */
function compareBody(out: RawFinding[], api: WatchApi, call: ObservedCall, against: 'expectation' | 'provider', dir: 'request' | 'response', value: unknown, declared: Shape) {
  compareShape(value === undefined ? undefined : observeShape(value, declared), declared, dir, `${dir}.body`, 'body', (m: Omit<Mismatch, 'severity' | 'message'> & { severity?: Severity }) => {
    // one sample can't prove optionality or format
    if (m.code === 'FIELD_OPTIONALITY' || m.code === 'FORMAT_MISMATCH') return;
    let level = LEVEL[m.severity ?? DEFAULT_SEVERITY[m.code]];
    // a stale provider spec is worth knowing, but it's the declaration that is wrong, not your app that breaks
    if (dir === 'response' && against === 'provider' && level === 'breaking') level = 'warning';
    add(out, api, call, against, m.code, level, m.pointer, m.expected, m.actual, value);
  });
}

const statusList = (rs: ResponseSpec[]) => rs.map((r) => r.status).join(', ') || 'none';
const isJson = (headers: Record<string, string>) => isJsonType(headers['content-type']);

export function checkCall(api: WatchApi, call: ObservedCall): RawFinding[] {
  const out: RawFinding[] = [];
  const res = parseBody(call.responseBody);
  const status = String(call.status);

  // response ↔ your contract
  const mine = api.expects.responses.find((r) => r.status === call.status);
  if (!mine) {
    if (api.expects.responses.length && call.status !== 304) add(out, api, call, 'expectation', 'STATUS_UNHANDLED', 'warning', 'response.status', statusList(api.expects.responses), status);
  } else if (mine.body && mine.body.type !== 'any' && !call.responseBodyUnread) {
    if (res.invalid || (call.responseBody && !isJson(call.responseHeaders) && res.value === undefined)) add(out, api, call, 'expectation', 'NOT_JSON', 'info', 'response.body', 'JSON', call.responseHeaders['content-type'] ?? 'unknown');
    else compareBody(out, api, call, 'expectation', 'response', res.value, mine.body);
  }

  if (api.provides) {
    // response ↔ the provider's declaration
    const theirs = api.provides.responses.find((r) => r.status === call.status);
    if (!theirs) {
      if (api.provides.responses.length && call.status !== 304) add(out, api, call, 'provider', 'ERROR_STATUS_UNDECLARED', 'info', 'response.status', statusList(api.provides.responses), status);
    } else if (theirs.body && theirs.body.type !== 'any' && !res.invalid && !call.responseBodyUnread) {
      compareBody(out, api, call, 'provider', 'response', res.value, theirs.body);
    }

    // request ↔ the provider's declaration
    const req = api.provides.request;
    const url = new URL(call.url);
    for (const q of req.query) if (q.required && !url.searchParams.has(q.name)) add(out, api, call, 'provider', 'QUERY_PARAM_MISSING', 'breaking', `request.query.${q.name}`, `${q.name} (required)`, 'absent');
    const sent = new Set(Object.keys(call.requestHeaders).map((h) => h.toLowerCase()));
    if (!call.requestHeadersUnread) for (const h of req.headers) {
      const name = h.name.toLowerCase();
      if (h.required && name !== 'authorization' && name !== 'content-type' && !sent.has(name)) add(out, api, call, 'provider', 'HEADER_MISSING', 'breaking', `request.headers.${name}`, `${h.name} (required)`, 'absent');
    }
    if (!call.requestHeadersUnread && req.auth.required && (req.auth.type === 'bearer' || req.auth.type === 'basic') && !sent.has('authorization')) add(out, api, call, 'provider', 'AUTH_MISSING', 'breaking', 'request.auth', req.auth.type, 'none');
    const body = parseBody(call.requestBody);
    // a body we couldn't read (Blob, FormData, a stream) proves nothing
    if (!call.requestBodyUnread && req.body && req.body.type !== 'any' && !body.invalid && ['POST', 'PUT', 'PATCH'].includes(call.method.toUpperCase())) compareBody(out, api, call, 'provider', 'request', body.value, req.body);
  }
  return out;
}

/** a call to a host we know that matches no contract */
export function undeclared(call: ObservedCall, path: string, providerId?: string): RawFinding {
  return {
    level: 'info', code: 'UNDECLARED_CALL', against: 'expectation', method: call.method.toUpperCase(), url: call.url, path, ...(providerId ? { providerId } : {}), pointer: 'request',
    expected: 'a contract', actual: `${call.method.toUpperCase()} ${path}`, message: describe('UNDECLARED_CALL', 'expectation', 'request', '', ''),
  };
}

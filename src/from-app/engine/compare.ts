import { DEFAULT_SEVERITY, mismatchMessage } from './messages';
import { calendarWords } from './calendar-words';
import { pathParamNames } from './path';
import { shapeLabel } from './shape-text';
import {
  CheckStatus, ContractStatus, Endpoint, ENGINE_VERSION, EvaluationResult, Mismatch, MismatchCode,
  MismatchPart, ParamSpec, Policy, ResponseSpec, Severity, Shape,
} from './types';

/** docs/02-engine/comparison.md */

type Sink = (m: Omit<Mismatch, 'severity' | 'message'> & { severity?: Severity }) => void;

const lc = (s: string) => s.toLowerCase();
const ct = (s?: string) => (s ? s.split(';')[0].trim().toLowerCase() : undefined);

function typesCompatible(sent: Shape, received: Shape): boolean {
  if (received.type === 'any' || sent.type === 'any') return true;
  if (sent.type === received.type) return true;
  return sent.type === 'integer' && received.type === 'number';
}

/** A union's options, each carrying the union's own nullability. */
const options = (s: Shape): Shape[] => (s.oneOf?.length ? s.oneOf.map((o) => (s.nullable ? { ...o, nullable: true } : o)) : [s]);

const SEVERITY_WEIGHT = { BREAKING: 1000, WARNING: 1, INFO: 0 } as const;
const severityOf = (m: Parameters<Sink>[0]) => m.severity ?? DEFAULT_SEVERITY[m.code];

function optionLabel(s: Shape, i: number, n: number): string {
  const keys = s.type === 'object' && !s.oneOf?.length ? Object.keys(s.properties ?? {}) : [];
  const what = keys.length ? `{ ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''} }` : shapeLabel(s);
  return `option ${i + 1} of ${n} (${what})`;
}

/**
 * Unions (docs/03-features/F15-importers.md). The rule is the same in both directions, on the sending side:
 * - every option the SENDING side may produce must be taken by the receiving side (a consumer reading a provider
 *   response must handle each option the provider may return; a provider must accept each body a consumer may send);
 * - a RECEIVING union takes a value when any one of its options does (a provider accepting `oneOf` takes a request
 *   body that fits one option; a consumer modelling the response as a union reads whichever option arrives).
 * For each sending option the receiving option with the fewest problems is reported, tagged with the option's name
 * (`Mismatch.option`); the same problem in several options is reported once, naming all of them.
 */
function compareUnion(sent: Shape, received: Shape, dir: 'request' | 'response', pointer: string, part: MismatchPart, add: Sink) {
  const weight = (ms: Parameters<Sink>[0][]) => ms.reduce((n, m) => n + SEVERITY_WEIGHT[severityOf(m)], 0);
  const sents = options(sent);
  const merged = new Map<string, { m: Parameters<Sink>[0]; labels: string[]; expected: string[]; actual: string[] }>();
  sents.forEach((s, i) => {
    let best: Parameters<Sink>[0][] = [];
    let bestWeight = Infinity;
    for (const r of options(received)) {
      const ms: Parameters<Sink>[0][] = [];
      compareShape(s, r, dir, pointer, part, (m) => ms.push(m));
      if (weight(ms) < bestWeight) [best, bestWeight] = [ms, weight(ms)];
    }
    const label = sents.length > 1 ? optionLabel(s, i, sents.length) : undefined;
    for (const m of best) {
      const tag = label && m.option ? `${label} › ${m.option}` : (label ?? m.option);
      const key = `${m.code}|${m.pointer}`;
      const seen = merged.get(key);
      if (!seen) {
        merged.set(key, { m, labels: tag ? [tag] : [], expected: [m.expected], actual: [m.actual] });
        continue;
      }
      if (tag) seen.labels.push(tag);
      if (!seen.expected.includes(m.expected)) seen.expected.push(m.expected);
      if (!seen.actual.includes(m.actual)) seen.actual.push(m.actual);
      if (SEVERITY_WEIGHT[severityOf(m)] > SEVERITY_WEIGHT[severityOf(seen.m)]) seen.m = { ...seen.m, severity: severityOf(m) };
    }
  });
  for (const { m, labels, expected, actual } of merged.values()) {
    const every = sents.length > 1 && labels.length === sents.length && labels.every((l) => !l.includes(' › '));
    add({
      ...m,
      expected: expected.join(' | '),
      actual: actual.join(' | '),
      option: every ? `any of its ${sents.length} options` : labels.length ? labels.join(', ') : undefined,
    });
  }
}

/**
 * Walks `sent` (the producing side) against `received` (the consuming side).
 * request: consumer → provider; response: provider → consumer.
 */
export function compareShape(
  sent: Shape | undefined,
  received: Shape | undefined,
  dir: 'request' | 'response',
  pointer: string,
  part: MismatchPart,
  add: Sink,
): void {
  const section = dir;
  if (!received) {
    if (sent && dir === 'request' && sent.type === 'object' && Object.keys(sent.properties ?? {}).length) {
      add({ code: 'FIELD_UNKNOWN', section, part, pointer, expected: 'no body', actual: shapeLabel(sent) });
    }
    return;
  }
  if (!sent) {
    const requiredFields = Object.entries(received.properties ?? {}).filter(([, f]) => f.required);
    if (received.type === 'object' && received.properties) {
      for (const [name] of requiredFields) {
        add({ code: 'FIELD_MISSING', section, part, pointer: `${pointer}.${name}`, expected: shapeLabel(received.properties[name]), actual: 'absent' });
      }
    } else if (received.type !== 'any') {
      add({ code: 'FIELD_MISSING', section, part, pointer, expected: shapeLabel(received), actual: 'no body' });
    }
    return;
  }
  if (sent.oneOf?.length || received.oneOf?.length) return compareUnion(sent, received, dir, pointer, part, add);

  if (!typesCompatible(sent, received)) {
    add({ code: 'TYPE_MISMATCH', section, part, pointer, expected: shapeLabel(received), actual: shapeLabel(sent) });
    return;
  }
  if (sent.nullable && !received.nullable && received.type !== 'any') {
    add({ code: 'NULLABILITY', section, part, pointer, expected: shapeLabel(received), actual: shapeLabel(sent) });
  }
  if (sent.enum?.length && received.enum?.length) {
    const extra = sent.enum.filter((v) => !received.enum!.includes(v));
    if (extra.length) {
      add({
        code: 'ENUM_VALUE_UNHANDLED', section, part, pointer,
        severity: dir === 'request' ? 'BREAKING' : 'WARNING',
        expected: received.enum.join(' | '), actual: extra.join(' | '),
      });
    }
  } else if (!sent.enum?.length && received.enum?.length && sent.type === 'string') {
    add({ code: 'ENUM_VALUE_UNHANDLED', section, part, pointer, severity: 'WARNING', expected: received.enum.join(' | '), actual: 'any string' });
  }
  if (sent.format && received.format && sent.format !== received.format) {
    add({ code: 'FORMAT_MISMATCH', section, part, pointer, expected: received.format, actual: sent.format });
  }

  if (sent.type === 'object' && received.type === 'object') {
    const sp = sent.properties ?? {};
    const rp = received.properties ?? {};
    for (const [name, rf] of Object.entries(rp)) {
      const sf = sp[name];
      const p = `${pointer}.${name}`;
      if (!sf) {
        if (rf.required) add({ code: 'FIELD_MISSING', section, part, pointer: p, expected: shapeLabel(rf), actual: 'absent' });
        continue;
      }
      if (rf.required && !sf.required) {
        add({ code: 'FIELD_OPTIONALITY', section, part, pointer: p, expected: `${shapeLabel(rf)} (required)`, actual: `${shapeLabel(sf)} (optional)` });
      }
      compareShape(sf, rf, dir, p, part, add);
    }
    for (const [name, sf] of Object.entries(sp)) {
      if (rp[name]) continue;
      const p = `${pointer}.${name}`;
      if (dir === 'request') {
        add({
          code: 'FIELD_UNKNOWN', section, part, pointer: p,
          severity: received.additionalProperties === false ? 'BREAKING' : 'WARNING',
          expected: 'not accepted', actual: shapeLabel(sf),
        });
      } else {
        add({ code: 'FIELD_EXTRA', section, part, pointer: p, expected: 'not read', actual: shapeLabel(sf) });
      }
    }
  }
  if (sent.type === 'array' && received.type === 'array' && sent.items && received.items) {
    compareShape(sent.items, received.items, dir, `${pointer}.[]`, part, add);
  }
}

function compareParams(
  mustProvide: ParamSpec[],
  provided: ParamSpec[],
  pointerBase: string,
  part: MismatchPart,
  section: 'request' | 'response',
  missingCode: MismatchCode,
  caseInsensitive: boolean,
  add: Sink,
) {
  const norm = (s: string) => (caseInsensitive ? lc(s) : s);
  // expected = consumer side, actual = provider side; in a request the provider is the one that must be provided for
  const valueMismatch = (pointer: string, need: ParamSpec, have: ParamSpec) =>
    add({ code: 'HEADER_VALUE_MISMATCH', section, part, pointer, expected: section === 'request' ? have.value! : need.value!, actual: section === 'request' ? need.value! : have.value! });
  for (const need of mustProvide) {
    const have = provided.find((p) => norm(p.name) === norm(need.name));
    const pointer = `${pointerBase}.${norm(need.name)}`;
    if (!need.required) {
      if (have && need.value && have.value && need.value !== have.value) valueMismatch(pointer, need, have);
      continue;
    }
    if (!have) {
      add({ code: missingCode, section, part, pointer, expected: `${need.name} (required)`, actual: 'absent' });
      continue;
    }
    if (section === 'response' && !have.required && part === 'headers') {
      add({ code: 'HEADER_OPTIONALITY', section, part, pointer, expected: 'required', actual: 'optional' });
    }
    if (need.value && have.value && need.value !== have.value) {
      valueMismatch(pointer, need, have);
    } else if (!typesCompatible(section === 'request' ? have.schema : need.schema, section === 'request' ? need.schema : have.schema)) {
      add({ code: 'TYPE_MISMATCH', section, part, pointer, expected: shapeLabel(need.schema), actual: shapeLabel(have.schema) });
    }
  }
}

export function primaryResponse(e: Endpoint): ResponseSpec | undefined {
  return e.responses.find((r) => r.primary) ?? e.responses.find((r) => r.status >= 200 && r.status < 300) ?? e.responses[0];
}

function worst(ms: Mismatch[]): CheckStatus {
  if (ms.some((m) => m.severity === 'BREAKING')) return 'failed';
  if (ms.some((m) => m.severity === 'WARNING')) return 'warning';
  return 'passed';
}

function combine(...s: CheckStatus[]): CheckStatus {
  if (s.includes('failed')) return 'failed';
  if (s.includes('warning')) return 'warning';
  if (s.every((x) => x === 'skipped')) return 'skipped';
  return 'passed';
}

export function emptyResult(status: ContractStatus): EvaluationResult {
  return {
    status,
    sections: {
      request: { status: 'skipped', method: 'skipped', path: 'skipped', headers: 'skipped', query: 'skipped', pathParams: 'skipped', auth: 'skipped', body: 'skipped' },
      response: { status: 'skipped', statusCode: 'skipped', headers: 'skipped', body: 'skipped' },
    },
    mismatches: [],
    suggestions: [],
    engineVersion: ENGINE_VERSION,
  };
}

export function evaluate(consumer: Endpoint, provider: Endpoint | null, policy?: Policy, now: Date = new Date()): EvaluationResult {
  if (!provider) return emptyResult('UNRESOLVED');

  const raw: Mismatch[] = [];
  const add: Sink = (m) => {
    const severity = m.severity ?? DEFAULT_SEVERITY[m.code];
    const message = mismatchMessage(m.code, m.pointer, m.expected, m.actual)
      + (m.option ? ` Applies when the ${m.section === 'request' ? 'consumer' : 'provider'} sends ${m.option}.` : '');
    raw.push({ ...m, severity, message });
  };

  // ---- request ----
  // normal matching needs equal methods; a hand-made link can pair different ones (mismatch-catalog.md)
  if (consumer.method.toUpperCase() !== provider.method.toUpperCase()) {
    add({ code: 'METHOD_MISMATCH', section: 'request', part: 'method', pointer: 'request.method', expected: consumer.method, actual: provider.method });
  }
  const cr = consumer.request;
  const pr = provider.request;
  compareParams(pr.headers, cr.headers, 'request.headers', 'headers', 'request', 'HEADER_MISSING', true, add);
  compareParams(pr.query, cr.query, 'request.query', 'query', 'request', 'QUERY_PARAM_MISSING', false, add);

  const cNames = pathParamNames(consumer.path);
  const pNames = pathParamNames(provider.path);
  pNames.forEach((pn, i) => {
    const cn = cNames[i];
    if (!cn) return;
    const ps = pr.pathParams.find((p) => p.name === pn)?.schema ?? { type: 'string' };
    const cs = cr.pathParams.find((p) => p.name === cn)?.schema ?? { type: 'string' };
    if (!typesCompatible(cs, ps) || (cs.format && ps.format && cs.format !== ps.format)) {
      add({ code: 'PATH_PARAM_TYPE', section: 'request', part: 'pathParams', pointer: `request.pathParams.${pn}`, expected: shapeLabel(cs), actual: shapeLabel(ps) });
    }
  });

  if (ct(cr.contentType) && ct(pr.contentType) && ct(cr.contentType) !== ct(pr.contentType)) {
    add({ code: 'CONTENT_TYPE_MISMATCH', section: 'request', part: 'headers', pointer: 'request.headers.content-type', expected: cr.contentType!, actual: pr.contentType! });
  }

  if (pr.auth.required && pr.auth.type !== 'none') {
    if (cr.auth.type === 'none') {
      add({ code: 'AUTH_MISSING', section: 'request', part: 'auth', pointer: 'request.auth', expected: 'none', actual: pr.auth.type });
    } else if (cr.auth.type !== pr.auth.type) {
      add({ code: 'AUTH_TYPE_MISMATCH', section: 'request', part: 'auth', pointer: 'request.auth', expected: cr.auth.type, actual: pr.auth.type });
    } else {
      const missing = (pr.auth.scopes ?? []).filter((s) => !(cr.auth.scopes ?? []).includes(s));
      if (missing.length) add({ code: 'AUTH_SCOPE_MISSING', section: 'request', part: 'auth', pointer: 'request.auth', expected: (cr.auth.scopes ?? []).join(', ') || 'none', actual: missing.join(', ') });
    }
  } else if (cr.auth.type !== 'none') {
    add({ code: 'AUTH_UNNEEDED', section: 'request', part: 'auth', pointer: 'request.auth', expected: cr.auth.type, actual: 'none' });
  }

  compareShape(cr.body, pr.body, 'request', 'request.body', 'body', add);

  // ---- response ----
  const primary = primaryResponse(consumer);
  const providerStatuses = provider.responses.map((r) => r.status);
  if (primary && !providerStatuses.includes(primary.status)) {
    add({ code: 'STATUS_MISSING', section: 'response', part: 'statusCode', pointer: `response[${primary.status}]`, expected: String(primary.status), actual: providerStatuses.join(', ') || 'none' });
  }
  for (const r of consumer.responses) {
    if (r === primary || providerStatuses.includes(r.status)) continue;
    add({ code: 'ERROR_STATUS_UNDECLARED', section: 'response', part: 'statusCode', pointer: `response[${r.status}]`, expected: String(r.status), actual: 'not declared' });
  }
  for (const pr2 of provider.responses) {
    if (pr2.status >= 200 && pr2.status < 300 && !consumer.responses.some((r) => r.status === pr2.status)) {
      add({ code: 'STATUS_UNHANDLED', section: 'response', part: 'statusCode', pointer: `response[${pr2.status}]`, expected: consumer.responses.map((r) => r.status).join(', '), actual: String(pr2.status) });
    }
  }
  for (const c of consumer.responses) {
    const p = provider.responses.find((r) => r.status === c.status);
    if (!p) continue;
    const base = `response[${c.status}]`;
    compareParams(c.headers, p.headers, `${base}.headers`, 'headers', 'response', 'HEADER_MISSING', true, add);
    if (ct(c.contentType) && ct(p.contentType) && ct(c.contentType) !== ct(p.contentType)) {
      add({ code: 'CONTENT_TYPE_MISMATCH', section: 'response', part: 'headers', pointer: `${base}.headers.content-type`, expected: c.contentType!, actual: p.contentType! });
    }
    compareShape(p.body, c.body, 'response', `${base}.body`, 'body', add);
  }

  // ---- deprecation ----
  if (provider.deprecation) {
    const sunset = provider.deprecation.sunsetAt;
    const passed = sunset ? new Date(sunset).getTime() < now.getTime() : false;
    add({
      code: passed ? 'ENDPOINT_SUNSET' : 'ENDPOINT_DEPRECATED', section: 'endpoint', part: 'endpoint', pointer: 'endpoint',
      expected: provider.deprecation.replacementEndpointId ? 'the replacement endpoint' : '', actual: sunset ? calendarWords(sunset) : '',
    });
  }

  // ---- policy ----
  const mismatches: Mismatch[] = [];
  for (const m of raw) {
    const o = policy?.overrides[m.code];
    if (o === 'OFF') continue;
    mismatches.push(o ? { ...m, severity: o } : m);
  }

  const of = (section: string, part?: MismatchPart) =>
    mismatches.filter((m) => m.section === section && (!part || m.part === part));
  const request = {
    method: worst(of('request', 'method')),
    path: 'passed' as CheckStatus,
    headers: worst(of('request', 'headers')),
    query: worst(of('request', 'query')),
    pathParams: worst(of('request', 'pathParams')),
    auth: worst(of('request', 'auth')),
    body: worst(of('request', 'body')),
    status: 'passed' as CheckStatus,
  };
  request.status = combine(request.method, request.headers, request.query, request.pathParams, request.auth, request.body);
  const response = {
    statusCode: worst(of('response', 'statusCode')),
    headers: worst(of('response', 'headers')),
    body: worst(of('response', 'body')),
    status: 'passed' as CheckStatus,
  };
  response.status = combine(response.statusCode, response.headers, response.body);

  const breaking = mismatches.some((m) => m.severity === 'BREAKING');
  const warning = mismatches.some((m) => m.severity === 'WARNING');
  let status: ContractStatus;
  if ((provider.lifecycle ?? 'deployed') !== 'deployed') status = breaking ? 'CONFLICT' : 'PLANNED';
  else status = breaking ? 'BROKEN' : warning ? 'WARNING' : 'HEALTHY';

  const order: Record<Severity, number> = { BREAKING: 0, WARNING: 1, INFO: 2 };
  mismatches.sort((a, b) => order[a.severity] - order[b.severity]);

  return { status, sections: { request, response }, mismatches, suggestions: [], engineVersion: ENGINE_VERSION };
}

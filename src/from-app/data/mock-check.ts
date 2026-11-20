// The hosted mock server's "Validate requests" (F17): does a call fit the provider's declared request? Required query
// parameters, required headers, authentication, and the JSON body (the contract engine's compareShape, on the shape of
// the value sent, as the contract watcher checks calls). Only what one call proves: optionality and formats aren't
// judged from a single sample. Pure; the mock function (functions/src/mock-logic.ts) uses it.
import { compareShape } from '../engine/compare';
import { DEFAULT_SEVERITY } from '../engine/messages';
import { Mismatch, RequestSpec, Severity } from '../engine/types';
import { observeShape } from '../watch/runtime/observe';

export interface MockCall {
  method: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  /** the parsed JSON body, or undefined when none was sent */
  body?: unknown;
}
export interface RequestProblem {
  /** request.query.page, request.headers.x-tenant, request.auth, request.body.user.email */
  pointer: string;
  message: string;
}

const readable = (p: string) => p.replace(/^request\.body(\.|$)/, 'request$1').replace(/\.\[\]/g, '[]');

export function requestProblems(spec: RequestSpec, call: MockCall): RequestProblem[] {
  const out: RequestProblem[] = [];
  const headers = new Map(Object.entries(call.headers).map(([k, v]) => [k.toLowerCase(), v]));
  for (const q of spec.query) if (q.required && call.query[q.name] === undefined) out.push({ pointer: `request.query.${q.name}`, message: `query parameter ${q.name} is required but was not sent` });
  for (const h of spec.headers) {
    const name = h.name.toLowerCase();
    if (h.required && name !== 'authorization' && name !== 'content-type' && !headers.has(name)) out.push({ pointer: `request.headers.${name}`, message: `header ${h.name} is required but was not sent` });
  }
  if (spec.auth.required && (spec.auth.type === 'bearer' || spec.auth.type === 'basic') && !headers.has('authorization')) {
    out.push({ pointer: 'request.auth', message: `${spec.auth.type} authentication is required; no Authorization header was sent` });
  }
  const method = call.method.toUpperCase();
  if (spec.body && spec.body.type !== 'any' && ['POST', 'PUT', 'PATCH'].includes(method)) {
    compareShape(call.body === undefined ? undefined : observeShape(call.body, spec.body), spec.body, 'request', 'request.body', 'body', (m: Omit<Mismatch, 'severity' | 'message'> & { severity?: Severity }) => {
      // one call can't prove optionality or a format; only what breaks the provider is a rejection
      if (m.code === 'FIELD_OPTIONALITY' || m.code === 'FORMAT_MISMATCH') return;
      if ((m.severity ?? DEFAULT_SEVERITY[m.code]) !== 'BREAKING') return;
      const f = readable(m.pointer);
      const message = m.code === 'FIELD_MISSING' ? `${f} is required but was not sent`
        : m.code === 'NULLABILITY' ? `${f} was null, which the provider doesn't allow`
          : m.code === 'FIELD_UNKNOWN' ? `${f} was sent but the provider doesn't accept it`
            : `${f}: expected ${m.expected}, got ${m.actual}`;
      out.push({ pointer: readable(m.pointer), message });
    });
  }
  return out;
}

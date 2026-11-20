import { MismatchCode, Severity } from './types';

export const DEFAULT_SEVERITY: Record<MismatchCode, Severity> = {
  METHOD_MISMATCH: 'BREAKING',
  HEADER_MISSING: 'BREAKING',
  HEADER_OPTIONALITY: 'WARNING',
  HEADER_VALUE_MISMATCH: 'BREAKING',
  QUERY_PARAM_MISSING: 'BREAKING',
  PATH_PARAM_TYPE: 'BREAKING',
  CONTENT_TYPE_MISMATCH: 'BREAKING',
  AUTH_MISSING: 'BREAKING',
  AUTH_TYPE_MISMATCH: 'BREAKING',
  AUTH_SCOPE_MISSING: 'WARNING',
  AUTH_UNNEEDED: 'INFO',
  STATUS_MISSING: 'BREAKING',
  STATUS_UNHANDLED: 'WARNING',
  ERROR_STATUS_UNDECLARED: 'INFO',
  TYPE_MISMATCH: 'BREAKING',
  NULLABILITY: 'BREAKING',
  FIELD_MISSING: 'BREAKING',
  FIELD_OPTIONALITY: 'BREAKING',
  FIELD_UNKNOWN: 'WARNING',
  FIELD_EXTRA: 'INFO',
  ENUM_VALUE_UNHANDLED: 'WARNING',
  FORMAT_MISMATCH: 'WARNING',
  ENDPOINT_DEPRECATED: 'WARNING',
  ENDPOINT_SUNSET: 'BREAKING',
};

export const MISMATCH_TITLES: Record<MismatchCode, string> = {
  METHOD_MISMATCH: 'HTTP method differs',
  HEADER_MISSING: 'Required header missing',
  HEADER_OPTIONALITY: 'Header may be absent',
  HEADER_VALUE_MISMATCH: 'Header value differs',
  QUERY_PARAM_MISSING: 'Required query parameter missing',
  PATH_PARAM_TYPE: 'Path parameter type differs',
  CONTENT_TYPE_MISMATCH: 'Content type differs',
  AUTH_MISSING: 'Authentication missing',
  AUTH_TYPE_MISMATCH: 'Authentication type differs',
  AUTH_SCOPE_MISSING: 'Authorization scope missing',
  AUTH_UNNEEDED: 'Credentials not needed',
  STATUS_MISSING: 'Expected status not returned',
  STATUS_UNHANDLED: 'Status not handled by consumer',
  ERROR_STATUS_UNDECLARED: 'Handled status never returned',
  TYPE_MISMATCH: 'Type mismatch',
  NULLABILITY: 'Value may be null',
  FIELD_MISSING: 'Field missing',
  FIELD_OPTIONALITY: 'Field may be absent',
  FIELD_UNKNOWN: 'Field not accepted',
  FIELD_EXTRA: 'Extra field',
  ENUM_VALUE_UNHANDLED: 'Unhandled enum value',
  FORMAT_MISMATCH: 'Format differs',
  ENDPOINT_DEPRECATED: 'Endpoint deprecated',
  ENDPOINT_SUNSET: 'Endpoint past sunset',
};

/** "response[200].body.user.email" → "response 200 body › user.email" */
const DOCS_LABEL: Record<string, string> = { meaning: 'meaning', example: 'example', when: 'when it happens' };

export function humanPointer(pointer: string): string {
  if (pointer === 'description') return 'details';
  if (pointer === 'decisionNote') return 'why it is like this';
  // the endpoint's own fields (dev round 2: the migration guide read "apiVersion v1 → v2")
  if (pointer === 'apiVersion') return 'API version';
  const docs = /#(meaning|example|when)$/.exec(pointer);
  if (docs) return `${humanPointer(pointer.slice(0, docs.index))} (${DOCS_LABEL[docs[1]]})`;
  return pointer
    .replace(/^response\[(\d+)\]/, 'response $1')
    // only the section right after request / response: a body field may be called `headers` or `query`
    .replace(/^(request|response \d+)\.body\.?/, '$1 body › ')
    .replace(/^(request|response \d+)\.headers\./, '$1 header › ')
    .replace(/^(request|response \d+)\.query\./, '$1 query › ')
    .replace(/^(request|response \d+)\.pathParams\./, '$1 path param › ')
    .replace(/ › $/, '')
    .replace(/\.\[\]/g, '[]');
}

export function fieldName(pointer: string): string {
  const m = /(?:body|headers|query|pathParams)\.(.+)$/.exec(pointer);
  return m ? m[1].replace(/\.\[\]/g, '[]') : pointer;
}

export function mismatchMessage(code: MismatchCode, pointer: string, expected: string, actual: string): string {
  const f = '`' + fieldName(pointer) + '`';
  switch (code) {
    case 'HEADER_MISSING':
      return pointer.startsWith('request')
        ? `The provider requires header ${f} but the consumer does not send it.`
        : `The consumer relies on header ${f} but the provider does not return it.`;
    case 'HEADER_OPTIONALITY':
      return `The consumer relies on header ${f}, but the provider marks it optional.`;
    case 'HEADER_VALUE_MISMATCH':
      return `Header ${f} is "${expected}" on the consumer side but "${actual}" on the provider.`;
    case 'QUERY_PARAM_MISSING':
      return `The provider requires query parameter ${f} but the consumer does not send it.`;
    case 'PATH_PARAM_TYPE':
      return `Path parameter ${f} is ${expected} for the consumer but ${actual} for the provider.`;
    case 'CONTENT_TYPE_MISMATCH':
      return `Content type differs: consumer uses ${expected}, provider uses ${actual}.`;
    case 'AUTH_MISSING':
      return `The provider requires ${actual} authentication, but the consumer sends no credentials.`;
    case 'AUTH_TYPE_MISMATCH':
      return `The consumer authenticates with ${expected}, but the provider expects ${actual}.`;
    case 'AUTH_SCOPE_MISSING':
      return `The provider requires scope(s) ${actual} that the consumer does not request.`;
    case 'AUTH_UNNEEDED':
      return `The consumer sends ${expected} credentials the provider does not require.`;
    case 'STATUS_MISSING':
      return `The consumer expects status ${expected}, but the provider never returns it (returns ${actual}).`;
    case 'STATUS_UNHANDLED':
      return `The provider may return ${actual}, which the consumer does not handle.`;
    case 'ERROR_STATUS_UNDECLARED':
      return `The consumer handles ${expected}, but the provider does not declare it.`;
    case 'TYPE_MISMATCH':
      return `${f} is expected as ${expected} but the other side uses ${actual}.`;
    case 'NULLABILITY':
      return `${f} may be null on the sending side, but the receiving side does not accept null.`;
    case 'FIELD_MISSING':
      return pointer.startsWith('request')
        ? `The provider requires ${f} but the consumer does not send it.`
        : `The consumer expects ${f} but the provider does not return it.`;
    case 'FIELD_OPTIONALITY':
      return pointer.startsWith('request')
        ? `The provider requires ${f}, but the consumer may omit it.`
        : `The consumer requires ${f}, but the provider may omit it.`;
    case 'FIELD_UNKNOWN':
      return `The consumer sends ${f}, which the provider does not accept.`;
    case 'FIELD_EXTRA':
      return `The provider returns ${f}, which the consumer ignores.`;
    case 'ENUM_VALUE_UNHANDLED':
      return `${f} may be ${actual}, but only ${expected} is handled.`;
    case 'FORMAT_MISMATCH':
      return `${f} format is ${expected} on one side and ${actual} on the other.`;
    case 'ENDPOINT_DEPRECATED':
      // in the app's words: a shutdown, not a sunset; with no replacement named, none is promised (found on dev)
      return `This endpoint is deprecated${actual ? ` and shuts down on ${actual}` : ''}. ${expected ? `Migrate to ${expected}.` : `Migrate off it${actual ? ' before then' : ''}.`}`;
    case 'ENDPOINT_SUNSET':
      return `This endpoint passed its shutdown date (${actual}) and may be removed at any time.`;
    case 'METHOD_MISMATCH':
      return `The consumer uses ${expected} but the provider uses ${actual}.`;
  }
}

// Canonical domain types. See docs/01-domain/endpoint-schema.md and contract-status.md.
// Pure TypeScript: no Angular or Firebase imports allowed in /engine.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export type EndpointRole = 'consumer' | 'provider';
export type ProviderLifecycle = 'todo' | 'in_progress' | 'deployed';

export type ShapeType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null' | 'any';

export interface Shape {
  type: ShapeType;
  nullable?: boolean;
  format?: string;
  enum?: (string | number)[];
  properties?: Record<string, Field>;
  additionalProperties?: boolean;
  items?: Shape;
  /** a union (OpenAPI oneOf/anyOf): the value matches one of these; `type` is then 'any' so union-unaware code stays lenient */
  oneOf?: Shape[];
  /** what the value means, in plain words ("Meaning" in the editor and the API reference) */
  description?: string;
  /** an example value (a field's own; a whole body's example is RequestSpec/ResponseSpec.example) */
  example?: unknown;
}

export interface Field extends Shape {
  required: boolean;
}

export interface ParamSpec {
  name: string;
  required: boolean;
  schema: Shape;
  value?: string;
  /** what the parameter means */
  description?: string;
  /** an example value, as sent */
  example?: string;
}

export type AuthType = 'none' | 'bearer' | 'basic' | 'apiKey' | 'oauth2';

export interface AuthSpec {
  type: AuthType;
  required: boolean;
  scopes?: string[];
}

export interface RequestSpec {
  headers: ParamSpec[];
  query: ParamSpec[];
  pathParams: ParamSpec[];
  auth: AuthSpec;
  contentType?: string;
  body?: Shape;
  /** a full example body; field examples fill what it leaves out */
  example?: unknown;
}

export interface ResponseSpec {
  status: number;
  primary?: boolean;
  headers: ParamSpec[];
  contentType?: string;
  body?: Shape;
  /** when the provider returns this status ("When it happens") */
  description?: string;
  /** a full example body */
  example?: unknown;
}

export interface Deprecation {
  deprecatedAt: string;
  sunsetAt?: string;
  replacementEndpointId?: string;
  note?: string;
  initialConsumerSystemIds: string[];
}

export interface Endpoint {
  id: string;
  systemId: string;
  role: EndpointRole;
  protocol: 'http';
  targetSystemId?: string;
  method: HttpMethod;
  path: string;
  apiVersion: string;
  summary?: string;
  /** Markdown "Details": what it does, side effects, permissions, gotchas (F91) */
  description?: string;
  /** why it is like this: a short Markdown decision note (F96) */
  decisionNote?: string;
  request: RequestSpec;
  responses: ResponseSpec[];
  lifecycle?: ProviderLifecycle;
  deprecation?: Deprecation;
  neededBy?: string;
  createdFromConsumerEndpointId?: string;
  /** F50: created by a flow store import */
  importedFrom?: { importId: string; templateId: string; templateVersion: string; localRef: string };
  revision: number;
  createdAt: string;
  updatedAt: string;
}

// ---------- evaluation ----------

export type ContractStatus = 'UNRESOLVED' | 'PLANNED' | 'CONFLICT' | 'HEALTHY' | 'WARNING' | 'BROKEN' | 'UNKNOWN';
export const CONTRACT_STATUSES: ContractStatus[] = [
  'BROKEN', 'CONFLICT', 'WARNING', 'UNKNOWN', 'UNRESOLVED', 'PLANNED', 'HEALTHY',
];

export type Severity = 'BREAKING' | 'WARNING' | 'INFO';
export type CheckStatus = 'passed' | 'warning' | 'failed' | 'skipped';

export type MismatchCode =
  | 'METHOD_MISMATCH' | 'HEADER_MISSING' | 'HEADER_OPTIONALITY' | 'HEADER_VALUE_MISMATCH'
  | 'QUERY_PARAM_MISSING' | 'PATH_PARAM_TYPE' | 'CONTENT_TYPE_MISMATCH'
  | 'AUTH_MISSING' | 'AUTH_TYPE_MISMATCH' | 'AUTH_SCOPE_MISSING' | 'AUTH_UNNEEDED'
  | 'STATUS_MISSING' | 'STATUS_UNHANDLED' | 'ERROR_STATUS_UNDECLARED'
  | 'TYPE_MISMATCH' | 'NULLABILITY' | 'FIELD_MISSING' | 'FIELD_OPTIONALITY' | 'FIELD_UNKNOWN'
  | 'FIELD_EXTRA' | 'ENUM_VALUE_UNHANDLED' | 'FORMAT_MISMATCH'
  | 'ENDPOINT_DEPRECATED' | 'ENDPOINT_SUNSET';

export type MismatchPart = 'method' | 'path' | 'headers' | 'query' | 'pathParams' | 'auth' | 'body' | 'statusCode' | 'endpoint';

export interface Mismatch {
  code: MismatchCode;
  severity: Severity;
  section: 'request' | 'response' | 'endpoint';
  part: MismatchPart;
  pointer: string;
  expected: string;
  actual: string;
  message: string;
  /** which option(s) of the sending side's union this applies to, e.g. "option 2 of 3 ({ id, name })" */
  option?: string;
}

export interface Suggestion {
  providerEndpointId: string;
  reason: string;
}

export interface RequestChecks {
  status: CheckStatus;
  method: CheckStatus; path: CheckStatus; headers: CheckStatus; query: CheckStatus;
  pathParams: CheckStatus; auth: CheckStatus; body: CheckStatus;
}
export interface ResponseChecks {
  status: CheckStatus;
  statusCode: CheckStatus; headers: CheckStatus; body: CheckStatus;
}

export interface EvaluationResult {
  status: ContractStatus;
  sections: { request: RequestChecks; response: ResponseChecks };
  mismatches: Mismatch[];
  suggestions: Suggestion[];
  engineVersion: string;
}

export interface Contract {
  id: string;
  consumerEndpointId: string;
  consumerSystemId: string;
  providerSystemId: string;
  providerEndpointId: string | null;
  matchKey: string;
  status: ContractStatus;
  result: EvaluationResult;
}

export interface Connection {
  id: string;
  consumerSystemId: string;
  providerSystemId: string;
  status: ContractStatus;
  counts: Record<ContractStatus, number>;
  total: number;
}

export type PolicyOverride = Severity | 'OFF';
export interface Policy {
  version: number;
  overrides: Partial<Record<MismatchCode, PolicyOverride>>;
}

export const ENGINE_VERSION = '0.1.0';

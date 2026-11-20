// The one call `rabbinatix impact` makes: POST {api}/impact with the API token. Only keys, names, paths and line numbers
// are sent.
import { call, Connection } from './connect.js';

export interface ImpactResponse {
  report: Record<string, unknown> & {
    starts: unknown[];
    triage: { kind: string; mustLook: boolean }[];
    dimensions: { far: { criticalFlows: number }; tests?: { failing: number } };
    notMapped?: { file: string; lines?: string }[];
  };
  markdown: string;
  id?: string;
  link?: string;
  again?: boolean;
}

export const postImpact = (c: Connection, body: unknown, warn?: (s: string) => void) => call<ImpactResponse>(c, 'POST', '/impact', { body, warn });

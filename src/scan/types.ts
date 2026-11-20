// A finding as `rabbinatix scan` prints and reports it (the shape POST /v1/code-scan takes: code-scan.ts ReportedFinding).

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];
export const rank = (s: Severity) => SEVERITIES.indexOf(s);

export interface Finding {
  /** from the repository's root, with forward slashes */
  file: string;
  line: number;
  category: string;
  severity: Severity;
  title: string;
  detail?: string;
  /** the line, secrets masked */
  snippet?: string;
  fixHint?: string;
  cwe?: string;
  owasp?: string;
  /** `rabbinatix:<rule>`, `gitleaks:<rule>`, `semgrep:<rule>`, `osv:<advisory>` */
  rule: string;
}

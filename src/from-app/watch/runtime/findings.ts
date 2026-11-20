// Findings of one session: deduplicated by (api, pointer, code, side), counted, filtered by level.
import { RawFinding } from './check';
import { Finding, FindingLevel } from './types';

export const RANK: Record<FindingLevel, number> = { info: 0, warning: 1, breaking: 2 };
export const atLeast = (level: FindingLevel, min: FindingLevel) => RANK[level] >= RANK[min];

/** screens kept per finding */
const MAX_SCREENS = 5;

export function createFindings() {
  const byKey = new Map<string, Finding>();
  return {
    /** record a finding; `isNew` when this (api, pointer, code, side) was not seen this session */
    add(raw: RawFinding, now = new Date().toISOString(), screen?: string): { finding: Finding; isNew: boolean } {
      const key = [raw.apiKey ?? `${raw.method} ${raw.path}`, raw.pointer, raw.code, raw.against].join('|');
      const prev = byKey.get(key);
      if (prev) {
        prev.count++;
        prev.lastSeen = now;
        // the screens it was seen on (a few: enough to find the button)
        if (screen && !prev.screens?.includes(screen) && (prev.screens?.length ?? 0) < MAX_SCREENS) prev.screens = [...(prev.screens ?? []), screen];
        return { finding: prev, isNew: false };
      }
      const finding: Finding = { ...raw, ...(screen ? { screens: [screen] } : {}), count: 1, firstSeen: now, lastSeen: now };
      byKey.set(key, finding);
      return { finding, isNew: true };
    },
    list: (): Finding[] => [...byKey.values()].sort((a, b) => RANK[b.level] - RANK[a.level]),
    clear: () => byKey.clear(),
    failed: (failOn: FindingLevel | 'never') => failOn !== 'never' && [...byKey.values()].some((f) => atLeast(f.level, failOn)),
  };
}

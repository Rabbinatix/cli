// F58: findings go to Rabbinatix's API, about 10 seconds after they happen, in batches; each finding once per batch
// with how many times it was seen since the last one. Values seen (`sample`) never leave the page. The request uses
// the fetch the page had before the watcher patched it, so reporting is never itself watched.
// The calls checked go along (the API's key, status and timing, never the URL): Rabbinatix turns a batch into an
// observed trace of the flows that make those calls.
import { Finding, ObservedCall, WatchContracts } from './types';

// every 10 s at most: each report costs reads on the server (cost review C3)
const DELAY_MS = 10_000;
/** calls kept for one batch (the server reads no more) */
const MAX_CALLS = 50;
const key = (f: Finding) => [f.apiKey ?? `${f.method} ${f.path ?? f.url}`, f.code, f.pointer, f.against].join('|');

export function createReporter(contracts: WatchContracts, send: typeof fetch) {
  const report = contracts.report!;
  const providerOf = new Map(contracts.apis.map((a) => [a.key, a.provider.id]));
  const sent = new Map<string, number>();
  const pending = new Map<string, Finding>();
  let calls: { apiKey: string; status: number; startMs: number; durationMs: number; screen?: string }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const findings = [...pending.values()].map((f) => ({
      method: f.method, path: f.path ?? new URL(f.url).pathname, apiKey: f.apiKey, providerId: (f.apiKey && providerOf.get(f.apiKey)) || f.providerId || '', code: f.code, level: f.level, against: f.against,
      pointer: f.pointer, expected: f.expected, actual: f.actual, message: f.message, count: f.count - (sent.get(key(f)) ?? 0), ...(f.screens?.length ? { screens: f.screens } : {}),
    })).filter((f) => f.count > 0);
    for (const f of pending.values()) sent.set(key(f), f.count);
    pending.clear();
    const batch = calls;
    calls = [];
    if (!findings.length && !batch.length) return;
    send(report.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${report.key}` }, body: JSON.stringify({ findings, calls: batch }), keepalive: true })
      .catch(() => undefined);
  };
  return {
    add(f: Finding) {
      pending.set(key(f), f);
      timer ??= setTimeout(flush, DELAY_MS);
    },
    /** a call that matched a contract (`apiKey`): its timing joins the batch */
    call(apiKey: string, c: ObservedCall) {
      if (calls.length >= MAX_CALLS) return;
      calls.push({ apiKey, status: c.status, startMs: c.startedAt ?? Date.now(), durationMs: c.durationMs ?? 0, ...(c.screen ? { screen: c.screen } : {}) });
      timer ??= setTimeout(flush, DELAY_MS);
    },
    flush() {
      if (timer) clearTimeout(timer);
      flush();
    },
  };
}

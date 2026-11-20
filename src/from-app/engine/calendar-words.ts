// A calendar date in words for text written once for everyone. It lives in the engine (no imports) because the
// watcher bundle (scripts/build-watch.mjs) may only take src/app/watch/runtime and src/app/engine; shared/time/format
// re-exports it for the app and the functions.

let words: Intl.DateTimeFormat | undefined;

/** a calendar date in words, for text written once for everyone (the server's notices, a contract's messages): `Mar 1,
 *  2027` in English whatever the reader's locale; what isn't a date is given back as it is (hand test: subscribers read
 *  "2027-03-01") */
export function calendarWords(v: string | undefined | null): string {
  const day = v ? String(v).slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return v ?? '';
  words ??= new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return words.format(new Date(`${day}T00:00:00Z`));
}

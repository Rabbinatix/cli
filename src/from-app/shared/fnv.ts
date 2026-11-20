// FNV-1a, 32 bits: a short, stable hash of text (ids, fingerprints, "has it changed" checks; never security). One copy
// for the app, the engines and the Cloud Functions, which must agree (a client error's fingerprint is made in both);
// the callers only differ in how they write the number (code review C: ten copies of this loop).
/** the hash as an unsigned 32-bit number */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

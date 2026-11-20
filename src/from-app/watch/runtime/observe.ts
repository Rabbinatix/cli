// The shape of a real value, observed with the contract at hand: enums get the actual value (so an unhandled value
// shows), formats are not guessed (one sample can't prove a format), null stays nullable.
import { Field, Shape } from '../../engine/types';

export function observeShape(value: unknown, expected?: Shape): Shape {
  if (value === null || value === undefined) return { type: 'any', nullable: true };
  if (Array.isArray(value)) return { type: 'array', items: value.length ? observeShape(value[0], expected?.items) : { type: 'any' } };
  switch (typeof value) {
    case 'string':
      return expected?.enum?.length ? { type: 'string', enum: [value] } : { type: 'string' };
    case 'number': {
      const type = Number.isInteger(value) ? 'integer' : 'number';
      return expected?.enum?.length ? { type, enum: [value] } : { type };
    }
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      const properties: Record<string, Field> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) properties[k] = { ...observeShape(v, expected?.properties?.[k]), required: true };
      return { type: 'object', properties };
    }
    default:
      return { type: 'any' };
  }
}

/** parse a body as JSON; undefined for empty, `{ invalid }` when it isn't JSON */
/** application/json and +json types; not ndjson or other streams of JSON */
export const isJsonType = (contentType: string | null | undefined) => /(^|\/|\+)json\s*($|;)/i.test((contentType ?? '').trim());

export function parseBody(text: string | undefined): { value?: unknown; invalid?: boolean } {
  if (text === undefined || text.trim() === '') return {};
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { invalid: true };
  }
}

/** the value at an engine pointer ("response.body.user.id", "…items.[].name") in a parsed body */
export function valueAt(root: unknown, pointer: string): unknown {
  const parts = pointer.split('.').slice(2);
  let cur: unknown = root;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (p === '[]') cur = Array.isArray(cur) ? cur[0] : undefined;
    else cur = typeof cur === 'object' ? (cur as Record<string, unknown>)[p] : undefined;
  }
  return cur;
}

import { Field, Shape, ShapeType } from './types';

/**
 * Compact shape notation (docs/03-features/F04-endpoint-editor.md):
 *   email: string(email)
 *   remember?: boolean
 *   role: enum(admin, member) | null
 *   profile: { name: string, age?: integer }
 *   tags: string[]
 *   id: string | integer          (a union; `[A | B]` for an array of one)
 * A text starting with "{" or "[" is parsed as a single type; `[T]` and `T[]` are arrays.
 * Docs (F91): `= value` after a field's type is its example (JSON, or a bare word), and a `# comment` at the end of a
 * field's line is its meaning. A `#` line on its own stays a plain comment.
 *   email: string(email) = "a@b.co"   # Login email, unique per organization
 */

type Tok = { t: 'id' | 'str' | 'num' | 'p' | 'nl' | 'doc' | 'ex' | 'eof'; v: string; pos: number };

/** the raw text of an `= value` example from `start`: up to a new line, a `#`, or a `,` / `}` / `]` outside quotes and brackets */
function exampleEnd(src: string, start: number): number {
  let depth = 0;
  let q = '';
  let j = start;
  for (; j < src.length; j++) {
    const c = src[j];
    if (q) {
      if (c === '\\') j++;
      else if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === '\n' || c === '#') break;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 0) break;
  }
  return j;
}

/** an example's raw text as a value: JSON when it parses, else the text itself (quotes around it dropped) */
function exampleValue(raw: string): unknown {
  const t = raw.trim();
  try {
    return JSON.parse(t);
  } catch {
    return /^'.*'$/.test(t) ? t.slice(1, -1) : t;
  }
}

export class ShapeParseError extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  /** something other than spaces came before on this line: a `#` here is a meaning, not a comment line */
  let lineUsed = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      const start = i;
      while (i < src.length && src[i] !== '\n') i++;
      const text = src.slice(start + 1, i).trim();
      if (lineUsed && text) out.push({ t: 'doc', v: text, pos: start });
      continue;
    }
    if (c === '\n') { out.push({ t: 'nl', v: c, pos: i }); i++; lineUsed = false; continue; }
    if (/\s/.test(c)) { i++; continue; }
    lineUsed = true;
    if (c === '=') {
      const end = exampleEnd(src, i + 1);
      const raw = src.slice(i + 1, end).trim();
      if (!raw) throw new ShapeParseError('Expected an example after "="', lineOf(src, i));
      out.push({ t: 'ex', v: raw, pos: i });
      i = end;
      continue;
    }
    if ('?:{}[](),|'.includes(c)) { out.push({ t: 'p', v: c, pos: i }); i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; let s = '';
      while (j < src.length && src[j] !== c) {
        // \" \' and \\ are escapes; any other backslash is kept as it is
        if (src[j] === '\\' && /["'\\]/.test(src[j + 1] ?? '')) j++;
        s += src[j++];
      }
      out.push({ t: 'str', v: s, pos: i }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i; let s = '';
      while (j < src.length && /[-0-9.]/.test(src[j])) s += src[j++];
      out.push({ t: 'num', v: s, pos: i }); i = j; continue;
    }
    if (/[A-Za-z0-9_$@.\-]/.test(c)) {
      let j = i; let s = '';
      while (j < src.length && /[A-Za-z0-9_$@.\-]/.test(src[j])) s += src[j++];
      out.push({ t: 'id', v: s, pos: i }); i = j; continue;
    }
    throw new ShapeParseError(`Unexpected character "${c}"`, lineOf(src, i));
  }
  out.push({ t: 'eof', v: '', pos: src.length });
  return out;
}

function lineOf(src: string, pos: number) {
  return src.slice(0, pos).split('\n').length;
}

const BASE_TYPES: ShapeType[] = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null', 'any'];

class Parser {
  i = 0;
  constructor(private toks: Tok[], private src: string) {}
  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  err(msg: string): never { throw new ShapeParseError(msg, lineOf(this.src, this.peek().pos)); }
  skipSep() { while (this.peek().t === 'nl' || this.peek().t === 'doc' || (this.peek().t === 'p' && this.peek().v === ',')) this.i++; }
  skipNl() { while (this.peek().t === 'nl' || this.peek().t === 'doc') this.i++; }
  /** `= example` and `# meaning` after a field's type */
  docs(shape: Shape) {
    if (this.peek().t === 'ex') shape.example = exampleValue(this.next().v);
    if (this.peek().t === 'doc') shape.description = this.next().v;
  }
  is(v: string) { const t = this.peek(); return t.t === 'p' && t.v === v; }
  expect(v: string) { if (!this.is(v)) this.err(`Expected "${v}"`); this.i++; }

  fields(end: string | null): Record<string, Field> {
    const props: Record<string, Field> = {};
    this.skipSep();
    while (!(end ? this.is(end) : this.peek().t === 'eof')) {
      if (end && this.peek().t === 'eof') this.err(`Expected "${end}"`);
      const nameTok = this.next();
      if (nameTok.t !== 'id' && nameTok.t !== 'str') this.err('Expected a field name');
      let required = true;
      if (this.is('?')) { this.i++; required = false; }
      this.expect(':');
      const shape = this.type();
      this.docs(shape);
      props[nameTok.v] = { ...shape, required };
      if (!(end ? this.is(end) : this.peek().t === 'eof')) {
        if (end && this.peek().t === 'eof') this.err(`Expected "${end}"`);
        if (this.peek().t !== 'nl' && !this.is(',')) this.err('Expected a new line or ","');
      }
      this.skipSep();
    }
    return props;
  }

  /** `A | B | null`: one option is a plain shape, several a union */
  type(): Shape {
    const options = [this.single()];
    let nullable = false;
    while (this.is('|')) {
      this.i++;
      const n = this.peek();
      if (n.t === 'id' && n.v === 'null') {
        this.i++;
        nullable = true;
      } else options.push(this.single());
    }
    const shape: Shape = options.length === 1 ? options[0] : { type: 'any', oneOf: options };
    if (nullable) shape.nullable = true;
    return shape;
  }

  single(): Shape {
    this.skipNl();
    let shape: Shape;
    const t = this.peek();
    if (this.is('{')) {
      this.i++;
      // `profile: {   # meaning` on the opening line
      const doc = this.peek().t === 'doc' ? this.next().v : undefined;
      shape = { type: 'object', properties: this.fields('}') };
      if (doc) shape.description = doc;
      this.expect('}');
    } else if (this.is('[')) {
      this.i++;
      const items = this.type();
      this.skipNl();
      this.expect(']');
      shape = { type: 'array', items };
    } else if (t.t === 'id' && t.v === 'enum') {
      this.i++;
      this.expect('(');
      const values: (string | number)[] = [];
      while (!this.is(')')) {
        if (this.peek().t === 'eof') this.err('Expected ")" to close enum(');
        const v = this.next();
        if (v.t === 'num') values.push(Number(v.v));
        else if (v.t === 'id' || v.t === 'str') values.push(v.v);
        else this.err('Expected an enum value');
        if (this.is(',')) this.i++;
      }
      this.expect(')');
      const allNum = values.length > 0 && values.every((v) => typeof v === 'number');
      shape = { type: allNum ? 'number' : 'string', enum: values };
    } else if (t.t === 'id' && (BASE_TYPES as string[]).includes(t.v)) {
      this.i++;
      shape = { type: t.v as ShapeType };
      if (this.is('(')) {
        this.i++;
        const f = this.next();
        shape.format = f.v;
        this.expect(')');
      }
    } else {
      this.err(`Unknown type "${t.v || t.t}"`);
    }
    while (this.is('[') && this.toks[this.i + 1]?.v === ']') {
      this.i += 2;
      shape = { type: 'array', items: shape };
    }
    return shape;
  }
}

/** Drops `# comments`, but not a `#` inside a quoted name or value. */
function stripComments(src: string): string {
  return src.replace(/("[^"\n]*"|'[^'\n]*')|#.*$/gm, (m, quoted: string | undefined) => quoted ?? '');
}

/** Returns undefined for empty text. Throws ShapeParseError on invalid input. */
export function parseShapeText(text: string): Shape | undefined {
  const src = text ?? '';
  if (!src.trim()) return undefined;
  const p = new Parser(tokenize(src), src);
  const trimmed = stripComments(src).trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || /^[a-z]+(\(.*\))?(\[\])*(\s*\|\s*[a-z]+(\([^)]*\))?(\[\])*)*$/.test(trimmed)) {
    const s = p.type();
    p.skipSep();
    if (p.peek().t !== 'eof') p.err('Unexpected content after type');
    return s;
  }
  return { type: 'object', properties: p.fields(null) };
}

export function tryParseShapeText(text: string): { shape?: Shape; error?: string; line?: number } {
  try {
    return { shape: parseShapeText(text) };
  } catch (e) {
    if (e instanceof ShapeParseError) return { error: e.message, line: e.line };
    return { error: String(e) };
  }
}

/** Names and enum values printed without quotes: they must read back as the same identifier (not a number). */
const BARE = /^[A-Za-z_$@][A-Za-z0-9_$@.\-]*$/;
/** a backslash that would read back as an escape is doubled */
const esc = (v: string) => v.replace(/\\(?=["'\\]|$)/g, '\\\\');
const quote = (v: string) => (!v.includes('"') ? `"${esc(v)}"` : !v.includes("'") ? `'${esc(v)}'` : `"${esc(v).replace(/"/g, '\\"')}"`);

function printType(s: Shape, indent: string): string {
  let out: string;
  if (s.oneOf?.length) {
    out = s.oneOf.map((o) => printType(o, indent)).join(' | ');
  } else if (s.enum?.length) {
    out = `enum(${s.enum.map((v) => (typeof v === 'string' && !BARE.test(v) ? quote(v) : String(v))).join(', ')})`;
  } else if (s.type === 'object' && s.properties) {
    const inner = printFields(s.properties, indent + '  ');
    out = inner ? `{\n${inner}\n${indent}}` : '{}';
  } else if (s.type === 'array' && s.items) {
    const inner = printType(s.items, indent);
    out = s.items.nullable || s.items.oneOf?.length ? `[${inner}]` : `${inner}[]`;
  } else {
    out = s.type + (s.format ? `(${s.format})` : '');
  }
  if (s.nullable) out += ' | null';
  return out;
}

/** a field's `= example` and `# meaning`, on one line (a meaning's line breaks become spaces) */
function printDocs(f: Shape): string {
  let out = '';
  if (f.example !== undefined) {
    const json = JSON.stringify(f.example);
    if (json !== undefined) out += ` = ${json}`;
  }
  const meaning = f.description?.replace(/\s+/g, ' ').trim();
  if (meaning) out += `  # ${meaning}`;
  return out;
}

function printFields(props: Record<string, Field>, indent: string): string {
  return Object.entries(props)
    .map(([name, f]) => {
      const key = BARE.test(name) ? name : quote(name);
      return `${indent}${key}${f.required ? '' : '?'}: ${printType(f, indent)}${printDocs(f)}`;
    })
    .join('\n');
}

export function printShapeText(shape: Shape | undefined): string {
  if (!shape) return '';
  if (shape.type === 'object' && shape.properties && !shape.nullable) return printFields(shape.properties, '') || '{}';
  return printType(shape, '');
}

/** Infer a Shape from a JSON example (all present fields required); `examples` keeps each text, number or true/false value as its field's example. */
export function inferShape(value: unknown, opts: { examples?: boolean } = {}): Shape {
  const s = inferBare(value, opts);
  if (opts.examples && value !== null && typeof value !== 'object') s.example = value;
  return s;
}

function inferBare(value: unknown, opts: { examples?: boolean }): Shape {
  const inferShape = (v: unknown) => inferShapeWith(v, opts);
  if (value === null) return { type: 'any', nullable: true };
  if (Array.isArray(value)) return { type: 'array', items: value.length ? inferShape(value[0]) : { type: 'any' } };
  switch (typeof value) {
    case 'string':
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return { type: 'string', format: 'email' };
      if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return { type: 'string', format: 'date-time' };
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value)) return { type: 'string', format: 'uuid' };
      return { type: 'string' };
    case 'number':
      return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      const properties: Record<string, Field> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) properties[k] = { ...inferShape(v), required: true };
      return { type: 'object', properties };
    }
    default:
      return { type: 'any' };
  }
}

const inferShapeWith = (v: unknown, opts: { examples?: boolean }) => inferShape(v, opts);

export function shapeLabel(s: Shape | undefined): string {
  if (!s) return '—';
  if (s.oneOf?.length) return s.oneOf.map((o) => shapeLabel(o)).join(' | ') + (s.nullable ? ' | null' : '');
  if (s.enum?.length) return `enum(${s.enum.join(', ')})` + (s.nullable ? ' | null' : '');
  let base: string = s.type;
  if (s.type === 'array') base = s.items?.oneOf?.length ? `(${shapeLabel(s.items)})[]` : `${s.items ? shapeLabel(s.items) : 'any'}[]`;
  if (s.format) base += `(${s.format})`;
  return base + (s.nullable ? ' | null' : '');
}

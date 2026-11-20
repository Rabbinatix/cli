// OTLP trace data in protobuf (what exporters send by default: OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf), read into
// the same shape as OTLP/JSON so watch-cli.ts checks both alike. Only the fields the watcher reads are kept; unknown
// fields are skipped by wire type, as protobuf readers do. No dependency: the messages are few and fixed
// (opentelemetry/proto/collector/trace/v1/trace_service.proto, trace/v1/trace.proto, common/v1/common.proto).

/** one field: its number, and its value (a varint as bigint, fixed64/fixed32 as their bytes, length-delimited as bytes) */
interface Field { no: number; wire: number; varint?: bigint; bytes?: Uint8Array }

class Bad extends Error {}

function fields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): bigint => {
    let x = 0n;
    for (let shift = 0n; ; shift += 7n) {
      if (i >= buf.length || shift > 63n) throw new Bad('a varint runs past the end');
      const b = buf[i++];
      x |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return x;
    }
  };
  const take = (n: number) => {
    if (n < 0 || i + n > buf.length) throw new Bad('a field runs past the end');
    const b = buf.subarray(i, i + n);
    i += n;
    return b;
  };
  while (i < buf.length) {
    const key = varint();
    const no = Number(key >> 3n), wire = Number(key & 7n);
    if (no === 0) throw new Bad('field number 0');
    if (wire === 0) out.push({ no, wire, varint: varint() });
    else if (wire === 1) out.push({ no, wire, bytes: take(8) });
    else if (wire === 2) out.push({ no, wire, bytes: take(Number(varint())) });
    else if (wire === 5) out.push({ no, wire, bytes: take(4) });
    else throw new Bad(`wire type ${wire}`);
  }
  return out;
}

const utf8 = new TextDecoder();
const all = (fs: Field[], no: number, wire = 2) => fs.filter((f) => f.no === no && f.wire === wire);
const one = (fs: Field[], no: number, wire = 2) => all(fs, no, wire).at(-1);
const fixed64 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);

interface Value { stringValue?: string; intValue?: string; boolValue?: boolean; doubleValue?: number; arrayValue?: { values: Value[] } }

/** AnyValue: string 1, bool 2, int 3, double 4, array 5 (kvlist 6 and bytes 7 aren't read) */
function anyValue(b: Uint8Array): Value {
  const fs = fields(b);
  const s = one(fs, 1);
  if (s) return { stringValue: utf8.decode(s.bytes) };
  const bool = one(fs, 2, 0);
  if (bool) return { boolValue: bool.varint !== 0n };
  const int = one(fs, 3, 0);
  if (int) return { intValue: BigInt.asIntN(64, int.varint!).toString() };
  const dbl = one(fs, 4, 1);
  if (dbl) return { doubleValue: new DataView(dbl.bytes!.buffer, dbl.bytes!.byteOffset, 8).getFloat64(0, true) };
  const arr = one(fs, 5);
  if (arr) return { arrayValue: { values: all(fields(arr.bytes!), 1).map((v) => anyValue(v.bytes!)) } };
  return {};
}

/** Span: kind 6, start 7, end 8 (fixed64 nanoseconds), attributes 9 (KeyValue: key 1, value 2) */
function span(b: Uint8Array) {
  const fs = fields(b);
  const start = one(fs, 7, 1), end = one(fs, 8, 1);
  return {
    kind: Number(one(fs, 6, 0)?.varint ?? 0n),
    ...(start ? { startTimeUnixNano: fixed64(start.bytes!).toString() } : {}),
    ...(end ? { endTimeUnixNano: fixed64(end.bytes!).toString() } : {}),
    attributes: all(fs, 9).map((kv) => {
      const k = fields(kv.bytes!);
      const v = one(k, 2);
      return { key: utf8.decode(one(k, 1)?.bytes ?? new Uint8Array()), value: v ? anyValue(v.bytes!) : {} };
    }),
  };
}

/** ExportTraceServiceRequest (resource_spans 1) → ResourceSpans (scope_spans 2; the old instrumentation_library_spans
 *  1000) → ScopeSpans (spans 2) */
function request(b: Uint8Array) {
  return {
    resourceSpans: all(fields(b), 1).map((rs) => {
      const r = fields(rs.bytes!);
      return { scopeSpans: [...all(r, 2), ...all(r, 1000)].map((ss) => ({ spans: all(fields(ss.bytes!), 2).map((sp) => span(sp.bytes!)) })) };
    }),
  };
}

export type OtlpProtoRequest = ReturnType<typeof request>;

/** One ExportTraceServiceRequest in protobuf, as OTLP/JSON's shape; null when the bytes aren't one. */
export function otlpProtoRequest(b: Uint8Array): OtlpProtoRequest | null {
  try {
    return request(b);
  } catch (e) {
    if (e instanceof Bad || e instanceof RangeError) return null;
    throw e;
  }
}

/**
 * A file of protobuf trace data: one request (an OTLP request body saved as it is), or the collector's file exporter
 * with `format: proto`, which writes each request after its length (4 bytes, big-endian). null when it's neither or
 * holds no spans.
 */
export function otlpProtoFile(b: Uint8Array): OtlpProtoRequest[] | null {
  const spans = (rs: OtlpProtoRequest[]) => rs.some((r) => r.resourceSpans.some((x) => x.scopeSpans.some((s) => s.spans.length)));
  const framed: OtlpProtoRequest[] = [];
  let i = 0;
  while (i + 4 <= b.length) {
    const n = new DataView(b.buffer, b.byteOffset + i, 4).getUint32(0, false);
    if (i + 4 + n > b.length) break;
    const r = otlpProtoRequest(b.subarray(i + 4, i + 4 + n));
    if (!r) break;
    framed.push(r);
    i += 4 + n;
  }
  if (i === b.length && framed.length && spans(framed)) return framed;
  const whole = otlpProtoRequest(b);
  return whole && spans([whole]) ? [whole] : null;
}

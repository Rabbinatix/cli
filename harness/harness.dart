// Runs generated Dart against recorded scenario frames (tests only; the app verifies the TypeScript build). Run with
// the runtime, jobs.dart (roots: job i's entry point) and one library per job. args[0]: a JSON list of jobs
// { frame, deps: [{ name, kind }] }. Prints a JSON list of outcomes { result | error | abort, path, sent }. Mirrors
// codegen/verify/sandbox.ts.
import 'dart:io';

import 'fdd_runtime.dart';
import 'jobs.dart';

Future<void> main(List<String> args) async {
  final jobs = asArray(FddJson.parse(File(args[0]).readAsStringSync()));
  final outs = <Object?>[];
  for (var i = 0; i < jobs.length; i++) {
    final job = jobs[i];
    FddVerify.reset(job);
    final input = get(get(job, 'frame'), 'input') ?? obj();
    Map<String, Object?> o;
    try {
      o = obj(['result', await roots[i](input)]);
    } on FddAbort catch (e) {
      o = obj(['abort', e.message]);
    } on FddError catch (e) {
      o = obj(['error', obj(['code', e.code, 'message', e.message])]);
    } catch (e) {
      o = obj(['error', obj(['code', 'RUNTIME_ERROR', 'message', '${e.runtimeType}: $e'])]);
    }
    o['path'] = FddVerify.frames.isEmpty ? <Object?>[] : List<Object?>.of(FddVerify.frames.first.keys);
    o['sent'] = FddVerify.sent;
    outs.add(o);
  }
  stdout.write(json(outs));
}

/// Verification itself stopped: an FddStop, so the generated catch (through toError) throws it on.
class FddAbort implements FddStop {
  final String message;

  FddAbort(this.message);
}

class Frame {
  final keys = <String>[];

  void enter(String key) {
    FddVerify.steps++;
    if (FddVerify.steps > FddVerify.maxSteps) throw FddAbort('Stopped after ${FddVerify.maxSteps} steps (infinite loop?)');
    keys.add(key);
  }
}

abstract final class FddVerify {
  static var steps = 0;
  static const maxSteps = 10000;
  static var frames = <Frame>[];
  static var sent = <Object?>[];
  static var queues = <String, List<Object?>>{};
  static var recorded = <String, List<Object?>>{};
  static var used = <String, int>{};
  static var kinds = <String, String>{};
  static var cache = <String, Object?>{};

  static void reset(Object? job) {
    steps = 0;
    frames = [];
    sent = [];
    queues = {};
    recorded = {};
    used = {};
    kinds = {};
    cache = {};
    final frame = get(job, 'frame');
    final b = get(frame, 'boundaries');
    if (b is Map<String, Object?>) for (final k in b.keys) queues[k] = List<Object?>.of(asArray(b[k]));
    final n = get(frame, 'nondet');
    if (n is Map<String, Object?>) for (final k in n.keys) recorded[k] = List<Object?>.of(asArray(n[k]));
    for (final d in asArray(get(job, 'deps'))) {
      kinds[str(get(d, 'name'))] = str(get(d, 'kind'));
    }
  }

  static Frame frame(String blueprintId) {
    final f = Frame();
    frames.add(f);
    return f;
  }

  static Object? _replay(String key) {
    final q = recorded[key];
    return q == null || q.isEmpty ? null : q.removeAt(0);
  }

  static Object? now(String key) => _replay(key);

  static Object? uuid(String key) => _replay(key);

  static Object? random(Object? min, Object? max, String key) => _replay(key);

  static Future<Object?> sleep(Object? ms) async => null;

  static Object? log(Object? message) => null;

  static Future<Object?> dep(String dep, String method, String key, List<Object?> args) async {
    final label = '$dep.$method';
    final kind = kinds[dep];
    if (kind == 'cache') {
      final ck = str(args.isEmpty ? null : args[0]);
      if (method == 'set') {
        cache[ck] = args.length > 1 ? args[1] : null;
        return null;
      }
      if (cache.containsKey(ck)) return obj(['found', true, 'value', cache[ck]]);
      return obj(['found', false, 'value', null]);
    }
    final q = queues[key];
    if (q == null || q.isEmpty) throw FddAbort('The generated code called $label at $key, but the simulator made no such call');
    final step = q.removeAt(0);
    final n = used[key] ?? 0;
    used[key] = n + 1;
    final err = get(step, 'error');
    if (err is Map) throw FddError(err['code'], err['message']);
    sent.add(obj(['label', label, 'key', key, 'index', n.toDouble(), 'request', args.isEmpty ? null : args[0]]));
    if (kind == 'api') return obj(['status', get(step, 'status'), 'body', get(step, 'response'), 'headers', get(step, 'headers') ?? obj()]);
    return get(step, 'response');
  }
}

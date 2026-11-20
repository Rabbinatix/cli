# Runs generated Python against recorded scenario frames (tests only; the app verifies the TypeScript build).
# stdin: a JSON list of jobs { runtime, source, root, frame, deps, maxSteps }; stdout: a JSON list of outcomes
# { result | error | abort, path, sent }. Mirrors codegen/verify/sandbox.ts.
import asyncio
import json
import math
import sys


class Abort(BaseException):
    """Verification itself stopped: never caught by the generated `except Exception`."""


def plain(v):
    """JSON-safe copy: integral floats as ints (JavaScript has one number type), NaN as null."""
    if isinstance(v, bool) or v is None or isinstance(v, (int, str)):
        return v
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return int(v) if v.is_integer() and abs(v) < 2 ** 53 else v
    if isinstance(v, (list, tuple)):
        return [plain(x) for x in v]
    if isinstance(v, dict):
        return {str(k): plain(x) for k, x in v.items()}
    return str(v)


class Obj:
    pass


def run(job):
    ns = {'__name__': 'fdd_program'}
    exec(compile(job['runtime'], 'fdd_runtime.py', 'exec'), ns)
    frame = job['frame']
    queues = {k: list(v) for k, v in frame['boundaries'].items()}
    nondet = {k: list(v) for k, v in frame['nondet'].items()}
    max_steps = job.get('maxSteps') or 10000
    frames = []
    steps = [0]
    sent = []
    used = {}

    class Frame:
        def __init__(self):
            self.keys = []

        def enter(self, key):
            steps[0] += 1
            if steps[0] > max_steps:
                raise Abort(f'Stopped after {max_steps} steps (infinite loop?)')
            self.keys.append(key)

    class Fdd:
        def frame(self, bp_id):
            f = Frame()
            frames.append(f)
            return f

    def recorded(*args):
        q = nondet.get(str(args[-1]))
        return q.pop(0) if q else None

    async def sleep(ms, *_):
        return None

    async def parallel(*branches):
        for b in branches:
            await b()

    ns.update(now=recorded, uuid=recorded, random=recorded, sleep=sleep, log=lambda *_: None, parallel=parallel, _fdd=Fdd())
    FddError = ns['FddError']
    cache = {}

    def method(dep, name):
        label = f"{dep['name']}.{name}"

        async def call(*args):
            key = str(args[-1])
            args = args[:-1]
            if dep['kind'] == 'cache':
                if name == 'set':
                    cache[str(args[0])] = args[1]
                    return None
                k = str(args[0])
                return {'found': True, 'value': cache[k]} if k in cache else {'found': False, 'value': None}
            q = queues.get(key)
            if not q:
                raise Abort(f'The generated code called {label} at {key}, but the simulator made no such call')
            step = q.pop(0)
            n = used.get(key, 0)
            used[key] = n + 1
            if step.get('error'):
                raise FddError(step['error']['code'], step['error']['message'])
            sent.append({'label': label, 'key': key, 'index': n, 'request': plain(args[0]) if args else None})
            if dep['kind'] == 'api':
                return {'status': step.get('status'), 'body': step.get('response'), 'headers': step.get('headers') or {}}
            return step.get('response')

        return call

    deps = Obj()
    for d in job['deps']:
        o = Obj()
        for m in d['methods']:
            setattr(o, m, method(d, m))
        setattr(deps, d['name'], o)

    path = lambda: frames[0].keys if frames else []
    try:
        exec(compile(job['source'], 'fdd_program.py', 'exec'), ns)
    except SyntaxError as e:
        return {'abort': f'The generated Python does not compile: {e}', 'path': [], 'sent': sent}
    root = ns[job['root']]
    try:
        r = root(json.loads(json.dumps(frame.get('input') or {})), deps)
        if asyncio.iscoroutine(r):
            r = asyncio.run(r)
        return {'result': plain(r), 'path': path(), 'sent': sent}
    except Abort as e:
        return {'abort': str(e), 'path': path(), 'sent': sent}
    except Exception as e:
        code = e.code if isinstance(e, FddError) else 'RUNTIME_ERROR'
        return {'error': {'code': code, 'message': f'{type(e).__name__}: {e}'}, 'path': path(), 'sent': sent}


if __name__ == '__main__':
    jobs = json.load(sys.stdin)
    print(json.dumps([run(j) for j in jobs], ensure_ascii=False))

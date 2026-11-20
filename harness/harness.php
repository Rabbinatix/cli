<?php
// Runs generated PHP against recorded scenario frames (tests only; the app verifies the TypeScript build). Run with the
// runtime (namespace FddRuntime), jobs.php ($roots: job i's entry point) and one namespace per job. $argv[1]: a JSON list
// of jobs { frame, deps: [{ name, kind }] }. Prints a JSON list of outcomes { result | error | abort, path, sent }.
// Mirrors codegen/verify/sandbox.ts.

declare(strict_types=1);

use FddRuntime\FddError;
use FddRuntime\FddJson;
use FddRuntime\FddStop;

use function FddRuntime\{asArray, get, json, obj, str};

require __DIR__ . '/FddRuntime.php';

/** Verification itself stopped: an FddStop, so the generated catch (through toError) throws it on. */
final class FddAbort extends \RuntimeException implements FddStop
{
}

final class Frame
{
    public array $keys = [];

    public function enter(string $key): void
    {
        FddVerify::$steps++;
        if (FddVerify::$steps > FddVerify::MAX_STEPS) throw new FddAbort('Stopped after ' . FddVerify::MAX_STEPS . ' steps (infinite loop?)');
        $this->keys[] = $key;
    }
}

final class FddVerify
{
    public const MAX_STEPS = 10000;
    public static int $steps = 0;
    public static array $frames = [];
    public static array $sent = [];
    private static array $queues = [];
    private static array $recorded = [];
    private static array $used = [];
    private static array $kinds = [];
    private static array $cache = [];

    public static function reset(mixed $job): void
    {
        self::$steps = 0;
        self::$frames = [];
        self::$sent = [];
        self::$queues = [];
        self::$recorded = [];
        self::$used = [];
        self::$kinds = [];
        self::$cache = [];
        $frame = get($job, 'frame');
        $b = get($frame, 'boundaries');
        if ($b instanceof \stdClass) foreach (get_object_vars($b) as $k => $q) self::$queues[(string) $k] = asArray($q);
        $n = get($frame, 'nondet');
        if ($n instanceof \stdClass) foreach (get_object_vars($n) as $k => $q) self::$recorded[(string) $k] = asArray($q);
        foreach (asArray(get($job, 'deps')) as $d) self::$kinds[str(get($d, 'name'))] = str(get($d, 'kind'));
    }

    public static function frame(string $blueprintId): Frame
    {
        $f = new Frame();
        self::$frames[] = $f;
        return $f;
    }

    private static function replay(string $key): mixed
    {
        if (empty(self::$recorded[$key])) return null;
        return array_shift(self::$recorded[$key]);
    }

    public static function now(string $key): mixed
    {
        return self::replay($key);
    }

    public static function uuid(string $key): mixed
    {
        return self::replay($key);
    }

    public static function random(mixed $min, mixed $max, string $key): mixed
    {
        return self::replay($key);
    }

    public static function sleep(mixed $ms): mixed
    {
        return null;
    }

    public static function log(mixed $message): mixed
    {
        return null;
    }

    public static function dep(string $dep, string $method, string $key, array $args): mixed
    {
        $label = "$dep.$method";
        $kind = self::$kinds[$dep] ?? null;
        if ($kind === 'cache') {
            $ck = str($args[0] ?? null);
            if ($method === 'set') {
                self::$cache[$ck] = $args[1] ?? null;
                return null;
            }
            if (array_key_exists($ck, self::$cache)) return obj('found', true, 'value', self::$cache[$ck]);
            return obj('found', false, 'value', null);
        }
        if (empty(self::$queues[$key])) throw new FddAbort("The generated code called $label at $key, but the simulator made no such call");
        $step = array_shift(self::$queues[$key]);
        $n = self::$used[$key] ?? 0;
        self::$used[$key] = $n + 1;
        $err = get($step, 'error');
        if ($err instanceof \stdClass) throw new FddError(get($err, 'code'), get($err, 'message'));
        self::$sent[] = obj('label', $label, 'key', $key, 'index', (float) $n, 'request', $args[0] ?? null);
        if ($kind === 'api') return obj('status', get($step, 'status'), 'body', get($step, 'response'), 'headers', get($step, 'headers') ?? obj());
        return get($step, 'response');
    }
}

require __DIR__ . '/jobs.php';

ini_set('memory_limit', '1G');
$jobs = asArray(FddJson::parse(file_get_contents($argv[1])));
$outs = [];
foreach ($jobs as $i => $job) {
    FddVerify::reset($job);
    $input = get(get($job, 'frame'), 'input') ?? obj();
    try {
        $o = obj('result', $roots[$i]($input));
    } catch (FddAbort $e) {
        $o = obj('abort', $e->getMessage());
    } catch (FddError $e) {
        $o = obj('error', obj('code', $e->errorCode, 'message', $e->getMessage()));
    } catch (\Throwable $e) {
        $o = obj('error', obj('code', 'RUNTIME_ERROR', 'message', get_class($e) . ': ' . $e->getMessage()));
    }
    $o->path = FddVerify::$frames ? FddVerify::$frames[0]->keys : [];
    $o->sent = FddVerify::$sent;
    $outs[] = $o;
}
echo json($outs);

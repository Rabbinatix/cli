// Runs generated C# against recorded scenario frames (tests only; the app verifies the TypeScript build).
// args[0]: a JSON list of jobs { frame, deps: [{ name, kind }] }; Jobs.Roots[i] runs job i. Prints a JSON list of
// outcomes { result | error | abort, path, sent }. Mirrors codegen/verify/sandbox.ts.
#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

namespace FddCheck;

/// <summary>Verification itself stopped: the generated `catch (…) when (e is not FddAbort)` lets it through.</summary>
public sealed class FddAbort : Exception
{
    public FddAbort(string message) : base(message) { }
}

public sealed class Frame
{
    public readonly List<string> Keys = new();

    public void Enter(string key)
    {
        if (++FddVerify.Steps > FddVerify.MaxSteps) throw new FddAbort($"Stopped after {FddVerify.MaxSteps} steps (infinite loop?)");
        Keys.Add(key);
    }
}

public static class FddVerify
{
    public static int Steps;
    public const int MaxSteps = 10000;
    public static readonly List<Frame> Frames = new();
    public static readonly List<object?> Sent = new();
    static readonly Dictionary<string, List<object?>> Queues = new(), Recorded = new();
    static readonly Dictionary<string, int> Used = new();
    static readonly Dictionary<string, string> Kinds = new();
    static readonly Dictionary<string, object?> Cache = new();

    public static void Reset(Dictionary<string, object?> job)
    {
        Steps = 0;
        Frames.Clear();
        Sent.Clear();
        Queues.Clear();
        Recorded.Clear();
        Used.Clear();
        Kinds.Clear();
        Cache.Clear();
        var frame = job.Get("frame");
        if (frame.Get("boundaries") is Dictionary<string, object?> b) foreach (var (k, v) in b) Queues[k] = new List<object?>(FddRuntime.AsArray(v));
        if (frame.Get("nondet") is Dictionary<string, object?> n) foreach (var (k, v) in n) Recorded[k] = new List<object?>(FddRuntime.AsArray(v));
        foreach (var d in FddRuntime.AsArray(job.Get("deps"))) Kinds[FddRuntime.Str(d.Get("name"))] = FddRuntime.Str(d.Get("kind"));
    }

    public static Frame Frame(string blueprintId)
    {
        var f = new Frame();
        Frames.Add(f);
        return f;
    }

    static object? Replay(string key)
    {
        if (!Recorded.TryGetValue(key, out var q) || q.Count == 0) return null;
        var v = q[0];
        q.RemoveAt(0);
        return v;
    }

    public static object? Now(string key) => Replay(key);

    public static object? Uuid(string key) => Replay(key);

    public static object? Random(object? min, object? max, string key) => Replay(key);

    public static Task Sleep(object? ms) => Task.CompletedTask;

    public static void Log(object? message) { }

    public static async Task Parallel(params Func<Task>[] branches)
    {
        foreach (var b in branches) await b();
    }

    public static Task<object?> Dep(string dep, string method, string key, params object?[] args)
    {
        var label = dep + "." + method;
        Kinds.TryGetValue(dep, out var kind);
        if (kind == "cache")
        {
            var ck = FddRuntime.Str(args.Length > 0 ? args[0] : null);
            if (method == "set")
            {
                Cache[ck] = args.Length > 1 ? args[1] : null;
                return Task.FromResult<object?>(null);
            }
            return Task.FromResult<object?>(Cache.TryGetValue(ck, out var hit) ? FddRuntime.Obj(("found", true), ("value", hit)) : FddRuntime.Obj(("found", false), ("value", null)));
        }
        if (!Queues.TryGetValue(key, out var q) || q.Count == 0) throw new FddAbort($"The generated code called {label} at {key}, but the simulator made no such call");
        var step = q[0];
        q.RemoveAt(0);
        var n = Used.GetValueOrDefault(key);
        Used[key] = n + 1;
        if (step.Get("error") is Dictionary<string, object?> err) throw new FddError(err.Get("code"), err.Get("message"));
        Sent.Add(FddRuntime.Obj(("label", label), ("key", key), ("index", (double)n), ("request", args.Length > 0 ? args[0] : null)));
        if (kind == "api") return Task.FromResult<object?>(FddRuntime.Obj(("status", step.Get("status")), ("body", step.Get("response")), ("headers", step.Get("headers") ?? FddRuntime.Obj())));
        return Task.FromResult(step.Get("response"));
    }
}

public static class Runner
{
    public static async Task Main(string[] args)
    {
        var jobs = FddRuntime.AsArray(FddJson.Parse(File.ReadAllText(args[0])));
        var outs = new List<object?>();
        for (var i = 0; i < jobs.Count; i++)
        {
            var job = (Dictionary<string, object?>)jobs[i]!;
            FddVerify.Reset(job);
            var input = job.Get("frame").Get("input") ?? FddRuntime.Obj();
            Dictionary<string, object?> o;
            try
            {
                o = FddRuntime.Obj(("result", await Jobs.Roots[i](input)));
            }
            catch (FddAbort e)
            {
                o = FddRuntime.Obj(("abort", e.Message));
            }
            catch (FddError e)
            {
                o = FddRuntime.Obj(("error", FddRuntime.Obj(("code", e.Code), ("message", e.Message))));
            }
            catch (Exception e)
            {
                o = FddRuntime.Obj(("error", FddRuntime.Obj(("code", "RUNTIME_ERROR"), ("message", e.GetType().Name + ": " + e.Message))));
            }
            o["path"] = FddVerify.Frames.Count > 0 ? FddVerify.Frames[0].Keys.Select(k => (object?)k).ToList() : new List<object?>();
            o["sent"] = new List<object?>(FddVerify.Sent);
            outs.Add(o);
        }
        Console.Out.Write(FddRuntime.Json(outs));
    }
}

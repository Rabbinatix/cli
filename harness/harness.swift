// Runs generated Swift against recorded scenario frames (tests only; the app verifies the TypeScript build). Built as
// main.swift with the runtime and the jobs. CommandLine.arguments[1]: a JSON list of jobs { frame, deps: [{ name, kind }] };
// roots[i] runs job i. Prints a JSON list of outcomes { result | error | abort, path, sent }. Mirrors codegen/verify/sandbox.ts.
import Foundation

let jobs = asArray(try FddJson.parse(String(decoding: FileManager.default.contents(atPath: CommandLine.arguments[1])!, as: UTF8.self)))
var outs: [Any?] = []
for (i, job) in jobs.enumerated() {
    FddVerify.reset(job)
    let input = get(get(job, "frame"), "input") ?? obj()
    let o: FddObject
    do {
        o = obj("result", try await roots[i](input))
    } catch let e as FddVerify.FddAbort {
        o = obj("abort", e.message)
    } catch let e as FddError {
        o = obj("error", obj("code", e.code, "message", e.message))
    } catch {
        o = obj("error", obj("code", "RUNTIME_ERROR", "message", "\(type(of: error)): \(error)"))
    }
    o["path"] = FddVerify.frames.first.map { $0.keys as [Any?] } ?? [Any?]()
    o["sent"] = FddVerify.sent
    outs.append(o)
}
print(json(outs), terminator: "")

enum FddVerify {
    /// Verification itself stopped: an FddStop, so the generated `catch` (through toError) throws it on.
    struct FddAbort: FddStop {
        let message: String
    }

    final class Frame {
        var keys: [String] = []

        func enter(_ key: String) throws {
            steps += 1
            if steps > maxSteps { throw FddAbort(message: "Stopped after \(maxSteps) steps (infinite loop?)") }
            keys.append(key)
        }
    }

    static var steps = 0
    static let maxSteps = 10000
    static var frames: [Frame] = []
    static var sent: [Any?] = []
    static var queues: [String: [Any?]] = [:]
    static var recorded: [String: [Any?]] = [:]
    static var used: [String: Int] = [:]
    static var kinds: [String: String] = [:]
    static var cache: [String: Any?] = [:]

    static func reset(_ job: Any?) {
        steps = 0
        frames = []
        sent = []
        queues = [:]
        recorded = [:]
        used = [:]
        kinds = [:]
        cache = [:]
        let frame = get(job, "frame")
        if let b = get(frame, "boundaries") as? FddObject { for k in b.keys { queues[k] = asArray(b[k]) } }
        if let n = get(frame, "nondet") as? FddObject { for k in n.keys { recorded[k] = asArray(n[k]) } }
        for d in asArray(get(job, "deps")) { kinds[str(get(d, "name"))] = str(get(d, "kind")) }
    }

    static func frame(_ blueprintId: String) -> Frame {
        let f = Frame()
        frames.append(f)
        return f
    }

    private static func replay(_ key: String) -> Any? {
        guard var q = recorded[key], !q.isEmpty else { return nil }
        let v = q.removeFirst()
        recorded[key] = q
        return v
    }

    static func now(_ key: String) -> Any? { replay(key) }

    static func uuid(_ key: String) -> Any? { replay(key) }

    static func random(_ min: Any?, _ max: Any?, _ key: String) -> Any? { replay(key) }

    static func sleep(_ ms: Any?) async throws -> Any? { nil }
    /// the branches one after the other, like the simulator: the first failure ends the step
    static func parallel(_ branches: (() async throws -> Void)...) async throws {
        for b in branches { try await b() }
    }

    static func log(_ message: Any?) -> Any? { nil }

    static func dep(_ dep: String, _ method: String, _ key: String, _ args: Any?...) async throws -> Any? {
        let label = "\(dep).\(method)"
        let kind = kinds[dep]
        if kind == "cache" {
            let ck = str(args.first ?? nil)
            if method == "set" {
                cache[ck] = .some(args.count > 1 ? args[1] : nil)
                return nil
            }
            if let v = cache[ck] { return obj("found", true, "value", v) }
            return obj("found", false, "value", nil)
        }
        guard var q = queues[key], !q.isEmpty else { throw FddAbort(message: "The generated code called \(label) at \(key), but the simulator made no such call") }
        let step = q.removeFirst()
        queues[key] = q
        let n = used[key] ?? 0
        used[key] = n + 1
        if let err = get(step, "error") as? FddObject { throw FddError(err["code"], err["message"]) }
        sent.append(obj("label", label, "key", key, "index", Double(n), "request", args.first ?? nil))
        if kind == "api" { return obj("status", get(step, "status"), "body", get(step, "response"), "headers", get(step, "headers") ?? obj()) }
        return get(step, "response")
    }
}

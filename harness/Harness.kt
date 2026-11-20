// Runs generated Kotlin against recorded scenario frames (tests only; the app verifies the TypeScript build).
// args[0]: a JSON list of jobs { frame, deps: [{ name, kind }] }; ROOTS[i] runs job i. Prints a JSON list of
// outcomes { result | error | abort, path, sent }. Mirrors codegen/verify/sandbox.ts.
@file:Suppress("UNCHECKED_CAST")

package fddcheck

import java.io.File

fun main(args: Array<String>) {
    val jobs = asArray(FddJson.parse(File(args[0]).readText(Charsets.UTF_8)))
    val outs = ArrayList<Any?>()
    for ((i, job) in jobs.withIndex()) {
        FddVerify.reset(job)
        val input = get(get(job, "frame"), "input") ?: obj()
        val o = try {
            obj("result", ROOTS[i](input))
        } catch (e: FddVerify.FddAbort) {
            obj("abort", e.message)
        } catch (e: FddError) {
            obj("error", obj("code", e.code, "message", e.message))
        } catch (e: Throwable) {
            obj("error", obj("code", "RUNTIME_ERROR", "message", e.javaClass.simpleName + ": " + e.message))
        }
        o["path"] = if (FddVerify.frames.isEmpty()) ArrayList<Any?>() else ArrayList<Any?>(FddVerify.frames[0].keys)
        o["sent"] = ArrayList(FddVerify.sent)
        outs.add(o)
    }
    print(json(outs))
}

object FddVerify {
    /** Verification itself stopped: an Error, so the generated `catch (e: RuntimeException)` lets it through. */
    class FddAbort(message: String) : Error(message)

    class Frame {
        val keys = ArrayList<String>()

        fun enter(key: String) {
            if (++steps > MAX_STEPS) throw FddAbort("Stopped after $MAX_STEPS steps (infinite loop?)")
            keys.add(key)
        }
    }

    private var steps = 0
    private const val MAX_STEPS = 10000
    val frames = ArrayList<Frame>()
    val sent = ArrayList<Any?>()
    private val queues = HashMap<String, MutableList<Any?>>()
    private val recorded = HashMap<String, MutableList<Any?>>()
    private val used = HashMap<String, Int>()
    private val kinds = HashMap<String, String>()
    private val cache = HashMap<String, Any?>()

    fun reset(job: Any?) {
        steps = 0
        frames.clear()
        sent.clear()
        queues.clear()
        recorded.clear()
        used.clear()
        kinds.clear()
        cache.clear()
        val frame = get(job, "frame")
        (get(frame, "boundaries") as? Map<String, Any?>)?.forEach { (k, v) -> queues[k] = ArrayList(asArray(v)) }
        (get(frame, "nondet") as? Map<String, Any?>)?.forEach { (k, v) -> recorded[k] = ArrayList(asArray(v)) }
        for (d in asArray(get(job, "deps"))) kinds[str(get(d, "name"))] = str(get(d, "kind"))
    }

    fun frame(blueprintId: String): Frame {
        val f = Frame()
        frames.add(f)
        return f
    }

    private fun replay(key: String): Any? {
        val q = recorded[key]
        return if (q.isNullOrEmpty()) null else q.removeAt(0)
    }

    fun now(key: String): Any? = replay(key)

    fun uuid(key: String): Any? = replay(key)

    fun random(min: Any?, max: Any?, key: String): Any? = replay(key)

    fun sleep(ms: Any?): Any? = null

    fun log(message: Any?): Any? = null

    /** Branches one after the other, like the simulator. */
    fun parallel(vararg branches: () -> Unit) {
        for (b in branches) b()
    }

    fun dep(dep: String, method: String, key: String, vararg args: Any?): Any? {
        val label = "$dep.$method"
        val kind = kinds[dep]
        if (kind == "cache") {
            val ck = str(args.getOrNull(0))
            if (method == "set") {
                cache[ck] = args.getOrNull(1)
                return null
            }
            return if (cache.containsKey(ck)) obj("found", true, "value", cache[ck]) else obj("found", false, "value", null)
        }
        val q = queues[key]
        if (q.isNullOrEmpty()) throw FddAbort("The generated code called $label at $key, but the simulator made no such call")
        val step = q.removeAt(0)
        val n = used[key] ?: 0
        used[key] = n + 1
        val err = get(step, "error")
        if (err is Map<*, *>) throw FddError(get(err, "code"), get(err, "message"))
        sent.add(obj("label", label, "key", key, "index", n.toDouble(), "request", args.getOrNull(0)))
        if (kind == "api") return obj("status", get(step, "status"), "body", get(step, "response"), "headers", get(step, "headers") ?: obj())
        return get(step, "response")
    }
}

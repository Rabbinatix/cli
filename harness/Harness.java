// Runs generated Java against recorded scenario frames (tests only; the app verifies the TypeScript build).
// args[0]: a JSON list of jobs { frame, deps: [{ name, kind }] }; Jobs.ROOTS.get(i) runs job i. Prints a JSON list of
// outcomes { result | error | abort, path, sent }. Mirrors codegen/verify/sandbox.ts.
package fddcheck;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static fddcheck.FddRuntime.*;

public final class Harness {
    private Harness() {
    }

    public static void main(String[] args) throws Exception {
        List<Object> jobs = asArray(FddJson.parse(Files.readString(Path.of(args[0]), StandardCharsets.UTF_8)));
        List<Object> outs = new ArrayList<>();
        for (int i = 0; i < jobs.size(); i++) {
            Object job = jobs.get(i);
            FddVerify.reset(job);
            Object input = get(get(job, "frame"), "input");
            if (input == null) input = obj();
            Map<String, Object> o;
            try {
                o = obj("result", Jobs.ROOTS.get(i).apply(input));
            } catch (FddVerify.FddAbort e) {
                o = obj("abort", e.getMessage());
            } catch (FddError e) {
                o = obj("error", obj("code", e.getCode(), "message", e.getMessage()));
            } catch (Throwable e) {
                o = obj("error", obj("code", "RUNTIME_ERROR", "message", e.getClass().getSimpleName() + ": " + e.getMessage()));
            }
            o.put("path", FddVerify.FRAMES.isEmpty() ? new ArrayList<Object>() : new ArrayList<Object>(FddVerify.FRAMES.get(0).keys));
            o.put("sent", new ArrayList<>(FddVerify.SENT));
            outs.add(o);
        }
        System.out.print(json(outs));
    }

    public static final class FddVerify {
        private FddVerify() {
        }

        /** Verification itself stopped: an Error, so the generated `catch (RuntimeException e)` lets it through. */
        public static final class FddAbort extends Error {
            private static final long serialVersionUID = 1L;

            FddAbort(String message) {
                super(message);
            }
        }

        public static final class Frame {
            final List<String> keys = new ArrayList<>();

            public void enter(String key) {
                if (++steps > MAX_STEPS) throw new FddAbort("Stopped after " + MAX_STEPS + " steps (infinite loop?)");
                keys.add(key);
            }
        }

        static int steps;
        static final int MAX_STEPS = 10000;
        static final List<Frame> FRAMES = new ArrayList<>();
        static final List<Object> SENT = new ArrayList<>();
        private static final Map<String, List<Object>> QUEUES = new HashMap<>(), RECORDED = new HashMap<>();
        private static final Map<String, Integer> USED = new HashMap<>();
        private static final Map<String, String> KINDS = new HashMap<>();
        private static final Map<String, Object> CACHE = new HashMap<>();

        static void reset(Object job) {
            steps = 0;
            FRAMES.clear();
            SENT.clear();
            QUEUES.clear();
            RECORDED.clear();
            USED.clear();
            KINDS.clear();
            CACHE.clear();
            Object frame = get(job, "frame");
            if (get(frame, "boundaries") instanceof Map<?, ?> b) for (Map.Entry<?, ?> e : b.entrySet()) QUEUES.put((String) e.getKey(), new ArrayList<>(asArray(e.getValue())));
            if (get(frame, "nondet") instanceof Map<?, ?> n) for (Map.Entry<?, ?> e : n.entrySet()) RECORDED.put((String) e.getKey(), new ArrayList<>(asArray(e.getValue())));
            for (Object d : asArray(get(job, "deps"))) KINDS.put(str(get(d, "name")), str(get(d, "kind")));
        }

        public static Frame frame(String blueprintId) {
            Frame f = new Frame();
            FRAMES.add(f);
            return f;
        }

        private static Object replay(String key) {
            List<Object> q = RECORDED.get(key);
            return q == null || q.isEmpty() ? null : q.remove(0);
        }

        public static Object now(String key) {
            return replay(key);
        }

        public static Object uuid(String key) {
            return replay(key);
        }

        public static Object random(Object min, Object max, String key) {
            return replay(key);
        }

        public static Object sleep(Object ms) {
            return null;
        }

        public static Object log(Object message) {
            return null;
        }

        /** Branches one after the other, like the simulator. */
        public static void parallel(Runnable... branches) {
            for (Runnable b : branches) b.run();
        }

        public static Object dep(String dep, String method, String key, Object... args) {
            String label = dep + "." + method;
            String kind = KINDS.get(dep);
            if ("cache".equals(kind)) {
                String ck = str(args.length > 0 ? args[0] : null);
                if (method.equals("set")) {
                    CACHE.put(ck, args.length > 1 ? args[1] : null);
                    return null;
                }
                return CACHE.containsKey(ck) ? obj("found", true, "value", CACHE.get(ck)) : obj("found", false, "value", null);
            }
            List<Object> q = QUEUES.get(key);
            if (q == null || q.isEmpty()) throw new FddAbort("The generated code called " + label + " at " + key + ", but the simulator made no such call");
            Object step = q.remove(0);
            int n = USED.getOrDefault(key, 0);
            USED.put(key, n + 1);
            if (get(step, "error") instanceof Map<?, ?> err) throw new FddError(get(err, "code"), get(err, "message"));
            SENT.add(obj("label", label, "key", key, "index", (double) n, "request", args.length > 0 ? args[0] : null));
            if ("api".equals(kind)) return obj("status", get(step, "status"), "body", get(step, "response"), "headers", orElse(get(step, "headers"), obj()));
            return get(step, "response");
        }
    }
}

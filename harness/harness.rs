// Runs generated Rust against recorded scenario frames (tests only; the app verifies the TypeScript build). Built with
// the runtime (fdd_runtime.rs) and jobs.rs (one module per job, and roots(): job i's entry point) into one program.
// args[1]: a JSON list of jobs { frame, deps: [{ name, kind }] }. Prints a JSON list of outcomes
// { result | error | abort, path, sent }. Mirrors codegen/verify/sandbox.ts.
#![allow(dead_code, unused_imports, unused_variables)]

mod fdd_runtime;
mod jobs;

use fdd_runtime::*;

/// What the instrumented code calls instead of the boundaries and now/uuid/random.
pub mod fdd_verify {
    use crate::fdd_runtime::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    pub const MAX_STEPS: usize = 10_000;

    #[derive(Default)]
    pub struct State {
        pub steps: usize,
        pub frames: Vec<Vec<String>>,
        pub sent: Vec<Value>,
        queues: HashMap<String, Vec<Value>>,
        recorded: HashMap<String, Vec<Value>>,
        used: HashMap<String, usize>,
        kinds: HashMap<String, String>,
        cache: HashMap<String, Value>,
    }

    thread_local! {
        pub static STATE: RefCell<State> = RefCell::new(State::default());
    }

    fn fields(v: &Value) -> Vec<(String, Value)> {
        map_of(v)
    }

    pub fn reset(job: &Value) {
        STATE.with(|cell| {
            let mut st = State::default();
            let frame = get(job, "frame");
            for (k, q) in fields(&get(&frame, "boundaries")) {
                st.queues.insert(k, list_of(&q));
            }
            for (k, q) in fields(&get(&frame, "nondet")) {
                st.recorded.insert(k, list_of(&q));
            }
            for d in list_of(&get(job, "deps")) {
                st.kinds.insert(text_of(&get(&d, "name")), text_of(&get(&d, "kind")));
            }
            *cell.borrow_mut() = st;
        });
    }

    /// One handler call's recorded steps.
    pub struct Frame(usize);

    impl Frame {
        pub fn enter(&self, key: &str) -> Res<()> {
            STATE.with(|cell| {
                let mut st = cell.borrow_mut();
                st.steps += 1;
                if st.steps > MAX_STEPS {
                    return Err(FddError::stop(&format!("Stopped after {} steps (infinite loop?)", MAX_STEPS)));
                }
                st.frames[self.0].push(key.to_string());
                Ok(())
            })
        }
    }

    pub fn frame(_blueprint_id: &str) -> Frame {
        STATE.with(|cell| {
            let mut st = cell.borrow_mut();
            st.frames.push(Vec::new());
            Frame(st.frames.len() - 1)
        })
    }

    fn replay(key: &str) -> Value {
        STATE.with(|cell| {
            let mut st = cell.borrow_mut();
            match st.recorded.get_mut(key) {
                Some(q) if !q.is_empty() => q.remove(0),
                _ => NULL,
            }
        })
    }

    pub fn now(key: &str) -> Value {
        replay(key)
    }

    pub fn uuid(key: &str) -> Value {
        replay(key)
    }

    pub fn random(_min: &Value, _max: &Value, key: &str) -> Value {
        replay(key)
    }

    /// the branches one after the other, like the simulator: the first failure ends the step
    pub fn parallel<'a>(branches: Vec<Box<dyn FnOnce() -> Res<()> + 'a>>) -> Res<()> {
        for b in branches {
            b()?;
        }
        Ok(())
    }

    pub fn sleep(_ms: &Value) -> Value {
        NULL
    }

    pub fn log(_message: &Value) -> Value {
        NULL
    }

    pub fn dep(dep: &str, method: &str, key: &str, args: Vec<Value>) -> Res<Value> {
        STATE.with(|cell| {
            let mut st = cell.borrow_mut();
            let label = format!("{}.{}", dep, method);
            let kind = st.kinds.get(dep).cloned();
            let arg = |i: usize| args.get(i).cloned().unwrap_or(NULL);
            if kind.as_deref() == Some("cache") {
                let ck = text_of(&arg(0));
                if method == "set" {
                    st.cache.insert(ck, arg(1));
                    return Ok(NULL);
                }
                return Ok(match st.cache.get(&ck) {
                    Some(v) => obj(vec![("found", b(true)), ("value", v.clone())]),
                    None => obj(vec![("found", b(false)), ("value", NULL)]),
                });
            }
            let step = match st.queues.get_mut(key) {
                Some(q) if !q.is_empty() => q.remove(0),
                _ => return Err(FddError::stop(&format!("The generated code called {} at {}, but the simulator made no such call", label, key))),
            };
            let used = st.used.entry(key.to_string()).or_insert(0);
            let index = *used;
            *used += 1;
            let err = get(&step, "error");
            if let Value::Obj(_) = err {
                return Err(fail(&get(&err, "code"), &get(&err, "message")));
            }
            st.sent.push(obj(vec![("label", s(&label)), ("key", s(key)), ("index", n(index as f64)), ("request", arg(0))]));
            if kind.as_deref() == Some("api") {
                let headers = match get(&step, "headers") {
                    Value::Null => obj(vec![]),
                    h => h,
                };
                return Ok(obj(vec![("status", get(&step, "status")), ("body", get(&step, "response")), ("headers", headers)]));
            }
            Ok(get(&step, "response"))
        })
    }
}

fn run() {
    let path = std::env::args().nth(1).expect("the jobs file");
    let jobs = Value::parse(&std::fs::read_to_string(path).expect("read the jobs file")).expect("jobs.json is JSON");
    let roots = jobs::roots();
    let mut outs = Vec::new();
    for (i, job) in list_of(&jobs).iter().enumerate() {
        fdd_verify::reset(job);
        let input = match get(&get(job, "frame"), "input") {
            Value::Null => obj(vec![]),
            x => x,
        };
        let mut o: Vec<(&str, Value)> = match roots[i](input) {
            Ok(v) => vec![("result", v)],
            Err(e) if e.stop => vec![("abort", su(&e.message))],
            Err(e) => vec![("error", obj(vec![("code", su(&e.code)), ("message", su(&e.message))]))],
        };
        let (path, sent) = fdd_verify::STATE.with(|cell| {
            let st = cell.borrow();
            (st.frames.first().cloned().unwrap_or_default(), st.sent.clone())
        });
        o.push(("path", list(path.iter().map(|k| s(k)).collect())));
        o.push(("sent", list(sent)));
        outs.push(obj(o));
    }
    print!("{}", list(outs).to_json());
}

fn main() {
    // deep recursion in a logic: a big stack, as JavaScript's
    std::thread::Builder::new().stack_size(1 << 30).spawn(run).unwrap().join().unwrap();
}

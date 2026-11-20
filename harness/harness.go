// Runs generated Go against recorded scenario frames (the tests and `rabbinatix verify`; the app verifies the TypeScript
// build). os.Args[1]: a JSON list of jobs { frame, deps: [{ name, kind }] }; roots[i] (jobs.go) runs job i. Prints a JSON
// list of outcomes { result | error | abort, path, sent }. Mirrors codegen/verify/sandbox.ts and Harness.java.
package main

import (
	"errors"
	"fmt"
	"os"
)

// fddAbort stops verification itself; the generated code lets it through (fdd.try and recoverInto re-raise it).
type fddAbort struct{ message string }

func (*fddAbort) FddAbort() {}

const maxSteps = 10000

type verifyFrame struct{ keys []any }

func (f *verifyFrame) enter(key string) {
	fddVerify.steps++
	if fddVerify.steps > maxSteps {
		panic(&fddAbort{fmt.Sprintf("Stopped after %d steps (infinite loop?)", maxSteps)})
	}
	f.keys = append(f.keys, key)
}

type verifier struct {
	steps    int
	frames   []*verifyFrame
	sent     []any
	queues   map[string][]any
	recorded map[string][]any
	used     map[string]int
	kinds    map[string]string
	cache    map[string]any
}

var fddVerify = &verifier{}

func (v *verifier) reset(job any) {
	*v = verifier{queues: map[string][]any{}, recorded: map[string][]any{}, used: map[string]int{}, kinds: map[string]string{}, cache: map[string]any{}, sent: []any{}}
	frame := fdd.get(job, "frame")
	if b, ok := fdd.get(frame, "boundaries").(*Object); ok {
		for _, k := range b.keys {
			v.queues[k] = append([]any{}, fdd.asArray(b.vals[k])...)
		}
	}
	if n, ok := fdd.get(frame, "nondet").(*Object); ok {
		for _, k := range n.keys {
			v.recorded[k] = append([]any{}, fdd.asArray(n.vals[k])...)
		}
	}
	for _, d := range fdd.asArray(fdd.get(job, "deps")) {
		v.kinds[fdd.str(fdd.get(d, "name"))] = fdd.str(fdd.get(d, "kind"))
	}
}

func (v *verifier) frame(blueprintID string) *verifyFrame {
	f := &verifyFrame{keys: []any{}}
	v.frames = append(v.frames, f)
	return f
}

func (v *verifier) replay(key string) any {
	q := v.recorded[key]
	if len(q) == 0 {
		return nil
	}
	v.recorded[key] = q[1:]
	return q[0]
}

func (v *verifier) now(key string) any                { return v.replay(key) }
func (v *verifier) uuid(key string) any               { return v.replay(key) }
func (v *verifier) random(lo, hi any, key string) any { return v.replay(key) }
func (v *verifier) sleep(ms any) any                  { return nil }
func (v *verifier) log(message any) any               { return nil }

// parallel runs the branches one after the other, like the simulator.
func (v *verifier) parallel(branches ...func()) {
	for _, b := range branches {
		b()
	}
}

func (v *verifier) dep(dep, method, key string, args ...any) any {
	label := dep + "." + method
	kind := v.kinds[dep]
	if kind == "cache" {
		var first any
		if len(args) > 0 {
			first = args[0]
		}
		ck := fdd.str(first)
		if method == "set" {
			var value any
			if len(args) > 1 {
				value = args[1]
			}
			v.cache[ck] = value
			return nil
		}
		if value, ok := v.cache[ck]; ok {
			return fdd.obj("found", true, "value", value)
		}
		return fdd.obj("found", false, "value", nil)
	}
	q := v.queues[key]
	if len(q) == 0 {
		panic(&fddAbort{"The generated code called " + label + " at " + key + ", but the simulator made no such call"})
	}
	step := q[0]
	v.queues[key] = q[1:]
	n := v.used[key]
	v.used[key] = n + 1
	if e, ok := fdd.get(step, "error").(*Object); ok {
		panic(NewFddError(fdd.asString(fdd.get(e, "code")), fdd.asString(fdd.get(e, "message"))))
	}
	var request any
	if len(args) > 0 {
		request = args[0]
	}
	v.sent = append(v.sent, fdd.obj("label", label, "key", key, "index", float64(n), "request", request))
	if kind == "api" {
		return fdd.obj("status", fdd.get(step, "status"), "body", fdd.get(step, "response"), "headers", fdd.orElse(fdd.get(step, "headers"), fdd.obj()))
	}
	return fdd.get(step, "response")
}

func run(i int, input any) (out *Object) {
	defer func() {
		if r := recover(); r != nil {
			if a, ok := r.(*fddAbort); ok {
				out = fdd.object("abort", a.message)
				return
			}
			out = fdd.object("error", fdd.obj("code", "RUNTIME_ERROR", "message", fdd.jsString(r)))
		}
	}()
	result, err := roots[i](input)
	if err != nil {
		var f *FddError
		if errors.As(err, &f) {
			return fdd.object("error", fdd.obj("code", f.Code, "message", f.Message))
		}
		return fdd.object("error", fdd.obj("code", "RUNTIME_ERROR", "message", err.Error()))
	}
	return fdd.object("result", result)
}

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	jobs, err := ParseJSON(string(data))
	if err != nil {
		panic(err)
	}
	outs := []any{}
	for i, job := range fdd.asArray(jobs) {
		fddVerify.reset(job)
		input := fdd.get(fdd.get(job, "frame"), "input")
		if input == nil {
			input = fdd.obj()
		}
		o := run(i, input)
		path := []any{}
		if len(fddVerify.frames) > 0 {
			path = fddVerify.frames[0].keys
		}
		o.Set("path", path)
		o.Set("sent", fddVerify.sent)
		outs = append(outs, o)
	}
	fmt.Print(fdd.json(outs))
}

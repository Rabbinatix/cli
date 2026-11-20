# frozen_string_literal: true

# Runs generated Ruby against recorded scenario frames (tests only; the app verifies the TypeScript build). Loads the
# runtime (fdd_runtime.rb, top-level FddRuntime), jobs.rb (ROOTS: job i's entry point) and one module per job.
# ARGV[0]: a JSON list of jobs { frame, deps: [{ name, kind }] }. Prints a JSON list of outcomes
# { result | error | abort, path, sent }. Mirrors codegen/verify/sandbox.ts.

require_relative 'fdd_runtime'

# Verification itself stopped: an FddStop, so the generated rescue (through to_error) raises it again.
class FddAbort < StandardError
  include FddStop
end

# One handler call's recorded steps.
class Frame
  attr_reader :keys

  def initialize
    @keys = []
  end

  def enter(key)
    FddVerify.steps += 1
    raise FddAbort, "Stopped after #{FddVerify::MAX_STEPS} steps (infinite loop?)" if FddVerify.steps > FddVerify::MAX_STEPS

    @keys << key
  end
end

# What the instrumented code calls instead of the boundaries and now/uuid/random.
module FddVerify
  MAX_STEPS = 10_000
  extend FddRuntime

  class << self
    attr_accessor :steps, :frames, :sent

    def reset(job)
      @steps = 0
      @frames = []
      @sent = []
      @queues = {}
      @recorded = {}
      @used = {}
      @kinds = {}
      @cache = {}
      frame = get(job, 'frame')
      b = get(frame, 'boundaries')
      b.each { |k, q| @queues[k] = as_array(q).dup } if b.is_a?(Hash)
      n = get(frame, 'nondet')
      n.each { |k, q| @recorded[k] = as_array(q).dup } if n.is_a?(Hash)
      as_array(get(job, 'deps')).each { |d| @kinds[str(get(d, 'name'))] = str(get(d, 'kind')) }
    end

    def frame(_blueprint_id)
      f = Frame.new
      @frames << f
      f
    end

    def replay(key)
      q = @recorded[key]
      q.nil? || q.empty? ? nil : q.shift
    end

    def now(key)
      replay(key)
    end

    def uuid(key)
      replay(key)
    end

    def random(_min, _max, key)
      replay(key)
    end

    def sleep(_ms)
      nil
    end

    # the branches one after the other, like the simulator: the first failure ends the step
    def parallel(*branches)
      branches.each(&:call)
      nil
    end

    def log(_message)
      nil
    end

    def dep(dep, method, key, args)
      label = "#{dep}.#{method}"
      kind = @kinds[dep]
      if kind == 'cache'
        ck = str(args[0])
        if method == 'set'
          @cache[ck] = args[1]
          return nil
        end
        return @cache.key?(ck) ? obj('found', true, 'value', @cache[ck]) : obj('found', false, 'value', nil)
      end
      q = @queues[key]
      raise FddAbort, "The generated code called #{label} at #{key}, but the simulator made no such call" if q.nil? || q.empty?

      step = q.shift
      n = @used[key] || 0
      @used[key] = n + 1
      err = get(step, 'error')
      raise FddError.new(get(err, 'code'), get(err, 'message')) if err.is_a?(Hash)

      @sent << obj('label', label, 'key', key, 'index', n.to_f, 'request', args[0])
      return obj('status', get(step, 'status'), 'body', get(step, 'response'), 'headers', get(step, 'headers') || obj) if kind == 'api'

      get(step, 'response')
    end
  end
end

require_relative 'jobs'

outs = FddRuntime.as_array(FddJson.parse(File.read(ARGV[0], encoding: 'UTF-8'))).each_with_index.map do |job, i|
  FddVerify.reset(job)
  input = FddRuntime.get(FddRuntime.get(job, 'frame'), 'input') || {}
  o = begin
    { 'result' => ROOTS[i].call(input) }
  rescue FddAbort => e
    { 'abort' => e.message }
  rescue FddError => e
    { 'error' => { 'code' => e.code, 'message' => e.message } }
  rescue SystemStackError, StandardError => e
    { 'error' => { 'code' => 'RUNTIME_ERROR', 'message' => "#{e.class}: #{e.message}" } }
  end
  o['path'] = FddVerify.frames.empty? ? [] : FddVerify.frames[0].keys
  o['sent'] = FddVerify.sent
  o
end
$stdout.write(FddRuntime.json(outs))

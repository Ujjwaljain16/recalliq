import { describe, expect, it } from 'vitest';
import { fakeBenchLlm } from '../../../src/llm/bench/fake.js';
import { percentile, runBenchmark } from '../../../src/llm/bench/harness.js';
import { BENCH_CASES, BENCH_SET_ID } from '../../../src/llm/bench/cases.js';
import { FakeLlm } from '../../../src/llm/fake.js';
import { LlmError } from '../../../src/shared/llm.js';

const clock = { now: () => 0 };

describe('model benchmark harness (wiring only: the fake adapter measures nothing)', () => {
  it('runs the fixed set against the fake adapter and reports per-case outcomes', async () => {
    const r = await runBenchmark({ llm: fakeBenchLlm(), clock, maxCalls: 20, callTimeoutMs: 1000 });
    expect(r.setId).toBe(BENCH_SET_ID);
    expect(r.results.map((x) => x.id)).toEqual(BENCH_CASES.map((c) => c.id));
    expect(r.results.map((x) => x.outcome)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(r.calls).toBe(6);
    expect(r.summary.failureRate).toBe(0);
  });

  it('never makes more calls than the cap and marks the rest skipped', async () => {
    const llm = fakeBenchLlm();
    const r = await runBenchmark({ llm, clock, maxCalls: 2, callTimeoutMs: 1000 });
    expect(r.calls).toBe(2);
    expect(llm.structuredCalls.length + llm.streamCalls.length).toBe(2);
    expect(r.summary.skipped).toBe(4);
    expect(r.results.filter((x) => x.outcome === 'skipped')).toHaveLength(4);
  });

  it('a wrong answer and a provider failure are counted separately; the failure rate counts failures only', async () => {
    const llm = new FakeLlm()
      .queueStructured(...Array.from({ length: 6 }, () => new LlmError('unavailable', 'x')))
      .queueStructured({ verdict: 'unsupported' }, { verdict: 'unsupported' })
      .queueStream({ deltas: [], failWith: new LlmError('timeout', 't') });
    const r = await runBenchmark({ llm, clock, maxCalls: 50, callTimeoutMs: 1000 });
    const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
    expect(by['extract-weekday-audit']?.outcome).toBe('failed');
    expect(by['judge-supported']?.outcome).toBe('wrong');
    expect(by['judge-unsupported']?.outcome).toBe('ok');
    expect(r.summary.failed).toBeGreaterThan(0);
    expect(r.summary.failureRate).toBeCloseTo(
      r.summary.failed / (r.results.length - r.summary.skipped),
    );
  });

  it('reports no latency and no cost when nothing was observed or priced', async () => {
    const r = await runBenchmark({ llm: fakeBenchLlm(), clock, maxCalls: 20, callTimeoutMs: 1000 });
    expect(r.summary.costEstimate).toBeNull();
    const priced = await runBenchmark({
      llm: fakeBenchLlm(),
      clock,
      maxCalls: 20,
      callTimeoutMs: 1000,
      prices: { inputPerMillion: 1, outputPerMillion: 2 },
    });
    expect(priced.summary.costEstimate).toBe(0); // the fake reports zero tokens
  });

  it('percentile uses observed values only', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([5, 1, 3], 100)).toBe(5);
  });
});

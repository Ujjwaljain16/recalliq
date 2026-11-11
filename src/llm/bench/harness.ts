import { LlmTurnAnalyzer } from '../analysis/analyzer.js';
import {
  JUDGE_SCHEMA_NAME,
  JUDGE_SYSTEM,
  buildJudgeMessages,
  judgeSchema,
} from '../prompts/judge.js';
import { SYNTHESIS_SYSTEM, buildSynthesisMessages } from '../prompts/synthesis.js';
import type { Clock, TurnBudget } from '../../shared/infrastructure.js';
import { LlmError, type LlmPort, type LlmUsage } from '../../shared/llm.js';
import { BENCH_CASES, BENCH_SET_ID, type BenchCase } from './cases.js';

export interface BenchOptions {
  llm: LlmPort;
  clock: Clock;
  /** Hard cap on provider calls. A case that would exceed it is skipped, never started. */
  maxCalls: number;
  /** Per call, in milliseconds. */
  callTimeoutMs: number;
  cases?: BenchCase[];
  /** Optional prices per million tokens, supplied by the person running the benchmark. */
  prices?: { inputPerMillion: number; outputPerMillion: number };
}

export interface CaseResult {
  id: string;
  kind: BenchCase['kind'];
  outcome: 'ok' | 'wrong' | 'failed' | 'skipped';
  /** LlmError code when failed, or the checks that did not hold when wrong. */
  detail: string | null;
  latencyMs: number | null;
  ttftMs: number | null;
  usage: LlmUsage | null;
}

export interface BenchReport {
  setId: string;
  /** Number of provider calls actually made. */
  calls: number;
  results: CaseResult[];
  summary: {
    ok: number;
    wrong: number;
    failed: number;
    skipped: number;
    /** failed / attempted, or null when nothing was attempted. */
    failureRate: number | null;
    totalUsage: LlmUsage;
    /** Observed values only; null when there is no observation. */
    latencyMs: { p50: number | null; max: number | null };
    /** Present only when prices were supplied by the caller. */
    costEstimate: number | null;
  };
}

const ZERO: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A budget that is only a timeout: the benchmark measures calls, not turn scheduling. */
function budgetFor(ms: number, now: number): TurnBudget {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('benchmark call timeout')), ms);
  timer.unref();
  return {
    deadline: now + ms,
    signal: controller.signal,
    remaining: () => ms,
    timeoutFor: (_stage, cap) => Math.min(cap, ms),
    signalFor: () => controller.signal,
    admit: () => true,
  };
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? null;
}

function guard(counter: { n: number; max: number }): void {
  if (counter.n >= counter.max) throw new LlmError('bad_request', 'benchmark call cap reached');
  counter.n++;
}

/** Wraps a port to capture the usage and timing of the one call a case makes. */
function tap(
  llm: LlmPort,
  counter: { n: number; max: number },
): {
  port: LlmPort;
  last: { usage: LlmUsage | null; latencyMs: number | null; ttftMs: number | null };
} {
  const last = {
    usage: null as LlmUsage | null,
    latencyMs: null as number | null,
    ttftMs: null as number | null,
  };
  const port: LlmPort = {
    async structured(r) {
      guard(counter);
      const res = await llm.structured(r);
      last.usage = res.usage;
      last.latencyMs = res.latencyMs;
      return res;
    },
    async *stream(r) {
      guard(counter);
      for await (const e of llm.stream(r)) {
        if (e.type === 'done') {
          last.usage = e.usage;
          last.latencyMs = e.latencyMs;
          last.ttftMs = e.ttftMs;
        }
        yield e;
      }
    },
  };
  return { port, last };
}

async function runCase(
  c: BenchCase,
  opts: BenchOptions,
  counter: { n: number; max: number },
): Promise<Omit<CaseResult, 'id' | 'kind'>> {
  const { port, last } = tap(opts.llm, counter);
  const budget = budgetFor(opts.callTimeoutMs, opts.clock.now());
  try {
    if (c.kind === 'extraction') {
      const analysis = await new LlmTurnAnalyzer({ llm: port }).analyze(
        { userMessage: c.userMessage, window: [], tz: 'UTC', now: opts.clock.now() },
        budget,
      );
      if (analysis.degraded)
        return { outcome: 'failed', detail: 'analysis degraded', ...snap(last) };
      const failures = c.checks.map((f) => f(analysis)).filter((x): x is string => x !== null);
      return failures.length === 0
        ? { outcome: 'ok', detail: null, ...snap(last) }
        : { outcome: 'wrong', detail: failures.join('; '), ...snap(last) };
    }
    if (c.kind === 'judge') {
      const r = await port.structured({
        role: 'judge',
        system: JUDGE_SYSTEM,
        messages: buildJudgeMessages(c.sentence, c.facts),
        schema: judgeSchema,
        schemaName: JUDGE_SCHEMA_NAME,
        maxTokens: 50,
        signal: budget.signal,
      });
      const right =
        c.expected === 'supported'
          ? r.value.verdict === 'supported'
          : r.value.verdict !== 'supported';
      return {
        outcome: right ? 'ok' : 'wrong',
        detail: right ? null : `answered ${r.value.verdict}`,
        ...snap(last),
      };
    }
    const messages = buildSynthesisMessages({
      findings: [],
      recall: [],
      sourceIds: [],
      userMessage: c.userMessage,
      window: [],
      compact: false,
    });
    let text = '';
    for await (const e of port.stream({
      role: 'synthesis',
      system: SYNTHESIS_SYSTEM,
      messages,
      maxTokens: 300,
      signal: budget.signal,
    })) {
      if (e.type === 'delta') text += e.text;
    }
    return {
      outcome: text.trim() === '' ? 'wrong' : 'ok',
      detail: text.trim() === '' ? 'empty answer' : null,
      ...snap(last),
    };
  } catch (e) {
    return { outcome: 'failed', detail: e instanceof LlmError ? e.code : 'error', ...snap(last) };
  }
}

function snap(last: { usage: LlmUsage | null; latencyMs: number | null; ttftMs: number | null }) {
  return { latencyMs: last.latencyMs, ttftMs: last.ttftMs, usage: last.usage };
}

/**
 * Runs the fixed benchmark set against a port. It measures; it never decides anything. All numbers in the report
 * are observed values or sums of them: no estimate is made unless the caller supplies prices.
 */
export async function runBenchmark(opts: BenchOptions): Promise<BenchReport> {
  const cases = opts.cases ?? BENCH_CASES;
  const results: CaseResult[] = [];
  const counter = { n: 0, max: opts.maxCalls };
  for (const c of cases) {
    if (counter.n >= counter.max) {
      results.push({
        id: c.id,
        kind: c.kind,
        outcome: 'skipped',
        detail: 'call cap reached',
        latencyMs: null,
        ttftMs: null,
        usage: null,
      });
      continue;
    }
    results.push({ id: c.id, kind: c.kind, ...(await runCase(c, opts, counter)) });
  }
  const attempted = results.filter((r) => r.outcome !== 'skipped');
  const totalUsage = results.reduce(
    (acc, r) =>
      r.usage
        ? {
            inputTokens: acc.inputTokens + r.usage.inputTokens,
            outputTokens: acc.outputTokens + r.usage.outputTokens,
            cacheReadTokens: acc.cacheReadTokens + r.usage.cacheReadTokens,
            cacheWriteTokens: acc.cacheWriteTokens + r.usage.cacheWriteTokens,
          }
        : acc,
    ZERO,
  );
  const latencies = results.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs]));
  const count = (o: CaseResult['outcome']): number => results.filter((r) => r.outcome === o).length;
  return {
    setId: BENCH_SET_ID,
    calls: counter.n,
    results,
    summary: {
      ok: count('ok'),
      wrong: count('wrong'),
      failed: count('failed'),
      skipped: count('skipped'),
      failureRate: attempted.length === 0 ? null : count('failed') / attempted.length,
      totalUsage,
      latencyMs: { p50: percentile(latencies, 50), max: percentile(latencies, 100) },
      costEstimate: opts.prices
        ? ((totalUsage.inputTokens + totalUsage.cacheReadTokens) * opts.prices.inputPerMillion +
            totalUsage.outputTokens * opts.prices.outputPerMillion) /
          1_000_000
        : null,
    },
  };
}

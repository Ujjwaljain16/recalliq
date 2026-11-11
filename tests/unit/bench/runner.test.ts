import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Components } from '../../../src/app/components.js';
import { LlmError } from '../../../src/shared/llm.js';
import {
  parseLongMemEval,
  parseSimpleQa,
  type BenchItem,
} from '../../../scripts/bench/datasets.js';
import { gradeResults, type GraderModel } from '../../../scripts/bench/grade.js';
import { CallRecorder } from '../../../scripts/bench/recorder.js';
import { buildReport } from '../../../scripts/bench/report.js';
import { readResults, type QuestionResult } from '../../../scripts/bench/results.js';
import {
  classify,
  runBenchmark,
  scriptedLauncher,
  type RunOptions,
} from '../../../scripts/bench/run.js';
import type { TurnOutcome } from '../../../scripts/bench/client.js';
import { LONGMEMEVAL_JSON, SIMPLEQA_CSV } from './fixtures.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-run-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const noNetwork: typeof fetch = () => Promise.reject(new Error('no network in tests'));

function options(items: BenchItem[], extra: Partial<RunOptions> = {}): RunOptions {
  const recorder = extra.recorder ?? new CallRecorder(noNetwork);
  return {
    dataset: items[0]?.dataset ?? 'simpleqa',
    split: 'dev',
    items,
    out: path.join(dir, 'results.jsonl'),
    runId: 'test-run',
    components: 'scripted',
    model: null,
    launcher: scriptedLauncher(),
    recorder,
    dbDir: path.join(dir, 'runs'),
    pauseMs: 0,
    log: () => undefined,
    ...extra,
  };
}

/** A grader that answers from a fixed table, so grading is checked without a model. */
class FakeGrader implements GraderModel {
  readonly name = 'fake-grader';
  readonly prompts: string[] = [];
  constructor(private readonly reply: (prompt: string) => string) {}
  complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return Promise.resolve(this.reply(prompt));
  }
}

/** Every analysis first meets a rate-limited provider response, then fails, as a quota outage would. */
function rateLimitedAnalyzer(recorder: CallRecorder, body: string) {
  return (c: Components): Components => ({
    ...c,
    analyzer: {
      async analyze() {
        const res = await recorder.fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent',
        );
        await res.text();
        throw new LlmError('rate_limited', body);
      },
    },
  });
}

const limitedFetch =
  (body: string): typeof fetch =>
  () =>
    Promise.resolve(new Response(body, { status: 429 }));

describe('runner, end to end over HTTP with the scripted components', () => {
  it('asks two SimpleQA questions, records them, grades them with a fake grader and reports', async () => {
    const items = parseSimpleQa(SIMPLEQA_CSV).slice(0, 2);
    const summary = await runBenchmark(options(items));
    expect(summary).toMatchObject({ attempted: 2, answered: 2, errors: 0, stopped: null });

    const results = readResults(path.join(dir, 'results.jsonl'));
    expect(results.map((r) => r.id)).toEqual(['simpleqa-0', 'simpleqa-1']);
    for (const r of results) {
      expect(r.outcome).toBe('answered');
      expect(r.status).toBe('complete');
      expect(r.answer.length).toBeGreaterThan(0);
      expect(r.firstTextMs).not.toBeNull();
      expect(r.wallMs).toBeGreaterThanOrEqual(r.firstTextMs ?? 0);
      expect(r.calls.gemini.count).toBe(0);
    }
    // Scratch databases are removed unless asked to keep them.
    expect(fs.readdirSync(path.join(dir, 'runs'))).toEqual([]);

    const grader = new FakeGrader((p) => (p.includes('Ada Example') ? 'A' : 'C'));
    const { file } = await gradeResults({
      dataset: 'simpleqa',
      split: 'dev',
      items,
      resultsFile: path.join(dir, 'results.jsonl'),
      out: path.join(dir, 'results.grades.json'),
      grader,
      upstreamSimpleQa: null,
      log: () => undefined,
    });
    expect(file.items.map((g) => g.grade)).toEqual(['CORRECT', 'NOT_ATTEMPTED']);
    expect(file.graderModel).toBe('fake-grader');
    expect(file.promptVersion).toBe('simple-evals-grader-template');
    expect(grader.prompts[0]).toContain('Gold target: Ada Example');

    // Grading again with the same grader and prompt reuses the stored grades.
    const again = new FakeGrader(() => 'B');
    await gradeResults({
      dataset: 'simpleqa',
      split: 'dev',
      items,
      resultsFile: path.join(dir, 'results.jsonl'),
      out: path.join(dir, 'results.grades.json'),
      grader: Object.assign(again, { name: 'fake-grader' }),
      upstreamSimpleQa: null,
      log: () => undefined,
    });
    expect(again.prompts).toEqual([]);

    const report = buildReport([file], new Date(Date.UTC(2026, 10, 12)));
    expect(report).toContain('## simpleqa (dev)');
    expect(report).toContain('Scripted components');
    expect(report).toContain('| 2 | dev | 2 | 1 | 50.0% [');
  });

  it('seeds a LongMemEval history into its own database and asks on the question date', async () => {
    const [item] = parseLongMemEval(LONGMEMEVAL_JSON);
    if (item === undefined) throw new Error('fixture');
    await runBenchmark(options([item], { keepDbs: true }));
    const [result] = readResults(path.join(dir, 'results.jsonl'));
    expect(result?.seeding).toEqual({ conversations: 2, userMessages: 2, assistantMessages: 2 });
    // "Yesterday" relative to the question date reaches the seeded session of the day before.
    expect(result?.lane).toBe('recall');
    expect(result?.answer).toMatch(/sourdough/i);
    expect(fs.existsSync(path.join(dir, 'runs', 'longmemeval-dev', 'q_temporal_1.db'))).toBe(true);
  });
});

describe('runner, resume', () => {
  it('skips answered ids and retries earlier errors', async () => {
    const items = parseSimpleQa(SIMPLEQA_CSV).slice(0, 3);
    const first = await runBenchmark(options(items, { maxQuestions: 1 }));
    expect(first).toMatchObject({ attempted: 1, skipped: 0 });

    // A stored error for the second question must not count as done.
    const out = path.join(dir, 'results.jsonl');
    const [answered] = readResults(out);
    if (answered === undefined) throw new Error('no result');
    const failed: QuestionResult = {
      ...answered,
      id: 'simpleqa-1',
      outcome: 'error',
      error: { kind: 'rate_limited', detail: 'test' },
    };
    fs.appendFileSync(out, JSON.stringify(failed) + '\n');

    const second = await runBenchmark(options(items));
    expect(second).toMatchObject({ skipped: 1, attempted: 2, answered: 2 });
    const third = await runBenchmark(options(items));
    expect(third).toMatchObject({ skipped: 3, attempted: 0 });
    const ids = readResults(out).map((r) => r.id);
    expect(ids).toEqual(['simpleqa-0', 'simpleqa-1', 'simpleqa-1', 'simpleqa-2']);
  });

  it('ignores a torn last line and drops it before appending', async () => {
    const items = parseSimpleQa(SIMPLEQA_CSV).slice(0, 2);
    await runBenchmark(options(items, { maxQuestions: 1 }));
    const out = path.join(dir, 'results.jsonl');
    fs.appendFileSync(out, '{"id":"simpleqa-1","trunc');
    expect(readResults(out)).toHaveLength(1);
    await runBenchmark(options(items));
    expect(readResults(out).map((r) => r.id)).toEqual(['simpleqa-0', 'simpleqa-1']);
  });
});

describe('runner, rate limits and quota', () => {
  it('records rate-limited questions as errors and stops after the configured number in a row', async () => {
    const body =
      '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Too many requests per minute"}}';
    const recorder = new CallRecorder(limitedFetch(body));
    const items = parseSimpleQa(SIMPLEQA_CSV);
    const summary = await runBenchmark(
      options(items, {
        recorder,
        launcher: scriptedLauncher({ decorate: rateLimitedAnalyzer(recorder, body) }),
        maxConsecutiveRateLimited: 2,
      }),
    );
    expect(summary.attempted).toBe(2);
    expect(summary.stopped).toMatch(/2 consecutive rate-limited/);
    const results = readResults(path.join(dir, 'results.jsonl'));
    expect(results.map((r) => [r.outcome, r.error?.kind])).toEqual([
      ['error', 'rate_limited'],
      ['error', 'rate_limited'],
    ]);
    expect(results[0]?.calls.gemini).toMatchObject({ count: 1, rateLimited: 1, statuses: [429] });

    // Errors are excluded from grading, never graded as wrong answers.
    const grader = new FakeGrader(() => 'B');
    const { file } = await gradeResults({
      dataset: 'simpleqa',
      split: 'dev',
      items,
      resultsFile: path.join(dir, 'results.jsonl'),
      out: path.join(dir, 'grades.json'),
      grader,
      log: () => undefined,
    });
    expect(file.items.map((g) => g.grade)).toEqual(['EXCLUDED', 'EXCLUDED']);
    expect(grader.prompts).toEqual([]);
  });

  it('stops at once on a daily quota', async () => {
    const body =
      '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel"}]}}';
    const recorder = new CallRecorder(limitedFetch(body));
    const summary = await runBenchmark(
      options(parseSimpleQa(SIMPLEQA_CSV), {
        recorder,
        launcher: scriptedLauncher({ decorate: rateLimitedAnalyzer(recorder, body) }),
      }),
    );
    expect(summary.attempted).toBe(1);
    expect(summary.stopped).toMatch(/daily quota/);
    expect(readResults(path.join(dir, 'results.jsonl'))[0]?.error?.kind).toBe('quota');
  });
});

describe('classify', () => {
  const turn = (over: Partial<TurnOutcome> = {}): TurnOutcome => ({
    httpStatus: 200,
    turnId: 'trn_x',
    lane: 'research',
    status: 'complete',
    sentences: [{ index: 0, text: 'An answer.', status: 'verified' }],
    withheld: [],
    clarification: null,
    sources: [],
    citations: 0,
    warnings: [],
    errors: [],
    serverMetrics: null,
    wallMs: 10,
    firstEventMs: 1,
    firstTextMs: 5,
    refusal: null,
    ...over,
  });
  const call = (status: number, rateLimited = false) => ({
    provider: 'gemini' as const,
    host: 'generativelanguage.googleapis.com',
    status,
    ms: 1,
    rateLimited,
    dailyQuota: false,
  });

  it('treats a rate limit the application retried through cleanly as an answer', () => {
    expect(classify(turn(), [call(429, true), call(200)])).toBeNull();
  });

  it('treats a rate limit that degraded the turn as an error', () => {
    const degraded = turn({ warnings: [{ code: 'search_partial', text: '' }] });
    expect(classify(degraded, [call(429, true)])?.kind).toBe('rate_limited');
  });

  it('counts other provider failures only when the turn produced nothing', () => {
    expect(classify(turn({ status: 'failed', sentences: [] }), [call(503)])?.kind).toBe('provider');
    expect(classify(turn({ status: 'partial' }), [call(503)])).toBeNull();
  });

  it('reports a refused request as an HTTP error', () => {
    expect(classify(turn({ httpStatus: 409, refusal: 'busy' }), [])?.kind).toBe('http');
  });
});

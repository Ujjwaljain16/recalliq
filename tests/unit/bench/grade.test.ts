import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFreshQa } from '../../../scripts/bench/datasets.js';
import {
  GeminiGrader,
  GraderQuotaError,
  gradeResults,
  responseText,
  reviewDue,
} from '../../../scripts/bench/grade.js';
import {
  checkSimpleQaTemplate,
  freshQaPrompt,
  longMemPrompt,
  parseLabelledGrade,
  parseSimpleQaGrade,
  parseYesNo,
  SIMPLEQA_GRADER_TEMPLATE,
} from '../../../scripts/bench/prompts.js';
import { buildReport, simpleQaMetrics, tally } from '../../../scripts/bench/report.js';
import { appendResult, type QuestionResult } from '../../../scripts/bench/results.js';
import { FRESHQA_CSV } from './fixtures.js';

describe('grade parsing', () => {
  it('reads the simple-evals letter, defaulting to not attempted', () => {
    expect(parseSimpleQaGrade('A')).toBe('CORRECT');
    expect(parseSimpleQaGrade(' B\n')).toBe('INCORRECT');
    expect(parseSimpleQaGrade('C')).toBe('NOT_ATTEMPTED');
    expect(parseSimpleQaGrade('no idea')).toBe('NOT_ATTEMPTED');
  });

  it('reads the last Grade line of a FreshQA reply, or nothing', () => {
    expect(parseLabelledGrade('Reasoning: fine.\nGrade: CORRECT')).toBe('CORRECT');
    expect(parseLabelledGrade('Grade: correct\nGrade: **NOT ATTEMPTED**')).toBe('NOT_ATTEMPTED');
    expect(parseLabelledGrade('I think it is right')).toBeNull();
  });

  it('reads yes or no for LongMemEval', () => {
    expect(parseYesNo('Yes.')).toBe('CORRECT');
    expect(parseYesNo('no')).toBe('INCORRECT');
  });
});

describe('grader prompts', () => {
  it('fills the simple-evals template and verifies it against an upstream source', () => {
    const upstream = `GRADER_TEMPLATE = """\n${SIMPLEQA_GRADER_TEMPLATE.replace(/\n/g, '\n  ')}\n""".strip()`;
    expect(checkSimpleQaTemplate(upstream)).toBe(true);
    expect(checkSimpleQaTemplate(upstream.replace('Gold target', 'Target'))).toBe(false);
  });

  it('demands that a false premise be pointed out', () => {
    const p = freshQaPrompt({
      question: 'Q?',
      answers: ['No such thing exists.'],
      falsePremise: true,
      askedOn: '2026-11-12',
      response: 'R',
    });
    expect(p).toContain('THIS QUESTION HAS A FALSE PREMISE');
    expect(p).toContain('recorded on 2026-04-21');
    expect(p).toContain('1. No such thing exists.');
  });

  it('chooses the judgement by question type', () => {
    const base = { question: 'Q', answer: 'A', response: 'R', abstention: false };
    expect(longMemPrompt({ ...base, questionType: 'temporal-reasoning' })).toContain('off-by-one');
    expect(longMemPrompt({ ...base, questionType: 'knowledge-update' })).toContain(
      'updated answer',
    );
    expect(longMemPrompt({ ...base, questionType: 'single-session-preference' })).toContain(
      'Rubric: A',
    );
    expect(longMemPrompt({ ...base, questionType: 'multi-session', abstention: true })).toContain(
      'unanswerable',
    );
  });
});

describe('response text and staleness', () => {
  const result = (answer: string, clarification: string | null = null): QuestionResult =>
    ({
      answer,
      clarification: clarification === null ? null : { question: clarification, options: [] },
    }) as QuestionResult;

  it('drops citation markers and falls back to a clarification question', () => {
    expect(responseText(result('Paris is the capital [1]. It is large [2].'))).toBe(
      'Paris is the capital. It is large.',
    );
    expect(responseText(result('', 'Which company do you mean?'))).toBe(
      'Which company do you mean?',
    );
  });

  it('flags review dates that passed before the question was asked', () => {
    expect(reviewDue('07/01/2026', '2026-11-12T10:00:00Z')).toBe(true);
    expect(reviewDue('01/01/2027', '2026-11-12T10:00:00Z')).toBe(false);
    expect(reviewDue('occasionally', '2026-11-12T10:00:00Z')).toBe(false);
  });
});

describe('simple-evals aggregate', () => {
  it('computes correct given attempted and the F-score', () => {
    const t = {
      n: 10,
      graded: 10,
      correct: 4,
      incorrect: 4,
      notAttempted: 2,
      excluded: 0,
      ungraded: 0,
    };
    const m = simpleQaMetrics(t);
    expect(m.correct).toBeCloseTo(0.4);
    expect(m.correctGivenAttempted).toBeCloseTo(0.5);
    expect(m.fScore).toBeCloseTo((2 * 0.5 * 0.4) / 0.9);
  });
});

describe('GeminiGrader', () => {
  const ok = (text: string): Response =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
    });

  it('sends the key in a header only, retries a rate limit, and returns the text', async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    let calls = 0;
    const fake: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        key: headers.get('x-goog-api-key'),
      });
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429 })
          : ok('A'),
      );
    };
    const grader = new GeminiGrader('grader-model', 'secret-key', {
      fetch: fake,
      sleep: () => Promise.resolve(),
    });
    await expect(grader.complete('prompt')).resolves.toBe('A');
    expect(calls).toBe(2);
    expect(seen.every((s) => !s.url.includes('secret-key') && s.key === 'secret-key')).toBe(true);
  });

  it('throws GraderQuotaError on a daily quota', async () => {
    const fake: typeof fetch = () =>
      Promise.resolve(
        new Response('{"error":{"status":"RESOURCE_EXHAUSTED","message":"PerDay"}}', {
          status: 429,
        }),
      );
    const grader = new GeminiGrader('m', 'k', { fetch: fake, sleep: () => Promise.resolve() });
    await expect(grader.complete('p')).rejects.toBeInstanceOf(GraderQuotaError);
  });
});

describe('FreshQA grading and report', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-grade-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const record = (id: string, answer: string): QuestionResult => ({
    id,
    dataset: 'freshqa',
    split: 'test',
    runId: 'r1',
    askedAt: '2026-11-12T10:00:00.000Z',
    components: 'live',
    model: 'agent-model',
    question: 'q',
    outcome: 'answered',
    error: null,
    lane: 'research',
    status: 'complete',
    httpStatus: 200,
    answer,
    answerMarked: answer,
    sentences: [],
    withheld: [],
    clarification: null,
    wallMs: 1000,
    firstEventMs: 100,
    firstTextMs: 500,
    serverMetrics: null,
    calls: {
      gemini: { count: 3, failed: 0, rateLimited: 0, statuses: [200, 200, 200] },
      exa: { count: 1, failed: 0, rateLimited: 0, statuses: [200] },
    },
    citations: { cited: 1, sources: 1, domains: ['example.org'] },
    warnings: [],
    errors: [],
    seeding: null,
  });

  it('grades by premise and flags fast-changing and overdue answers separately', async () => {
    const items = parseFreshQa(FRESHQA_CSV).filter((i) => i.split === 'TEST');
    const out = path.join(dir, 'freshqa-test-live.jsonl');
    appendResult(out, record('freshqa-0', 'No cat has ever walked on Mars.'));
    appendResult(out, record('freshqa-1', 'Jane Placeholder chairs it.'));
    appendResult(out, record('freshqa-3', 'Unclear.'));
    const replies = new Map([
      ['No cat', 'Reasoning: points out the false premise.\nGrade: CORRECT'],
      ['Jane', 'Reasoning: matches.\nGrade: CORRECT'],
      ['Unclear', 'garbled'],
    ]);
    const grader = {
      name: 'fake',
      complete: (p: string) =>
        Promise.resolve(
          [...replies.entries()].find(([k]) => p.includes(`Response: ${k}`))?.[1] ?? '',
        ),
    };
    const { file } = await gradeResults({
      dataset: 'freshqa',
      split: 'test',
      items,
      resultsFile: out,
      out: path.join(dir, 'grades.json'),
      grader,
      log: () => undefined,
    });
    expect(file.items.map((g) => [g.id, g.grade, g.reviewDue])).toEqual([
      ['freshqa-0', 'CORRECT', false],
      ['freshqa-1', 'CORRECT', true],
      ['freshqa-3', 'UNGRADED', false],
    ]);
    expect(tally(file.items)).toMatchObject({ graded: 2, correct: 2, ungraded: 1 });

    const report = buildReport([file], new Date(Date.UTC(2026, 10, 12)));
    expect(report).toContain('### By premise');
    expect(report).toContain('| fast-changing | 1 | 1 | 1 |');
    expect(report).toContain('| review date passed before asking | 1 |');
    expect(report).toContain('agent-model');
    expect(report).not.toContain('Scripted components');
  });
});

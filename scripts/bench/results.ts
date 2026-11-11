import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** One line of a run's JSONL file: everything recorded about one question. Written by the runner only. */

const callSummary = z.object({
  count: z.number().int(),
  failed: z.number().int(),
  rateLimited: z.number().int(),
  statuses: z.array(z.number().int()),
});

export const questionResultSchema = z.object({
  id: z.string(),
  dataset: z.enum(['simpleqa', 'freshqa', 'longmemeval']),
  split: z.enum(['dev', 'test']),
  runId: z.string(),
  askedAt: z.string(),
  components: z.enum(['live', 'scripted']),
  model: z.string().nullable(),
  question: z.string(),
  /** `error` results are never graded as wrong answers: they are counted as provider or harness errors. */
  outcome: z.enum(['answered', 'error']),
  error: z
    .object({
      kind: z.enum(['rate_limited', 'quota', 'provider', 'http', 'harness']),
      detail: z.string(),
    })
    .nullable(),
  lane: z.string().nullable(),
  status: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  /** The released sentences, joined: what the user was shown. */
  answer: z.string(),
  /** The same, with a marker for every sentence the release gate withheld and the status of weak ones. */
  answerMarked: z.string(),
  sentences: z.array(z.object({ index: z.number().int(), text: z.string(), status: z.string() })),
  withheld: z.array(z.array(z.string())),
  clarification: z.object({ question: z.string(), options: z.array(z.string()) }).nullable(),
  wallMs: z.number().nullable(),
  firstEventMs: z.number().nullable(),
  firstTextMs: z.number().nullable(),
  serverMetrics: z
    .object({ ttfpMs: z.number().nullable(), ttftMs: z.number().nullable(), ttcMs: z.number() })
    .nullable(),
  calls: z.object({ gemini: callSummary, exa: callSummary }),
  citations: z.object({
    cited: z.number().int(),
    sources: z.number().int(),
    domains: z.array(z.string()),
  }),
  warnings: z.array(z.string()),
  errors: z.array(z.object({ code: z.string(), text: z.string() })),
  seeding: z
    .object({
      conversations: z.number().int(),
      userMessages: z.number().int(),
      assistantMessages: z.number().int(),
    })
    .nullable(),
});

export type QuestionResult = z.infer<typeof questionResultSchema>;

/** Every record in file order. A torn last line (a crash mid-write) is ignored, any other bad line is an error. */
export function readResults(file: string): QuestionResult[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out: QuestionResult[] = [];
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      out.push(questionResultSchema.parse(JSON.parse(line)));
    } catch (error) {
      if (i === lines.length - 1) return;
      throw new Error(`${file} line ${i + 1}: ${String(error)}`, { cause: error });
    }
  });
  return out;
}

/** The latest record per question id: a retried question supersedes its earlier error. */
export function latestById(results: readonly QuestionResult[]): Map<string, QuestionResult> {
  const map = new Map<string, QuestionResult>();
  for (const r of results) map.set(r.id, r);
  return map;
}

export function appendResult(file: string, result: QuestionResult): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A torn last line (a crash mid-write) is dropped before appending, so it never ends up mid-file.
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (existing.length > 0 && !existing.endsWith('\n')) {
    fs.writeFileSync(file, existing.slice(0, existing.lastIndexOf('\n') + 1));
  }
  fs.appendFileSync(file, JSON.stringify(questionResultSchema.parse(result)) + '\n');
}

export const RESULTS_DIR = 'data/benchmarks/results';
export const RUNS_DIR = 'data/benchmarks/runs';

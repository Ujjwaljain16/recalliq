import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BenchItem, DatasetName } from './datasets.js';
import {
  checkSimpleQaTemplate,
  FRESHQA_PROMPT_VERSION,
  freshQaPrompt,
  LONGMEMEVAL_PROMPT_VERSION,
  longMemPrompt,
  parseLabelledGrade,
  parseSimpleQaGrade,
  parseYesNo,
  SIMPLEQA_PROMPT_VERSION,
  simpleQaPrompt,
} from './prompts.js';
import { latestById, readResults, type QuestionResult } from './results.js';
import { stratumOf, type Split } from './sampler.js';

/**
 * Grading, separate from running: it reads a run's JSONL results and the sample's gold answers, asks the
 * grader model once per answered question, and writes a grades file next to the results. Grading is
 * re-runnable: items already graded with the same grader model and prompt version are kept, so an
 * interrupted grading resumes, and a new grader model or prompt version re-grades everything.
 */

export type Grade = 'CORRECT' | 'INCORRECT' | 'NOT_ATTEMPTED' | 'EXCLUDED' | 'UNGRADED';

export interface GraderModel {
  readonly name: string;
  complete(prompt: string): Promise<string>;
}

/** The grader model ran out of daily quota: grading stops and keeps what it has. */
export class GraderQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraderQuotaError';
  }
}

/**
 * A grader on the Gemini Developer API through plain fetch (the application's adapter is built for its own
 * structured roles; a grader needs only one plain completion). The key is read from GEMINI_API_KEY and sent
 * only in the x-goog-api-key header; nothing here prints it. Retries rate limits and server errors with
 * backoff; a daily quota throws GraderQuotaError.
 */
export class GeminiGrader implements GraderModel {
  constructor(
    readonly name: string,
    private readonly apiKey: string,
    private readonly options: {
      fetch?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
      maxRetries?: number;
      baseUrl?: string;
    } = {},
  ) {}

  async complete(prompt: string): Promise<string> {
    const doFetch = this.options.fetch ?? fetch;
    const sleep =
      this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const base = this.options.baseUrl ?? 'https://generativelanguage.googleapis.com';
    const url = `${base}/v1beta/models/${encodeURIComponent(this.name)}:generateContent`;
    const maxRetries = this.options.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0 },
        }),
      });
      const text = await res.text();
      if (res.ok) {
        const parsed = z
          .object({
            candidates: z
              .array(
                z.object({
                  content: z
                    .object({ parts: z.array(z.object({ text: z.string().optional() })) })
                    .optional(),
                }),
              )
              .optional(),
          })
          .parse(JSON.parse(text));
        return (parsed.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      }
      const limited = res.status === 429 || /RESOURCE_EXHAUSTED/.test(text);
      if (limited && /per ?day|PerDay|daily/i.test(text)) {
        throw new GraderQuotaError('grader model daily quota exhausted');
      }
      if ((limited || res.status >= 500) && attempt < maxRetries) {
        await sleep(2000 * 4 ** attempt);
        continue;
      }
      throw new Error(`grader model call failed: HTTP ${res.status}`);
    }
  }
}

export interface GradeRecord {
  id: string;
  grade: Grade;
  /** The grader's reply, shortened. Null when no grader call was made. */
  reply: string | null;
  stratum: string;
  /** FreshQA only. */
  factType: string | null;
  falsePremise: boolean | null;
  /** FreshQA only: the maintainers' planned review date had passed when the question was asked. */
  reviewDue: boolean | null;
  /** LongMemEval only. */
  questionType: string | null;
  errorKind: string | null;
  wallMs: number | null;
  firstTextMs: number | null;
  geminiCalls: number;
  exaCalls: number;
  providerFailures: number;
}

export interface GradeFile {
  dataset: DatasetName;
  split: Split;
  resultsFile: string;
  runIds: string[];
  components: string[];
  models: string[];
  graderModel: string;
  promptVersion: string;
  /** SimpleQA only: whether the embedded grader template matched the downloaded upstream file (null: not checked). */
  templateVerified: boolean | null;
  firstAskedAt: string | null;
  gradedAt: string;
  items: GradeRecord[];
}

const gradeFileSchema = z.object({
  dataset: z.enum(['simpleqa', 'freshqa', 'longmemeval']),
  split: z.enum(['dev', 'test']),
  resultsFile: z.string(),
  runIds: z.array(z.string()),
  components: z.array(z.string()),
  models: z.array(z.string()),
  graderModel: z.string(),
  promptVersion: z.string(),
  templateVerified: z.boolean().nullable(),
  firstAskedAt: z.string().nullable(),
  gradedAt: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      grade: z.enum(['CORRECT', 'INCORRECT', 'NOT_ATTEMPTED', 'EXCLUDED', 'UNGRADED']),
      reply: z.string().nullable(),
      stratum: z.string(),
      factType: z.string().nullable(),
      falsePremise: z.boolean().nullable(),
      reviewDue: z.boolean().nullable(),
      questionType: z.string().nullable(),
      errorKind: z.string().nullable(),
      wallMs: z.number().nullable(),
      firstTextMs: z.number().nullable(),
      geminiCalls: z.number(),
      exaCalls: z.number(),
      providerFailures: z.number(),
    }),
  ),
});

export function readGradeFile(file: string): GradeFile {
  return gradeFileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function promptVersionFor(dataset: DatasetName): string {
  switch (dataset) {
    case 'simpleqa':
      return SIMPLEQA_PROMPT_VERSION;
    case 'freshqa':
      return FRESHQA_PROMPT_VERSION;
    case 'longmemeval':
      return LONGMEMEVAL_PROMPT_VERSION;
  }
}

/** Citation markers like [1] belong to the interface, not to the answer. */
export function responseText(result: QuestionResult): string {
  const text = result.answer.replace(/\s*\[\d+\]/g, '').trim();
  if (text.length > 0) return text;
  return result.clarification?.question ?? '';
}

/** MM/DD/YYYY review dates before the ask date. Words such as "occasionally" are never due. */
export function reviewDue(nextReview: string, askedAt: string): boolean {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(nextReview.trim());
  if (!m) return false;
  const due = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return due < Date.parse(askedAt);
}

function promptFor(item: BenchItem, result: QuestionResult, response: string): string {
  switch (item.dataset) {
    case 'simpleqa':
      return simpleQaPrompt(item.question, item.answer, response);
    case 'freshqa':
      return freshQaPrompt({
        question: item.question,
        answers: item.answers,
        falsePremise: item.falsePremise,
        askedOn: result.askedAt.slice(0, 10),
        response,
      });
    case 'longmemeval':
      return longMemPrompt({
        questionType: item.questionType,
        abstention: item.abstention,
        question: item.question,
        answer: item.answer,
        response,
      });
  }
}

function parseReply(dataset: DatasetName, reply: string): Grade {
  switch (dataset) {
    case 'simpleqa':
      return parseSimpleQaGrade(reply);
    case 'freshqa':
      return parseLabelledGrade(reply) ?? 'UNGRADED';
    case 'longmemeval':
      return parseYesNo(reply);
  }
}

function baseRecord(item: BenchItem, result: QuestionResult): Omit<GradeRecord, 'grade' | 'reply'> {
  return {
    id: item.id,
    stratum: stratumOf(item),
    factType: item.dataset === 'freshqa' ? item.factType : null,
    falsePremise: item.dataset === 'freshqa' ? item.falsePremise : null,
    reviewDue: item.dataset === 'freshqa' ? reviewDue(item.nextReview, result.askedAt) : null,
    questionType: item.dataset === 'longmemeval' ? item.questionType : null,
    errorKind: result.error?.kind ?? null,
    wallMs: result.wallMs,
    firstTextMs: result.firstTextMs,
    geminiCalls: result.calls.gemini.count,
    exaCalls: result.calls.exa.count,
    providerFailures: result.calls.gemini.failed + result.calls.exa.failed,
  };
}

export interface GradeOptions {
  dataset: DatasetName;
  split: Split;
  items: BenchItem[];
  resultsFile: string;
  out: string;
  grader: GraderModel;
  /** Text of the downloaded upstream simple-evals source, when available (SimpleQA only). */
  upstreamSimpleQa?: string | null;
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  now?: () => Date;
}

export async function gradeResults(
  options: GradeOptions,
): Promise<{ file: GradeFile; stopped: string | null }> {
  const log = options.log ?? ((line: string) => process.stdout.write(line + '\n'));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => new Date());
  const promptVersion = promptVersionFor(options.dataset);
  const results = [...latestById(readResults(options.resultsFile)).values()];
  const byId = new Map(options.items.map((i) => [i.id, i]));

  const previous =
    fs.existsSync(options.out) && fs.statSync(options.out).size > 0
      ? readGradeFile(options.out)
      : null;
  const reusable =
    previous !== null &&
    previous.graderModel === options.grader.name &&
    previous.promptVersion === promptVersion
      ? new Map(previous.items.map((g) => [g.id, g]))
      : new Map<string, GradeRecord>();

  const file: GradeFile = {
    dataset: options.dataset,
    split: options.split,
    resultsFile: options.resultsFile,
    runIds: [...new Set(results.map((r) => r.runId))],
    components: [...new Set(results.map((r) => r.components))],
    models: [...new Set(results.map((r) => r.model ?? 'none'))],
    graderModel: options.grader.name,
    promptVersion,
    templateVerified:
      options.dataset === 'simpleqa' && options.upstreamSimpleQa
        ? checkSimpleQaTemplate(options.upstreamSimpleQa)
        : null,
    firstAskedAt: results.map((r) => r.askedAt).sort()[0] ?? null,
    gradedAt: now().toISOString(),
    items: [],
  };
  const save = (): void => {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, JSON.stringify(file, null, 2) + '\n');
  };

  let stopped: string | null = null;
  let calls = 0;
  for (const result of results) {
    const item = byId.get(result.id);
    if (item === undefined) {
      log(`skipping ${result.id}: not in the sample`);
      continue;
    }
    const base = baseRecord(item, result);
    if (result.outcome === 'error') {
      file.items.push({ ...base, grade: 'EXCLUDED', reply: null });
      continue;
    }
    const kept = reusable.get(result.id);
    if (kept !== undefined && kept.grade !== 'UNGRADED' && kept.grade !== 'EXCLUDED') {
      file.items.push({ ...base, grade: kept.grade, reply: kept.reply });
      continue;
    }
    const response = responseText(result);
    if (response === '' || stopped !== null) {
      file.items.push({
        ...base,
        grade: response === '' ? 'NOT_ATTEMPTED' : 'UNGRADED',
        reply: null,
      });
      continue;
    }
    if (calls > 0 && (options.pauseMs ?? 0) > 0) await sleep(options.pauseMs ?? 0);
    calls += 1;
    try {
      const reply = await options.grader.complete(promptFor(item, result, response));
      file.items.push({
        ...base,
        grade: parseReply(options.dataset, reply),
        reply: reply.slice(0, 600),
      });
    } catch (error) {
      if (error instanceof GraderQuotaError) stopped = error.message;
      file.items.push({ ...base, grade: 'UNGRADED', reply: null });
      log(`grading ${result.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    save();
  }
  save();
  return { file, stopped };
}

export function defaultGradesPath(resultsFile: string): string {
  return resultsFile.replace(/\.jsonl$/, '') + '.grades.json';
}

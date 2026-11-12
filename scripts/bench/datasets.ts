import fs from 'node:fs';
import { z } from 'zod';
import { parseCsv, recordsWithHeader } from './csv.js';

/**
 * Loaders for the three benchmark files. Every row is validated with zod; a malformed row is an error that
 * names the file and the row, never silently skipped. Each loader returns rows in a normalized shape that
 * the sampler, the runner and the graders share.
 */

export type DatasetName = 'simpleqa' | 'freshqa' | 'longmemeval';
export const DATASETS: readonly DatasetName[] = ['simpleqa', 'freshqa', 'longmemeval'];

export function isDatasetName(value: string): value is DatasetName {
  return (DATASETS as readonly string[]).includes(value);
}

// ── SimpleQA ──

export interface SimpleQaItem {
  dataset: 'simpleqa';
  /** The 0-based data row of the official CSV: the file has no id column, and its row order is fixed. */
  id: string;
  question: string;
  answer: string;
  topic: string;
  answerType: string;
}

const simpleQaRow = z.object({
  metadata: z.string().min(1),
  problem: z.string().min(1),
  answer: z.string().min(1),
});

/** The metadata column is a Python dict literal; only two of its string fields are needed. */
function pyField(metadata: string, key: string): string | undefined {
  const m = new RegExp(`'${key}':\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`).exec(
    metadata,
  );
  return m?.[1] ?? m?.[2];
}

export function parseSimpleQa(text: string): SimpleQaItem[] {
  const records = recordsWithHeader(parseCsv(text), 0);
  return records.map((raw, i) => {
    const parsed = simpleQaRow.safeParse(raw);
    if (!parsed.success) throw new Error(`SimpleQA row ${i}: ${parsed.error.message}`);
    const topic = pyField(parsed.data.metadata, 'topic');
    if (topic === undefined) throw new Error(`SimpleQA row ${i}: metadata has no topic`);
    return {
      dataset: 'simpleqa',
      id: `simpleqa-${i}`,
      question: parsed.data.problem,
      answer: parsed.data.answer,
      topic,
      answerType: pyField(parsed.data.metadata, 'answer_type') ?? 'unknown',
    };
  });
}

// ── FreshQA ──

export type FactType = 'never-changing' | 'slow-changing' | 'fast-changing';

export interface FreshQaItem {
  dataset: 'freshqa';
  id: string;
  /** FreshQA's own split. */
  split: 'TEST' | 'DEV';
  question: string;
  /** Every acceptable answer (answer_0 to answer_9, blanks removed), in file order. */
  answers: string[];
  falsePremise: boolean;
  factType: FactType;
  numHops: string;
  effectiveYear: string;
  /** When the maintainers planned to review the answer: a MM/DD/YYYY date or a word such as "occasionally". */
  nextReview: string;
}

const freshQaRow = z.object({
  id: z.string().regex(/^\d+$/),
  split: z.enum(['TEST', 'DEV']),
  question: z.string().min(1),
  effective_year: z.string(),
  next_review: z.string(),
  false_premise: z.enum(['TRUE', 'FALSE']),
  num_hops: z.string(),
  fact_type: z.enum(['never-changing', 'slow-changing', 'fast-changing']),
  source: z.string(),
  answer_0: z.string().min(1),
  answer_1: z.string(),
  answer_2: z.string(),
  answer_3: z.string(),
  answer_4: z.string(),
  answer_5: z.string(),
  answer_6: z.string(),
  answer_7: z.string(),
  answer_8: z.string(),
  answer_9: z.string(),
  note: z.string(),
});

export function parseFreshQa(text: string): FreshQaItem[] {
  const rows = parseCsv(text);
  // The published sheet carries a warning line and a blank line before the header.
  const headerIndex = rows.findIndex((r) => r[0] === 'id' && r[1] === 'split');
  if (headerIndex < 0) throw new Error('FreshQA: header row (id,split,...) not found');
  return recordsWithHeader(rows, headerIndex).map((raw, i) => {
    const parsed = freshQaRow.safeParse(raw);
    if (!parsed.success) throw new Error(`FreshQA row ${i}: ${parsed.error.message}`);
    const r = parsed.data;
    const answers = [
      r.answer_0,
      r.answer_1,
      r.answer_2,
      r.answer_3,
      r.answer_4,
      r.answer_5,
      r.answer_6,
      r.answer_7,
      r.answer_8,
      r.answer_9,
    ]
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    return {
      dataset: 'freshqa',
      id: `freshqa-${r.id}`,
      split: r.split,
      question: r.question,
      answers,
      falsePremise: r.false_premise === 'TRUE',
      factType: r.fact_type,
      numHops: r.num_hops,
      effectiveYear: r.effective_year,
      nextReview: r.next_review,
    };
  });
}

// ── LongMemEval ──

export interface LongMemTurn {
  role: 'user' | 'assistant';
  content: string;
  hasAnswer: boolean;
}

export interface LongMemEvalItem {
  dataset: 'longmemeval';
  id: string;
  questionType: string;
  /** Question ids ending in `_abs` are unanswerable by design (abstention). */
  abstention: boolean;
  question: string;
  answer: string;
  /** UTC milliseconds of the question date. */
  questionAt: number;
  questionDate: string;
  sessions: Array<{ sessionId: string; at: number; date: string; turns: LongMemTurn[] }>;
  answerSessionIds: string[];
}

const LME_DATE = /^(\d{4})\/(\d{2})\/(\d{2}) \([A-Za-z]{3}\) (\d{2}):(\d{2})$/;

/** "2023/04/10 (Mon) 23:07" read as UTC (the dataset carries no zone; the harness runs everything in UTC). */
export function parseLongMemDate(value: string): number {
  const m = LME_DATE.exec(value);
  if (!m) throw new Error(`not a LongMemEval date: ${value}`);
  const [, y, mo, d, h, mi] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
}

const lmeTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  has_answer: z.boolean().optional(),
});

const lmeItem = z
  .object({
    question_id: z.string().min(1),
    question_type: z.string().min(1),
    question: z.string().min(1),
    answer: z.union([z.string(), z.number()]).transform((a) => String(a)),
    question_date: z.string().regex(LME_DATE),
    haystack_dates: z.array(z.string().regex(LME_DATE)),
    haystack_session_ids: z.array(z.string()),
    haystack_sessions: z.array(z.array(lmeTurn)),
    answer_session_ids: z.array(z.string()),
  })
  .refine(
    (x) =>
      x.haystack_dates.length === x.haystack_sessions.length &&
      x.haystack_session_ids.length === x.haystack_sessions.length,
    'haystack_dates, haystack_session_ids and haystack_sessions must have the same length',
  );

export function parseLongMemEval(json: unknown): LongMemEvalItem[] {
  const list = z.array(z.unknown()).parse(json);
  return list.map((raw, i) => {
    const parsed = lmeItem.safeParse(raw);
    if (!parsed.success) throw new Error(`LongMemEval item ${i}: ${parsed.error.message}`);
    const x = parsed.data;
    return {
      dataset: 'longmemeval',
      id: x.question_id,
      questionType: x.question_type,
      abstention: x.question_id.endsWith('_abs'),
      question: x.question,
      answer: x.answer,
      questionAt: parseLongMemDate(x.question_date),
      questionDate: x.question_date,
      sessions: x.haystack_sessions.map((turns, k) => ({
        sessionId: x.haystack_session_ids[k] ?? `session-${k}`,
        date: x.haystack_dates[k] ?? '',
        at: parseLongMemDate(x.haystack_dates[k] ?? ''),
        turns: turns.map((t) => ({
          role: t.role,
          content: t.content,
          hasAnswer: t.has_answer ?? false,
        })),
      })),
      answerSessionIds: x.answer_session_ids,
    };
  });
}

export type BenchItem = SimpleQaItem | FreshQaItem | LongMemEvalItem;

// ── files ──

export const DATA_FILES: Record<DatasetName, string> = {
  simpleqa: 'data/benchmarks/simpleqa/simple_qa_test_set.csv',
  freshqa: 'data/benchmarks/freshqa/freshqa_2026-04-21.csv',
  longmemeval: 'data/benchmarks/longmemeval/longmemeval_oracle.json',
};

export function loadDataset(name: DatasetName, file: string = DATA_FILES[name]): BenchItem[] {
  if (!fs.existsSync(file)) {
    throw new Error(`${file} is missing: run "npm run bench -- download" first`);
  }
  const text = fs.readFileSync(file, 'utf8');
  switch (name) {
    case 'simpleqa':
      return parseSimpleQa(text);
    case 'freshqa':
      return parseFreshQa(text);
    case 'longmemeval':
      return parseLongMemEval(JSON.parse(text) as unknown);
  }
}

/** The text a grader compares against, per dataset (FreshQA lists every accepted answer). */
export function goldAnswer(item: BenchItem): string {
  switch (item.dataset) {
    case 'simpleqa':
      return item.answer;
    case 'freshqa':
      return item.answers.join(' | ');
    case 'longmemeval':
      return item.answer;
  }
}

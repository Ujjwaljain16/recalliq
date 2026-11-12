import type { TurnAnalysis } from '../../shared/understanding.js';

/** Identifies the fixed prompt set, so a recorded run says exactly which cases it used. */
export const BENCH_SET_ID = 'bench-set-1';

/** Every case is synthetic: invented company names and messages, nothing from a real user. [SYNTHETIC] */
export interface ExtractionCase {
  kind: 'extraction';
  id: string;
  userMessage: string;
  /** Checks on the validated analysis. Each returns a short failure label or null when it holds. */
  checks: Array<(a: TurnAnalysis) => string | null>;
}

export interface JudgeCase {
  kind: 'judge';
  id: string;
  sentence: string;
  facts: string[];
  expected: 'supported' | 'unsupported';
}

export interface SynthesisCase {
  kind: 'synthesis';
  id: string;
  userMessage: string;
}

export type BenchCase = ExtractionCase | JudgeCase | SynthesisCase;

const has =
  (label: string, ok: (a: TurnAnalysis) => boolean) =>
  (a: TurnAnalysis): string | null =>
    ok(a) ? null : label;

export const BENCH_CASES: BenchCase[] = [
  {
    kind: 'extraction',
    id: 'extract-weekday-audit',
    userMessage:
      '[SYNTHETIC] Last Tuesday you told me ExampleCo Pro was cheap. Is that still correct?',
    checks: [
      has('entity ExampleCo', (a) => a.entities.some((e) => e.normalized.includes('exampleco'))),
      has('weekday expression kept as data', (a) =>
        a.temporal.some((t) => t.expr.kind === 'weekday' && t.expr.weekday === 2),
      ),
      has('asksStillCorrect', (a) => a.asksStillCorrect),
    ],
  },
  {
    kind: 'extraction',
    id: 'extract-since-monday',
    userMessage:
      '[SYNTHETIC] Has anything changed for the Widgets and Gadgets vendors since Monday?',
    checks: [
      has('two entities', (a) => a.entities.length >= 2),
      has('since expression', (a) => a.temporal.some((t) => t.expr.kind === 'since')),
    ],
  },
  {
    kind: 'extraction',
    id: 'extract-fact-quote',
    userMessage: '[SYNTHETIC] We only have 20 seats, so shortlist ExampleCo and SampleSoft.',
    checks: [
      has('user fact with verbatim quote', (a) => a.userFacts.length > 0),
      has('no invented date', (a) => a.temporal.length === 0),
    ],
  },
  {
    kind: 'judge',
    id: 'judge-supported',
    sentence: 'ExampleCo is cheaper than SampleSoft.',
    facts: ['ExampleCo: 10 per user per month', 'SampleSoft: 15 per user per month'],
    expected: 'supported',
  },
  {
    kind: 'judge',
    id: 'judge-unsupported',
    sentence: 'ExampleCo is cheaper than SampleSoft.',
    facts: ['ExampleCo: 20 per user per month', 'SampleSoft: 15 per user per month'],
    expected: 'unsupported',
  },
  {
    kind: 'synthesis',
    id: 'synthesis-two-findings',
    userMessage: '[SYNTHETIC] What do ExampleCo and SampleSoft cost?',
  },
];

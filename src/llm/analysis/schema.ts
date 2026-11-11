import { z } from 'zod';
import type { TemporalExpression, TurnAnalysis } from '../../shared/understanding.js';

const weekday = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
]);

const simpleExpr = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('today') }),
  z.object({ kind: z.literal('yesterday') }),
  z.object({ kind: z.literal('days_ago'), n: z.number().int() }),
  z.object({
    kind: z.literal('weekday'),
    weekday,
    modifier: z.enum(['none', 'last', 'this']),
  }),
  z.object({
    kind: z.literal('calendar_date'),
    day: z.number().int(),
    month: z.number().int(),
    year: z.number().int().optional(),
  }),
  z.object({ kind: z.literal('last_week') }),
]);

const expr = z.discriminatedUnion('kind', [
  ...simpleExpr.options,
  z.object({ kind: z.literal('since'), anchor: simpleExpr }),
]);

const userFactData = z.object({
  kind: z.enum(['shortlist', 'constraint', 'preference', 'choice']),
  entities: z.array(z.string()).optional(),
  label: z.string().optional(),
  constraint: z
    .object({
      key: z.string(),
      value: z.union([z.string(), z.number()]),
      unit: z.string().optional(),
    })
    .optional(),
});

/**
 * What the model returns. Size caps (entities <= 8, queries <= 3, topicTerms <= 8, userFacts <= 5) are applied
 * by code after validation, not here, so an over-long list is trimmed instead of failing the whole analysis.
 * Range checks on temporal fields are also applied by code (invalid mentions are dropped).
 */
export const analysisModelSchema = z.object({
  laneHint: z.enum(['chat', 'recall', 'research', 'audit', 'clarify']),
  intents: z.array(z.enum(['pricing', 'releases', 'general'])),
  temporal: z.array(
    z.object({
      text: z.string(),
      expr,
      role: z.enum(['reference_conversation', 'change_since', 'event_time']),
    }),
  ),
  entities: z.array(
    z.object({
      text: z.string(),
      normalized: z.string(),
      officialDomainGuess: z.string().optional(),
    }),
  ),
  references: z.array(
    z.object({
      text: z.string(),
      kind: z.enum(['previous_answer', 'decision', 'conversation', 'entity_set']),
    }),
  ),
  topicTerms: z.array(z.string()),
  asksStillCorrect: z.boolean(),
  queries: z.array(z.string()),
  alternateQueries: z.array(z.string()),
  userFacts: z.array(
    z.object({
      kind: z.enum(['shortlist', 'constraint', 'preference', 'choice', 'correction']),
      quote: z.string(),
      data: userFactData,
      correctsDecisionKind: z.enum(['shortlist', 'constraint', 'preference', 'choice']).optional(),
    }),
  ),
});

export type AnalysisModelOutput = z.infer<typeof analysisModelSchema>;

export const ANALYSIS_CAPS = { entities: 8, queries: 3, topicTerms: 8, userFacts: 5 } as const;

function validExpression(e: TemporalExpression): boolean {
  switch (e.kind) {
    case 'days_ago':
      return e.n >= 1 && e.n <= 366;
    case 'calendar_date':
      return (
        e.day >= 1 &&
        e.day <= 31 &&
        e.month >= 1 &&
        e.month <= 12 &&
        (e.year === undefined || (e.year >= 1970 && e.year <= 2100))
      );
    case 'since':
      return validExpression(e.anchor);
    default:
      return true;
  }
}

const clean = (xs: string[], max: number): string[] =>
  [...new Set(xs.map((x) => x.trim()).filter((x) => x.length > 0))].slice(0, max);

/**
 * Turns validated model output into a TurnAnalysis: applies caps, drops temporal mentions whose numbers are out
 * of range, drops facts without a quote, normalises entities, and sets degraded = false.
 */
export function toTurnAnalysis(m: AnalysisModelOutput): TurnAnalysis {
  const seen = new Set<string>();
  const entities = m.entities
    .map((e) => ({
      ...e,
      text: e.text.trim(),
      normalized: e.normalized.trim().toLowerCase(),
    }))
    .filter((e) => {
      if (e.text === '' || e.normalized === '' || seen.has(e.normalized)) return false;
      seen.add(e.normalized);
      return true;
    })
    .slice(0, ANALYSIS_CAPS.entities);
  return {
    laneHint: m.laneHint,
    intents: [...new Set(m.intents)],
    temporal: m.temporal.filter((t) => t.text.trim() !== '' && validExpression(t.expr)),
    entities,
    references: m.references.filter((r) => r.text.trim() !== ''),
    topicTerms: clean(m.topicTerms, ANALYSIS_CAPS.topicTerms),
    asksStillCorrect: m.asksStillCorrect,
    queries: clean(m.queries, ANALYSIS_CAPS.queries),
    alternateQueries: clean(m.alternateQueries, ANALYSIS_CAPS.queries),
    userFacts: m.userFacts.filter((f) => f.quote.trim() !== '').slice(0, ANALYSIS_CAPS.userFacts),
    degraded: false,
  };
}

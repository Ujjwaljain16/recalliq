import type { Logger } from '../../shared/infrastructure.js';
import type { LlmPort } from '../../shared/llm.js';
import type { TurnBudget } from '../../shared/infrastructure.js';
import type { TurnAnalyzer } from '../../shared/pipeline.js';
import type { TurnAnalysis } from '../../shared/understanding.js';
import {
  ANALYSIS_PROMPT_VERSION,
  ANALYSIS_SCHEMA_NAME,
  ANALYSIS_SYSTEM,
  buildAnalysisMessages,
} from '../prompts/analysis.js';
import { analysisModelSchema, toTurnAnalysis } from './schema.js';

export const ANALYSIS_CAP_MS = 8000;
export const ANALYSIS_MAX_TOKENS = 1200;
const MAX_ATTEMPTS = 2;

export interface TurnAnalyzerDeps {
  llm: LlmPort;
  logger?: Logger;
}

type Input = Parameters<TurnAnalyzer['analyze']>[0];

const STILL_CORRECT =
  /\b(still (?:correct|true|right|accurate|valid)|double[- ]check|is that (?:still )?right)\b/i;
const STOP = new Set(
  'about above after again also been being between could does doing from have here into just like more most must only other over really should since some than that their them then there these they this those very want what when where which while will with would your'.split(
    ' ',
  ),
);

/**
 * The minimal analysis used when the model cannot be used. Deterministic and cheap: topic terms from the
 * message, a "still correct?" cue, nothing else. `laneHint` stays `chat`; routing falls back to the
 * orchestrator's own rules because `degraded` is true.
 */
export function degradedAnalysis(userMessage: string): TurnAnalysis {
  const terms = [
    ...new Set(
      (userMessage.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]{3,}/gu) ?? []).filter(
        (w) => !STOP.has(w),
      ),
    ),
  ].slice(0, 8);
  return {
    laneHint: 'chat',
    intents: ['general'],
    temporal: [],
    entities: [],
    references: [],
    topicTerms: terms,
    asksStillCorrect: STILL_CORRECT.test(userMessage),
    queries: [],
    alternateQueries: [],
    userFacts: [],
    degraded: true,
  };
}

/**
 * The `analysis` role. Structured output validated against a zod schema; temporal expressions are extracted as
 * data and never computed. Any failure of the model (unavailable, invalid output after repair, refusal,
 * deadline) returns the degraded analysis: this method does not throw for model failure.
 */
export class LlmTurnAnalyzer implements TurnAnalyzer {
  /** Exposed so recorded fixtures and benchmarks can state which prompt produced them. */
  readonly promptVersion = ANALYSIS_PROMPT_VERSION;

  constructor(private readonly deps: TurnAnalyzerDeps) {}

  async analyze(input: Input, budget: TurnBudget): Promise<TurnAnalysis> {
    const messages = buildAnalysisMessages(input);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (budget.timeoutFor('analysis', ANALYSIS_CAP_MS) <= 0) break;
      try {
        const result = await this.deps.llm.structured({
          role: 'analysis',
          system: ANALYSIS_SYSTEM,
          messages,
          schema: analysisModelSchema,
          schemaName: ANALYSIS_SCHEMA_NAME,
          maxTokens: ANALYSIS_MAX_TOKENS,
          signal: budget.signalFor('analysis', ANALYSIS_CAP_MS),
        });
        return this.finish(toTurnAnalysis(result.value), input.userMessage);
      } catch (e) {
        const code =
          e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : 'unknown';
        this.deps.logger?.warn(
          { code, attempt, promptVersion: ANALYSIS_PROMPT_VERSION },
          'analysis failed',
        );
        // A cancelled call, a refusal or a malformed request will not improve on a second try.
        if (code === 'cancelled' || code === 'refused' || code === 'bad_request') break;
      }
    }
    return degradedAnalysis(input.userMessage);
  }

  /** A user fact must quote the user's own message: that is what the persistence layer checks. */
  private finish(a: TurnAnalysis, userMessage: string): TurnAnalysis {
    return {
      ...a,
      queries: stripUnwrittenYears(a.queries, userMessage),
      alternateQueries: stripUnwrittenYears(a.alternateQueries, userMessage),
      userFacts: a.userFacts.filter((f) => userMessage.includes(f.quote)),
    };
  }
}

const YEAR = /\b(?:19|20)\d{2}\b/g;
const DANGLING = /\s+(?:in|for|of|during|from|since|by|until|as of)\s*$/i;

/**
 * The model's own idea of the current year (stale training knowledge) must not steer a search. A four-digit year
 * (19xx or 20xx) in a generated query stays only when the user's message contains that same year. What is left
 * is tidied (spacing, a trailing "in"), queries that become empty are dropped and duplicates collapse.
 */
export function stripUnwrittenYears(queries: string[], userMessage: string): string[] {
  const written = new Set(userMessage.match(YEAR) ?? []);
  const out = queries
    .map((q) =>
      q
        .replace(YEAR, (y) => (written.has(y) ? y : ' '))
        .replace(/\s{2,}/g, ' ')
        .trim()
        .replace(DANGLING, '')
        .replace(/[,;:(]+\s*$/, '')
        .trim(),
    )
    .filter((q) => q.length > 0);
  return [...new Set(out)];
}

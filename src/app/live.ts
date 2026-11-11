import type { ComponentFactory } from './components.js';

/**
 * INTEGRATION POINT: the single place where the real components are wired.
 *
 * Today none of the three real components exists in this codebase, so selecting `live` fails fast with a
 * message that names what is missing. It never falls back to the scripted set.
 *
 * To wire the real components, delete the entries of `MISSING_LIVE_COMPONENTS` as they arrive and return, from
 * `liveFactory`, a `Components` object (src/app/components.ts) built from:
 *
 *   analyzer   a TurnAnalyzer (src/shared/pipeline.ts), the `analysis` LLM role
 *   research   a ResearchService (src/shared/pipeline.ts): search, snapshots, extraction, verification, beliefs
 *   answer     an AnswerPipeline (src/shared/answer.ts): synthesis, placeholder rendering, T3a/T3b checks
 *   baselines  LoaderBaselineSource (src/app/store-adapters.ts), once the belief-key decoder exists
 *   memory     SqliteMemoryRetriever (src/app/memory-adapter.ts)
 *   window     MessageWindowReader (src/app/store-adapters.ts)
 *
 * The provider keys (ANTHROPIC_API_KEY, GEMINI_API_KEY, EXA_API_KEY) are available as `env.config.secrets`.
 */
export const MISSING_LIVE_COMPONENTS: readonly string[] = [
  'TurnAnalyzer (the analysis LLM role)',
  'ResearchService (search, extraction, verification, belief resolution)',
  'AnswerPipeline (synthesis, placeholder rendering, sentence verification)',
  'belief-key decoder (so BaselineSource.eligible can return audit baselines)',
];

export class LiveComponentsUnavailableError extends Error {
  constructor(public readonly missing: readonly string[]) {
    super(
      'APP_COMPONENTS=live was requested, but these real components are not available yet:\n' +
        missing.map((m) => `  - ${m}`).join('\n') +
        '\nNot falling back to scripted components. Set APP_COMPONENTS=scripted for the demo set.',
    );
    this.name = 'LiveComponentsUnavailableError';
  }
}

export function liveFactory(): ComponentFactory {
  if (MISSING_LIVE_COMPONENTS.length > 0) {
    throw new LiveComponentsUnavailableError(MISSING_LIVE_COMPONENTS);
  }
  throw new Error('live component wiring is missing: see src/app/live.ts');
}

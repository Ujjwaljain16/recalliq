import type { LlmRole } from '../shared/llm.js';

/** Which configured model serves a role. Names of models are never hard-coded here: they are injected. */
export type LlmTier = 'fast' | 'main';

export interface TierConfig {
  /** Model identifier, from MODEL_FAST / MODEL_MAIN (src/config). */
  model: string;
  /**
   * `thinking.type` sent with the request, or undefined to omit the field (the provider's default applies).
   * Which values a given model accepts is provider-specific; see src/llm/anthropic/wire.ts.
   */
  thinking?: 'disabled' | 'between_tools' | 'adaptive';
  /** `output_config.effort`, or undefined to omit it. */
  effort?: 'low' | 'medium' | 'high';
}

export interface AnthropicAdapterConfig {
  /** Never logged, never included in an error message. */
  apiKey: string;
  /** Default https://api.anthropic.com. No trailing slash needed. */
  baseUrl?: string;
  tiers: Record<LlmTier, TierConfig>;
  /** Overrides of DEFAULT_ROLE_TIER. */
  roleTier?: Partial<Record<LlmRole, LlmTier>>;
  /** Extra attempts after an output that fails validation. Default 1 (so at most 2 provider calls). */
  maxRepairs?: number;
}

/**
 * Provisional role mapping (ADR-14, Proposed): analysis, extraction and the judge on the fast tier, synthesis
 * on the main tier. Extraction is the one the benchmark is meant to decide, so it is a plain override away.
 */
export const DEFAULT_ROLE_TIER: Record<LlmRole, LlmTier> = {
  analysis: 'fast',
  extraction: 'fast',
  judge: 'fast',
  synthesis: 'main',
};

/**
 * Builds adapter configuration from the two model names in AppConfig.models. Thinking and effort follow the
 * architecture (fast tier: thinking disabled; main tier: effort "low").
 */
export function anthropicConfigFromModels(
  models: { fast: string; main: string },
  apiKey: string,
  overrides: Partial<Omit<AnthropicAdapterConfig, 'apiKey' | 'tiers'>> = {},
): AnthropicAdapterConfig {
  return {
    apiKey,
    tiers: {
      fast: { model: models.fast, thinking: 'disabled' },
      main: { model: models.main, effort: 'low' },
    },
    ...overrides,
  };
}

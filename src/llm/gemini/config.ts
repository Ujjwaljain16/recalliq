import type { GeminiAdapterConfig } from './adapter.js';

/** The parts of AppConfig the Gemini adapter needs (GEMINI_API_KEY, GEMINI_MODEL). */
export interface GeminiAppSettings {
  gemini: { model: string | undefined };
  secrets: { geminiApiKey: string | undefined };
}

/**
 * Builds adapter configuration from application settings. Throws (naming the variable, never a value) when
 * the key or the model is missing: provider choice is explicit and there is no default model.
 * Defaults are conservative and unmeasured: 20 s per attempt, two retries.
 */
export function geminiConfigFromApp(
  app: GeminiAppSettings,
  overrides: Partial<Omit<GeminiAdapterConfig, 'apiKey' | 'model'>> = {},
): GeminiAdapterConfig {
  const apiKey = app.secrets.geminiApiKey;
  const model = app.gemini.model;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  if (!model) throw new Error('GEMINI_MODEL is not set');
  return { apiKey, model, requestTimeoutMs: 20_000, maxRetries: 2, ...overrides };
}

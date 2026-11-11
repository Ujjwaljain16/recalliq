import path from 'node:path';
import { z } from 'zod';

/**
 * The model used when GEMINI_MODEL is unset, so a reviewer only has to supply keys. It is a choice, not a
 * measurement: compare models with the benchmark harness before changing it.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';

/**
 * The model asked once when the main model is rate limited, overloaded or too slow (GEMINI_FALLBACK_MODEL;
 * "none" turns it off). A lighter model, because free-tier limits are per model.
 */
export const DEFAULT_GEMINI_FALLBACK_MODEL = 'gemini-3.5-flash-lite';

export type AppMode = 'real' | 'demo';

export interface AppConfig {
  mode: AppMode;
  /** Absolute path of the SQLite file for this mode. */
  dbPath: string;
  port: number;
  /** ALLOWED_ORIGIN: the one cross-origin origin allowed to call the API. Unset by default: no CORS at all. */
  allowedOrigin: string | undefined;
  models: { fast: string; main: string };
  /** Gemini model id for the Gemini adapter (GEMINI_MODEL); DEFAULT_GEMINI_MODEL when unset. */
  gemini: { model: string | undefined; fallbackModel: string | undefined };
  /**
   * Secrets are optional at this layer: the database tooling needs none of them.
   * The composition root of the research pipeline asserts the ones it uses are present.
   */
  secrets: {
    anthropicApiKey: string | undefined;
    geminiApiKey: string | undefined;
    exaApiKey: string | undefined;
    sessionSecret: string | undefined;
  };
}

/** Raised for any invalid configuration. The message names variables, never their values. */
export class ConfigError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

// An empty string in .env (e.g. `EXA_API_KEY=`) means "not set".
const blankToUndefined = (v: unknown): unknown => (v === '' ? undefined : v);
const optionalString = z.preprocess(blankToUndefined, z.string().min(1).optional());

const envSchema = z.object({
  APP_MODE: z.preprocess(blankToUndefined, z.enum(['real', 'demo']).default('real')),
  DB_PATH: optionalString,
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(3001)),
  ALLOWED_ORIGIN: z.preprocess(blankToUndefined, z.url().optional()),
  MODEL_FAST: z.preprocess(blankToUndefined, z.string().min(1).default('claude-haiku-5-5')),
  MODEL_MAIN: z.preprocess(blankToUndefined, z.string().min(1).default('claude-sonnet-5-5')),
  ANTHROPIC_API_KEY: optionalString,
  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: optionalString,
  GEMINI_FALLBACK_MODEL: optionalString,
  EXA_API_KEY: optionalString,
  // Signs the anonymous user cookie, so a short value is a security defect rather than a typo.
  SESSION_SECRET: z.preprocess(blankToUndefined, z.string().min(32).optional()),
});

const DEFAULT_DB_FILE: Record<AppMode, string> = {
  real: path.join('data', 'app.db'),
  demo: path.join('data', 'demo.db'),
};

/**
 * Validates `env` and returns typed configuration. Pure: reads nothing from the process,
 * so tests can pass any environment.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // `issue.message` from zod does not echo the offending value, so secrets cannot leak here.
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const mode = e.APP_MODE;
  return {
    mode,
    dbPath: path.resolve(e.DB_PATH ?? DEFAULT_DB_FILE[mode]),
    port: e.PORT,
    allowedOrigin: e.ALLOWED_ORIGIN,
    models: { fast: e.MODEL_FAST, main: e.MODEL_MAIN },
    gemini: {
      model: e.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
      fallbackModel: fallbackModelOf(
        e.GEMINI_FALLBACK_MODEL,
        e.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
      ),
    },
    secrets: {
      anthropicApiKey: e.ANTHROPIC_API_KEY,
      geminiApiKey: e.GEMINI_API_KEY,
      exaApiKey: e.EXA_API_KEY,
      sessionSecret: e.SESSION_SECRET,
    },
  };
}

/** The fallback model, or undefined when it is off ("none") or the same as the main model. */
function fallbackModelOf(raw: string | undefined, main: string): string | undefined {
  const m = raw ?? DEFAULT_GEMINI_FALLBACK_MODEL;
  return m.toLowerCase() === 'none' || m === main ? undefined : m;
}

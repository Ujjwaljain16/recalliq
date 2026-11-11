import { randomBytes } from 'node:crypto';
import { ConfigError, loadConfig, type AppConfig } from '../config/env.js';
import type { ComponentKind } from './components.js';

/** Everything the server process needs from the environment, validated. Secrets are never echoed in errors. */
export interface AppEnv {
  config: AppConfig;
  components: ComponentKind;
  host: string;
  production: boolean;
  /** The cookie signing secret: SESSION_SECRET, or a random one generated for this process (development only). */
  sessionSecret: string;
  sessionSecretEphemeral: boolean;
  /** How long a shutdown waits for running turns to persist. */
  shutdownGraceMs: number;
  /** Pause between scripted deltas so a person can watch the stream. */
  scriptedPaceMs: number;
  /** REPLAY_FIXTURE: path of the replay fixture file (replay set only). */
  replayFixture: string | undefined;
  /** OFFICIAL_DOMAINS_FILE: the owner's registry of official domains. Optional; none ships and none is assumed. */
  officialDomainsFile: string | undefined;
}

function blank(v: string | undefined): string | undefined {
  return v === undefined || v === '' ? undefined : v;
}

function intInRange(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
  fallback: number,
  problems: string[],
): number {
  const value = blank(raw);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name}: must be an integer from ${min} to ${max}`);
    return fallback;
  }
  return n;
}

/**
 * Validates the whole environment: the shared configuration (src/config/env.ts) plus the settings of the
 * application surface. Every problem is reported at once, by variable name and rule, never by value.
 */
export function loadAppEnv(
  env: Readonly<Record<string, string | undefined>>,
  generateSecret: () => string = () => randomBytes(32).toString('hex'),
): AppEnv {
  const problems: string[] = [];
  let config: AppConfig | undefined;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // Each problem already starts with its variable name; keep them verbatim.
    problems.push(...error.problems);
  }

  const providerKeys = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'EXA_API_KEY'].some(
    (k) => blank(env[k]) !== undefined,
  );
  const requested = blank(env['APP_COMPONENTS']);
  let components: ComponentKind = providerKeys ? 'live' : 'scripted';
  if (requested !== undefined) {
    if (requested === 'scripted' || requested === 'replay' || requested === 'live')
      components = requested;
    else problems.push('APP_COMPONENTS: must be "scripted", "replay" or "live"');
  }

  const host = blank(env['HOST']) ?? '127.0.0.1';
  if (!/^[A-Za-z0-9.:-]{1,253}$/.test(host)) problems.push('HOST: must be a host name or address');

  const production = env['NODE_ENV'] === 'production';
  let sessionSecret = config?.secrets.sessionSecret;
  const ephemeral = sessionSecret === undefined;
  if (ephemeral && production) {
    problems.push('SESSION_SECRET: required (at least 32 characters) when NODE_ENV=production');
  }

  const shutdownGraceMs = intInRange(
    env['SHUTDOWN_GRACE_MS'],
    'SHUTDOWN_GRACE_MS',
    0,
    600_000,
    15_000,
    problems,
  );
  const scriptedPaceMs = intInRange(
    env['SCRIPTED_PACE_MS'],
    'SCRIPTED_PACE_MS',
    0,
    2_000,
    120,
    problems,
  );

  if (problems.length > 0 || config === undefined) throw new ConfigError(problems);
  sessionSecret ??= generateSecret();
  return {
    config,
    components,
    host,
    production,
    sessionSecret,
    sessionSecretEphemeral: ephemeral,
    shutdownGraceMs,
    scriptedPaceMs,
    replayFixture: blank(env['REPLAY_FIXTURE']),
    officialDomainsFile: blank(env['OFFICIAL_DOMAINS_FILE']),
  };
}

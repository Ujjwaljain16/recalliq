import { DEFAULT_LIMITER } from '../llm/limiter.js';
import { randomBytes } from 'node:crypto';
import { ConfigError, loadConfig, type AppConfig } from '../config/env.js';
import { DEFAULT_SERVER_LIMITS, type ServerLimits } from '../server/limits.js';
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
  /** The client-side Gemini limiter (GEMINI_MAX_CONCURRENT, GEMINI_MIN_SPACING_MS); free-tier-safe defaults. */
  geminiLimiter: { maxConcurrent: number; minSpacingMs: number };
  /** The client-side Exa limiter (EXA_MAX_CONCURRENT); no spacing between starts. */
  exaLimiter: { maxConcurrent: number; minSpacingMs: number };
  /** Request quotas and node:http limits of the server. */
  limits: ServerLimits;
  /** Startup warnings to log (for example a non-loopback HOST). Never contain secret values. */
  warnings: string[];
  /** REPLAY_FIXTURE: path of the replay fixture file (replay set only). */
  replayFixture: string | undefined;
  /** OFFICIAL_DOMAINS_FILE: the owner's registry of official domains. Optional; none ships and none is assumed. */
  officialDomainsFile: string | undefined;
}

function blank(v: string | undefined): string | undefined {
  return v === undefined || v === '' ? undefined : v;
}

/** True for an address or name that only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

export const DEFAULT_EXA_MAX_CONCURRENT = 4;

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
  const warnings: string[] = [];
  if (!isLoopbackHost(host)) {
    // Another machine can reach a non-loopback address, and the session cookie is then the only barrier
    // between it and the owner's provider keys: allow it only for a deliberate production deployment.
    if (!production || ephemeral) {
      problems.push(
        'HOST: a non-loopback address is refused unless NODE_ENV=production and SESSION_SECRET is set',
      );
    } else {
      warnings.push(
        'HOST is not a loopback address: the server is reachable from other machines. Put it behind TLS and ' +
          'set ALLOWED_ORIGIN to the public origin.',
      );
    }
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

  const geminiLimiter = {
    maxConcurrent: intInRange(
      env['GEMINI_MAX_CONCURRENT'],
      'GEMINI_MAX_CONCURRENT',
      1,
      16,
      DEFAULT_LIMITER.maxConcurrent,
      problems,
    ),
    minSpacingMs: intInRange(
      env['GEMINI_MIN_SPACING_MS'],
      'GEMINI_MIN_SPACING_MS',
      0,
      60_000,
      DEFAULT_LIMITER.minSpacingMs,
      problems,
    ),
  };

  const exaLimiter = {
    maxConcurrent: intInRange(
      env['EXA_MAX_CONCURRENT'],
      'EXA_MAX_CONCURRENT',
      1,
      32,
      DEFAULT_EXA_MAX_CONCURRENT,
      problems,
    ),
    minSpacingMs: 0,
  };

  const d = DEFAULT_SERVER_LIMITS;
  const int = (name: string, min: number, max: number, fallback: number): number =>
    intInRange(env[name], name, min, max, fallback, problems);
  const limits: ServerLimits = {
    maxRunningTurnsPerUser: int('MAX_RUNNING_TURNS_PER_USER', 1, 50, d.maxRunningTurnsPerUser),
    turnsPerMinute: int('TURN_RATE_PER_MINUTE', 1, 1_000, d.turnsPerMinute),
    turnBurst: int('TURN_RATE_BURST', 1, 1_000, d.turnBurst),
    newSessionsPerHour: int('NEW_SESSIONS_PER_HOUR', 1, 100_000, d.newSessionsPerHour),
    maxConnections: int('SERVER_MAX_CONNECTIONS', 1, 100_000, d.maxConnections),
    headersTimeoutMs: int('SERVER_HEADERS_TIMEOUT_MS', 1_000, 600_000, d.headersTimeoutMs),
    requestTimeoutMs: int('SERVER_REQUEST_TIMEOUT_MS', 1_000, 600_000, d.requestTimeoutMs),
  };
  if (limits.headersTimeoutMs > limits.requestTimeoutMs) {
    problems.push('SERVER_HEADERS_TIMEOUT_MS: must not exceed SERVER_REQUEST_TIMEOUT_MS');
  }

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
    geminiLimiter,
    exaLimiter,
    limits,
    warnings,
    replayFixture: blank(env['REPLAY_FIXTURE']),
    officialDomainsFile: blank(env['OFFICIAL_DOMAINS_FILE']),
  };
}

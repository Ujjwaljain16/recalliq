import { DEFAULT_LIMITER } from '../../../src/llm/limiter.js';
import { describe, expect, it } from 'vitest';
import { LiveConfigurationError, liveFactory } from '../../../src/app/live.js';
import { isLoopbackHost, loadAppEnv } from '../../../src/app/env.js';
import { DEFAULT_SERVER_LIMITS } from '../../../src/server/limits.js';
import { ConfigError } from '../../../src/config/env.js';

const SECRET = 's'.repeat(40);

function problems(env: Record<string, string>): string[] {
  try {
    loadAppEnv(env);
  } catch (e) {
    if (e instanceof ConfigError) return [...e.problems];
    throw e;
  }
  return [];
}

describe('application environment', () => {
  it('defaults to scripted components, localhost and a generated development secret', () => {
    const env = loadAppEnv({}, () => 'generated');
    expect(env.components).toBe('scripted');
    expect(env.host).toBe('127.0.0.1');
    expect(env.sessionSecret).toBe('generated');
    expect(env.sessionSecretEphemeral).toBe(true);
  });

  it('uses SESSION_SECRET when given', () => {
    const env = loadAppEnv({ SESSION_SECRET: SECRET });
    expect(env.sessionSecret).toBe(SECRET);
    expect(env.sessionSecretEphemeral).toBe(false);
  });

  it('defaults to live when a provider key is present, and honours an explicit choice', () => {
    expect(loadAppEnv({ EXA_API_KEY: 'k' }).components).toBe('live');
    expect(loadAppEnv({ EXA_API_KEY: 'k', APP_COMPONENTS: 'scripted' }).components).toBe(
      'scripted',
    );
    expect(loadAppEnv({ APP_COMPONENTS: 'live' }).components).toBe('live');
  });

  it('reports every problem by variable name and never echoes a value', () => {
    const list = problems({
      APP_COMPONENTS: 'bogus-value',
      SESSION_SECRET: 'short-secret-value',
      PORT: 'not-a-port',
      SHUTDOWN_GRACE_MS: '-5',
    });
    const text = list.join('\n');
    expect(text).toContain('APP_COMPONENTS');
    expect(text).toContain('SESSION_SECRET');
    expect(text).toContain('PORT');
    expect(text).toContain('SHUTDOWN_GRACE_MS');
    for (const value of ['bogus-value', 'short-secret-value', 'not-a-port']) {
      expect(text).not.toContain(value);
    }
  });

  it('requires a session secret in production', () => {
    expect(problems({ NODE_ENV: 'production' }).join()).toContain('SESSION_SECRET');
    expect(problems({ NODE_ENV: 'production', SESSION_SECRET: SECRET })).toEqual([]);
  });

  it('selects the demo or real database exactly as the shared configuration does', () => {
    expect(loadAppEnv({ APP_MODE: 'demo' }).config.dbPath).toMatch(/demo\.db$/);
    expect(loadAppEnv({}).config.dbPath).toMatch(/app\.db$/);
  });
});

describe('live component selection', () => {
  it('fails fast, naming each missing variable, and never falls back', () => {
    const env = loadAppEnv({ APP_COMPONENTS: 'live' });
    expect(() => liveFactory(env)).toThrow(LiveConfigurationError);
    try {
      liveFactory(env);
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('GEMINI_API_KEY');
      expect(message).not.toContain('GEMINI_MODEL');
      expect(message).toContain('EXA_API_KEY');
      expect(message).toContain('Not falling back');
    }
  });
});

describe('Gemini pacing', () => {
  it('defaults to the free-tier-safe limiter and accepts overrides within range', () => {
    expect(loadAppEnv({}).geminiLimiter).toEqual(DEFAULT_LIMITER);
    expect(
      loadAppEnv({ GEMINI_MAX_CONCURRENT: '4', GEMINI_MIN_SPACING_MS: '0' }).geminiLimiter,
    ).toEqual({ maxConcurrent: 4, minSpacingMs: 0 });
    expect(() => loadAppEnv({ GEMINI_MAX_CONCURRENT: '0' })).toThrow(/GEMINI_MAX_CONCURRENT/);
    expect(() => loadAppEnv({ GEMINI_MIN_SPACING_MS: '-1' })).toThrow(/GEMINI_MIN_SPACING_MS/);
  });
});

describe('quotas and server limits', () => {
  it('defaults to the documented limits', () => {
    const env = loadAppEnv({});
    expect(env.limits).toEqual(DEFAULT_SERVER_LIMITS);
    expect(env.limits).toMatchObject({
      maxRunningTurnsPerUser: 2,
      turnsPerMinute: 10,
      turnBurst: 5,
      newSessionsPerHour: 20,
    });
    expect(env.exaLimiter).toEqual({ maxConcurrent: 4, minSpacingMs: 0 });
  });

  it('accepts overrides within range and names each variable out of range', () => {
    const env = loadAppEnv({
      MAX_RUNNING_TURNS_PER_USER: '3',
      TURN_RATE_PER_MINUTE: '30',
      TURN_RATE_BURST: '10',
      NEW_SESSIONS_PER_HOUR: '100',
      EXA_MAX_CONCURRENT: '8',
      SERVER_MAX_CONNECTIONS: '1000',
      SERVER_HEADERS_TIMEOUT_MS: '5000',
      SERVER_REQUEST_TIMEOUT_MS: '60000',
    });
    expect(env.limits).toEqual({
      maxRunningTurnsPerUser: 3,
      turnsPerMinute: 30,
      turnBurst: 10,
      newSessionsPerHour: 100,
      maxConnections: 1000,
      headersTimeoutMs: 5000,
      requestTimeoutMs: 60000,
    });
    expect(env.exaLimiter.maxConcurrent).toBe(8);
    const list = problems({
      MAX_RUNNING_TURNS_PER_USER: '0',
      TURN_RATE_PER_MINUTE: '1.5',
      TURN_RATE_BURST: 'many',
      NEW_SESSIONS_PER_HOUR: '-1',
      EXA_MAX_CONCURRENT: '33',
      SERVER_MAX_CONNECTIONS: '0',
      SERVER_HEADERS_TIMEOUT_MS: '10',
      SERVER_REQUEST_TIMEOUT_MS: '9999999',
    }).join('\n');
    for (const name of [
      'MAX_RUNNING_TURNS_PER_USER',
      'TURN_RATE_PER_MINUTE',
      'TURN_RATE_BURST',
      'NEW_SESSIONS_PER_HOUR',
      'EXA_MAX_CONCURRENT',
      'SERVER_MAX_CONNECTIONS',
      'SERVER_HEADERS_TIMEOUT_MS',
      'SERVER_REQUEST_TIMEOUT_MS',
    ]) {
      expect(list, name).toContain(name);
    }
    expect(
      problems({ SERVER_HEADERS_TIMEOUT_MS: '40000', SERVER_REQUEST_TIMEOUT_MS: '30000' }).join(),
    ).toContain('must not exceed SERVER_REQUEST_TIMEOUT_MS');
  });
});

describe('listening address', () => {
  it('accepts loopback addresses without a warning', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', '::1']) {
      expect(loadAppEnv({ HOST: host }).warnings, host).toEqual([]);
    }
  });

  it('refuses a non-loopback HOST unless NODE_ENV=production and SESSION_SECRET are set', () => {
    for (const host of ['0.0.0.0', '192.168.1.20', 'my-box.lan', '::']) {
      const dev = problems({ HOST: host, SESSION_SECRET: SECRET }).join();
      expect(dev, host).toContain('HOST');
      expect(dev).toContain('NODE_ENV=production');
      expect(dev).toContain('SESSION_SECRET');
    }
    expect(problems({ HOST: '0.0.0.0', NODE_ENV: 'production' }).join()).toMatch(
      /HOST: a non-loopback address is refused/,
    );
  });

  it('allows a non-loopback HOST in production with a secret, and warns', () => {
    const env = loadAppEnv({ HOST: '0.0.0.0', NODE_ENV: 'production', SESSION_SECRET: SECRET });
    expect(env.host).toBe('0.0.0.0');
    expect(env.warnings.join()).toContain('not a loopback address');
  });

  it('recognises loopback names exactly', () => {
    expect(isLoopbackHost('127.255.0.1')).toBe(true);
    expect(isLoopbackHost('localhost.evil.example')).toBe(false);
    expect(isLoopbackHost('1127.0.0.1')).toBe(false);
  });
});

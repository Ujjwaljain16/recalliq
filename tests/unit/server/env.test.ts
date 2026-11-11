import { describe, expect, it } from 'vitest';
import { LiveConfigurationError, liveFactory } from '../../../src/app/live.js';
import { loadAppEnv } from '../../../src/app/env.js';
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

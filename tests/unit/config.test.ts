import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_GEMINI_MODEL, loadConfig } from '../../src/config/env.js';

describe('loadConfig', () => {
  it('uses safe defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(config.mode).toBe('real');
    expect(config.dbPath).toBe(path.resolve('data', 'app.db'));
    expect(config.port).toBe(3001);
    expect(config.secrets).toEqual({
      geminiApiKey: undefined,
      exaApiKey: undefined,
      sessionSecret: undefined,
    });
  });

  it('reads the Gemini key and model, and treats blanks as unset', () => {
    const set = loadConfig({ GEMINI_API_KEY: 'g-key', GEMINI_MODEL: 'some-free-model' });
    expect(set.secrets.geminiApiKey).toBe('g-key');
    expect(set.gemini.model).toBe('some-free-model');
    const blank = loadConfig({ GEMINI_API_KEY: '', GEMINI_MODEL: '' });
    expect(blank.secrets.geminiApiKey).toBeUndefined();
    // A blank model falls back to the default, so only keys are required.
    expect(blank.gemini.model).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('demo mode defaults to a different database file than real mode', () => {
    expect(loadConfig({ APP_MODE: 'demo' }).dbPath).toBe(path.resolve('data', 'demo.db'));
    expect(loadConfig({ APP_MODE: 'demo' }).dbPath).not.toBe(loadConfig({}).dbPath);
  });

  it('honours an explicit DB_PATH', () => {
    expect(loadConfig({ DB_PATH: 'somewhere/else.db' }).dbPath).toBe(
      path.resolve('somewhere/else.db'),
    );
  });

  it('treats blank values from an .env file as unset', () => {
    const config = loadConfig({ EXA_API_KEY: '', SESSION_SECRET: '', APP_MODE: '', PORT: '' });
    expect(config.secrets.exaApiKey).toBeUndefined();
    expect(config.secrets.sessionSecret).toBeUndefined();
    expect(config.mode).toBe('real');
    expect(config.port).toBe(3001);
  });

  it('rejects an unknown APP_MODE, naming the variable', () => {
    expect(() => loadConfig({ APP_MODE: 'staging' })).toThrow(ConfigError);
    expect(() => loadConfig({ APP_MODE: 'staging' })).toThrow(/APP_MODE/);
  });

  it('rejects an out-of-range or non-numeric PORT', () => {
    expect(() => loadConfig({ PORT: '0' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
  });

  it('leaves ALLOWED_ORIGIN unset by default, so no cross-origin access is allowed', () => {
    expect(loadConfig({}).allowedOrigin).toBeUndefined();
    expect(loadConfig({ ALLOWED_ORIGIN: '' }).allowedOrigin).toBeUndefined();
    expect(loadConfig({ ALLOWED_ORIGIN: 'https://app.example' }).allowedOrigin).toBe(
      'https://app.example',
    );
  });

  it('rejects a malformed ALLOWED_ORIGIN', () => {
    expect(() => loadConfig({ ALLOWED_ORIGIN: 'not a url' })).toThrow(/ALLOWED_ORIGIN/);
  });

  it('rejects a short SESSION_SECRET without echoing it', () => {
    const secret = 'short-secret-value';
    let message = '';
    try {
      loadConfig({ SESSION_SECRET: secret });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toMatch(/SESSION_SECRET/);
    expect(message).not.toContain(secret);
  });

  it('reports every problem at once', () => {
    let problems: readonly string[] = [];
    try {
      loadConfig({ APP_MODE: 'nope', PORT: 'x' });
    } catch (error) {
      if (error instanceof ConfigError) problems = error.problems;
    }
    expect(problems.length).toBe(2);
  });

  it('accepts a valid SESSION_SECRET and API keys', () => {
    const config = loadConfig({
      SESSION_SECRET: 'x'.repeat(32),
      GEMINI_API_KEY: 'k1',
      EXA_API_KEY: 'k2',
    });
    expect(config.secrets.sessionSecret).toHaveLength(32);
    expect(config.secrets.geminiApiKey).toBe('k1');
    expect(config.secrets.exaApiKey).toBe('k2');
  });
});

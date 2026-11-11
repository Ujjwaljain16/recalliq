import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadAppEnv } from '../../../src/app/env.js';

/** The variables of `.env.example`, whether active (`KEY=value`) or commented out (`# KEY=value`). */
function exampleVariables(): { active: Record<string, string>; all: Set<string> } {
  const active: Record<string, string> = {};
  const all = new Set<string>();
  for (const line of fs.readFileSync('.env.example', 'utf8').split('\n')) {
    const m = /^(#\s*)?([A-Z][A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    all.add(m[2] as string);
    if (!m[1]) active[m[2] as string] = m[3] as string;
  }
  return { active, all };
}

describe('.env.example', () => {
  it('loads as it is, and starts the scripted set (no secrets are needed)', () => {
    const env = loadAppEnv(exampleVariables().active);
    expect(env.components).toBe('scripted');
  });

  it('lists every variable the application reads', () => {
    const { all } = exampleVariables();
    for (const name of [
      'APP_COMPONENTS',
      'APP_MODE',
      'DB_PATH',
      'REPLAY_FIXTURE',
      'HOST',
      'PORT',
      'ALLOWED_ORIGIN',
      'SESSION_SECRET',
      'NODE_ENV',
      'SHUTDOWN_GRACE_MS',
      'SCRIPTED_PACE_MS',
      'GEMINI_API_KEY',
      'GEMINI_MODEL',
      'EXA_API_KEY',
      'EXA_MAX_CONCURRENT',
      'GEMINI_MAX_CONCURRENT',
      'GEMINI_MIN_SPACING_MS',
      'MAX_RUNNING_TURNS_PER_USER',
      'TURN_RATE_PER_MINUTE',
      'TURN_RATE_BURST',
      'NEW_SESSIONS_PER_HOUR',
      'SERVER_MAX_CONNECTIONS',
      'SERVER_HEADERS_TIMEOUT_MS',
      'SERVER_REQUEST_TIMEOUT_MS',
      'OFFICIAL_DOMAINS_FILE',
      'MODEL_FAST',
      'MODEL_MAIN',
      'ANTHROPIC_API_KEY',
    ]) {
      expect(all.has(name), name).toBe(true);
    }
  });

  it('contains no secret values', () => {
    const { active } = exampleVariables();
    for (const name of ['SESSION_SECRET', 'GEMINI_API_KEY', 'EXA_API_KEY', 'ANTHROPIC_API_KEY']) {
      expect(active[name] ?? '', name).toBe('');
    }
    expect(fs.readFileSync('.env.example', 'utf8')).not.toMatch(
      /AIza|sk-[A-Za-z0-9]{10,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });
});

describe('.env.example and the code agree', () => {
  it('lists every variable src/app/env.ts and src/config/env.ts read', () => {
    const { all } = exampleVariables();
    const read = new Set<string>();
    for (const file of ['src/app/env.ts', 'src/config/env.ts']) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(
        /(?:env\[|int\()'([A-Z][A-Z0-9_]+)'|^\s+([A-Z][A-Z0-9_]+):/gm,
      )) {
        read.add((m[1] ?? m[2]) as string);
      }
    }
    expect(read.size).toBeGreaterThan(20);
    for (const name of read) expect(all.has(name), name).toBe(true);
  });
});

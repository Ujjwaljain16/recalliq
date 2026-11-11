import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startApplication, type Application } from '../../../src/app/application.js';
import {
  REPLAY_BANNER,
  SCRIPTED_BANNER,
  type ComponentFactory,
} from '../../../src/app/components.js';
import { loadAppEnv, type AppEnv } from '../../../src/app/env.js';
import {
  assertReplayRunnable,
  liveFactory,
  LiveConfigurationError,
  replayFactory,
  ReplayConfigurationError,
  replayFactoryFromFixture,
} from '../../../src/app/live.js';
import { parseReplayFixture } from '../../../src/app/live/fixture.js';
import { scriptedFactory } from '../../../src/app/scripted/index.js';
import { getMeta, loadMigrations } from '../../../src/db/index.js';
import { SECRET } from '../server/harness.js';
import { fixture } from './scenarios.js';

const dirs: string[] = [];
const apps: Application[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recalliq-modes-'));
  dirs.push(dir);
  return path.join(dir, 'fresh.db');
}

function env(vars: Record<string, string>, dbPath: string): AppEnv {
  const base = loadAppEnv({ SESSION_SECRET: SECRET, ...vars });
  return { ...base, config: { ...base.config, dbPath } };
}

interface Health {
  status: string;
  mode: string;
  components: string;
  banner: string | null;
}

async function boot(
  e: AppEnv,
  factory: ComponentFactory,
): Promise<{ app: Application; health: Health }> {
  const app = await startApplication({ env: e, factory, port: 0 });
  apps.push(app);
  const res = await fetch(`http://127.0.0.1:${app.port}/api/health`);
  return { app, health: (await res.json()) as Health };
}

const GEMINI = { GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'test-model', EXA_API_KEY: 'test-key' };

describe('T-E2E a fresh database starts and migrates in every supported mode and component set', () => {
  const latest = loadMigrations().length;
  const rejectFetch = vi.fn(() => Promise.reject(new Error('no network in this test')));

  const cases: Array<{
    name: string;
    vars: Record<string, string>;
    factory: (e: AppEnv) => ComponentFactory;
    components: string;
    mode: string;
    banner: string | null;
  }> = [
    {
      name: 'scripted on a real database',
      vars: { APP_MODE: 'real', APP_COMPONENTS: 'scripted' },
      factory: () => scriptedFactory(),
      components: 'scripted',
      mode: 'real',
      banner: SCRIPTED_BANNER,
    },
    {
      name: 'scripted on a demo database',
      vars: { APP_MODE: 'demo', APP_COMPONENTS: 'scripted' },
      factory: () => scriptedFactory(),
      components: 'scripted',
      mode: 'demo',
      banner: SCRIPTED_BANNER,
    },
    {
      name: 'replay on a demo database',
      vars: { APP_MODE: 'demo', APP_COMPONENTS: 'replay' },
      factory: () => replayFactoryFromFixture(parseReplayFixture(fixture({}))),
      components: 'replay',
      mode: 'demo',
      banner: REPLAY_BANNER,
    },
    {
      name: 'live on a real database (started, no provider call made)',
      vars: { APP_MODE: 'real', APP_COMPONENTS: 'live', ...GEMINI },
      factory: (e) => liveFactory(e, { fetch: rejectFetch }),
      components: 'live',
      mode: 'real',
      banner: null,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: migrates, reports itself honestly and serves health`, async () => {
      const dbPath = tempDb();
      const e = env(c.vars, dbPath);
      const { app, health } = await boot(e, c.factory(e));
      expect(health).toEqual({
        status: 'ok',
        mode: c.mode,
        components: c.components,
        banner: c.banner,
      });
      expect(getMeta(app.db, 'schema_version')).toBe(String(latest));
      expect(getMeta(app.db, 'db_mode')).toBe(c.mode);
      expect(app.components.kind).toBe(c.components);
    });
  }

  it('a database created in one mode is refused in the other, for every component set', async () => {
    const dbPath = tempDb();
    const demo = env({ APP_MODE: 'demo', APP_COMPONENTS: 'replay' }, dbPath);
    await (await boot(demo, replayFactoryFromFixture(parseReplayFixture(fixture({}))))).app.stop();
    apps.pop();
    const real = env({ APP_MODE: 'real', APP_COMPONENTS: 'scripted' }, dbPath);
    await expect(
      startApplication({ env: real, factory: scriptedFactory(), port: 0 }),
    ).rejects.toThrow(/mode/i);
  });
});

describe('T-E2E the component sets are explicit, isolated and never substituted', () => {
  it('live without credentials fails before the database is touched, naming every missing variable', () => {
    const dbPath = tempDb();
    const e = env({ APP_MODE: 'real', APP_COMPONENTS: 'live' }, dbPath);
    let message = '';
    try {
      liveFactory(e);
    } catch (error) {
      expect(error).toBeInstanceOf(LiveConfigurationError);
      message = (error as Error).message;
    }
    for (const name of ['GEMINI_API_KEY', 'GEMINI_MODEL', 'EXA_API_KEY']) {
      expect(message).toContain(name);
    }
    expect(message).toContain('Not falling back');
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('live names only what is missing and refuses a demo database', () => {
    const onlyExa = env({ APP_MODE: 'real', APP_COMPONENTS: 'live', EXA_API_KEY: 'k' }, tempDb());
    expect(() => liveFactory(onlyExa)).toThrow(/GEMINI_API_KEY/);
    expect(() => liveFactory(onlyExa)).not.toThrow(/EXA_API_KEY/);
    const demo = env({ APP_MODE: 'demo', APP_COMPONENTS: 'live', ...GEMINI }, tempDb());
    expect(() => liveFactory(demo)).toThrow(/APP_MODE must be "real"/);
  });

  it('replay requires a demo database and a fixture, and says so', () => {
    const real = env({ APP_MODE: 'real', APP_COMPONENTS: 'replay' }, tempDb());
    expect(() => assertReplayRunnable(real)).toThrow(ReplayConfigurationError);
    expect(() => assertReplayRunnable(real)).toThrow(/APP_MODE must be "demo"/);
    expect(() => assertReplayRunnable(real)).toThrow(/REPLAY_FIXTURE/);
    // even if wired by hand, the factory itself refuses a real database
    const factory = replayFactoryFromFixture(parseReplayFixture(fixture({})));
    expect(() => replayFactory(real)).toThrow(ReplayConfigurationError);
    expect(factory).toBeTypeOf('function');
  });

  it('replay on a real database is rejected at startup and nothing is left running', async () => {
    const dbPath = tempDb();
    const real = env({ APP_MODE: 'real', APP_COMPONENTS: 'replay' }, dbPath);
    await expect(
      startApplication({
        env: real,
        factory: replayFactoryFromFixture(parseReplayFixture(fixture({}))),
        port: 0,
      }),
    ).rejects.toThrow(ReplayConfigurationError);
  });

  it('the process refuses to start APP_COMPONENTS=live without credentials, with an actionable message', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/main.ts')], {
      // a minimal environment: no .env file is read and no provider key is inherited
      env: {
        PATH: process.env['PATH'] ?? '',
        SystemRoot: process.env['SystemRoot'] ?? '',
        APP_COMPONENTS: 'live',
        APP_MODE: 'real',
        DB_PATH: path.join(os.tmpdir(), 'recalliq-never-created.db'),
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('GEMINI_API_KEY');
    expect(run.stderr).toContain('EXA_API_KEY');
    expect(run.stderr).toContain('Not falling back');
    expect(fs.existsSync(path.join(os.tmpdir(), 'recalliq-never-created.db'))).toBe(false);
  });

  it('an unknown component set is a configuration error, not a default', () => {
    expect(() => loadAppEnv({ APP_COMPONENTS: 'auto' })).toThrow(/APP_COMPONENTS/);
  });
});

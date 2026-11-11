import path from 'node:path';
import { ExaSearchAdapter } from '../search/exa-adapter.js';
import { ReplaySearchAdapter } from '../search/replay.js';
import { GeminiLlm } from '../llm/gemini/adapter.js';
import { geminiConfigFromApp } from '../llm/gemini/config.js';
import { realSleep } from '../llm/abort.js';
import { ClientLimiter, DEFAULT_LIMITER } from '../llm/limiter.js';
import type { Origin } from '../shared/ids.js';
import type { ComponentFactory } from './components.js';
import type { AppEnv } from './env.js';
import { loadReplayFixture, type ReplayFixture } from './live/fixture.js';
import { buildRealComponents } from './live/pipeline.js';
import { FixtureLlm, FixtureSearchPort, MissLog } from './live/replay-providers.js';

/**
 * INTEGRATION POINT: the single place where the real components are wired to a provider.
 *
 *   live    Gemini (GEMINI_API_KEY, GEMINI_MODEL) for every model role and Exa (EXA_API_KEY) for search.
 *   replay  the same real components, with a fixture search port and a fixture model reading REPLAY_FIXTURE.
 *
 * Both go through buildRealComponents (src/app/live/pipeline.ts), so only the two provider ports differ.
 * Neither set ever falls back to the scripted set, to the other set, or to another provider.
 */

/** A required setting of the live set is missing. Names variables, never values. */
export class LiveConfigurationError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(
      'APP_COMPONENTS=live cannot start:\n' +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\nNot falling back to scripted or replay components, and no other provider is used. ' +
        'Set the variables above, or select APP_COMPONENTS=scripted or APP_COMPONENTS=replay explicitly.',
    );
    this.name = 'LiveConfigurationError';
  }
}

/** The replay set cannot start in this configuration. */
export class ReplayConfigurationError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super('APP_COMPONENTS=replay cannot start:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    this.name = 'ReplayConfigurationError';
  }
}

export interface LiveOptions {
  /** Node's global fetch in production; a test passes its own. Used only by the live providers. */
  fetch?: typeof fetch;
}

/** Checks everything the live set needs, before the database is opened. */
export function liveFactory(env: AppEnv, options: LiveOptions = {}): ComponentFactory {
  const problems: string[] = [];
  const { secrets, gemini } = env.config;
  if (secrets.geminiApiKey === undefined) problems.push('GEMINI_API_KEY is not set');
  if (gemini.model === undefined)
    problems.push('GEMINI_MODEL is not set (there is no default model)');
  if (secrets.exaApiKey === undefined) problems.push('EXA_API_KEY is not set');
  if (env.config.mode !== 'real') {
    problems.push(
      'APP_MODE must be "real": the live set writes live data and must not share a demo database',
    );
  }
  if (problems.length > 0) throw new LiveConfigurationError(problems);

  const doFetch = options.fetch ?? fetch;
  return (c) => {
    const limiter = new ClientLimiter(DEFAULT_LIMITER, { clock: c.clock, sleep: realSleep });
    const llm = new GeminiLlm({
      config: geminiConfigFromApp(c.config),
      fetch: doFetch,
      clock: c.clock,
      limiter,
    });
    const search = new ExaSearchAdapter({
      apiKey: secrets.exaApiKey ?? '',
      fetch: (input, init) => doFetch(input, init),
      clock: c.clock,
    });
    return buildRealComponents(c, { kind: 'live', llm, search, origin: 'live' });
  };
}

/**
 * Checks what the replay set needs. Fixture rows (origin `recorded` or `synthetic`) are rejected by a real
 * database, so replay requires APP_MODE=demo, and it needs a fixture file.
 */
export function assertReplayRunnable(env: AppEnv): void {
  const problems: string[] = [];
  if (env.config.mode !== 'demo') {
    problems.push(
      'APP_MODE must be "demo": replay stores fixture data, which a real database rejects by design',
    );
  }
  if (env.replayFixture === undefined) {
    problems.push('REPLAY_FIXTURE is not set (path of the replay fixture file)');
  }
  if (problems.length > 0) throw new ReplayConfigurationError(problems);
}

export function replayFactoryFromFixture(
  fixture: ReplayFixture,
  recorded?: ReplaySearchAdapter,
): ComponentFactory {
  const origin: Origin = fixture.class === 'recorded' ? 'recorded' : 'synthetic';
  return (c) => {
    if (c.config.mode !== 'demo') {
      throw new ReplayConfigurationError(['APP_MODE must be "demo" for the replay set']);
    }
    const log = new MissLog();
    return buildRealComponents(c, {
      kind: 'replay',
      llm: new FixtureLlm(fixture.llm, log),
      search: new FixtureSearchPort({ entries: fixture.search, recorded, clock: c.clock, log }),
      origin,
      missLog: log,
    });
  };
}

/** Reads REPLAY_FIXTURE (and any recordings it names) and returns the replay set. Fails before the database is opened. */
export function replayFactory(env: AppEnv): ComponentFactory {
  assertReplayRunnable(env);
  const { fixture, recordings } = loadReplayFixture(path.resolve(env.replayFixture ?? ''));
  const exchanges = recordings.flatMap((r) => r.exchanges);
  const first = exchanges[0];
  const recorded =
    first === undefined
      ? undefined
      : new ReplaySearchAdapter(
          first.response.provider,
          exchanges.map((e) => ({ key: e.key, response: e.response })),
        );
  return replayFactoryFromFixture(fixture, recorded);
}

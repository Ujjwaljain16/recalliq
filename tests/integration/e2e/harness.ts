import type { Components } from '../../../src/app/components.js';
import { startApplication, type Application } from '../../../src/app/application.js';
import { loadAppEnv, type AppEnv } from '../../../src/app/env.js';
import { replayFactoryFromFixture } from '../../../src/app/live.js';
import { parseReplayFixture, type ReplayFixtureInput } from '../../../src/app/live/fixture.js';
import { FixedClock } from '../../../src/temporal/clock.js';
import { Client, SECRET, type RawSse, type SseRead } from '../server/harness.js';

export { Client, SECRET, type RawSse, type SseRead };

/** All names, vendors and prices in these tests are [SYNTHETIC]; every vendor domain ends in `.example`. */
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** Tuesday 2026-11-03 10:00 UTC. */
export const TUE = Date.UTC(2026, 10, 3, 10, 0, 0);

export interface E2eApp {
  app: Application;
  clock: FixedClock;
  base: string;
  env: AppEnv;
  client(): Client;
  stop(): Promise<void>;
}

export interface E2eOptions {
  fixture: ReplayFixtureInput;
  clock?: FixedClock;
  /** A file path to share one database between application instances; default is a private in-memory one. */
  dbPath?: string;
  mode?: 'demo' | 'real';
  decorate?: (c: Components) => Components;
}

/**
 * The real HTTP server, real SQLite with real migrations, the real orchestrator, research service, evidence
 * verification, belief resolution and answer pipeline. Only the search provider and the model are replaced, by
 * the replay providers reading `fixture`.
 */
export async function startE2e(o: E2eOptions): Promise<E2eApp> {
  const clock = o.clock ?? new FixedClock(TUE);
  const base = loadAppEnv({
    APP_MODE: o.mode ?? 'demo',
    SESSION_SECRET: SECRET,
    APP_COMPONENTS: 'replay',
    SHUTDOWN_GRACE_MS: '5000',
  });
  const env: AppEnv = { ...base, config: { ...base.config, dbPath: o.dbPath ?? ':memory:' } };
  const app = await startApplication({
    env,
    factory: replayFactoryFromFixture(parseReplayFixture(o.fixture)),
    clock,
    port: 0,
    ...(o.decorate ? { decorate: o.decorate } : {}),
  });
  const url = `http://127.0.0.1:${app.port}`;
  return {
    app,
    clock,
    base: url,
    env,
    client: () => new Client(url),
    stop: async () => {
      await app.stop();
    },
  };
}

export interface TurnOutcome {
  read: SseRead;
  turnId: string;
  names: string[];
  /** The text of each sentence that was released, in order. */
  sentences: string[];
  completed: {
    assistantMessageId: string;
    sentences: Array<{ index: number; status: string }>;
  } | null;
  status: string;
}

export function summarize(read: SseRead): TurnOutcome {
  const events = read.events;
  const sentences: string[] = [];
  for (const e of events) {
    if (e.event === 'answer.delta') sentences.push((e.data as { text: string }).text);
  }
  const completedEvent = events.find((e) => e.event === 'answer.completed');
  const turnCompleted = events.find((e) => e.event === 'turn.completed');
  return {
    read,
    turnId: (events[0]?.data as { turnId: string }).turnId,
    names: events.map((e) => e.event),
    sentences,
    completed: (completedEvent?.data as TurnOutcome['completed']) ?? null,
    status: (turnCompleted?.data as { status: string } | undefined)?.status ?? 'missing',
  };
}

let keySeq = 0;
export async function ask(
  client: Client,
  conversationId: string,
  text: string,
  tz = 'UTC',
): Promise<TurnOutcome> {
  const res = await client.request('POST', `/api/conversations/${conversationId}/turns`, {
    text,
    idempotencyKey: `k-${++keySeq}`,
    tz,
  });
  const raw = await res.text();
  const { parseSse } = await import('../server/harness.js');
  return summarize({ status: res.status, headers: res.headers, raw, ...parseSse(raw) });
}

/** What a browser does after rendering: acknowledges every sentence up to `through` (default: the last). */
export async function acknowledge(
  client: Client,
  t: TurnOutcome,
  through?: number,
): Promise<{ status: number; body: unknown }> {
  const last = (t.completed?.sentences.length ?? 0) - 1;
  const n = through ?? last;
  return client.json('POST', `/api/turns/${t.turnId}/ack`, {
    renderedThrough: n,
    complete: n === last,
  });
}

export function scalar<T = number>(app: Application, sql: string, ...params: unknown[]): T {
  return app.db
    .prepare(sql)
    .pluck()
    .get(...params) as T;
}

/** True when any text in any table of the database contains `needle` (used to show something was never stored). */
export function dbContains(app: Application, needle: string): boolean {
  const tables = app.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .pluck()
    .all() as string[];
  for (const table of tables) {
    for (const row of app.db.prepare(`SELECT * FROM "${table}"`).all()) {
      if (JSON.stringify(row).includes(needle)) return true;
    }
  }
  return false;
}

export const eventsOf = (t: TurnOutcome, name: string): unknown[] =>
  t.read.events.filter((e) => e.event === name).map((e) => e.data);

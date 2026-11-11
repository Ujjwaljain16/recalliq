import fs from 'node:fs';
import path from 'node:path';
import { startApplication } from '../../src/app/application.js';
import type { Components } from '../../src/app/components.js';
import { loadAppEnv } from '../../src/app/env.js';
import { liveFactory } from '../../src/app/live.js';
import { createLogger, silentLogger } from '../../src/app/logger.js';
import { scriptedFactory } from '../../src/app/scripted/index.js';
import type { Db } from '../../src/db/index.js';
import { BenchClient, type TurnOutcome } from './client.js';
import { OffsetClock } from './clock.js';
import type { BenchItem, DatasetName, LongMemEvalItem } from './datasets.js';
import { summarize, type CallRecorder, type ProviderCall } from './recorder.js';
import { appendResult, latestById, readResults, type QuestionResult } from './results.js';
import type { Split } from './sampler.js';
import { seedLongMemHistory, soleUserId, type SeedSummary } from './seed.js';

/**
 * The runner: starts the real application in this process, then asks every sampled question over HTTP the
 * way the browser does, one fresh user and conversation per question. LongMemEval questions each get their
 * own database file, seeded with the item's history before the question is asked "on" its question date.
 * Every result is appended to a JSONL file as soon as it exists, so a run can stop at any point and resume.
 */

export interface LaunchedApp {
  base: string;
  db: Db;
  stop(): Promise<void>;
}

export type Launcher = (options: { dbPath: string; clock: OffsetClock }) => Promise<LaunchedApp>;

export type ComponentsKind = 'live' | 'scripted';

/** The real components against Gemini and Exa. Keys come from the process environment only. */
export function liveLauncher(
  recorder: CallRecorder,
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
  verbose = false,
): Launcher {
  return async ({ dbPath, clock }) => {
    const env = loadAppEnv({
      ...processEnv,
      APP_COMPONENTS: 'live',
      APP_MODE: 'real',
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
    });
    const app = await startApplication({
      env,
      factory: liveFactory(env, { fetch: recorder.fetch }),
      clock,
      port: 0,
      logger: verbose ? createLogger() : silentLogger,
    });
    return {
      base: `http://127.0.0.1:${app.port}`,
      db: app.db,
      stop: async () => {
        await app.stop();
      },
    };
  };
}

/** The scripted (offline, canned) components: for checking the harness itself, never for a score. */
export function scriptedLauncher(
  options: { decorate?: (c: Components) => Components } = {},
): Launcher {
  return async ({ dbPath, clock }) => {
    const env = loadAppEnv({
      APP_MODE: 'real',
      APP_COMPONENTS: 'scripted',
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      SHUTDOWN_GRACE_MS: '2000',
    });
    const app = await startApplication({
      env,
      factory: scriptedFactory({ paceMs: 0 }),
      clock,
      port: 0,
      ...(options.decorate ? { decorate: options.decorate } : {}),
    });
    return {
      base: `http://127.0.0.1:${app.port}`,
      db: app.db,
      stop: async () => {
        await app.stop();
      },
    };
  };
}

export interface RunOptions {
  dataset: DatasetName;
  split: Split;
  items: BenchItem[];
  /** The JSONL results file; existing answered ids in it are skipped. */
  out: string;
  runId: string;
  components: ComponentsKind;
  model: string | null;
  launcher: Launcher;
  recorder: CallRecorder;
  /** Where the scratch databases live. */
  dbDir: string;
  keepDbs?: boolean;
  pauseMs?: number;
  /** At most this many questions in this invocation (null: all pending). */
  maxQuestions?: number | null;
  /** Stop after this many consecutive rate-limited questions. A daily quota stops at once. */
  maxConsecutiveRateLimited?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface RunSummary {
  pending: number;
  attempted: number;
  answered: number;
  errors: number;
  skipped: number;
  /** Why the run stopped before the end, if it did. */
  stopped: string | null;
}

const DEGRADED_WARNINGS = new Set([
  'analysis_degraded',
  'judge_skipped',
  'search_partial',
  'deadline_compacted',
]);

/**
 * Whether a question's outcome is the provider's failure rather than the agent's answer. A rate limit that
 * the application retried through cleanly is not an error; one that left the turn failed, interrupted,
 * degraded or with an error event is. Other provider failures count only when the turn did not complete.
 */
export function classify(
  turn: TurnOutcome,
  calls: readonly ProviderCall[],
): QuestionResult['error'] {
  if (turn.httpStatus !== 200) {
    return { kind: 'http', detail: `HTTP ${turn.httpStatus}: ${turn.refusal ?? ''}`.trim() };
  }
  const limited = calls.filter((c) => c.rateLimited);
  const clean =
    turn.status === 'complete' &&
    turn.errors.length === 0 &&
    !turn.warnings.some((w) => DEGRADED_WARNINGS.has(w.code));
  if (limited.length > 0 && !clean) {
    const daily = limited.some((c) => c.dailyQuota);
    return {
      kind: daily ? 'quota' : 'rate_limited',
      detail: `${limited.length} rate-limited provider call(s) (${[...new Set(limited.map((c) => c.provider))].join(', ')}); turn ${turn.status ?? 'unknown'}`,
    };
  }
  const failed = calls.filter((c) => c.status < 200 || c.status >= 300);
  if (failed.length > 0 && turn.status !== 'complete' && turn.sentences.length === 0) {
    return {
      kind: 'provider',
      detail: `${failed.length} failed provider call(s): ${failed.map((c) => `${c.provider} ${c.status}`).join(', ')}; turn ${turn.status ?? 'unknown'}`,
    };
  }
  return null;
}

function markedAnswer(turn: TurnOutcome): string {
  const parts = turn.sentences.map((s) =>
    s.status === 'verified' || s.status === 'no_claims' ? s.text : `${s.text} [${s.status}]`,
  );
  for (const issues of turn.withheld) parts.push(`[withheld sentence: ${issues.join(', ')}]`);
  return parts.join(' ');
}

function emptyTurn(): TurnOutcome {
  return {
    httpStatus: 0,
    turnId: null,
    lane: null,
    status: null,
    sentences: [],
    withheld: [],
    clarification: null,
    sources: [],
    citations: 0,
    warnings: [],
    errors: [],
    serverMetrics: null,
    wallMs: 0,
    firstEventMs: null,
    firstTextMs: null,
    refusal: null,
  };
}

function toResult(
  options: RunOptions,
  item: BenchItem,
  askedAt: Date,
  turn: TurnOutcome | null,
  calls: readonly ProviderCall[],
  seeding: SeedSummary | null,
  harnessError: string | null,
): QuestionResult {
  const t = turn ?? emptyTurn();
  const error =
    harnessError !== null ? { kind: 'harness' as const, detail: harnessError } : classify(t, calls);
  return {
    id: item.id,
    dataset: options.dataset,
    split: options.split,
    runId: options.runId,
    askedAt: askedAt.toISOString(),
    components: options.components,
    model: options.model,
    question: item.question,
    outcome: error === null ? 'answered' : 'error',
    error,
    lane: t.lane,
    status: t.status,
    httpStatus: turn === null ? null : t.httpStatus,
    answer: t.sentences.map((s) => s.text).join(' '),
    answerMarked: markedAnswer(t),
    sentences: t.sentences,
    withheld: t.withheld,
    clarification: t.clarification,
    wallMs: turn === null ? null : t.wallMs,
    firstEventMs: t.firstEventMs,
    firstTextMs: t.firstTextMs,
    serverMetrics: t.serverMetrics,
    calls: { gemini: summarize(calls, 'gemini'), exa: summarize(calls, 'exa') },
    citations: {
      cited: t.citations,
      sources: t.sources.length,
      domains: [...new Set(t.sources.map((s) => s.domain))],
    },
    warnings: t.warnings.map((w) => w.code),
    errors: t.errors,
    seeding:
      seeding === null
        ? null
        : {
            conversations: seeding.conversations,
            userMessages: seeding.userMessages,
            assistantMessages: seeding.assistantMessages,
          },
  };
}

function removeDb(file: string): void {
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(file + ext, { force: true });
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/** One LongMemEval question: its own database, its history seeded, the question asked on its date. */
async function askLongMem(
  options: RunOptions,
  item: LongMemEvalItem,
): Promise<{ turn: TurnOutcome; seeding: SeedSummary }> {
  const dir = path.join(options.dbDir, `longmemeval-${options.split}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, `${safeName(item.id)}.db`);
  removeDb(dbPath);
  const clock = new OffsetClock();
  const firstAt = Math.min(item.questionAt, ...item.sessions.map((s) => s.at));
  clock.setNow(firstAt - 60_000);
  const app = await options.launcher({ dbPath, clock });
  try {
    const client = new BenchClient(app.base);
    // The user (and its cookie) is created through the API, before the history it owns.
    await client.newConversation();
    const seeding = seedLongMemHistory(app.db, soleUserId(app.db), item, 'UTC');
    clock.setNow(item.questionAt);
    const conversation = await client.newConversation();
    const turn = await client.turn(
      conversation,
      item.question,
      `bench-${options.runId}-${item.id}-${Date.now()}`,
      'UTC',
    );
    return { turn, seeding };
  } finally {
    await app.stop();
    if (!options.keepDbs) removeDb(dbPath);
  }
}

export async function runBenchmark(options: RunOptions): Promise<RunSummary> {
  const log = options.log ?? ((line: string) => process.stdout.write(line + '\n'));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => new Date());
  const done = new Set(
    [...latestById(readResults(options.out)).values()]
      .filter((r) => r.outcome === 'answered')
      .map((r) => r.id),
  );
  const pending = options.items.filter((i) => !done.has(i.id));
  const limit = options.maxQuestions ?? pending.length;
  const queue = pending.slice(0, limit);
  const summary: RunSummary = {
    pending: pending.length,
    attempted: 0,
    answered: 0,
    errors: 0,
    skipped: options.items.length - pending.length,
    stopped: null,
  };
  log(
    `${options.dataset}/${options.split}: ${options.items.length} sampled, ${summary.skipped} already answered, ${queue.length} to ask now`,
  );
  if (queue.length === 0) return summary;

  const maxLimited = options.maxConsecutiveRateLimited ?? 3;
  let consecutiveLimited = 0;
  let shared: LaunchedApp | null = null;
  const sharedDb = path.join(options.dbDir, `${options.dataset}-${options.split}.db`);

  try {
    for (const [k, item] of queue.entries()) {
      if (k > 0 && (options.pauseMs ?? 0) > 0) await sleep(options.pauseMs ?? 0);
      const mark = options.recorder.mark();
      const askedAt = now();
      let turn: TurnOutcome | null = null;
      let seeding: SeedSummary | null = null;
      let harnessError: string | null = null;
      try {
        if (item.dataset === 'longmemeval') {
          ({ turn, seeding } = await askLongMem(options, item));
        } else {
          if (shared === null) {
            fs.mkdirSync(options.dbDir, { recursive: true });
            removeDb(sharedDb);
            shared = await options.launcher({ dbPath: sharedDb, clock: new OffsetClock() });
          }
          // A new client is a new user: nothing one question leaves in memory reaches the next.
          const client = new BenchClient(shared.base);
          const conversation = await client.newConversation();
          turn = await client.turn(
            conversation,
            item.question,
            `bench-${options.runId}-${item.id}-${Date.now()}`,
            'UTC',
          );
        }
      } catch (error) {
        harnessError = error instanceof Error ? error.message : String(error);
      }
      const result = toResult(
        options,
        item,
        askedAt,
        turn,
        options.recorder.since(mark),
        seeding,
        harnessError,
      );
      appendResult(options.out, result);
      summary.attempted += 1;
      if (result.outcome === 'answered') summary.answered += 1;
      else summary.errors += 1;
      log(
        `[${k + 1}/${queue.length}] ${item.id} ${result.outcome}${result.error ? ` (${result.error.kind}: ${result.error.detail})` : ''} lane=${result.lane ?? '-'} status=${result.status ?? '-'} wall=${result.wallMs ?? '-'}ms`,
      );

      if (result.error?.kind === 'quota') {
        summary.stopped = 'daily quota exhausted: resume later with the same command';
        break;
      }
      if (result.error?.kind === 'rate_limited') {
        consecutiveLimited += 1;
        if (consecutiveLimited >= maxLimited) {
          summary.stopped = `${consecutiveLimited} consecutive rate-limited questions: resume later with the same command`;
          break;
        }
      } else {
        consecutiveLimited = 0;
      }
    }
  } finally {
    if (shared !== null) {
      await shared.stop();
      if (!options.keepDbs) removeDb(sharedDb);
    }
  }
  if (summary.stopped) log(`stopped: ${summary.stopped}`);
  return summary;
}

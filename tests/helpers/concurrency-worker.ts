import { parentPort, workerData } from 'node:worker_threads';
import { initializeDatabase, openDatabase } from '../../src/db/index.js';
import type { AckRequest } from '../../src/shared/delivery.js';
import type { TurnId, UserId } from '../../src/shared/ids.js';
import type { TurnRequest } from '../../src/shared/turn.js';
import { FixedClock } from '../../src/temporal/clock.js';
import { reposFor, T0 } from './db.js';

/**
 * One contender in a concurrency test. Each worker thread opens its OWN connection to the same database file,
 * waits at a barrier so that all workers start together, performs one operation, and reports the outcome.
 * Errors are reported by class name and message instead of being thrown, so the test can assert on them.
 */
export type WorkerJob =
  | { op: 'begin'; request: TurnRequest }
  | { op: 'ack'; userId: UserId; turnId: TurnId; ack: AckRequest };

export interface WorkerData {
  dbPath: string;
  barrier: SharedArrayBuffer;
  job: WorkerJob;
}

export type WorkerOutcome =
  { ok: true; value: unknown } | { ok: false; error: { name: string; message: string } };

const { dbPath, barrier, job } = workerData as WorkerData;

const db = openDatabase(dbPath);
initializeDatabase(db, { mode: 'real', clock: new FixedClock(T0) });
const repos = reposFor(db, new FixedClock(T0));

// Tell the parent we are ready, then block until it releases everyone at once.
const gate = new Int32Array(barrier);
parentPort?.postMessage({ ready: true });
Atomics.wait(gate, 0, 0);

let outcome: WorkerOutcome;
try {
  const value =
    job.op === 'begin'
      ? repos.turns.begin(job.request, T0, T0 + 60_000)
      : repos.turns.ack(job.userId, job.turnId, job.ack, T0 + 1_000);
  outcome = { ok: true, value };
} catch (error) {
  outcome = {
    ok: false,
    error: {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
db.close();
parentPort?.postMessage({ done: outcome });

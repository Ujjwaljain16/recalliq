import { Worker } from 'node:worker_threads';
import type { WorkerData, WorkerJob, WorkerOutcome } from './concurrency-worker.js';

const WORKER_FILE = new URL('./worker-bootstrap.ts', import.meta.url);

/**
 * Runs every job in its own worker thread, each with its own SQLite connection to `dbPath`, and releases
 * them all at the same instant. Returns the outcomes in job order. This is real contention between
 * connections, not interleaving inside one thread.
 */
export async function race(dbPath: string, jobs: WorkerJob[]): Promise<WorkerOutcome[]> {
  const barrier = new SharedArrayBuffer(4);
  const gate = new Int32Array(barrier);

  let readyCount = 0;
  let releaseWhenReady: () => void = () => undefined;
  const allReady = new Promise<void>((resolve) => {
    releaseWhenReady = resolve;
  });

  const workers = jobs.map((job) => {
    const data: WorkerData = { dbPath, barrier, job };
    const worker = new Worker(WORKER_FILE, { workerData: data });
    const outcome = new Promise<WorkerOutcome>((resolve, reject) => {
      worker.on('message', (message: { ready?: true; done?: WorkerOutcome }) => {
        if (message.ready) {
          readyCount += 1;
          if (readyCount === jobs.length) releaseWhenReady();
        }
        if (message.done) resolve(message.done);
      });
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`worker exited with code ${code}`));
      });
    });
    return { worker, outcome };
  });

  await allReady;
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);

  const outcomes = await Promise.all(workers.map((w) => w.outcome));
  await Promise.all(workers.map((w) => w.worker.terminate()));
  return outcomes;
}

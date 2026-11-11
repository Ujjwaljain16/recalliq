import { LlmError } from '../shared/llm.js';

/** The reason a signal aborted, as a typed error: a timeout is not a cancellation. */
export function abortToError(signal: AbortSignal): LlmError {
  const reason: unknown = signal.reason;
  const name = reason instanceof Error ? reason.name : '';
  return name === 'TimeoutError'
    ? new LlmError('timeout', 'the call exceeded its time allowance')
    : new LlmError('cancelled', 'the call was cancelled');
}

/** A promise that rejects when `signal` aborts, so a fetch or reader that ignores the signal cannot hang us. */
export function abortPromise(signal: AbortSignal): {
  promise: Promise<never>;
  dispose: () => void;
} {
  let onAbort: () => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortToError(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  promise.catch(() => undefined); // never an unhandled rejection once nobody races it any more
  return { promise, dispose: () => signal.removeEventListener('abort', onAbort) };
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Real-time sleep that ends early, with a typed error, when the signal aborts. */
export const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortToError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortToError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

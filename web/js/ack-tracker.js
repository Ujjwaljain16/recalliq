// Acknowledgement bookkeeping, kept free of the DOM and of timers it does not receive, so it can be tested
// without a browser.
//
// The rule it enforces (ADR-23, ADR-31): a sentence is acknowledged only after it was actually rendered, the
// acknowledged extent only moves forward, it never passes what the server streamed, and `complete` is true
// only when every streamed sentence is rendered. Nothing is acknowledged before the server has stored the
// answer, because the server rejects an acknowledgement for a turn with no stored answer.

/**
 * @typedef {{ renderedThrough: number, complete: boolean }} AckBody
 */

export class AckTracker {
  constructor() {
    /** @type {Map<string, TurnState>} */
    this.turns = new Map();
  }

  #state(turnId) {
    let s = this.turns.get(turnId);
    if (!s) {
      s = {
        streamed: new Set(),
        rendered: new Set(),
        stored: false,
        streamedThrough: -1,
        ackedThrough: -1,
        completeSent: false,
      };
      this.turns.set(turnId, s);
    }
    return s;
  }

  /** The server finished writing sentence `index` to the stream (`answer.sentence_end`). */
  sentenceStreamed(turnId, index) {
    const s = this.#state(turnId);
    s.streamed.add(index);
    s.streamedThrough = contiguousThrough(s.streamed);
  }

  /** Sentence `index` is in the DOM with its full text. Call it only after it really is. */
  sentenceRendered(turnId, index) {
    this.#state(turnId).rendered.add(index);
  }

  /** `answer.completed` arrived: the server has stored the answer, so acknowledgements are now accepted. */
  answerStored(turnId) {
    this.#state(turnId).stored = true;
  }

  /**
   * A stored message re-rendered after a reload. `streamedThrough` and `renderedThrough` are the server's own
   * extents; sentences up to `streamedThrough` are marked streamed, and those up to `renderedThrough` already
   * acknowledged.
   */
  restore(turnId, { streamedThrough, renderedThrough }) {
    const s = this.#state(turnId);
    s.stored = true;
    for (let i = 0; i <= streamedThrough; i += 1) s.streamed.add(i);
    s.streamedThrough = Math.max(s.streamedThrough, streamedThrough);
    s.ackedThrough = Math.max(s.ackedThrough, renderedThrough);
    s.completeSent = renderedThrough >= streamedThrough && streamedThrough >= 0;
  }

  /** The highest sentence index that is rendered without a gap from 0, never past the streamed extent. */
  renderedThrough(turnId) {
    const s = this.turns.get(turnId);
    if (!s) return -1;
    return Math.min(contiguousThrough(s.rendered), s.streamedThrough);
  }

  /**
   * The acknowledgement to send now, or null when there is nothing new to say. It is never stale: it is
   * recomputed from what is rendered at the time of the call.
   * @returns {AckBody | null}
   */
  next(turnId) {
    const s = this.turns.get(turnId);
    if (!s || !s.stored || s.streamedThrough < 0) return null;
    const renderedThrough = this.renderedThrough(turnId);
    if (renderedThrough < 0) return null;
    const complete = renderedThrough === s.streamedThrough;
    const advances = renderedThrough > s.ackedThrough;
    const completes = complete && !s.completeSent;
    if (!advances && !completes) return null;
    return { renderedThrough, complete };
  }

  /** The server accepted an acknowledgement (or reported the stored extent). */
  acknowledged(turnId, body, storedThrough = body.renderedThrough) {
    const s = this.#state(turnId);
    s.ackedThrough = Math.max(s.ackedThrough, storedThrough, body.renderedThrough);
    if (body.complete) s.completeSent = true;
  }

  /** Turn ids that currently have something to send. */
  pending() {
    return [...this.turns.keys()].filter((id) => this.next(id) !== null);
  }
}

/**
 * Batches acknowledgements: a render notifies the scheduler, which sends one acknowledgement after a short
 * delay for everything rendered in the meantime. A failed send is retried a few times with a growing delay.
 * Timers and the transport are injected.
 *
 * @param {{
 *   tracker: AckTracker,
 *   send: (turnId: string, body: AckBody) => Promise<{ renderedThrough: number } | void>,
 *   delayMs?: number,
 *   maxAttempts?: number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 * }} options
 */
export function createAckScheduler(options) {
  const delayMs = options.delayMs ?? 250;
  const maxAttempts = options.maxAttempts ?? 4;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  /** @type {Map<string, { handle: unknown }>} */
  const timers = new Map();
  const attempts = new Map();

  function schedule(turnId, ms) {
    if (timers.has(turnId)) return;
    const handle = setTimer(() => {
      timers.delete(turnId);
      void flush(turnId);
    }, ms);
    timers.set(turnId, { handle });
  }

  async function flush(turnId) {
    const body = options.tracker.next(turnId);
    if (!body) return;
    try {
      const reply = await options.send(turnId, body);
      options.tracker.acknowledged(turnId, body, reply ? reply.renderedThrough : undefined);
      attempts.delete(turnId);
      // More may have been rendered while the request was in flight.
      if (options.tracker.next(turnId)) schedule(turnId, delayMs);
    } catch {
      const n = (attempts.get(turnId) ?? 0) + 1;
      attempts.set(turnId, n);
      if (n < maxAttempts) schedule(turnId, delayMs * 2 ** n);
    }
  }

  return {
    /** Something was rendered for this turn: send an acknowledgement soon. */
    notify(turnId) {
      if (options.tracker.next(turnId)) schedule(turnId, delayMs);
    },
    /** Send now (the page is going away, or the caller wants it immediately). */
    flush,
    cancel(turnId) {
      const t = timers.get(turnId);
      if (t) clearTimer(t.handle);
      timers.delete(turnId);
    },
    /** For the page-hide beacon: the acknowledgements that are due right now, without sending them. */
    due() {
      return options.tracker
        .pending()
        .map((turnId) => ({ turnId, body: /** @type {AckBody} */ (options.tracker.next(turnId)) }));
    },
  };
}

/**
 * @param {Set<number>} indexes
 * @returns {number} the highest n such that 0..n are all in the set, or -1
 */
function contiguousThrough(indexes) {
  let n = -1;
  while (indexes.has(n + 1)) n += 1;
  return n;
}

/**
 * @typedef {{
 *   streamed: Set<number>, rendered: Set<number>, stored: boolean,
 *   streamedThrough: number, ackedThrough: number, completeSent: boolean
 * }} TurnState
 */

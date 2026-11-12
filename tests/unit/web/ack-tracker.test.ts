import { describe, expect, it } from 'vitest';
import { AckTracker, createAckScheduler } from '../../../web/js/ack-tracker.js';

const T = 'trn_1';

function streamed(tracker: AckTracker, n: number): void {
  for (let i = 0; i < n; i += 1) tracker.sentenceStreamed(T, i);
}

describe('AckTracker', () => {
  it('has nothing to send before the server stored the answer', () => {
    const t = new AckTracker();
    streamed(t, 3);
    t.sentenceRendered(T, 0);
    expect(t.next(T)).toBeNull();
    t.answerStored(T);
    expect(t.next(T)).toEqual({ renderedThrough: 0, complete: false });
  });

  it('never acknowledges a sentence that is not rendered', () => {
    const t = new AckTracker();
    streamed(t, 3);
    t.answerStored(T);
    expect(t.next(T)).toBeNull();
  });

  it('only counts a contiguous run of rendered sentences, so the extent is monotonic and gap-free', () => {
    const t = new AckTracker();
    streamed(t, 4);
    t.answerStored(T);
    t.sentenceRendered(T, 0);
    t.sentenceRendered(T, 2); // sentence 1 is not rendered yet
    expect(t.next(T)).toEqual({ renderedThrough: 0, complete: false });
    t.sentenceRendered(T, 1);
    expect(t.next(T)).toEqual({ renderedThrough: 2, complete: false });
  });

  it('never goes past what the server streamed', () => {
    const t = new AckTracker();
    streamed(t, 2);
    t.answerStored(T);
    for (let i = 0; i < 5; i += 1) t.sentenceRendered(T, i); // 2..4 were never streamed
    expect(t.next(T)).toEqual({ renderedThrough: 1, complete: true });
  });

  it('sets complete only when every streamed sentence is rendered', () => {
    const t = new AckTracker();
    streamed(t, 3);
    t.answerStored(T);
    t.sentenceRendered(T, 0);
    t.sentenceRendered(T, 1);
    expect(t.next(T)?.complete).toBe(false);
    t.sentenceRendered(T, 2);
    expect(t.next(T)).toEqual({ renderedThrough: 2, complete: true });
  });

  it('does not repeat an acknowledgement and resumes when more is rendered', () => {
    const t = new AckTracker();
    streamed(t, 3);
    t.answerStored(T);
    t.sentenceRendered(T, 0);
    const first = t.next(T)!;
    t.acknowledged(T, first);
    expect(t.next(T)).toBeNull();
    t.sentenceRendered(T, 1);
    t.sentenceRendered(T, 2);
    const second = t.next(T)!;
    expect(second).toEqual({ renderedThrough: 2, complete: true });
    t.acknowledged(T, second);
    expect(t.next(T)).toBeNull();
  });

  it('sends nothing for an answer where nothing was streamed', () => {
    const t = new AckTracker();
    t.answerStored(T);
    expect(t.next(T)).toBeNull();
  });

  it('restores the server extents after a reload and acknowledges only what is new', () => {
    const t = new AckTracker();
    t.restore(T, { streamedThrough: 3, renderedThrough: 1 });
    expect(t.next(T)).toBeNull(); // nothing rendered on this page yet
    for (let i = 0; i <= 3; i += 1) t.sentenceRendered(T, i);
    expect(t.next(T)).toEqual({ renderedThrough: 3, complete: true });
  });

  it('has nothing to send for a fully acknowledged message after a reload', () => {
    const t = new AckTracker();
    t.restore(T, { streamedThrough: 2, renderedThrough: 2 });
    for (let i = 0; i <= 2; i += 1) t.sentenceRendered(T, i);
    expect(t.next(T)).toBeNull();
  });

  it('lists the turns that have something due', () => {
    const t = new AckTracker();
    t.sentenceStreamed('trn_a', 0);
    t.answerStored('trn_a');
    t.sentenceRendered('trn_a', 0);
    t.sentenceStreamed('trn_b', 0);
    t.answerStored('trn_b');
    expect(t.pending()).toEqual(['trn_a']);
  });
});

describe('ack scheduler', () => {
  function harness(failures = 0) {
    const tracker = new AckTracker();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const sent: Array<{ turnId: string; renderedThrough: number; complete: boolean }> = [];
    let remaining = failures;
    const scheduler = createAckScheduler({
      tracker,
      delayMs: 100,
      setTimer: (fn, ms) => {
        const entry = { fn, ms };
        timers.push(entry);
        return entry;
      },
      clearTimer: (h) => {
        const i = timers.indexOf(h as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
      send: (turnId, body) => {
        if (remaining > 0) {
          remaining -= 1;
          return Promise.reject(new Error('network'));
        }
        sent.push({ turnId, ...body });
        return Promise.resolve({ renderedThrough: body.renderedThrough });
      },
    });
    const run = async () => {
      const t = timers.shift();
      t?.fn();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };
    return { tracker, scheduler, timers, sent, run };
  }

  it('batches several renders into one acknowledgement after the delay', async () => {
    const h = harness();
    streamed(h.tracker, 3);
    h.tracker.answerStored(T);
    h.tracker.sentenceRendered(T, 0);
    h.scheduler.notify(T);
    h.tracker.sentenceRendered(T, 1);
    h.scheduler.notify(T);
    h.tracker.sentenceRendered(T, 2);
    h.scheduler.notify(T);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.ms).toBe(100);
    await h.run();
    expect(h.sent).toEqual([{ turnId: T, renderedThrough: 2, complete: true }]);
  });

  it('sends nothing when nothing is rendered', async () => {
    const h = harness();
    streamed(h.tracker, 2);
    h.tracker.answerStored(T);
    h.scheduler.notify(T);
    expect(h.timers).toHaveLength(0);
    await h.scheduler.flush(T);
    expect(h.sent).toEqual([]);
  });

  it('retries a failed send with a growing delay, and stops after the limit', async () => {
    const h = harness(2);
    streamed(h.tracker, 1);
    h.tracker.answerStored(T);
    h.tracker.sentenceRendered(T, 0);
    h.scheduler.notify(T);
    await h.run();
    expect(h.sent).toEqual([]);
    expect(h.timers[0]?.ms).toBe(200);
    await h.run();
    expect(h.timers[0]?.ms).toBe(400);
    await h.run();
    expect(h.sent).toEqual([{ turnId: T, renderedThrough: 0, complete: true }]);
  });

  it('reports what is due for a page-hide beacon without sending it', () => {
    const h = harness();
    streamed(h.tracker, 2);
    h.tracker.answerStored(T);
    h.tracker.sentenceRendered(T, 0);
    expect(h.scheduler.due()).toEqual([
      { turnId: T, body: { renderedThrough: 0, complete: false } },
    ]);
    expect(h.sent).toEqual([]);
  });
});

import type { AnswerPipeline, AnswerResult } from '../shared/answer.js';
import type { Ms, TurnId } from '../shared/ids.js';
import type { Logger, TurnBudget } from '../shared/infrastructure.js';
import type { EventSink } from '../shared/sse.js';
import type { LaneInput } from './lanes/types.js';

/**
 * The quick sourced section of one turn (ADR-43). The research lane calls `start` when the turn's sources are
 * stored; the section then streams while extraction and verification run. `finish` is called when the lane
 * returns, the findings being ready: it stops the section where it is (the sentence still open is dropped) and
 * hands back what was released, or null when nothing was, in which case the turn behaves exactly as it does
 * without a quick section. It owns nothing else: persistence, numbering and the verified section stay with the
 * coordinator.
 */
export class QuickSection {
  private readonly cut = new AbortController();
  private running: Promise<void> | null = null;
  private result: AnswerResult | null = null;
  private failure: { error: unknown } | null = null;

  constructor(
    private readonly c: {
      answer: AnswerPipeline;
      budget: TurnBudget;
      emit: EventSink;
      turnId: TurnId;
      now: Ms;
      userMessage: string;
      tz: string;
      logger?: Logger;
    },
  ) {}

  /** True when the pipeline has a quick capability at all. */
  get available(): boolean {
    return this.c.answer.quick !== undefined;
  }

  start(ready: Parameters<NonNullable<LaneInput['onSourcesReady']>>[0]): void {
    const quick = this.c.answer.quick?.bind(this.c.answer);
    if (this.running || !quick) return;
    this.running = quick(
      {
        turnId: this.c.turnId,
        createdAt: this.c.now,
        sources: ready.sources,
        ctx: ready.ctx,
        userMessage: this.c.userMessage,
        tz: this.c.tz,
        cut: this.cut.signal,
      },
      this.c.budget,
      this.c.emit,
    ).then(
      (r) => {
        this.result = r;
      },
      (error: unknown) => {
        this.failure = { error };
      },
    );
  }

  /**
   * Stops the section and returns what it released. Always call it before the turn moves on, so nothing is
   * emitted after the turn is persisted. A defect inside the pipeline (it must not throw) propagates from here.
   */
  async finish(): Promise<AnswerResult | null> {
    this.cut.abort();
    if (this.running) await this.running;
    if (this.failure) throw this.failure.error;
    return this.result && this.result.sentences.length > 0 ? this.result : null;
  }
}

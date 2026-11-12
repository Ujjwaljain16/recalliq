import type { AnswerPipeline, AnswerResult } from '../shared/answer.js';
import type { Ms, TurnId } from '../shared/ids.js';
import type { Logger, TurnBudget } from '../shared/infrastructure.js';
import type { EventSink } from '../shared/sse.js';
import type { LaneInput } from './lanes/types.js';
import { deterministicAnswer } from './prepare.js';

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
  /** The sentences written in code that were released before the quick section's own. */
  private opening: ReturnType<typeof deterministicAnswer> | null = null;

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

  /** How many sentences written in code were released first (the quick section is numbered after them). */
  get leadCount(): number {
    return this.opening?.sentences.length ?? 0;
  }

  start(ready: Parameters<NonNullable<LaneInput['onSourcesReady']>>[0]): void {
    const quick = this.c.answer.quick?.bind(this.c.answer);
    if (this.running || !quick) return;
    const opening = deterministicAnswer(ready.lead ?? []);
    const k = opening.sentences.length;
    if (k > 0) {
      this.opening = opening;
      for (const s of opening.sentences) {
        this.c.emit({
          event: 'answer.delta',
          data: { sentenceIndex: s.index, text: (s.index === 0 ? '' : ' ') + s.text },
        });
        this.c.emit({
          event: 'answer.sentence_end',
          data: { index: s.index, status: s.status, issues: s.issues },
        });
      }
    }
    // The quick section numbers its sentences from 0; they follow the opening ones.
    const emit: EventSink = (e) => {
      if (k === 0) return this.c.emit(e);
      switch (e.event) {
        case 'answer.delta':
          return this.c.emit({
            event: 'answer.delta',
            data: {
              sentenceIndex: e.data.sentenceIndex + k,
              text: e.data.sentenceIndex === 0 ? ' ' + e.data.text : e.data.text,
            },
          });
        case 'answer.sentence_end':
          return this.c.emit({ event: e.event, data: { ...e.data, index: e.data.index + k } });
        case 'verification':
          return this.c.emit({ event: e.event, data: { ...e.data, index: e.data.index + k } });
        default:
          return this.c.emit(e);
      }
    };
    this.running = quick(
      {
        turnId: this.c.turnId,
        createdAt: this.c.now,
        sources: ready.sources,
        ctx: ready.ctx,
        ...(ready.entities ? { entities: ready.entities } : {}),
        ...(ready.companyNames ? { companyNames: ready.companyNames } : {}),
        ...(ready.releasesChecked ? { releasesChecked: true } : {}),
        userMessage: this.c.userMessage,
        tz: this.c.tz,
        cut: this.cut.signal,
      },
      this.c.budget,
      emit,
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
    const quick = this.result && this.result.sentences.length > 0 ? this.result : null;
    const opening = this.opening;
    if (!opening) return quick;
    const k = opening.sentences.length;
    if (!quick) return { ...opening, interrupted: false };
    return {
      sentences: [
        ...opening.sentences,
        ...quick.sentences.map((x) => ({ ...x, index: x.index + k })),
      ],
      streamedThrough:
        quick.streamedThrough < quick.sentences.length - 1
          ? quick.streamedThrough + k
          : k + quick.sentences.length - 1,
      interrupted: quick.interrupted,
      template: [opening.template, quick.template].filter((t) => t !== '').join(' '),
      rendered: [opening.rendered, quick.rendered].filter((t) => t !== '').join(' '),
    };
  }
}

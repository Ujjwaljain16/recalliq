import type { AnswerPipeline } from '../../shared/answer.js';
import type { TurnAnalyzer } from '../../shared/pipeline.js';
import { FixtureMissError, type MissLog } from './replay-providers.js';

/**
 * The analyzer and the answer pipeline turn a provider error into a degraded analysis or an interrupted answer.
 * That is right for a live outage and wrong for a replay miss: a missing fixture is a defect of the fixture and
 * must stop the turn. These wrappers rethrow when the miss log grew during the call.
 */

export class StrictTurnAnalyzer implements TurnAnalyzer {
  constructor(
    private readonly inner: TurnAnalyzer,
    private readonly log: MissLog,
  ) {}

  async analyze(...args: Parameters<TurnAnalyzer['analyze']>): ReturnType<TurnAnalyzer['analyze']> {
    const before = this.log.count;
    const result = await this.inner.analyze(...args);
    if (this.log.count > before)
      throw new FixtureMissError(this.log.misses[before] ?? 'fixture miss');
    return result;
  }
}

export class StrictAnswerPipeline implements AnswerPipeline {
  constructor(
    private readonly inner: AnswerPipeline,
    private readonly log: MissLog,
  ) {}

  async run(...args: Parameters<AnswerPipeline['run']>): ReturnType<AnswerPipeline['run']> {
    const before = this.log.count;
    const result = await this.inner.run(...args);
    if (this.log.count > before)
      throw new FixtureMissError(this.log.misses[before] ?? 'fixture miss');
    return result;
  }
}

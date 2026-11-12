import {
  LlmError,
  type LlmPort,
  type LlmUsage,
  type StreamEvent,
  type StreamRequest,
  type StructuredRequest,
  type StructuredResult,
} from '../../shared/llm.js';
import type { ExtractedStatement } from '../prompts/extraction.js';
import type { CalibrationPage } from './gold.js';

/**
 * Ports for evaluation runs: one that caps and counts what goes to a real model, and one that answers with the
 * gold claims themselves (the ideal extraction), so the whole path can be exercised offline.
 */

export interface MeterTotals {
  calls: number;
  usage: LlmUsage;
}

/**
 * Wraps a port. Lowers `maxTokens` of every request to `maxOutputTokens` (a hard cap on what a run can spend on
 * output), counts calls and adds up reported usage. It never changes prompts or messages.
 */
export class MeteredLlm implements LlmPort {
  readonly totals: MeterTotals = {
    calls: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };

  constructor(
    private readonly inner: LlmPort,
    private readonly maxOutputTokens: number,
  ) {
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)
      throw new RangeError('maxOutputTokens must be a positive integer');
  }

  async structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.totals.calls += 1;
    const res = await this.inner.structured({
      ...r,
      maxTokens: Math.min(r.maxTokens, this.maxOutputTokens),
    });
    const u = this.totals.usage;
    u.inputTokens += res.usage.inputTokens;
    u.outputTokens += res.usage.outputTokens;
    u.cacheReadTokens += res.usage.cacheReadTokens;
    u.cacheWriteTokens += res.usage.cacheWriteTokens;
    return res;
  }

  stream(r: StreamRequest): AsyncIterable<StreamEvent> {
    return this.inner.stream({ ...r, maxTokens: Math.min(r.maxTokens, this.maxOutputTokens) });
  }
}

const NO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export interface OracleOptions {
  /** Answer with each claim's best-achievable quote and context where the set has one. */
  useBestAchievable?: boolean;
}

/**
 * Answers an extraction request with the gold claims of the page whose text is in the request. It is the ideal
 * extraction: the model it stands in for never errs. Used to test the evaluation path and to measure the
 * ceiling of the verifier, never as a measurement of any real model.
 */
export class OracleLlm implements LlmPort {
  constructor(
    private readonly pages: readonly CalibrationPage[],
    private readonly opts: OracleOptions = {},
  ) {}

  structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const user = r.messages.find((m) => m.role === 'user')?.content ?? '';
    const page = this.pages.find((p) => user.includes(p.page.text.slice(0, 200)));
    if (!page)
      return Promise.reject(
        new LlmError('bad_request', 'OracleLlm: no calibration page in the request'),
      );
    const statements: ExtractedStatement[] = page.gold.claims.map((c) => {
      const best = this.opts.useBestAchievable === true ? c.bestAchievable : undefined;
      return {
        sourceId: 'S1',
        entityId: 'E1',
        kind: 'price',
        plan: c.plan,
        planNorm: c.planNorm,
        value: { ...c.value },
        releaseTitle: null,
        releaseKind: null,
        conditions: c.conditions,
        quote: best?.quote ?? c.quote,
        contextQuote: best ? best.contextQuote : c.contextQuote,
        polarity: 'affirmed',
        modality: c.modality,
        effectiveFromText: null,
        eventDateText: null,
        significance: null,
        significanceReason: null,
      };
    });
    const parsed = r.schema.safeParse({ statements });
    if (!parsed.success)
      return Promise.reject(
        new LlmError('invalid_output', 'OracleLlm: gold claims fail the output schema'),
      );
    return Promise.resolve({ value: parsed.data, usage: NO_USAGE, model: 'oracle', latencyMs: 0 });
  }

  stream(): never {
    throw new LlmError('bad_request', 'OracleLlm does not stream');
  }
}

/** Replies `{statements: []}` to every request: the model that finds nothing. */
export class EmptyLlm implements LlmPort {
  structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const parsed = r.schema.safeParse({ statements: [] });
    if (!parsed.success) return Promise.reject(new LlmError('invalid_output', 'EmptyLlm: schema'));
    return Promise.resolve({ value: parsed.data, usage: NO_USAGE, model: 'empty', latencyMs: 0 });
  }

  stream(): never {
    throw new LlmError('bad_request', 'EmptyLlm does not stream');
  }
}

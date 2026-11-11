import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../../../src/config/env.js';
import { FallbackLlm, type FallbackNotice } from '../../../src/llm/fallback.js';
import {
  LlmError,
  type LlmErrorCode,
  type LlmPort,
  type StreamEvent,
  type StreamRequest,
  type StructuredRequest,
  type StructuredResult,
} from '../../../src/shared/llm.js';

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A model that either answers as `name` or fails with `code`, and optionally fails after some text. */
function model(
  name: string,
  code?: LlmErrorCode,
  failAfterText = false,
): LlmPort & { calls: number } {
  return {
    calls: 0,
    structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
      this.calls++;
      if (code) return Promise.reject(new LlmError(code, `${name} failed`));
      return Promise.resolve({
        value: r.schema.parse({ ok: name }),
        usage: USAGE,
        model: name,
        latencyMs: 1,
      });
    },
    async *stream(): AsyncIterable<StreamEvent> {
      this.calls++;
      await Promise.resolve();
      if (code && !failAfterText) throw new LlmError(code, `${name} failed`);
      yield { type: 'delta', text: `${name} says hi.` };
      if (code) throw new LlmError(code, `${name} failed`);
      yield { type: 'done', usage: USAGE, model: name, ttftMs: 1, latencyMs: 1 };
    },
  };
}

function structuredRequest(
  signal = new AbortController().signal,
): StructuredRequest<{ ok: string }> {
  return {
    role: 'analysis',
    system: 's',
    messages: [{ role: 'user', content: 'q' }],
    schema: z.object({ ok: z.string() }),
    schemaName: 't',
    maxTokens: 10,
    signal,
  };
}

const streamRequest = (signal = new AbortController().signal): StreamRequest => ({
  role: 'synthesis',
  system: 's',
  messages: [{ role: 'user', content: 'q' }],
  maxTokens: 10,
  signal,
});

async function collect(it: AsyncIterable<StreamEvent>): Promise<string> {
  let text = '';
  for await (const ev of it) if (ev.type === 'delta') text += ev.text;
  return text;
}

function setup(
  primary: LlmPort,
  fallback: LlmPort,
): { llm: FallbackLlm; notices: FallbackNotice[] } {
  const notices: FallbackNotice[] = [];
  const llm = new FallbackLlm(primary, fallback, { primary: 'main', fallback: 'lite' }, (n) =>
    notices.push(n),
  );
  return { llm, notices };
}

describe('model fallback', () => {
  it.each<LlmErrorCode>(['rate_limited', 'unavailable', 'timeout'])(
    'asks the fallback once after %s and reports the switch',
    async (code) => {
      const fb = model('lite');
      const { llm, notices } = setup(model('main', code), fb);
      const r = await llm.structured(structuredRequest());
      expect(r.value.ok).toBe('lite');
      expect(r.model).toBe('lite');
      expect(fb.calls).toBe(1);
      expect(notices).toEqual([{ role: 'analysis', code, primary: 'main', fallback: 'lite' }]);
    },
  );

  it.each<LlmErrorCode>(['bad_request', 'refused', 'invalid_output', 'cancelled'])(
    'does not fall back after %s',
    async (code) => {
      const fb = model('lite');
      const { llm, notices } = setup(model('main', code), fb);
      await expect(llm.structured(structuredRequest())).rejects.toMatchObject({ code });
      expect(fb.calls).toBe(0);
      expect(notices).toEqual([]);
    },
  );

  it('does not fall back once the caller has given up', async () => {
    const ac = new AbortController();
    ac.abort();
    const fb = model('lite');
    const { llm } = setup(model('main', 'timeout'), fb);
    await expect(llm.structured(structuredRequest(ac.signal))).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(fb.calls).toBe(0);
  });

  it('uses the primary when it answers', async () => {
    const fb = model('lite');
    const { llm, notices } = setup(model('main'), fb);
    expect((await llm.structured(structuredRequest())).model).toBe('main');
    expect(await collect(llm.stream(streamRequest()))).toBe('main says hi.');
    expect(fb.calls).toBe(0);
    expect(notices).toEqual([]);
  });

  it('a stream that failed before any text continues on the fallback', async () => {
    const { llm, notices } = setup(model('main', 'unavailable'), model('lite'));
    expect(await collect(llm.stream(streamRequest()))).toBe('lite says hi.');
    expect(notices).toHaveLength(1);
  });

  it('a stream that already produced text is never stitched from two models', async () => {
    const fb = model('lite');
    const { llm } = setup(model('main', 'unavailable', true), fb);
    await expect(collect(llm.stream(streamRequest()))).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(fb.calls).toBe(0);
  });
});

describe('fallback model configuration', () => {
  it('defaults to a lighter model, can be changed or turned off, and is never the main model', () => {
    expect(loadConfig({}).gemini.fallbackModel).toBe('gemini-3.1-flash-lite');
    expect(loadConfig({ GEMINI_FALLBACK_MODEL: 'other' }).gemini.fallbackModel).toBe('other');
    expect(loadConfig({ GEMINI_FALLBACK_MODEL: 'none' }).gemini.fallbackModel).toBeUndefined();
    expect(
      loadConfig({ GEMINI_MODEL: 'gemini-3.1-flash-lite' }).gemini.fallbackModel,
    ).toBeUndefined();
  });
});

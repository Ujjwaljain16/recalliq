import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GeminiLlm, type GeminiAdapterConfig } from '../../../src/llm/gemini/adapter.js';
import { abortToError, type Sleep } from '../../../src/llm/abort.js';
import { LlmError, type StreamEvent, type StreamRequest } from '../../../src/shared/llm.js';
import {
  ManualClock,
  byteChunks,
  fakeFetch,
  fixture,
  jsonResponse,
  sseResponse,
  type Handler,
} from '../../unit/llm/fetch-helpers.js';

const SECRET = 'test-key-not-a-real-secret';
const schema = z.object({ label: z.string(), count: z.number() });

function reply(text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    ...extra,
  };
}

function make(handler: Handler, config: Partial<GeminiAdapterConfig> = {}) {
  const f = fakeFetch(handler);
  const sleeps: number[] = [];
  const sleep: Sleep = (ms, signal) => {
    sleeps.push(ms);
    return signal.aborted ? Promise.reject(abortToError(signal)) : Promise.resolve();
  };
  const clock = new ManualClock();
  const llm = new GeminiLlm({
    config: {
      apiKey: SECRET,
      model: 'model-test',
      requestTimeoutMs: 5000,
      maxRetries: 2,
      ...config,
    },
    fetch: f.fetch,
    clock,
    sleep,
    random: () => 0.5,
  });
  return { llm, calls: f.calls, sleeps, clock };
}

const sreq = (signal: AbortSignal = new AbortController().signal) => ({
  role: 'analysis' as const,
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'hi' }],
  schema,
  schemaName: 'Thing',
  maxTokens: 321,
  signal,
});

const streq = (signal: AbortSignal = new AbortController().signal): StreamRequest => ({
  role: 'synthesis',
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 99,
  signal,
});

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

async function rejection(p: Promise<unknown>): Promise<LlmError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof LlmError) return e;
    throw e;
  }
  throw new Error('expected a rejection');
}

describe('Gemini adapter: request shape', () => {
  it('uses the configured model, the key header, maxOutputTokens from the request, and no tools', async () => {
    const { llm, calls } = make(() => jsonResponse(reply('{"label":"a","count":1}')));
    await llm.structured(sreq());
    const call = calls[0];
    expect(call?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/model-test:generateContent',
    );
    expect(call?.headers['x-goog-api-key']).toBe(SECRET);
    const body = call?.body ?? {};
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('toolConfig');
    const cfg = body.generationConfig as Record<string, unknown>;
    expect(cfg.maxOutputTokens).toBe(321);
    expect(cfg.responseMimeType).toBe('application/json');
    expect(JSON.stringify(cfg.responseJsonSchema)).toContain('"label"');
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });

  it('streams from streamGenerateContent with alt=sse', async () => {
    const { llm, calls } = make(() => sseResponse([fixture('gemini-stream-basic.sse')]));
    await collect(llm.stream(streq()));
    expect(calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/model-test:streamGenerateContent?alt=sse',
    );
    expect((calls[0]?.body.generationConfig as Record<string, unknown>).maxOutputTokens).toBe(99);
    expect(calls[0]?.body).not.toHaveProperty('tools');
  });
});

describe('Gemini adapter: structured output', () => {
  it('returns the validated value and maps usage (cached split out, thoughts counted as output)', async () => {
    const { llm } = make(() => jsonResponse(fixture('gemini-generate-ok.json')));
    const r = await llm.structured(sreq());
    expect(r.value).toEqual({ label: 'alpha', count: 3 });
    expect(r.usage).toEqual({
      inputTokens: 60,
      outputTokens: 15,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
    });
    expect(r.model).toBe('model-test');
  });

  it('repairs once: second call carries the bad output and the problem; usage is summed', async () => {
    const { llm, calls } = make((_c, n) =>
      jsonResponse(reply(n === 1 ? '{"label":"a"}' : '{"label":"a","count":2}')),
    );
    const r = await llm.structured(sreq());
    expect(r.value.count).toBe(2);
    expect(calls).toHaveLength(2);
    expect(r.usage.inputTokens).toBe(20);
    const contents = calls[1]?.body.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(contents[2]?.parts[0]?.text).toContain('count');
  });

  it('gives up with invalid_output after the bounded repairs (and with maxRepairs 0 after one call)', async () => {
    const bad = () => jsonResponse(reply('not json'));
    const a = make(bad);
    expect((await rejection(a.llm.structured(sreq()))).code).toBe('invalid_output');
    expect(a.calls).toHaveLength(2);
    const b = make(bad, { maxRepairs: 0 });
    expect((await rejection(b.llm.structured(sreq()))).code).toBe('invalid_output');
    expect(b.calls).toHaveLength(1);
  });

  it('treats a code fence around the JSON as valid and a thought part as invisible', async () => {
    const body = {
      candidates: [
        {
          content: {
            parts: [{ text: 'thinking...', thought: true }, { text: '```json\n{"label":"x","count":1}\n```' }],
          },
          finishReason: 'STOP',
        },
      ],
    };
    const { llm } = make(() => jsonResponse(body));
    expect((await llm.structured(sreq())).value.label).toBe('x');
  });

  it('MAX_TOKENS is a distinct failure and is not repaired by repeating the same limit', async () => {
    const { llm, calls } = make(() =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: '{"lab' }] }, finishReason: 'MAX_TOKENS' }] }),
    );
    const e = await rejection(llm.structured(sreq()));
    expect(e.code).toBe('invalid_output');
    expect(e.message).toContain('maxOutputTokens');
    expect(calls).toHaveLength(1);
  });

  it('maps a blocked prompt and safety finishes to refused', async () => {
    const blocked = make(() => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }));
    expect((await rejection(blocked.llm.structured(sreq()))).code).toBe('refused');
    const safety = make(() =>
      jsonResponse({ candidates: [{ finishReason: 'SAFETY' }] }),
    );
    expect((await rejection(safety.llm.structured(sreq()))).code).toBe('refused');
    expect(safety.calls).toHaveLength(1);
  });

  it('maps an empty candidate list and an odd finish reason to invalid_output', async () => {
    const empty = make(() => jsonResponse({ candidates: [] }));
    expect((await rejection(empty.llm.structured(sreq()))).code).toBe('invalid_output');
    const odd = make(() => jsonResponse({ candidates: [{ finishReason: 'OTHER' }] }));
    expect((await rejection(odd.llm.structured(sreq()))).code).toBe('invalid_output');
  });
});

describe('Gemini adapter: retries, quota and backoff', () => {
  it('retries a 503 with exponential backoff and jitter, then succeeds', async () => {
    const { llm, calls, sleeps } = make((_c, n) =>
      n === 1 ? jsonResponse({ error: { code: 503, status: 'UNAVAILABLE' } }, 503) : jsonResponse(reply('{"label":"a","count":1}')),
    );
    await llm.structured(sreq());
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([500]); // random 0.5 * min(20000, 1000 * 2^0)
  });

  it('stops after maxRetries and throws the last error: never loops', async () => {
    const { llm, calls, sleeps } = make(() => jsonResponse({ error: { code: 500 } }, 500));
    const e = await rejection(llm.structured(sreq()));
    expect(e.code).toBe('unavailable');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('honours the retryDelay hint of a 429 and maps exhaustion to rate_limited with retryAfterMs', async () => {
    const { llm, sleeps } = make(() => jsonResponse(fixture('gemini-error-429.json'), 429));
    const e = await rejection(llm.structured(sreq()));
    expect(e.code).toBe('rate_limited');
    expect(e.retryAfterMs).toBe(2000);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('honours the Retry-After header', async () => {
    const { llm, sleeps } = make((_c, n) =>
      n === 1
        ? jsonResponse({ error: { code: 429 } }, 429, { 'retry-after': '3' })
        : jsonResponse(reply('{"label":"a","count":1}')),
    );
    await llm.structured(sreq());
    expect(sleeps).toEqual([3000]);
  });

  it('does not wait when the hint exceeds maxRetryWaitMs, and does not retry a daily quota', async () => {
    const long = make(() => jsonResponse({ error: { code: 429 } }, 429, { 'retry-after': '60' }));
    const e = await rejection(long.llm.structured(sreq()));
    expect(e.code).toBe('rate_limited');
    expect(e.retryAfterMs).toBe(60000);
    expect(long.calls).toHaveLength(1);
    expect(long.sleeps).toEqual([]);

    const daily = make(() =>
      jsonResponse({ error: { code: 429, message: 'Quota exceeded: requests per day', status: 'RESOURCE_EXHAUSTED' } }, 429),
    );
    expect((await rejection(daily.llm.structured(sreq()))).code).toBe('rate_limited');
    expect(daily.calls).toHaveLength(1);
  });

  it('does not retry a client error', async () => {
    const { llm, calls } = make(() => jsonResponse({ error: { code: 400, message: 'bad' } }, 400));
    expect((await rejection(llm.structured(sreq()))).code).toBe('bad_request');
    expect(calls).toHaveLength(1);
    const denied = make(() => jsonResponse({ error: { code: 403 } }, 403));
    expect((await rejection(denied.llm.structured(sreq()))).code).toBe('unavailable');
    expect(denied.calls).toHaveLength(1);
  });

  it('never retries past the caller signal: abort during backoff cancels', async () => {
    const controller = new AbortController();
    const f = fakeFetch(() => jsonResponse({ error: { code: 503 } }, 503));
    const llm = new GeminiLlm({
      config: { apiKey: SECRET, model: 'm', requestTimeoutMs: 5000, maxRetries: 5 },
      fetch: f.fetch,
      clock: new ManualClock(),
      sleep: (_ms, signal) => {
        controller.abort(new Error('deadline'));
        return signal.aborted ? Promise.reject(abortToError(signal)) : Promise.resolve();
      },
      random: () => 0.5,
    });
    const e = await rejection(llm.structured(sreq(controller.signal)));
    expect(e.code).toBe('cancelled');
    expect(f.calls).toHaveLength(1);
  });

  it('there is no provider fallback: every request goes to the one configured host', async () => {
    const { llm, calls } = make(() => jsonResponse({ error: { code: 500 } }, 500));
    await rejection(llm.structured(sreq()));
    expect(new Set(calls.map((c) => new URL(c.url).host))).toEqual(
      new Set(['generativelanguage.googleapis.com']),
    );
  });
});

describe('Gemini adapter: timeout and abort', () => {
  it('a hung request times out per attempt (retryable), then reports timeout', async () => {
    const hang: Handler = (c) =>
      new Promise<Response>((_res, rej) => {
        c.signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
      });
    const { llm, calls } = make(hang, { requestTimeoutMs: 15, maxRetries: 1 });
    const e = await rejection(llm.structured(sreq()));
    expect(e.code).toBe('timeout');
    expect(calls).toHaveLength(2);
  });

  it('a pre-aborted signal makes no request', async () => {
    const c = new AbortController();
    c.abort(new Error('deadline'));
    const { llm, calls } = make(() => jsonResponse(reply('{}')));
    expect((await rejection(llm.structured(sreq(c.signal)))).code).toBe('cancelled');
    expect(calls).toHaveLength(0);
  });

  it('abort wins over a fetch that ignores the signal', async () => {
    const c = new AbortController();
    const { llm } = make(() => new Promise<Response>(() => undefined));
    const p = rejection(llm.structured(sreq(c.signal)));
    c.abort(new Error('deadline'));
    expect((await p).code).toBe('cancelled');
  });

  it('a TimeoutError reason on the caller signal is reported as timeout', async () => {
    const { llm } = make(() => new Promise<Response>(() => undefined));
    const p = rejection(llm.structured(sreq(AbortSignal.timeout(10))));
    expect((await p).code).toBe('timeout');
  });
});

describe('Gemini adapter: streaming', () => {
  it('yields text deltas (thought parts and empty text dropped), then done with usage and ttft', async () => {
    const { llm, clock } = make(() => {
      const chunks = byteChunks(fixture('gemini-stream-basic.sse'), 7); // cuts events and the euro sign
      clock.advance(0);
      return sseResponse(chunks);
    });
    const events = await collect(llm.stream(streq()));
    const text = events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
    expect(text).toBe('Hello €uro world.');
    const done = events[events.length - 1];
    expect(done).toMatchObject({
      type: 'done',
      model: 'model-test',
      usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 10 },
    });
  });

  it('measures ttft and latency with the injected clock', async () => {
    const clock = new ManualClock(0);
    const enc = new TextEncoder();
    const parts = [
      'data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}\n\n',
      'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
    ];
    let i = 0;
    const f = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              clock.advance(100);
              const p = parts[i++];
              if (p === undefined) controller.close();
              else controller.enqueue(enc.encode(p));
            },
          }, { highWaterMark: 0 }),
        ),
    );
    const llm = new GeminiLlm({
      config: { apiKey: SECRET, model: 'm', requestTimeoutMs: 5000, maxRetries: 0 },
      fetch: f.fetch,
      clock,
    });
    const events = await collect(llm.stream(streq()));
    expect(events[events.length - 1]).toMatchObject({ type: 'done', ttftMs: 100, latencyMs: 300 });
  });

  it('delivers the text of a MAX_TOKENS stream, then fails as invalid_output', async () => {
    const { llm } = make(() =>
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"cut"}]}}]}\n\n',
        'data: {"candidates":[{"finishReason":"MAX_TOKENS"}]}\n\n',
      ]),
    );
    const got: string[] = [];
    let code = '';
    try {
      for await (const e of llm.stream(streq())) if (e.type === 'delta') got.push(e.text);
    } catch (e) {
      code = e instanceof LlmError ? e.code : 'other';
    }
    expect(got).toEqual(['cut']);
    expect(code).toBe('invalid_output');
  });

  it('an error object inside the stream is typed and ends the stream; no retry after a delta', async () => {
    const { llm, calls } = make(() =>
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n\n',
        'data: {"error":{"code":503,"message":"overloaded","status":"UNAVAILABLE"}}\n\n',
      ]),
    );
    const got: string[] = [];
    let code = '';
    try {
      for await (const e of llm.stream(streq())) if (e.type === 'delta') got.push(e.text);
    } catch (e) {
      code = e instanceof LlmError ? e.code : 'other';
    }
    expect(got).toEqual(['x']);
    expect(code).toBe('unavailable');
    expect(calls).toHaveLength(1);
  });

  it('a stream that ends without a finish reason is unavailable (truncated)', async () => {
    const { llm } = make(
      () => sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n\n']),
      { maxRetries: 0 },
    );
    expect((await rejection(collect(llm.stream(streq())))).code).toBe('unavailable');
  });

  it('retries a stream only before its first delta', async () => {
    const { llm, calls } = make((_c, n) =>
      n === 1
        ? jsonResponse({ error: { code: 503 } }, 503)
        : sseResponse([
            'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n',
          ]),
    );
    const events = await collect(llm.stream(streq()));
    expect(calls).toHaveLength(2);
    expect(events.filter((e) => e.type === 'delta')).toHaveLength(1);
  });

  it('a safety stop mid-stream is refused; a blocked prompt chunk is refused', async () => {
    const a = make(() =>
      sseResponse(['data: {"candidates":[{"finishReason":"SAFETY"}]}\n\n']),
    );
    expect((await rejection(collect(a.llm.stream(streq())))).code).toBe('refused');
    const b = make(() => sseResponse(['data: {"promptFeedback":{"blockReason":"OTHER"}}\n\n']));
    expect((await rejection(collect(b.llm.stream(streq())))).code).toBe('refused');
  });

  it('abort mid-stream ends the iterator even if the body never ends', async () => {
    const c = new AbortController();
    const { llm } = make(() =>
      sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n\n'], 'hang'),
    );
    const got: string[] = [];
    const run = (async () => {
      for await (const e of llm.stream(streq(c.signal))) {
        if (e.type === 'delta') {
          got.push(e.text);
          c.abort(new Error('deadline'));
        }
      }
    })();
    expect((await rejection(run)).code).toBe('cancelled');
    expect(got).toEqual(['x']);
  });

  it('a malformed chunk is unavailable and carries no key', async () => {
    const { llm } = make(() => sseResponse(['data: {oops\n\n']), { maxRetries: 0 });
    const e = await rejection(collect(llm.stream(streq())));
    expect(e.code).toBe('unavailable');
    expect(e.message).not.toContain(SECRET);
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GeminiLlm } from '../../../src/llm/gemini/adapter.js';
import { ExaSearchAdapter } from '../../../src/search/exa-adapter.js';
import { SystemClock } from '../../../src/temporal/clock.js';

/**
 * Gated smoke tests against the real providers. They are skipped unless the variables are present in
 * process.env (no .env file is read here), use only synthetic prompts, and make at most two provider calls each.
 * They show that an adapter can talk to its provider; they do not show that the product works.
 */
const gemini = process.env['GEMINI_API_KEY'] && process.env['GEMINI_MODEL'];
const exa = process.env['EXA_API_KEY'];

describe.skipIf(!gemini)('live smoke: Gemini adapter (at most 2 calls)', () => {
  it('returns a structured reply and a short stream for a synthetic prompt', async () => {
    const llm = new GeminiLlm({
      config: {
        apiKey: process.env['GEMINI_API_KEY'] ?? '',
        model: process.env['GEMINI_MODEL'] ?? '',
        requestTimeoutMs: 20_000,
        maxRetries: 0,
      },
      fetch,
      clock: new SystemClock(),
    });
    const signal = AbortSignal.timeout(30_000);
    const structured = await llm.structured({
      role: 'analysis',
      system: 'Reply with the JSON object the schema asks for.',
      messages: [{ role: 'user', content: '[SYNTHETIC] Say ok.' }],
      schema: z.object({ reply: z.string() }),
      schemaName: 'SmokeReply',
      maxTokens: 50,
      signal,
    });
    expect(typeof structured.value.reply).toBe('string');

    let text = '';
    for await (const e of llm.stream({
      role: 'synthesis',
      system: 'Answer in one short sentence.',
      messages: [{ role: 'user', content: '[SYNTHETIC] Say hello.' }],
      maxTokens: 50,
      signal,
    })) {
      if (e.type === 'delta') text += e.text;
    }
    expect(text.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!exa)('live smoke: Exa adapter (at most 2 calls)', () => {
  it('answers one synthetic query with a normalised response', async () => {
    const search = new ExaSearchAdapter({
      apiKey: process.env['EXA_API_KEY'] ?? '',
      fetch: (input, init) => fetch(input, init),
      clock: new SystemClock(),
    });
    const res = await search.search(
      {
        query: '[SYNTHETIC] example domain',
        numResults: 1,
        freshness: 'cached',
        contentMode: 'highlights',
        contentChars: 500,
      },
      AbortSignal.timeout(30_000),
    );
    expect(res.provider).toBe('exa');
    expect(Array.isArray(res.hits)).toBe(true);
  });
});

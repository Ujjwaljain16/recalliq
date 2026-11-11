import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GeminiLlm } from '../../../src/llm/gemini/adapter.js';
import { geminiConfigFromApp } from '../../../src/llm/gemini/config.js';
import { ClientLimiter, DEFAULT_LIMITER } from '../../../src/llm/limiter.js';
import { realSleep } from '../../../src/llm/abort.js';

/**
 * LIVE tests: they run only when GEMINI_API_KEY and GEMINI_MODEL are in process.env (never read from a file,
 * never printed). Otherwise they are reported as skipped. They send only the SYNTHETIC text below: free-tier
 * prompts may be used by the provider, so no real or private data may ever be placed here. Two calls in total.
 */
const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL;
const enabled = Boolean(key && model);

// Generous per-test timeout: the adapter's own limiter enforces a 4 s spacing between requests, which alone
// exceeds vitest's default 5 s for the second call. Production turn deadlines are separate and unaffected.
const LIVE_TEST_TIMEOUT_MS = 60_000;

describe.skipIf(!enabled)('Gemini live (SYNTHETIC prompts, 2 calls)', () => {
  // Built lazily: a skipped suite still runs its body, and the config throws without a key.
  const build = (): GeminiLlm =>
    new GeminiLlm({
      config: geminiConfigFromApp({ gemini: { model }, secrets: { geminiApiKey: key } }),
      fetch,
      clock: { now: () => Date.now() },
      limiter: new ClientLimiter(DEFAULT_LIMITER, {
        clock: { now: () => Date.now() },
        sleep: realSleep,
      }),
    });
  let shared: GeminiLlm | undefined;
  const get = (): GeminiLlm => (shared ??= build());
  const signal = (): AbortSignal => AbortSignal.timeout(60_000);

  it(
    'structured: returns JSON that passes the zod schema',
    async () => {
      const r = await get().structured({
        role: 'analysis',
        system: 'Extract the product name and whether the price is flat. Reply as JSON.',
        messages: [
          { role: 'user', content: '[SYNTHETIC] ExampleCo Widget costs a flat fee each month.' },
        ],
        schema: z.object({ product: z.string(), flat: z.boolean() }),
        schemaName: 'LiveProbe',
        maxTokens: 200,
        signal: signal(),
      });
      expect(r.value.product.length).toBeGreaterThan(0);
      expect(r.usage.inputTokens + r.usage.cacheReadTokens).toBeGreaterThan(0);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it(
    'stream: yields at least one delta and a done event',
    async () => {
      let deltas = 0;
      let done = false;
      for await (const e of get().stream({
        role: 'synthesis',
        system: 'Answer in one short sentence.',
        messages: [{ role: 'user', content: '[SYNTHETIC] Say hello to ExampleCo.' }],
        maxTokens: 100,
        signal: signal(),
      })) {
        if (e.type === 'delta') deltas++;
        else done = true;
      }
      expect(deltas).toBeGreaterThan(0);
      expect(done).toBe(true);
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});

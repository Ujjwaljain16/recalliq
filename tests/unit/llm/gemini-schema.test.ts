import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractionOutputSchema } from '../../../src/evidence/prompts/extraction.js';
import { toGeminiJsonSchema } from '../../../src/llm/gemini/wire.js';

/** Every key that appears anywhere in a JSON schema. */
function keysOf(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => keysOf(n, found));
  else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      found.add(k);
      keysOf(v, found);
    }
  }
  return found;
}

// The real API rejected a schema containing these with HTTP 400 INVALID_ARGUMENT (observed 2026-11-12), although
// they are documented as supported. They must never be sent; the zod schema enforces them on the response.
const REJECTED = ['maxItems', 'minItems', 'minimum', 'maximum'];

describe('Gemini response schema', () => {
  it('drops the keywords the real API rejected, however they were written in zod', () => {
    const schema = z.object({
      list: z.array(z.string()).min(1).max(5),
      amount: z.number().min(0).max(1000),
    });
    const keys = keysOf(toGeminiJsonSchema(schema));
    for (const k of REJECTED) expect(keys.has(k), k).toBe(false);
    // The structure itself is kept.
    expect(keys.has('items')).toBe(true);
    expect(keys.has('properties')).toBe(true);
  });

  it('the evidence extraction schema (the one that failed against the real API) contains none of them', () => {
    const keys = keysOf(toGeminiJsonSchema(extractionOutputSchema));
    for (const k of REJECTED) expect(keys.has(k), k).toBe(false);
  });

  it('local validation still enforces the dropped limits', () => {
    const schema = z.object({ list: z.array(z.string()).max(2) });
    expect(schema.safeParse({ list: ['a', 'b', 'c'] }).success).toBe(false);
  });
});

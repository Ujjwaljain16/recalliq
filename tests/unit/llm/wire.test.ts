import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmError } from '../../../src/shared/llm.js';
import {
  buildRequestBody,
  errorFromHttp,
  normalizeMessages,
  parseMessageResponse,
  parseRetryAfter,
  parseStreamEvent,
  toProviderJsonSchema,
} from '../../../src/llm/anthropic/wire.js';

describe('toProviderJsonSchema', () => {
  const schema = z.object({
    name: z.string().min(1).max(40),
    count: z.number().int().min(0).max(5),
    tags: z.array(z.string()).max(3),
    kind: z.enum(['a', 'b']),
    note: z.string().nullable(),
    byKey: z.record(z.string(), z.number()),
  });

  it('removes constraints the structured-output subset rejects, keeps the structure', () => {
    const out = JSON.stringify(toProviderJsonSchema(schema));
    for (const k of ['minLength', 'maxLength', 'minimum', 'maximum', 'maxItems', '$schema']) {
      expect(out).not.toContain(`"${k}"`);
    }
    expect(out).toContain('"enum":["a","b"]');
    expect(out).toContain('"additionalProperties":false');
    expect(out).toContain('"required"');
  });

  it('keeps a property that is merely called like a keyword', () => {
    const s = z.object({ maximum: z.number(), format: z.string() });
    const props = toProviderJsonSchema(s).properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['maximum', 'format']);
  });
});

describe('buildRequestBody', () => {
  it('omits optional controls that the tier does not set and never forces a tool', () => {
    const body = buildRequestBody({
      tier: { model: 'm' },
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 10,
      stream: false,
    });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('output_config');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('stream');
  });
});

describe('normalizeMessages', () => {
  it('merges consecutive turns and fronts a leading assistant turn without dropping content', () => {
    expect(
      normalizeMessages([
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u1' },
        { role: 'user', content: 'u2' },
      ]),
    ).toEqual([
      { role: 'user', content: '(conversation start)' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u1\n\nu2' },
    ]);
  });
});

describe('parseRetryAfter / errorFromHttp', () => {
  it('reads seconds, rejects dates and garbage', () => {
    expect(parseRetryAfter('30')).toBe(30000);
    expect(parseRetryAfter('1.5')).toBe(1500);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it.each([
    [429, 'rate_limit_error', 'rate_limited'],
    [529, 'overloaded_error', 'unavailable'],
    [500, 'api_error', 'unavailable'],
    [504, 'timeout_error', 'timeout'],
    [400, 'invalid_request_error', 'bad_request'],
    [404, 'not_found_error', 'bad_request'],
    [401, 'authentication_error', 'unavailable'],
    [402, 'billing_error', 'unavailable'],
  ] as const)('HTTP %i %s maps to %s', (status, type, code) => {
    const body = JSON.stringify({ type: 'error', error: { type, message: 'm' } });
    const e = errorFromHttp(status, body, null);
    expect(e).toBeInstanceOf(LlmError);
    expect(e.code).toBe(code);
  });

  it('classifies by status alone when the body is not JSON', () => {
    expect(errorFromHttp(502, '<html>bad gateway</html>', null).code).toBe('unavailable');
    expect(errorFromHttp(418, 'teapot', null).code).toBe('bad_request');
  });
});

describe('parseMessageResponse / parseStreamEvent', () => {
  it('joins text blocks and ignores others', () => {
    const m = parseMessageResponse({
      content: [{ type: 'thinking' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(m.text).toBe('ab');
    expect(m.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('rejects a body that is not a message', () => {
    expect(() => parseMessageResponse({ nope: 1 })).toThrow(LlmError);
  });

  it('throws a typed error for an error event and for malformed JSON, ignores unknown types', () => {
    const overloaded = '{"type":"error","error":{"type":"overloaded_error"}}';
    expect(() => parseStreamEvent({ event: 'error', data: overloaded })).toThrow(LlmError);
    expect(() => parseStreamEvent({ event: 'message_delta', data: '{oops' })).toThrow(LlmError);
    expect(parseStreamEvent({ event: 'x', data: '{"type":"brand_new"}' })).toEqual({
      type: 'ignored',
    });
    expect(parseStreamEvent({ event: 'ping', data: '{"type":"ping"}' })).toEqual({
      type: 'ignored',
    });
  });
});

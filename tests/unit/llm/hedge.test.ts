import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FallbackLlm, type FallbackNotice, type HedgePolicy } from '../../../src/llm/fallback.js';
import {
  LlmError,
  type LlmErrorCode,
  type LlmPort,
  type StructuredRequest,
  type StructuredResult,
} from '../../../src/shared/llm.js';

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A model that answers as `name` after `ms`, or fails with `code`; records whether its call was aborted. */
function slow(name: string, ms: number, code?: LlmErrorCode) {
  const m = {
    calls: 0,
    aborted: 0,
    structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
      m.calls++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          if (code) reject(new LlmError(code, `${name} failed`));
          else
            resolve({
              value: r.schema.parse({ ok: name }),
              usage: USAGE,
              model: name,
              latencyMs: ms,
            });
        }, ms);
        r.signal.addEventListener('abort', () => {
          m.aborted++;
          clearTimeout(t);
          reject(new LlmError('cancelled', 'aborted'));
        });
      });
    },
    stream(): never {
      throw new Error('not used');
    },
  };
  return m as typeof m & LlmPort;
}

const req = (role = 'extraction'): StructuredRequest<{ ok: string }> => ({
  role: role as StructuredRequest<{ ok: string }>['role'],
  system: 's',
  messages: [{ role: 'user', content: 'q' }],
  schema: z.object({ ok: z.string() }),
  schemaName: 't',
  maxTokens: 10,
  signal: new AbortController().signal,
});

function setup(primary: LlmPort, fallback: LlmPort, ready = true) {
  const notices: FallbackNotice[] = [];
  const hedge: HedgePolicy = {
    afterMs: (role) => (role === 'extraction' ? 20 : null),
    ready: () => ready,
  };
  const llm = new FallbackLlm(
    primary,
    fallback,
    { primary: 'main', fallback: 'lite' },
    (n) => notices.push(n),
    () => false,
    hedge,
  );
  return { llm, notices };
}

describe('hedged structured calls', () => {
  it('a slow primary is overtaken by the fallback, and the primary call is aborted', async () => {
    const p = slow('main', 300);
    const f = slow('lite', 10);
    const { llm, notices } = setup(p, f);
    const out = await llm.structured(req());
    expect(out.value.ok).toBe('lite');
    expect(p.aborted).toBe(1);
    expect(notices).toHaveLength(1);
  });

  it('a fast primary answers alone: no second call', async () => {
    const p = slow('main', 5);
    const f = slow('lite', 5);
    const { llm, notices } = setup(p, f);
    expect((await llm.structured(req())).value.ok).toBe('main');
    expect(f.calls).toBe(0);
    expect(notices).toHaveLength(0);
  });

  it('the primary wins when it answers first after the hedge started; the fallback is aborted', async () => {
    const p = slow('main', 40);
    const f = slow('lite', 300);
    const { llm } = setup(p, f);
    expect((await llm.structured(req())).value.ok).toBe('main');
    expect(f.calls).toBe(1);
    expect(f.aborted).toBe(1);
  });

  it('no hedge when the fallback has no quota to spare, or for a role without a hedge', async () => {
    const p = slow('main', 60);
    const f = slow('lite', 5);
    expect((await setup(p, f, false).llm.structured(req())).value.ok).toBe('main');
    expect((await setup(p, f).llm.structured(req('analysis'))).value.ok).toBe('main');
    expect(f.calls).toBe(0);
  });

  it('a primary that fails over to the fallback still works, and both failing reports the primary error', async () => {
    const { llm } = setup(slow('main', 5, 'unavailable'), slow('lite', 5));
    expect((await llm.structured(req())).value.ok).toBe('lite');
    const both = setup(slow('main', 5, 'unavailable'), slow('lite', 5, 'rate_limited')).llm;
    await expect(both.structured(req())).rejects.toMatchObject({ code: 'unavailable' });
    const bad = setup(slow('main', 5, 'invalid_output'), slow('lite', 5)).llm;
    await expect(bad.structured(req())).rejects.toMatchObject({ code: 'invalid_output' });
  });
});

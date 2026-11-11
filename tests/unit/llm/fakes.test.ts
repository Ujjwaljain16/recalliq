import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeLlm } from '../../../src/llm/fake.js';
import { RecordingLlm, ReplayLlm, ReplayMissError, requestKey } from '../../../src/llm/replay.js';
import { LlmError, type StreamRequest, type StructuredRequest } from '../../../src/shared/llm.js';

const schema = z.object({ a: z.number() });
const sig = new AbortController().signal;
const sreq = (content: string): StructuredRequest<{ a: number }> => ({
  role: 'judge',
  system: 's',
  messages: [{ role: 'user', content }],
  schema,
  schemaName: 'T',
  maxTokens: 10,
  signal: sig,
});
const streq = (content: string): StreamRequest => ({
  role: 'synthesis',
  system: 's',
  messages: [{ role: 'user', content }],
  maxTokens: 10,
  signal: sig,
});

describe('FakeLlm', () => {
  it('replays queued values validated by the request schema, and queued errors', async () => {
    const fake = new FakeLlm().queueStructured({ a: 1 }, new LlmError('unavailable', 'down'), {
      a: 'x',
    });
    expect((await fake.structured(sreq('q'))).value).toEqual({ a: 1 });
    await expect(fake.structured(sreq('q'))).rejects.toMatchObject({ code: 'unavailable' });
    await expect(fake.structured(sreq('q'))).rejects.toMatchObject({ code: 'invalid_output' });
    expect(fake.structuredCalls).toHaveLength(3);
  });

  it('streams scripted deltas and fails or hangs as scripted', async () => {
    const fake = new FakeLlm().queueStream(
      { deltas: ['a', 'b'] },
      { deltas: ['c'], failWith: new LlmError('timeout', 't') },
    );
    const got: string[] = [];
    for await (const e of fake.stream(streq('q'))) if (e.type === 'delta') got.push(e.text);
    expect(got).toEqual(['a', 'b']);
    const run = async (): Promise<void> => {
      for await (const e of fake.stream(streq('q'))) void e;
    };
    await expect(run()).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('ReplayLlm / RecordingLlm', () => {
  it('replays what was recorded, and a miss throws ReplayMissError (never a live call)', async () => {
    const fake = new FakeLlm().queueStructured({ a: 7 }).queueStream({ deltas: ['x', 'y'] });
    const rec = new RecordingLlm(fake, {});
    await rec.structured(sreq('one'));
    for await (const e of rec.stream(streq('two'))) void e;

    const replay = new ReplayLlm(JSON.parse(JSON.stringify(rec.store)) as typeof rec.store);
    expect((await replay.structured(sreq('one'))).value).toEqual({ a: 7 });
    const deltas: string[] = [];
    for await (const e of replay.stream(streq('two'))) if (e.type === 'delta') deltas.push(e.text);
    expect(deltas).toEqual(['x', 'y']);

    await expect(replay.structured(sreq('other'))).rejects.toBeInstanceOf(ReplayMissError);
    const miss = async (): Promise<void> => {
      for await (const e of replay.stream(streq('other'))) void e;
    };
    await expect(miss()).rejects.toBeInstanceOf(ReplayMissError);
  });

  it('keys differ by kind, role, system, messages and limits but not by signal', () => {
    const base = {
      role: 'judge',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 1,
    };
    const k = requestKey('structured', base);
    expect(requestKey('stream', base)).not.toBe(k);
    expect(requestKey('structured', { ...base, system: 't' })).not.toBe(k);
    expect(requestKey('structured', { ...base, maxTokens: 2 })).not.toBe(k);
    expect(requestKey('structured', { ...base })).toBe(k);
  });
});

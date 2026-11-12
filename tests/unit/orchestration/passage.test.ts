import { describe, expect, it } from 'vitest';
import { passageOf } from '../../../src/db/repositories/memory-retriever.js';

describe('passageOf', () => {
  it('returns a short message whole', () => {
    expect(passageOf('I started the Ferrari kit first.', ['ferrari'], 900)).toBe(
      'I started the Ferrari kit first.',
    );
  });

  it('centres a long message on the words searched for and marks both cut ends', () => {
    const text = `${'filler '.repeat(300)}the Porsche kit came later ${'padding '.repeat(300)}`;
    const p = passageOf(text, ['porsche', 'kit'], 200);
    expect(p).toContain('Porsche kit came later');
    expect(p.startsWith('…')).toBe(true);
    expect(p.endsWith('…')).toBe(true);
    expect(Array.from(p).length).toBeLessThanOrEqual(200);
  });

  it('prefers the window with more distinct searched words', () => {
    const text = `ferrari ${'x '.repeat(400)}porsche ferrari kit ${'y '.repeat(400)}`;
    expect(passageOf(text, ['ferrari', 'porsche', 'kit'], 120)).toContain('porsche ferrari kit');
  });

  it('falls back to the start when no word matches', () => {
    const p = passageOf(`alpha ${'beta '.repeat(300)}`, ['zzzz'], 100);
    expect(p.startsWith('alpha beta')).toBe(true);
  });
});

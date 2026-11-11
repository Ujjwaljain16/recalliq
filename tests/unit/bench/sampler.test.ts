import { describe, expect, it } from 'vitest';
import type {
  BenchItem,
  FreshQaItem,
  LongMemEvalItem,
  SimpleQaItem,
} from '../../../scripts/bench/datasets.js';
import { allocate, drawSamples, manifestEntry, stratumOf } from '../../../scripts/bench/sampler.js';

const source = { file: 'fixture.csv', sha256: 'abc' };
const sizes = { dev: 30, test: 100 };

function simpleQa(n: number): SimpleQaItem[] {
  const topics = ['Art', 'Geography', 'History', 'Music', 'Sports', 'Video games'];
  const weights = [30, 25, 10, 20, 12, 3];
  const items: SimpleQaItem[] = [];
  let i = 0;
  topics.forEach((topic, t) => {
    const count = Math.round((n * (weights[t] ?? 0)) / 100);
    for (let k = 0; k < count; k++, i++) {
      items.push({
        dataset: 'simpleqa',
        id: `simpleqa-${i}`,
        question: `q${i}`,
        answer: `a${i}`,
        topic,
        answerType: 'Other',
      });
    }
  });
  return items;
}

function freshQa(): FreshQaItem[] {
  const items: FreshQaItem[] = [];
  const types = ['never-changing', 'slow-changing', 'fast-changing'] as const;
  for (let i = 0; i < 600; i++) {
    items.push({
      dataset: 'freshqa',
      id: `freshqa-${i}`,
      split: i < 500 ? 'TEST' : 'DEV',
      question: `q${i}`,
      answers: ['a'],
      falsePremise: i % 5 === 0,
      factType: types[i % 3] ?? 'never-changing',
      numHops: 'one-hop',
      effectiveYear: '2024',
      nextReview: 'occasionally',
    });
  }
  return items;
}

function longMem(): LongMemEvalItem[] {
  const types: Array<[string, number, number]> = [
    ['temporal-reasoning', 127, 6],
    ['multi-session', 121, 12],
    ['knowledge-update', 72, 6],
    ['single-session-preference', 30, 0],
    ['single-session-assistant', 56, 0],
    ['single-session-user', 64, 6],
  ];
  const items: LongMemEvalItem[] = [];
  for (const [type, normal, abs] of types) {
    for (let k = 0; k < normal + abs; k++) {
      const id = `${type}-${k}${k >= normal ? '_abs' : ''}`;
      items.push({
        dataset: 'longmemeval',
        id,
        questionType: type,
        abstention: k >= normal,
        question: 'q',
        answer: 'a',
        questionAt: 0,
        questionDate: '',
        sessions: [],
        answerSessionIds: [],
      });
    }
  }
  return items;
}

const ids = (items: readonly BenchItem[]): string[] => items.map((i) => i.id);

describe('allocate', () => {
  it('is proportional, sums to n and gives every stratum at least one', () => {
    const alloc = allocate(30, [858, 424, 368, 550, 709, 475, 293, 341, 173, 135]);
    expect(alloc.reduce((a, b) => a + b, 0)).toBe(30);
    expect(Math.min(...alloc)).toBeGreaterThanOrEqual(1);
    expect(alloc[0]).toBeGreaterThan(alloc[9] ?? 0);
  });

  it('never exceeds a capacity and stops at the total capacity', () => {
    expect(allocate(10, [2, 1, 50], [50, 1, 1])).toEqual([2, 1, 7]);
    expect(allocate(100, [3, 4])).toEqual([3, 4]);
  });

  it('gives the largest strata one each when n is smaller than the number of strata', () => {
    expect(allocate(2, [5, 50, 20])).toEqual([0, 1, 1]);
  });
});

describe('drawSamples', () => {
  it('is deterministic for a seed, independent of input order, and changes with the seed', () => {
    const items = simpleQa(1000);
    const a = drawSamples('simpleqa', items, { seed: 's1', sizes, source });
    const b = drawSamples('simpleqa', [...items].reverse(), { seed: 's1', sizes, source });
    const c = drawSamples('simpleqa', items, { seed: 's2', sizes, source });
    expect(a.test.ids).toEqual(b.test.ids);
    expect(a.dev.ids).toEqual(b.dev.ids);
    expect(c.test.ids).not.toEqual(a.test.ids);
  });

  it('keeps dev and test disjoint and the test sample stable when the dev size changes', () => {
    const items = simpleQa(1000);
    const a = drawSamples('simpleqa', items, { seed: 's1', sizes, source });
    const b = drawSamples('simpleqa', items, { seed: 's1', sizes: { dev: 50, test: 100 }, source });
    const overlap = a.dev.ids.filter((id) => a.test.ids.includes(id));
    expect(overlap).toEqual([]);
    expect(a.dev.n).toBe(30);
    expect(a.test.n).toBe(100);
    expect(b.test.ids).toEqual(a.test.ids);
  });

  it('stratifies SimpleQA by topic in proportion to the pool', () => {
    const { test } = drawSamples('simpleqa', simpleQa(1000), { seed: 's1', sizes, source });
    expect(Object.keys(test.strata).sort()).toEqual([
      'Art',
      'Geography',
      'History',
      'Music',
      'Sports',
      'Video games',
    ]);
    expect(test.strata['Art']).toBe(30);
    expect(test.strata['Video games']).toBe(3);
  });

  it('draws FreshQA test from its TEST split and dev from its DEV split, by fact type and premise', () => {
    const items = freshQa();
    const { dev, test } = drawSamples('freshqa', items, { seed: 's1', sizes, source });
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(test.ids.every((id) => byId.get(id)?.split === 'TEST')).toBe(true);
    expect(dev.ids.every((id) => byId.get(id)?.split === 'DEV')).toBe(true);
    expect(Object.keys(test.strata)).toHaveLength(6);
    expect(Object.keys(test.strata)).toContain('fast-changing/false-premise');
  });

  it('stratifies LongMemEval by question type with abstention as its own strata', () => {
    const { dev, test } = drawSamples('longmemeval', longMem(), { seed: 's1', sizes, source });
    const abstention = Object.entries(test.strata).filter(([k]) => k.endsWith('/abstention'));
    expect(abstention.map(([k]) => k).sort()).toEqual([
      'knowledge-update/abstention',
      'multi-session/abstention',
      'single-session-user/abstention',
      'temporal-reasoning/abstention',
    ]);
    expect(Object.keys(dev.strata)).toHaveLength(10);
    const counted: Record<string, number> = {};
    for (const item of test.items) counted[stratumOf(item)] = (counted[stratumOf(item)] ?? 0) + 1;
    expect(counted).toEqual(test.strata);
    expect(ids(dev.items).filter((id) => test.ids.includes(id))).toEqual([]);
  });

  it('puts ids, seed and checksums in the manifest entry, never question or answer text', () => {
    const { test } = drawSamples('simpleqa', simpleQa(200), { seed: 's1', sizes, source });
    const entry = manifestEntry(test);
    expect(Object.keys(entry).sort()).toEqual([
      'dataset',
      'ids',
      'n',
      'seed',
      'source',
      'split',
      'strata',
    ]);
    expect(JSON.stringify(entry)).not.toMatch(/"q\d+"|"a\d+"/);
  });
});

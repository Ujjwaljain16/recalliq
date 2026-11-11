import { describe, expect, it } from 'vitest';
import { LlmAnswerPipeline } from '../../../src/answer/pipeline.js';
import { repeatsRenderedText, words } from '../../../src/answer/duplicate.js';
import { FakeLlm } from '../../../src/llm/fake.js';
import type { MessageId } from '../../../src/shared/ids.js';
import { FakeBudget } from '../../helpers/budget.js';
import { context, finding, findingSet, sink } from './builders.js';

const dup = (template: string, rendered: string): boolean =>
  repeatsRenderedText(template, [{ rendered }]);

const NO_PRICE = 'no verified price was found';
const UNABLE = "couldn't be checked this time (the search timed out)";
const STALE = 'US$90 per user per month (pro) (last seen 3 Nov 2026) [1]';
const CONTESTED =
  'listed as US$90 per user per month (pro) [1] and US$100 per user per month (pro) [2] — official sources disagree';
const SAME_PRICE = 'the official page still showed the same price when checked on 3 Nov 2026';
const NO_SIGN = 'no sign of a change in what I could check';

describe('duplicate text: the free text restates what a placeholder renders', () => {
  it('the observed case: "No verified price was found for Neon [[F1]]."', () => {
    expect(dup('No verified price was found for Neon [[F1]].', NO_PRICE)).toBe(true);
  });

  it.each([
    [
      'unable_to_verify, whole text',
      "Couldn't be checked this time (the search timed out) [[F1]].",
      UNABLE,
    ],
    ['unable_to_verify, in a sentence', "Neon couldn't be checked this time [[F1]].", UNABLE],
    ['stale, "last seen" with its date words', 'Neon: last seen 3 Nov 2026 [[F1]].', STALE],
    [
      'contested, the closing phrase',
      'Neon has official sources disagree on it [[F1]].',
      CONTESTED,
    ],
    [
      'verdict, same price',
      'The official page still showed the same price [[F1:verdict]].',
      SAME_PRICE,
    ],
    ['verdict, no sign of a change', 'Neon: no sign of a change [[F1:verdict]].', NO_SIGN],
  ])('%s', (_label, template, rendered) => {
    expect(dup(template, rendered)).toBe(true);
  });

  it.each([
    'NO VERIFIED PRICE WAS FOUND for Neon [[F1]].',
    'No-verified-price-was-found, for Neon [[F1]].',
    'Neon... no   verified\nprice was found! [[F1]]',
    'neon (no verified price was found) [[F1]]',
  ])('case, punctuation and spacing variants are caught: %j', (template) => {
    expect(dup(template, NO_PRICE)).toBe(true);
  });

  it('a distinctive run of three words is enough, not only the whole text', () => {
    expect(dup('A verified price was never seen [[F1]].', NO_PRICE)).toBe(true);
    expect(dup('Verified price was low [[F1]].', NO_PRICE)).toBe(true);
  });

  it('two words, or three words that are mostly filler, are not a duplicate', () => {
    expect(dup('Neon has a verified price [[F1]].', NO_PRICE)).toBe(false);
    expect(dup('Billed per user per month [[F1]].', STALE)).toBe(false);
    expect(
      dup('Seats can be added per user per month [[F1]].', 'US$90 per user per month (pro) [1]'),
    ).toBe(false);
  });

  it('legitimate sentences pass: the entity name, a number from the user message, a lead-in with a colon', () => {
    expect(dup('Neon: [[F1]].', NO_PRICE)).toBe(false);
    expect(
      dup(
        'For your 20 seats, ExampleCo1 offers this [[F1]].',
        'US$90 per user per month (pro) [1]',
      ),
    ).toBe(false);
    expect(dup('ExampleCo2 [[F2:verdict]].', SAME_PRICE)).toBe(false);
    expect(dup('Thanks for waiting.', NO_PRICE)).toBe(false);
  });

  it('a run never spans a placeholder', () => {
    expect(dup('no verified [[F2]] price [[F1]]', NO_PRICE)).toBe(false);
  });

  it('a placeholder that renders a single word is not compared (documented limit)', () => {
    expect(dup('It changed [[F1:verdict]].', 'changed')).toBe(false);
    expect(words('Ünï-code  TEXT')).toEqual(['ünï', 'code', 'text']);
  });
});

describe('duplicate text through the release gate (ADR-40 semantics)', () => {
  const run = async (
    deltas: string[],
    f = finding(1, { currentStatus: 'unknown', current: undefined }),
  ) => {
    const llm = new FakeLlm().queueStream({ deltas });
    const s = sink();
    const r = await new LlmAnswerPipeline({ llm, options: { judge: false } }).run(
      {
        findings: findingSet([f]),
        recall: new Map<MessageId, { text: string; localTime: string }>(),
        ctx: context(),
        userMessage: 'What does Neon charge per month for its Postgres plans?',
        window: [],
        tz: 'Europe/London',
      },
      new FakeBudget(60_000),
      s.emit,
    );
    return { r, events: s.events };
  };
  const warn = (events: Array<{ event: string; data?: unknown }>) =>
    events.flatMap((e) =>
      e.event === 'warning' && (e.data as { code: string }).code === 'sentence_withheld'
        ? [(e.data as { text: string }).text]
        : [],
    );

  it('the observed output: the doubled sentence is withheld, the clean one is released, no index gap', async () => {
    const { r, events } = await run(['No verified price was found for Neon [[F1]]. Neon: [[F1]].']);
    expect(r.sentences.map((x) => x.index)).toEqual([0]);
    expect(r.sentences[0]?.text).toBe('Neon: no verified price was found.');
    expect(r.rendered).not.toMatch(/Neon no verified/i);
    const w = warn(events);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('duplicate_text');
    const ends = events.flatMap((e) => (e.event === 'answer.sentence_end' ? [e.data.index] : []));
    expect(ends).toEqual([0]);
    expect(r.streamedThrough).toBe(0);
  });

  it('the same defect with an unable_to_verify finding is withheld too', async () => {
    const f = finding(1, {
      currentStatus: 'unable_to_verify',
      current: undefined,
      coverage: { ...finding(1).coverage, failure: 'search_timeout' },
    });
    const { r, events } = await run(
      ["Neon couldn't be checked this time [[F1]]. Neon: [[F1]]."],
      f,
    );
    expect(r.sentences.map((x) => x.template)).toEqual(['Neon: [[F1]].']);
    expect(warn(events)[0]).toContain('duplicate_text');
  });
});

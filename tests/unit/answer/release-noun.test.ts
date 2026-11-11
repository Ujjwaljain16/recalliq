import { describe, expect, it } from 'vitest';
import { LlmAnswerPipeline } from '../../../src/answer/pipeline.js';
import { parsePlaceholderBody } from '../../../src/answer/placeholders.js';
import { checkFreeText } from '../../../src/answer/t3a.js';
import { FakeLlm } from '../../../src/llm/fake.js';
import type { Finding } from '../../../src/shared/findings.js';
import type { MessageId } from '../../../src/shared/ids.js';
import { FakeBudget } from '../../helpers/budget.js';
import { context, finding, findingSet, sink } from './builders.js';

const item = (kind: 'launch' | 'change' | 'removal') => ({
  title: 'X',
  kind,
  eventDate: null,
  providerPublishedAt: null,
  significance: null,
  announcedBeforeBaseline: false,
  citations: [],
});

/** The shape of the observed live run: pricing and releases findings for the same vendor. */
const NONE = finding(21, { intent: 'releases', verdict: 'none_found', releases: [] });
const FOUND = finding(22, {
  intent: 'releases',
  verdict: 'releases_found',
  releases: [item('launch')],
});
const UNABLE = finding(23, {
  intent: 'releases',
  verdict: 'unable_to_verify',
  currentStatus: 'unable_to_verify',
});
const PRICE_UP = finding(1, { verdict: 'changed', direction: 'up' });
const PRICE_PLAIN = finding(12);
const F: Finding[] = [NONE, FOUND, UNABLE, PRICE_UP, PRICE_PLAIN];

function check(template: string, findings: Finding[] = F) {
  const refs = [...template.matchAll(/\[\[([^\]]*)\]\]/g)].flatMap((m) => {
    const ref = parsePlaceholderBody(m[1] ?? '');
    if (!ref) return [];
    const f =
      ref.kind === 'finding' || ref.kind === 'finding_derived'
        ? (findings.find((x) => x.ord === ref.ord) ?? null)
        : null;
    return [{ ref, finding: f }];
  });
  return checkFreeText(
    { template, refs },
    { userMessage: 'What are their releases?', localDates: [], findings },
  );
}

describe('"release(s)" as a topic noun', () => {
  it.each([
    ['none_found', 21],
    ['releases_found', 22],
    ['unable_to_verify', 23],
  ] as const)('the observed sentences pass with a %s finding', (_verdict, n) => {
    expect(check(`Pipedrive releases: [[F${n}]].`)).toEqual([]);
    expect(check(`Pipedrive releases: [[F${n}:verdict]].`)).toEqual([]);
    expect(check(`No releases found for Pipedrive [[F${n}:verdict]].`)).toEqual([]);
    expect(check(`Pipedrive release notes: [[F${n}]].`)).toEqual([]);
    expect(check(`The latest release: [[F${n}:verdict]].`)).toEqual([]);
  });

  it('a clause for each finding: the noun attaches to the releases finding, the price word to the price finding', () => {
    expect(check('It jumped: [[F1:verdict]] and releases: [[F21]].')).toEqual([]);
    expect(check('Pipedrive releases: [[F21]]; Pipedrive pricing: [[F12]].')).toEqual([]);
  });
});

describe('the verb forms still need releases_found with a compatible item', () => {
  it.each([
    'launched',
    'released a feature',
    'shipped',
    'introduced a tier',
    'rolled out a plan',
    'announced a tier',
    'unveiled a plan',
  ])('none_found never authorises "%s"', (verb) => {
    expect(check(`They ${verb}: [[F21:verdict]].`)).toContain('unsupported_verdict_word');
    expect(check(`They ${verb}: [[F23:verdict]].`)).toContain('unsupported_verdict_word');
  });

  it('releases_found with a launch item authorises the launch verbs, not removal wording', () => {
    expect(check('They launched it: [[F22:verdict]].')).toEqual([]);
    expect(check('They released a feature: [[F22:verdict]].')).toEqual([]);
    expect(check('They removed it: [[F22:verdict]].')).toContain('unsupported_verdict_word');
  });

  it('a pricing finding never authorises a launch verb', () => {
    expect(check('They launched it: [[F1:verdict]].')).toContain('unsupported_verdict_word');
  });
});

describe('no borrowing across findings or intents', () => {
  it.each([
    ['the noun with a pricing finding', 'Pipedrive releases: [[F12]].'],
    ['the noun with a pricing verdict', 'Pipedrive releases: [[F1:verdict]].'],
    ['the noun with no placeholder in the clause', 'Pipedrive releases are listed below.'],
    [
      'the noun with only a source placeholder (still a known false positive)',
      'Use the release notes [[S:src_one]].',
    ],
    [
      'the noun and a pricing finding in the same clause',
      'Releases and pricing: [[F21]], [[F1:verdict]].',
    ],
    [
      'the noun with the pricing finding in another clause',
      'Pipedrive releases and pricing: [[F12]].',
    ],
  ])('is withheld: %s', (_label, template) => {
    expect(check(template)).toContain('unsupported_verdict_word');
  });

  it.each([
    'It was raised: [[F21:verdict]].',
    'It jumped: [[F22:verdict]].',
    'It is unchanged: [[F21:verdict]].',
    'It is now pricier: [[F23:verdict]].',
    'It used to cost less: [[F22:baseline]].',
  ])('a releases finding never authorises price wording: %s', (template) => {
    expect(check(template)).toContain('unsupported_verdict_word');
  });

  it('with no findings in the turn the noun is ordinary text', () => {
    expect(check('Use the release notes.', [])).toEqual([]);
  });
});

describe('release sentences through the release gate (ADR-40 semantics)', () => {
  type Ev = Array<{ event: string; data?: unknown }>;
  const run = async (middle: string) => {
    const llm = new FakeLlm().queueStream({ deltas: [`First [[F12]]. ${middle} Last [[F12]].`] });
    const s = sink();
    const r = await new LlmAnswerPipeline({ llm, options: { judge: false } }).run(
      {
        findings: findingSet(F),
        recall: new Map<MessageId, { text: string; localTime: string }>(),
        ctx: context(),
        userMessage: 'What are their releases?',
        window: [],
        tz: 'Europe/London',
      },
      new FakeBudget(60_000),
      s.emit,
    );
    return { r, events: s.events };
  };
  const ends = (events: Ev) =>
    events.flatMap((e) =>
      e.event === 'answer.sentence_end' ? [(e.data as { index: number }).index] : [],
    );
  const withheld = (events: Ev) =>
    events.filter(
      (e) => e.event === 'warning' && (e.data as { code: string }).code === 'sentence_withheld',
    );

  it.each([
    'Pipedrive releases: [[F21]].',
    'Pipedrive releases: [[F21:verdict]].',
    'Pipedrive releases: [[F22:verdict]].',
    'Pipedrive releases: [[F23:verdict]].',
  ])('releases %j with contiguous indices', async (sentence) => {
    const { r, events } = await run(sentence);
    expect(r.sentences.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(ends(events)).toEqual([0, 1, 2]);
    expect(withheld(events)).toEqual([]);
    expect(r.streamedThrough).toBe(2);
  });

  it.each([
    'Pipedrive releases: [[F12]].',
    'They launched it: [[F21:verdict]].',
    'It was raised: [[F21:verdict]].',
  ])('withholds %j and leaves no index gap', async (sentence) => {
    const { r, events } = await run(sentence);
    expect(r.sentences.map((x) => x.index)).toEqual([0, 1]);
    expect(ends(events)).toEqual([0, 1]);
    expect(withheld(events)).toHaveLength(1);
    expect(r.streamedThrough).toBe(1);
    expect(JSON.stringify(r.sentences)).not.toMatch(/F21|F22|F23/);
  });
});

describe('the intent guard stands on its own', () => {
  it('even a releases-intent finding that carries a price verdict cannot authorise price wording', () => {
    const odd = finding(30, { intent: 'releases', verdict: 'changed', direction: 'up' });
    expect(check('It was raised: [[F30:verdict]].', [odd])).toContain('unsupported_verdict_word');
    const odd2 = finding(31, { intent: 'releases', verdict: 'unchanged_confirmed' });
    expect(check('It is unchanged: [[F31:verdict]].', [odd2])).toContain(
      'unsupported_verdict_word',
    );
  });
});

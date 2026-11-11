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

const VERDICT_FINDINGS = [
  ['none_found', 21],
  ['releases_found', 22],
  ['unable_to_verify', 23],
] as const;

describe('a neutral heading naming the topic: allowed for any verdict of a releases finding', () => {
  it.each(VERDICT_FINDINGS)('%s', (_verdict, n) => {
    expect(check(`Releases: [[F${n}]].`)).toEqual([]);
    expect(check(`Pipedrive releases: [[F${n}]].`)).toEqual([]);
    expect(check(`Pipedrive releases: [[F${n}:verdict]].`)).toEqual([]);
    expect(check(`Pipedrive release notes: [[F${n}:verdict]].`)).toEqual([]);
    expect(check(`- Pipedrive releases: [[F${n}]].`)).toEqual([]);
    expect(check(`Big Pipedrive CRM releases: [[F${n}]].`)).toEqual([]); // the entity and up to 3 other words
  });

  it('a clause for each finding: the heading with the releases finding, the price word with its price verdict', () => {
    expect(check('It jumped: [[F1:verdict]] and releases: [[F21]].')).toEqual([]);
    expect(check('Pipedrive releases: [[F21]]; Pipedrive pricing: [[F12]].')).toEqual([]);
  });

  it('the exception permits only neutral presentation: a heading plus a claim in the same clause is judged by the claim', () => {
    // heading, then a negative claim that a releases_found finding contradicts
    expect(check('Pipedrive releases: there are no new releases [[F22]].')).toContain(
      'unsupported_verdict_word',
    );
    // heading, then a positive claim that a none_found finding contradicts
    expect(check('Pipedrive releases: there are several releases [[F21]].')).toContain(
      'unsupported_verdict_word',
    );
    // Decision: only "noun: [[placeholder]]" is a heading. Free text after the colon or a dash is a claim and is
    // judged as one, so a label followed by words is never neutral.
    expect(check('Pipedrive releases: none, [[F21]].')).toEqual([]);
    expect(check('Pipedrive releases: none, [[F22]].')).toContain('unsupported_verdict_word');
    expect(check('Pipedrive releases: none, [[F23]].')).toContain('unsupported_verdict_word');
    expect(check('Pipedrive releases: several, [[F22]].')).toEqual([]);
    expect(check('Pipedrive releases: several, [[F21]].')).toContain('unsupported_verdict_word');
    expect(check('Pipedrive releases - none [[F22]].')).toContain('unsupported_verdict_word');
    expect(check('Pipedrive releases - [[F21]].')).toContain('unsupported_verdict_word'); // dash: no heading
    // a claim word before the noun means it is no heading
    expect(check('The latest release: [[F21]].')).toContain('unsupported_verdict_word');
    expect(check('No releases: [[F22]].')).toContain('unsupported_verdict_word');
  });

  it('a noun that is not a heading and not followed by the placeholder is a claim', () => {
    expect(check('Pipedrive releases [[F21]].')).toContain('unsupported_verdict_word');
    expect(check('Pipedrive releases [[F22]].')).toEqual([]); // as a claim ("has releases") it is true
  });
});

describe('claims with "release(s)" need a compatible verdict of the finding in the same clause', () => {
  const NEGATIVE = [
    'Pipedrive has no releases [[F2]].',
    'No releases found for Pipedrive [[F2:verdict]].',
    'There are no new releases [[F2]].',
    'Pipedrive is without releases [[F2]].',
    'Nothing was released [[F2:verdict]].',
  ];
  const POSITIVE = [
    'Pipedrive had several releases [[F2]].',
    'There are new releases [[F2:verdict]].',
    'The latest release is listed [[F2]].',
    'Pipedrive has a release [[F2]].',
  ];
  const at = (t: string, n: number): string => t.replace('F2', `F${n}`);

  it.each(NEGATIVE)('negative claim %j: passes with none_found only', (t) => {
    expect(check(at(t, 21))).toEqual([]);
    expect(check(at(t, 22))).toContain('unsupported_verdict_word'); // contradicted by releases_found
    expect(check(at(t, 23))).toContain('unsupported_verdict_word'); // unable_to_verify authorises no claim
  });

  it.each(POSITIVE)('positive claim %j: passes with releases_found only', (t) => {
    expect(check(at(t, 22))).toEqual([]);
    expect(check(at(t, 21))).toContain('unsupported_verdict_word'); // contradicted by none_found
    expect(check(at(t, 23))).toContain('unsupported_verdict_word');
  });

  it('a positive claim needs an actual item, not just the verdict', () => {
    const empty = finding(40, { intent: 'releases', verdict: 'releases_found', releases: [] });
    expect(check('Pipedrive had several releases [[F40]].', [empty])).toContain(
      'unsupported_verdict_word',
    );
  });

  it('a pricing finding authorises no release language: heading or claim', () => {
    for (const t of [
      'Pipedrive releases: [[F12]].',
      'Pipedrive releases: [[F1:verdict]].',
      'Pipedrive has no releases [[F12]].',
      'Pipedrive had several releases [[F1:verdict]].',
      'Pipedrive release notes: [[F12]].',
    ]) {
      expect(check(t)).toContain('unsupported_verdict_word');
    }
  });

  it('no placeholder in the clause: withheld, heading or claim', () => {
    for (const t of [
      'Pipedrive releases are listed below.',
      'Pipedrive has no releases.',
      'Use the release notes [[S:src_one]].',
      'Releases:',
    ]) {
      expect(check(t)).toContain('unsupported_verdict_word');
    }
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

describe('claims about a specific item must match an item of the finding', () => {
  const smart = finding(50, {
    intent: 'releases',
    verdict: 'releases_found',
    releases: [{ ...item('launch'), title: 'Smart Docs' }],
  });
  const old = finding(51, {
    intent: 'releases',
    verdict: 'releases_found',
    releases: [{ ...item('removal'), title: 'Old Plan' }],
  });
  const all: Finding[] = [...F, smart, old];

  it('a named item that is among the finding items passes', () => {
    expect(check('Pipedrive launched Smart Docs [[F50:verdict]].', all)).toEqual([]);
    expect(check('The latest release is Smart Docs [[F50]].', all)).toEqual([]);
    expect(check('Pipedrive removed Old Plan [[F51:verdict]].', all)).toEqual([]);
  });

  it('a different or invented item is withheld', () => {
    expect(check('Pipedrive launched Magic Mailer [[F50:verdict]].', all)).toContain(
      'unsupported_verdict_word',
    );
    expect(check('The latest release is Magic Mailer [[F50]].', all)).toContain(
      'unsupported_verdict_word',
    );
    expect(check('Pipedrive launched Smart Docs Pro Max [[F50:verdict]].', all)).toContain(
      'unsupported_verdict_word',
    );
    expect(check('Pipedrive removed Smart Docs [[F51:verdict]].', all)).toContain(
      'unsupported_verdict_word',
    );
  });

  it('an item of the wrong kind does not support the verb: a removal is not a launch', () => {
    expect(check('Pipedrive launched Old Plan [[F51:verdict]].', all)).toContain(
      'unsupported_verdict_word',
    );
  });

  it('a named item with none_found or unable_to_verify is withheld', () => {
    expect(check('Pipedrive launched Smart Docs [[F21:verdict]].', all)).toContain(
      'unsupported_verdict_word',
    );
    expect(check('The latest release is Smart Docs [[F23]].', all)).toContain(
      'unsupported_verdict_word',
    );
  });

  it('a claim that names nothing specific is decided by the verdict alone (documented)', () => {
    expect(check('Pipedrive launched it: [[F50:verdict]].', all)).toEqual([]);
    expect(check('Pipedrive shipped something: [[F50:verdict]].', all)).toEqual([]);
  });
});

describe('a heading never authorises the sentence after it (gate level)', () => {
  type Ev = Array<{ event: string; data?: unknown }>;
  const run = async (sentences: string) => {
    const llm = new FakeLlm().queueStream({
      deltas: [`First [[F12]]. ${sentences} Last [[F12]].`],
    });
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
    return { r, events: s.events as Ev };
  };
  const warnings = (events: Ev) =>
    events.filter(
      (e) => e.event === 'warning' && (e.data as { code: string }).code === 'sentence_withheld',
    );
  const ends = (events: Ev) =>
    events.flatMap((e) =>
      e.event === 'answer.sentence_end' ? [(e.data as { index: number }).index] : [],
    );

  it.each([
    ['releases_found', 'Pipedrive releases: [[F22]]. Pipedrive has no releases.'],
    ['none_found', 'Pipedrive releases: [[F21]]. Pipedrive shipped three new features.'],
    ['none_found', 'Pipedrive releases: [[F21]]. Pipedrive had several releases.'],
    ['unable_to_verify', 'Pipedrive releases: [[F23]]. Pipedrive has no releases.'],
    ['releases_found', 'Pipedrive releases: [[F22]]. Pipedrive had several releases.'],
    ['none_found', 'Pipedrive releases: [[F21]]. Pipedrive has no releases.'],
  ])('%s: the heading is released, the contradicting sentence is withheld', async (_v, text) => {
    const { r, events } = await run(text);
    expect(r.sentences.map((x) => x.template)).toEqual([
      'First [[F12]].',
      text.split('. ')[0] + '.',
      'Last [[F12]].',
    ]);
    expect(r.sentences.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(ends(events)).toEqual([0, 1, 2]);
    expect(warnings(events)).toHaveLength(1);
    expect(r.streamedThrough).toBe(2);
    expect(r.rendered).not.toMatch(/has no releases|shipped|had several/i);
  });

  it('a sentence with the matching claim and its own placeholder is released next to the heading', async () => {
    const { r, events } = await run(
      'Pipedrive releases: [[F21]]. Pipedrive has no releases [[F21]].',
    );
    expect(r.sentences).toHaveLength(4);
    expect(warnings(events)).toEqual([]);
  });
});

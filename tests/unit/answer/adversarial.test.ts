import { describe, expect, it } from 'vitest';
import { LlmAnswerPipeline } from '../../../src/answer/pipeline.js';
import { parsePlaceholderBody } from '../../../src/answer/placeholders.js';
import { checkFreeText, textVariants } from '../../../src/answer/t3a.js';
import { FakeLlm } from '../../../src/llm/fake.js';
import type { Finding } from '../../../src/shared/findings.js';
import type { MessageId } from '../../../src/shared/ids.js';
import { FakeBudget } from '../../helpers/budget.js';
import { context, finding, findingSet, sink } from './builders.js';

/** Characters written by code, so the source stays readable and the test shows what is being slipped in. */
const SHY = String.fromCharCode(0x00ad); // soft hyphen
const NB_HYPHEN = String.fromCharCode(0x2011); // non-breaking hyphen
const EN_DASH = String.fromCharCode(0x2013);
const CURLY = String.fromCharCode(0x2019); // typographic apostrophe
const CYR_P = String.fromCharCode(0x0440); // Cyrillic small er, looks like Latin p
const CYR_O = String.fromCharCode(0x043e); // Cyrillic small o
const ZWSP = String.fromCharCode(0x200b); // zero-width space
const fullWidth = (s: string): string =>
  [...s].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');

const F: Finding[] = [
  finding(1, { verdict: 'changed', direction: 'up' }),
  finding(2, { verdict: 'changed', direction: 'down' }),
  finding(3, { verdict: 'unchanged_confirmed' }),
  finding(4, { verdict: 'baseline_incorrect', verdictReason: 'unsupported_at_time' }),
  finding(5, { verdict: 'differs_timing_unknown' }),
  finding(6, {
    intent: 'releases',
    verdict: 'releases_found',
    releases: [
      {
        title: 'T',
        kind: 'launch',
        eventDate: null,
        providerPublishedAt: null,
        significance: null,
        announcedBeforeBaseline: false,
        citations: [],
      },
    ],
  }),
  finding(7, {
    intent: 'releases',
    verdict: 'releases_found',
    releases: [
      {
        title: 'U',
        kind: 'removal',
        eventDate: null,
        providerPublishedAt: null,
        significance: null,
        announcedBeforeBaseline: false,
        citations: [],
      },
    ],
  }),
  finding(8), // a plain finding: no verdict
];

function check(template: string, findings: Finding[] = F, userMessage = 'What do they cost?') {
  const refs = [...template.matchAll(/\[\[([^\]]*)\]\]/g)].flatMap((m) => {
    const ref = parsePlaceholderBody(m[1] ?? '');
    if (!ref) return [];
    const f =
      ref.kind === 'finding' || ref.kind === 'finding_derived'
        ? (findings.find((x) => x.ord === ref.ord) ?? null)
        : null;
    return [{ ref, finding: f }];
  });
  return checkFreeText({ template, refs }, { userMessage, localDates: [], findings });
}

/** Free-text change language with no justifying verdict placeholder: every one must be withheld. */
const WITHHELD: Array<[label: string, template: string]> = [
  ['jumped to', 'ExampleCo8 jumped to [[F8]].'],
  ['doubled', 'The price doubled: [[F8]].'],
  ['tripled', 'The price tripled.'],
  ['quadrupled', 'It quadrupled overnight.'],
  ['slashed', 'They slashed it.'],
  ['went from X to Y, plain finding', 'It went from [[F8:baseline]] to [[F8]].'],
  ['is now pricier', 'ExampleCo8 is now pricier [[F8]].'],
  ['has gone up', 'It has gone up.'],
  ['no longer offers', 'ExampleCo8 no longer offers the team plan.'],
  ['used to cost', 'It used to cost [[F8:baseline]].'],
  ['hiked', 'They hiked it.'],
  ['bumped', 'They bumped the price.'],
  ['climbed', 'Costs climbed.'],
  ['surged', 'Prices surged.'],
  ['spiked', 'Prices spiked recently.'],
  ['fell', 'The price fell.'],
  ['plunged', 'The price plunged.'],
  ['dipped', 'The price dipped.'],
  ['halved', 'They halved it.'],
  ['cheaper now, one finding', 'It is cheaper now [[F8]].'],
  ['now costs more', 'It now costs more [[F8]].'],
  ['more expensive, one finding', 'It is more expensive [[F8]].'],
  ['less expensive', "It's less expensive."],
  ['re-priced', 'They re-priced the plan.'],
  ['up-ticked', 'The rate was up-ticked.'],
  ['mixed case', 'The price was RAISED.'],
  ['mixed case 2', 'It JuMpEd again.'],
  ['soft hyphen inside', `It rai${SHY}sed it.`],
  ['hyphenated', 'It was in-creased.'],
  ['non-breaking hyphen', `It was re${NB_HYPHEN}priced.`],
  ['en dash', `It was up${EN_DASH}ticked.`],
  ['curly apostrophe', `The price didn${CURLY}t change.`],
  ['extra spaces', 'It   now    costs    more.'],
  ['cyrillic look-alike letters', `It jum${CYR_P}ed.`],
  ['cyrillic o', `It d${CYR_O}ubled.`],
  ['full-width letters', `It ${fullWidth('doubled')}.`],
  ['zero-width space inside', `It dou${ZWSP}bled.`],
  ['new price', 'The new price is lower.'],
  ['deprecated', 'The plan was deprecated.'],
  ['sunset', 'The tier was sunset.'],
  ['announced', 'The feature was announced.'],
  ['previously', 'A previously listed price.'],
  ['anymore', 'It is not available anymore.'],
  ['updated', 'It was updated last week.'],
  ['changed, plain current value of a changed finding', 'Everything has changed [[F1]].'],
  ['jumped, plain current value of a changed finding', 'It jumped to [[F1]].'],
  ['pricier, plain value only', 'ExampleCo1 is pricier [[F1]].'],
  ['jumped with the wrong direction', 'It jumped: [[F2:verdict]].'],
  ['slashed with the wrong direction', 'It was slashed: [[F1:verdict]].'],
  ['pricier with a down verdict', 'It is pricier: [[F2:verdict]].'],
  ['went from with an unchanged finding', 'It went from [[F3:baseline]] to [[F3]].'],
  ['launched with a removal finding', 'They launched it: [[F7:verdict]].'],
  ['removed with a launch finding', 'They removed it: [[F6:verdict]].'],
  ['raised for an unchanged finding', 'It was raised: [[F3:verdict]].'],
  ['unchanged for a changed finding', 'It is unchanged: [[F1:verdict]].'],
  ['introduced, no placeholder', 'They introduced a new tier.'],
  ['discounted', 'The plan is discounted.'],
  ['mark-up', 'A mark-up was applied.'],
  ['downtick', 'A down-tick in the rate.'],
  ['reduction', 'There was a reduction.'],
  ['rolled out', 'They rolled out a plan.'],
  ['formerly', 'It formerly cost less.'],
];

/** Sentences that must pass: narrative, and change language backed by a compatible verdict placeholder. */
const PASSES: Array<[label: string, template: string]> = [
  ['plan includes', 'The Pro plan includes unlimited seats.'],
  ['you asked about', 'You asked about ExampleCo1 earlier.'],
  ['narrative', 'Here is what I found.'],
  ['offers', 'ExampleCo1 offers a team plan [[F1]].'],
  ['listed at', 'ExampleCo2 is listed at [[F2]].'],
  ['verdict placeholder alone', 'ExampleCo1: [[F1:verdict]].'],
  ['comparison of two findings', 'ExampleCo2 is cheaper than [[F1]] by far, see [[F2]].'],
  ['pricier among two findings', 'ExampleCo1 is pricier than [[F2]], see [[F1]].'],
  [
    'went from X to Y with a baseline of a changed finding',
    'The price went from [[F1:baseline]] to [[F1]].',
  ],
  ['raised from X to Y', 'It was raised from [[F1:baseline]] to [[F1]].'],
  ['jumped, verdict up', 'Prices jumped: [[F1:verdict]].'],
  ['doubled, verdict up', 'It doubled: [[F1:verdict]].'],
  ['slashed, verdict down', 'ExampleCo2 slashed it: [[F2:verdict]].'],
  ['pricier, verdict up', 'ExampleCo1 is now pricier: [[F1:verdict]].'],
  ['cheaper, verdict down', 'ExampleCo2 is cheaper now: [[F2:verdict]].'],
  ['used to cost, baseline of a changed finding', 'It used to cost [[F1:baseline]].'],
  ['no longer offers, removal verdict', 'It no longer offers the plan: [[F7:verdict]].'],
  ['launched, launch verdict', 'They launched it: [[F6:verdict]].'],
  ['out of date, baseline incorrect', 'The old price was out of date: [[F4:verdict]].'],
  ['differs', 'It differs now: [[F5:verdict]].'],
  ['updated, differs verdict', 'It was updated: [[F5:verdict]].'],
  ['unchanged, confirmed', 'It is unchanged: [[F3:verdict]].'],
  ['closing offer', 'Let me know if you want a deeper look.'],
  ['could not check', 'I could not check ExampleCo8 this time.'],
  ['citation', 'This summary covers the sources I checked [[S:src_one]].'],
  ['thanks', 'Thanks for waiting.'],
  ['billing', 'Both are billed monthly.'],
  ['list price', 'That is the list price [[F8]].'],
  ['seats later', 'Seats can be added later.'],
  ['custom priced', 'The enterprise tier is custom priced.'],
  ['billed annually', 'It is billed annually.'],
  ['free trials', 'ExampleCo1 and ExampleCo2 both have free trials.'],
  ['tracking', 'I will keep tracking it.'],
  ['rose with an up finding, plain placeholder (existing family rule)', 'It rose sharply [[F1]].'],
  ['dropped with a down finding (existing family rule)', 'It dropped to [[F2]].'],
  ['hyphen in a normal word', 'ExampleCo1 is a well-known vendor.'],
];

/**
 * The cost of a broad lexicon: ordinary sentences that use a change word with no change meaning are withheld
 * as well. This list is asserted so the trade-off is visible, not hidden.
 */
const BENIGN_BUT_WITHHELD: Array<[label: string, template: string]> = [
  ['"change" as an instruction', 'You can change plans at any time.'],
  ['"updated" about a page', 'The page was last updated recently.'],
  ['"remove" as an instruction', 'Ask them to remove the seat limit.'],
  ['"drop" in an offer', 'I can drop that comparison if you like.'],
  ['"fall" as "belong"', 'The plans fall into tiers.'],
  ['"lower" as an adjective', 'The team plan has a lower seat minimum.'],
  ['"discount" as a noun', 'Annual billing gives a discount.'],
  ['"release notes"', 'Use the release notes [[S:src_one]].'],
  ['"previously" about the conversation', 'We previously talked about this.'],
  ['"cheaper" in a hypothetical', 'It would be cheaper to ask them.'],
  ['"announced" about an event', 'They announced it on their blog.'],
];

describe('adversarial corpus: change language in free text', () => {
  it('has at least 60 sentences', () => {
    expect(WITHHELD.length + PASSES.length + BENIGN_BUT_WITHHELD.length).toBeGreaterThanOrEqual(60);
  });

  it.each(WITHHELD)('is withheld: %s', (_label, template) => {
    expect(check(template)).toContain('unsupported_verdict_word');
  });

  it.each(PASSES)('is not withheld: %s', (_label, template) => {
    expect(check(template)).toEqual([]);
  });

  it.each(BENIGN_BUT_WITHHELD)('known false positive, withheld: %s', (_label, template) => {
    expect(check(template)).toContain('unsupported_verdict_word');
  });

  it('the structural rule applies only when the turn is about findings; the older phrase families always apply', () => {
    // no findings at all: the broad lexicon is not applied ...
    expect(check('The price jumped.', [])).toEqual([]);
    expect(check('You can change plans.', [])).toEqual([]);
    // ... but the original families still are
    expect(check('The price was raised.', [])).toContain('unsupported_verdict_word');
    // a finding placeholder in the sentence switches the lexicon on even with no other findings
    expect(check('The price jumped [[F8]].', [finding(8)])).toContain('unsupported_verdict_word');
  });

  it('normalisation produces the variants the matcher relies on', () => {
    expect(textVariants(`Up${NB_HYPHEN}Ticked  ${fullWidth('A')}`)).toEqual([
      'up ticked a',
      'upticked a',
    ]);
  });
});

describe('adversarial corpus through the release gate (ADR-40 semantics)', () => {
  const run = async (sentence: string) => {
    const llm = new FakeLlm().queueStream({
      deltas: [`First [[F8]]. ${sentence} Last [[F8]].`],
    });
    const s = sink();
    const r = await new LlmAnswerPipeline({ llm, options: { judge: false } }).run(
      {
        findings: findingSet(F),
        recall: new Map<MessageId, { text: string; localTime: string }>(),
        ctx: context(),
        userMessage: 'What do they cost?',
        window: [],
        tz: 'Europe/London',
      },
      new FakeBudget(60_000),
      s.emit,
    );
    return { r, events: s.events };
  };

  it.each([
    'ExampleCo8 jumped to [[F8]].',
    'They slashed it.',
    'It is now pricier [[F8]].',
    'It used to cost [[F8:baseline]].',
    `They re${NB_HYPHEN}priced it.`,
    `It jum${CYR_P}ed.`,
    'It went from [[F1:baseline]] to [[F1]] and jumped.',
  ])('withholds %j, releases its neighbours, leaves no index gap', async (sentence) => {
    const { r, events } = await run(sentence);
    expect(r.sentences.map((x) => x.index)).toEqual([0, 1]);
    expect(r.sentences.map((x) => x.template)).toEqual(['First [[F8]].', 'Last [[F8]].']);
    const withheld = events.filter(
      (e) => e.event === 'warning' && e.data.code === 'sentence_withheld',
    );
    expect(withheld).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('jumped');
    expect(JSON.stringify(events)).not.toContain('slashed');
    expect(r.streamedThrough).toBe(1);
  });

  it.each([
    'Prices jumped: [[F1:verdict]].',
    'It was raised: [[F1:verdict]].',
    'It no longer offers the plan: [[F7:verdict]].',
    'The Pro plan includes unlimited seats.',
  ])('releases %j', async (sentence) => {
    const { r, events } = await run(sentence);
    expect(r.sentences).toHaveLength(3);
    expect(r.sentences.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(
      events.filter((e) => e.event === 'warning' && e.data.code === 'sentence_withheld'),
    ).toEqual([]);
  });
});

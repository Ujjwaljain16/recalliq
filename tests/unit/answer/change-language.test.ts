import { describe, expect, it } from 'vitest';
import { LlmAnswerPipeline } from '../../../src/answer/pipeline.js';
import { parsePlaceholderBody } from '../../../src/answer/placeholders.js';
import { checkFreeText } from '../../../src/answer/t3a.js';
import { validateCompletion } from '../../../src/db/repositories/turn-completion.js';
import { FakeLlm } from '../../../src/llm/fake.js';
import type { Finding } from '../../../src/shared/findings.js';
import type { MessageId, TurnId } from '../../../src/shared/ids.js';
import type { TurnCompletion } from '../../../src/shared/repositories.js';
import { FakeBudget } from '../../helpers/budget.js';
import { buildCompletion } from '../../helpers/turns.js';
import { context, finding, findingSet, sink } from './builders.js';

const CYR_P = String.fromCharCode(0x0440); // Cyrillic look-alike of "p"
const NB_HYPHEN = String.fromCharCode(0x2011);
const SHY = String.fromCharCode(0x00ad);

const release = (kind: 'launch' | 'change' | 'removal') => ({
  title: 'X',
  kind,
  eventDate: null,
  providerPublishedAt: null,
  significance: null,
  announcedBeforeBaseline: false,
  citations: [],
});

/** One finding per verdict, so every case names exactly which verdict it relies on. */
const F: Finding[] = [
  finding(1, { verdict: 'changed', direction: 'up' }),
  finding(2, { verdict: 'changed', direction: 'down' }),
  finding(3, { verdict: 'unchanged_confirmed' }),
  finding(4, { verdict: 'baseline_incorrect' }),
  finding(5, { verdict: 'differs_timing_unknown' }),
  finding(6, { verdict: 'contested', currentStatus: 'contested' }),
  finding(7, { verdict: 'unable_to_verify', currentStatus: 'unable_to_verify' }),
  finding(8, { verdict: 'no_evidence_of_change', currentStatus: 'stale' }),
  finding(9, {
    verdict: 'changed',
    direction: 'up',
    changeWindow: { after: 1, notAfter: 2 },
  }),
  finding(10, { intent: 'releases', verdict: 'releases_found', releases: [release('removal')] }),
  finding(11, { intent: 'releases', verdict: 'releases_found', releases: [release('launch')] }),
  finding(12), // no verdict at all
];

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
    { userMessage: 'What do they cost?', localDates: [], findings },
  );
}

type Case = [label: string, template: string];

/** Plain current-value placeholders never authorise change language, even for a `changed` finding. */
const PLAIN_VALUE: Case[] = [
  ['rose + plain value of an up finding (the old loophole)', 'It rose sharply [[F1]].'],
  ['raised + plain value of an up finding', 'It was raised to [[F1]].'],
  ['cut + plain value of a down finding', 'It was cut to [[F2]].'],
  ['dropped + plain value of a down finding', 'It dropped to [[F2]].'],
  ['launched + plain value of a launch finding', 'They launched it [[F11]].'],
  ['jumped + plain value', 'It jumped to [[F1]].'],
  ['used to cost + plain value', 'It used to cost [[F1]].'],
  ['now costs more + plain value', 'It now costs more [[F1]].'],
  ['went from X to Y with only plain values', 'It went from [[F1]] to [[F9]].'],
];

/** A verdict that belongs to another finding, or that is borrowed across findings or clauses. */
const BORROWED: Case[] = [
  [
    'verdict of another finding, plain value of the subject',
    'It jumped: [[F1]] and [[F3:verdict]].',
  ],
  [
    'verdict of another finding in another clause',
    'It jumped: [[F1]]; ExampleCo3 is unchanged: [[F3:verdict]].',
  ],
  ['two findings in one clause', 'It jumped: [[F1:verdict]], [[F2:verdict]].'],
  [
    'subject clause without markers, two findings',
    'ExampleCo1 jumped and ExampleCo2 jumped: [[F1:verdict]] and [[F2:verdict]].',
  ],
  [
    '"both" over a changed and an unchanged finding',
    'Both jumped: [[F1:verdict]] and [[F3:verdict]].',
  ],
  ['"they" over two findings', 'They jumped: [[F1:verdict]] and [[F9:verdict]].'],
  ['swapped verdicts across clauses', 'It jumped: [[F2:verdict]] but it fell: [[F1:verdict]].'],
  ['up and down words, one up finding', 'It jumped but it fell: [[F1:verdict]].'],
  ['unchanged word with a changed finding in the clause', 'It is unchanged: [[F1:verdict]].'],
  ['changed word attached to the unchanged finding', 'It jumped: [[F3:verdict]].'],
];

/** differs_timing_unknown (F5) never authorises a confirmed-change word. */
const DIFFERS_WORDS = [
  'raised',
  'cut',
  'jumped',
  'rose',
  'fell',
  'increased',
  'decreased',
  'doubled',
  'slashed',
  'changed',
  'updated',
  'was re-priced',
  'went up',
  'went down',
  'now costs more',
  'used to cost less',
  'previously cost less',
  'formerly cost less',
  'no longer the same',
  'is pricier',
  'is cheaper',
];
const DIFFERS: Case[] = DIFFERS_WORDS.map((w) => [`${w}`, `It ${w}: [[F5:verdict]].`]);

/** Contested, unable_to_verify and stale findings authorise no definitive claim. */
const NOT_DEFINITIVE: Case[] = [
  ['jumped, contested', 'It jumped: [[F6:verdict]].'],
  ['unchanged, contested', 'It is unchanged: [[F6:verdict]].'],
  ['raised, unable_to_verify', 'It was raised: [[F7:verdict]].'],
  ['unchanged, unable_to_verify', 'It is unchanged: [[F7:verdict]].'],
  ['jumped, stale', 'It jumped: [[F8:verdict]].'],
  ['unchanged, stale (no evidence is not "unchanged")', 'It is unchanged: [[F8:verdict]].'],
  ['used to cost, contested', 'It used to cost [[F6:baseline]].'],
];

/** Direction, timing and historical mismatches. */
const MISMATCH: Case[] = [
  ['fell for an up finding', 'It fell: [[F1:verdict]].'],
  ['cheaper for an up finding', 'It is cheaper now: [[F1:verdict]].'],
  ['pricier for a down finding', 'It is pricier: [[F2:verdict]].'],
  ['jumped for a down finding', 'It jumped: [[F2:verdict]].'],
  ['timing word, finding with no window', 'It jumped since last week: [[F1:verdict]].'],
  ['"recently", finding with no window', 'It was raised recently: [[F1:verdict]].'],
  ['used to, unchanged finding baseline', 'It used to cost [[F3:baseline]].'],
  ['used to, baseline_incorrect finding', 'It used to cost [[F4:baseline]].'],
  ['formerly, differs finding baseline', 'It formerly cost [[F5:baseline]].'],
  ['previously, stale finding', 'It previously cost [[F8:baseline]].'],
  ['launched for a removal finding', 'They launched it: [[F10:verdict]].'],
  ['removed for a launch finding', 'They removed it: [[F11:verdict]].'],
  ['was wrong for a changed finding', 'My answer was wrong: [[F1:verdict]].'],
];

/** The same refusals under obfuscation. */
const OBFUSCATED_REFUSED: Case[] = [
  ['upper case, differs', 'IT JUMPED: [[F5:verdict]].'],
  ['mixed case, plain value', 'It RoSe sharply [[F1]].'],
  ['hyphenated, differs', 'It was re-priced: [[F5:verdict]].'],
  ['non-breaking hyphen, differs', `It was re${NB_HYPHEN}priced: [[F5:verdict]].`],
  ['look-alike letter, differs', `It jum${CYR_P}ed: [[F5:verdict]].`],
  ['soft hyphen, plain value', `It rai${SHY}sed to [[F1]].`],
  ['extra spaces, differs', 'It   now   costs   more: [[F5:verdict]].'],
  ['up-ticked, contested', 'It was up-ticked: [[F6:verdict]].'],
];

/** Language that IS authorised: the right verdict placeholder of the right finding, in the same clause. */
const AUTHORISED: Case[] = [
  ['jumped, up verdict', 'It jumped: [[F1:verdict]].'],
  ['doubled, up verdict', 'It doubled: [[F1:verdict]].'],
  ['slashed, down verdict', 'It was slashed: [[F2:verdict]].'],
  ['cheaper now, down verdict', 'It is cheaper now: [[F2:verdict]].'],
  ['pricier, up verdict', 'It is now pricier: [[F1:verdict]].'],
  [
    'went from X to Y, baseline of a changed finding',
    'The price went from [[F1:baseline]] to [[F1]].',
  ],
  ['used to cost, baseline of a changed finding', 'It used to cost [[F1:baseline]].'],
  ['formerly, baseline of a changed finding', 'It formerly cost [[F2:baseline]].'],
  ['previously, verdict of a changed finding', 'Previously it was different: [[F1:verdict]].'],
  ['changed, changed finding', 'It changed: [[F1:verdict]].'],
  ['timing word with a window', 'It jumped since last week: [[F9:verdict]].'],
  ['unchanged, unchanged finding', 'It is unchanged: [[F3:verdict]].'],
  ['same price, unchanged finding', 'It is the same price: [[F3:verdict]].'],
  ['no sign of a change, no_evidence finding', 'There is no sign of a change: [[F8:verdict]].'],
  ['no sign of a change, unchanged finding', 'There is no sign of a change: [[F3:verdict]].'],
  ['out of date, baseline_incorrect', 'My earlier answer was out of date: [[F4:verdict]].'],
  ['differs, differs finding', 'The values differ and the timing is unknown: [[F5:verdict]].'],
  ['different now, changed finding', 'It is different now: [[F1:verdict]].'],
  ['no longer offers, removal item', 'It no longer offers the plan: [[F10:verdict]].'],
  ['launched, launch item', 'They launched it: [[F11:verdict]].'],
  ['removed, removal item', 'They removed it: [[F10:verdict]].'],
  [
    'two clauses, each with its own verdict',
    'It jumped: [[F1:verdict]] but it fell: [[F2:verdict]].',
  ],
  [
    'unchanged and jumped in separate clauses',
    'ExampleCo3 is unchanged: [[F3:verdict]], and ExampleCo1 jumped: [[F1:verdict]].',
  ],
  ['upper case, authorised', 'IT JUMPED: [[F1:verdict]].'],
  ['hyphenated, authorised', 'It was re-priced: [[F1:verdict]].'],
  [
    'cross-finding comparison (judged, not forbidden)',
    'ExampleCo1 is cheaper than [[F2]], see [[F1]].',
  ],
  ['cross-finding comparison, pricier', 'ExampleCo1 is pricier than [[F2]], see [[F1]].'],
];

/** Ordinary sentences with no change language. */
const BENIGN: Case[] = [
  ['plan includes', 'The Pro plan includes unlimited seats [[F1]].'],
  ['you asked about', 'You asked about ExampleCo1 [[F1]].'],
  ['list price', 'That is the list price [[F3]].'],
  ['verdict placeholder alone', 'ExampleCo3: [[F3:verdict]].'],
  ['verdict placeholder of a contested finding alone', 'ExampleCo6: [[F6:verdict]].'],
  ['narrative', 'Here is what I found.'],
  ['custom priced', 'The enterprise tier is custom priced [[F12]].'],
  ['billing', 'Both are billed monthly.'],
];

/**
 * Harmless sentences that are withheld because they use a word of the lexicon with no change meaning.
 * The cost of a backstop that cannot read meaning.
 */
const KNOWN_FALSE_POSITIVES: Case[] = [
  ['"change" as an instruction', 'You can change plans at any time [[F12]].'],
  ['"updated" about a page', 'The page was last updated recently [[F12]].'],
  ['"remove" as an instruction', 'Ask them to remove the seat limit [[F12]].'],
  ['"drop" in an offer', 'I can drop that comparison if you like [[F12]].'],
  ['"fall" as "belong"', 'The plans fall into tiers [[F12]].'],
  ['"lower" as an adjective', 'The team plan has a lower seat minimum [[F12]].'],
  ['"discount" as a noun', 'Annual billing gives a discount [[F12]].'],
  ['"release notes"', 'Use the release notes [[S:src_one]].'],
  ['"previously" about the conversation', 'We previously talked about this [[F12]].'],
  ['"since" about the user', 'Since you asked, here is the list price [[F12]].'],
];

/**
 * Change language the lexicon does not know. These PASS: the backstop is not a semantic detector. They are
 * listed so the gap is visible; the verdict-placeholder requirement and the prompt are the real boundary.
 */
const KNOWN_FALSE_NEGATIVES: Case[] = [
  ['"ticked upward"', 'The figure ticked upward [[F12]].'],
  ['"steeper"', 'It is steeper than it was [[F12]].'],
  ['"costs a premium"', 'It carries a premium [[F12]].'],
  ['"is not what it was"', 'It is not what it was [[F12]].'],
  ['"back to"', 'It is back to the old level [[F12]].'],
];

describe('change language: structural verdict requirement', () => {
  const corpus: Array<[string, Case[], 'withheld' | 'passed']> = [
    ['plain value placeholder', PLAIN_VALUE, 'withheld'],
    ['borrowed or ambiguous verdicts', BORROWED, 'withheld'],
    ['differs_timing_unknown with confirmed-change words', DIFFERS, 'withheld'],
    ['contested, unable_to_verify, stale', NOT_DEFINITIVE, 'withheld'],
    ['direction, timing and historical mismatches', MISMATCH, 'withheld'],
    ['obfuscated refusals', OBFUSCATED_REFUSED, 'withheld'],
    ['authorised language', AUTHORISED, 'passed'],
    ['benign sentences', BENIGN, 'passed'],
    ['known false positives', KNOWN_FALSE_POSITIVES, 'withheld'],
    ['known false negatives', KNOWN_FALSE_NEGATIVES, 'passed'],
  ];

  it('the corpus has at least 40 new cases', () => {
    expect(corpus.reduce((n, [, cases]) => n + cases.length, 0)).toBeGreaterThanOrEqual(40);
  });

  for (const [name, cases, outcome] of corpus) {
    describe(name, () => {
      it.each(cases)(`${outcome}: %s`, (_label, template) => {
        const issues = check(template);
        if (outcome === 'withheld') expect(issues).toContain('unsupported_verdict_word');
        else expect(issues).toEqual([]);
      });
    });
  }

  describe('a verdict cannot be borrowed from another finding', () => {
    it('BORROWED: another finding verdict, a verdict in another clause, several findings in one clause', () => {
      for (const [, t] of BORROWED) expect(check(t)).toContain('unsupported_verdict_word');
    });
    it('the right verdict of the right finding passes, the same words with the neighbour verdict do not', () => {
      expect(check('It jumped: [[F1:verdict]].')).toEqual([]);
      expect(check('It jumped: [[F3:verdict]].')).toContain('unsupported_verdict_word');
      expect(check('It jumped: [[F9:verdict]].')).toEqual([]);
    });
  });

  describe('differs_timing_unknown cannot authorise definitive change wording', () => {
    it.each(DIFFERS)('refused with F5: %s', (_label, template) => {
      expect(check(template)).toContain('unsupported_verdict_word');
    });
    it('only neutral wording that the values differ is accepted', () => {
      expect(check('The values differ and the timing is unknown: [[F5:verdict]].')).toEqual([]);
    });
  });
});

describe('change language through the release gate (ADR-40 semantics)', () => {
  const run = async (middle: string) => {
    const llm = new FakeLlm().queueStream({
      deltas: [`First [[F12]]. ${middle} Last [[F12]].`],
    });
    const s = sink();
    const set = findingSet(F);
    const r = await new LlmAnswerPipeline({ llm, options: { judge: false } }).run(
      {
        findings: set,
        recall: new Map<MessageId, { text: string; localTime: string }>(),
        ctx: context(),
        userMessage: 'What do they cost?',
        window: [],
        tz: 'Europe/London',
      },
      new FakeBudget(60_000),
      s.emit,
    );
    return { r, events: s.events, set };
  };
  const withheldWarnings = (events: Array<{ event: string; data?: unknown }>) =>
    events.filter(
      (e) => e.event === 'warning' && (e.data as { code: string }).code === 'sentence_withheld',
    );

  it.each([
    'It rose sharply [[F1]].',
    'It jumped: [[F5:verdict]].',
    'It jumped: [[F6:verdict]].',
    'It used to cost [[F3:baseline]].',
    'Both jumped: [[F1:verdict]] and [[F9:verdict]].',
    'It jumped: [[F3:verdict]].',
  ])(
    'withholds %j: no SSE index gap, no persisted placeholder, no leaked text',
    async (sentence) => {
      const { r, events } = await run(sentence);
      expect(r.sentences.map((x) => x.index)).toEqual([0, 1]);
      expect(r.sentences.map((x) => x.template)).toEqual(['First [[F12]].', 'Last [[F12]].']);
      expect(withheldWarnings(events)).toHaveLength(1);
      const sentEnds = events.flatMap((e) =>
        e.event === 'answer.sentence_end' ? [e.data.index] : [],
      );
      expect(sentEnds).toEqual([0, 1]);
      const delta = events.flatMap((e) =>
        e.event === 'answer.delta' ? [e.data.sentenceIndex] : [],
      );
      expect(delta).toEqual([0, 1]);
      expect(r.streamedThrough).toBe(1);
      expect(JSON.stringify(events)).not.toMatch(/jumped|rose|used to/);
      // nothing of the withheld sentence is persisted: its placeholders are in no stored sentence
      const stored = JSON.stringify(r.sentences);
      expect(stored).not.toContain('F1:verdict');
      expect(stored).not.toContain('F5:verdict');
      expect(stored).not.toContain('F3:baseline');
    },
  );

  it('releases an authorised sentence in place, and the persistence check accepts the result', async () => {
    const { r, set } = await run('It jumped: [[F1:verdict]].');
    expect(r.sentences.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(r.sentences[1]?.template).toBe('It jumped: [[F1:verdict]].');
    const base = buildCompletion({
      turnId: set.turnId,
      userId: 'usr_1',
      entityId: 'ent_1',
      sentences: 1,
      claimsAt: [],
      streamedThrough: -1,
    });
    const completion: TurnCompletion = {
      ...base,
      findings: set,
      assertions: r.sentences.flatMap((s) =>
        s.placeholders.flatMap((p) => {
          const m = /^\[\[(F\d+(?::baseline|:verdict|:derived:\d+)?)\]\]$/.exec(p.token);
          const f = F.find((x) => x.id === p.findingId);
          return m?.[1] && f
            ? [
                {
                  findingId: f.id,
                  sentenceIndex: s.index,
                  placeholder: m[1],
                  beliefKey: f.beliefKey,
                  renderedText: p.rendered,
                  value: f.current?.value ?? null,
                  evidenceIds: [],
                },
              ]
            : [];
        }),
      ),
      assistant: {
        rendered: r.rendered,
        template: r.template,
        sentences: r.sentences,
        streamedThrough: r.streamedThrough,
        messageStatus: 'complete',
      },
    };
    expect(() => validateCompletion(set.turnId, completion)).not.toThrow();
  });

  it('assertions built from a withheld-sentence answer never mention the withheld placeholder', async () => {
    const { r } = await run('It rose sharply [[F1]].');
    const tokens = r.sentences.flatMap((s) => s.placeholders.map((p) => p.token));
    expect(tokens).toEqual(['[[F12]]', '[[F12]]']);
  });
});

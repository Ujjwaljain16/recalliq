import { describe, expect, it } from 'vitest';
import { parsePlaceholderBody } from '../../../src/answer/placeholders.js';
import { checkFreeText, type T3aContext } from '../../../src/answer/t3a.js';
import type { Finding } from '../../../src/shared/findings.js';
import { finding } from './builders.js';

function check(
  template: string,
  opts: {
    findings?: Finding[];
    userMessage?: string;
    localDates?: string[];
    names?: string[];
  } = {},
) {
  const findings = opts.findings ?? [];
  const refs = [...template.matchAll(/\[\[([^\]]*)\]\]/g)].flatMap((m) => {
    const ref = parsePlaceholderBody(m[1] ?? '');
    if (!ref) return [];
    const f =
      ref.kind === 'finding' || ref.kind === 'finding_derived'
        ? (findings.find((x) => x.ord === ref.ord) ?? null)
        : null;
    return [{ ref, finding: f }];
  });
  const ctx: T3aContext = {
    userMessage: opts.userMessage ?? 'What does it cost?',
    localDates: opts.localDates ?? [],
    findings,
    nameNumerals: new Set(opts.names ?? []),
  };
  return checkFreeText({ template, refs }, ctx);
}

describe('T3a: free numbers, currency, percentages, dates', () => {
  it('a number inside a valid placeholder is never seen as free text', () => {
    expect(
      check('ExampleCo1 costs [[F1]] and was [[F1:baseline]].', { findings: [finding(1)] }),
    ).toEqual([]);
  });

  it('the same amount typed by the model in free text is flagged', () => {
    expect(check('ExampleCo1 costs $100 per user.')).toEqual(['free_currency']);
    expect(check('It is US$90 a month.')).toEqual(['free_currency']);
    expect(check('It costs 90 USD.')).toEqual(['free_currency']);
    expect(check('It costs ninety dollars.')).toEqual(['free_currency']);
    expect(check('It costs €1,200.50 a year.')).toEqual(['free_currency']);
  });

  it('a currency amount the user typed himself is exempt, a different one is not', () => {
    expect(check('Your budget of $100 is noted.', { userMessage: 'Anything under $100?' })).toEqual(
      [],
    );
    expect(check('Your budget of $200 is noted.', { userMessage: 'Anything under $100?' })).toEqual(
      ['free_currency'],
    );
  });

  it('flags percentages', () => {
    expect(check('Prices rose by 15%.')).toContain('free_percent');
    expect(check('Prices fell ten percent.')).toContain('free_percent');
  });

  it('flags other numbers unless the user wrote them or they belong to a name', () => {
    expect(check('There are 3 plans.')).toEqual(['free_number']);
    expect(check('There are three plans.')).toEqual(['free_number']);
    expect(
      check('For 20 seats you need the team plan.', { userMessage: 'We have 20 seats' }),
    ).toEqual([]);
    expect(check('Office 365 is covered.', { names: ['365'] })).toEqual([]);
    expect(check('Office 365 is covered.')).toEqual(['free_number']);
    expect(check('Not one of them is cheap.')).toEqual([]);
  });

  it('ignores a list marker at the start of a sentence, but not a number after it', () => {
    expect(check('1. First, the plan.')).toEqual([]);
    expect(check('2) Second, the plan.')).toEqual([]);
    expect(check('1. There are 7 plans.')).toEqual(['free_number']);
  });

  it('flags explicit dates unless they equal a resolved local date; weekdays and bare months are fine', () => {
    expect(check('It changed on 3 November.')).toEqual(['free_date']);
    expect(check('It changed on November 3rd, 2026.')).toEqual(['free_date']);
    expect(check('Since 2026-11-03 nothing moved.')).toContain('free_date');
    expect(check('It was in March 2026.')).toEqual(['free_date']);
    expect(check('You asked about 3 November.', { localDates: ['2026-11-03'] })).toEqual([]);
    expect(check('You asked about 3 November 2026.', { localDates: ['2026-11-03'] })).toEqual([]);
    expect(check('You asked about 3 November 2025.', { localDates: ['2026-11-03'] })).toEqual([
      'free_date',
    ]);
    expect(check('You asked about 4 November.', { localDates: ['2026-11-03'] })).toEqual([
      'free_date',
    ]);
    expect(check('Last Tuesday we spoke, probably in March.')).toEqual([]);
  });

  it('a date is not reported a second time as a free number', () => {
    expect(check('On 3 November it moved.')).toEqual(['free_date']);
  });
});

describe('T3a: verdict-word families need a compatible finding in the same sentence', () => {
  const up = finding(1, { verdict: 'changed', direction: 'up' });
  const down = finding(2, { verdict: 'changed', direction: 'down' });
  const same = finding(3, { verdict: 'unchanged_confirmed' });
  const quiet = finding(4, { verdict: 'no_evidence_of_change' });
  const differs = finding(5, { verdict: 'differs_timing_unknown' });
  const wrong = finding(6, { verdict: 'baseline_incorrect' });
  const launched = finding(7, {
    intent: 'releases',
    verdict: 'releases_found',
    releases: [
      {
        title: 'X',
        kind: 'launch',
        eventDate: null,
        providerPublishedAt: null,
        significance: null,
        announcedBeforeBaseline: false,
        citations: [],
      },
    ],
  });
  const removed = finding(8, {
    intent: 'releases',
    verdict: 'releases_found',
    releases: [
      {
        title: 'Y',
        kind: 'removal',
        eventDate: null,
        providerPublishedAt: null,
        significance: null,
        announcedBeforeBaseline: false,
        citations: [],
      },
    ],
  });
  const all = [up, down, same, quiet, differs, wrong, launched, removed];

  it.each([
    ['raised', 'The price was raised: [[F1]].', 'The price was raised: [[F3]].'],
    ['cut', 'They cut it: [[F2]].', 'They cut it: [[F1]].'],
    ['unchanged', 'It is unchanged: [[F3]].', 'It is unchanged: [[F4]].'],
    [
      'no evidence',
      'There is no evidence of a change: [[F4]].',
      'There is no evidence of a change: [[F1]].',
    ],
    ['different now', 'It is different now: [[F5]].', 'It is different now: [[F3]].'],
    ['launched', 'They launched it: [[F7]].', 'They launched it: [[F8]].'],
    ['discontinued', 'They discontinued it: [[F8]].', 'They discontinued it: [[F7]].'],
    ['was wrong', 'My answer was wrong: [[F6]].', 'My answer was wrong: [[F3]].'],
  ])('%s: allowed with its finding, flagged with another', (_name, good, bad) => {
    expect(check(good, { findings: all })).toEqual([]);
    expect(check(bad, { findings: all })).toEqual(['unsupported_verdict_word']);
  });

  it('flags a verdict word with no placeholder at all, and with a direction that does not match', () => {
    expect(check('The price was raised.', { findings: all })).toEqual(['unsupported_verdict_word']);
    expect(check('The price was lowered: [[F1]].', { findings: all })).toEqual([
      'unsupported_verdict_word',
    ]);
  });

  it('a verdict word is fine when ANY finding placeholder of the sentence supports it', () => {
    expect(
      check('Raised for one, unchanged for the other: [[F1]] and [[F3]].', { findings: all }),
    ).toEqual([]);
  });

  it('the same word with a "baseline" placeholder of a compatible finding is accepted (verdict belongs to the finding)', () => {
    expect(check('It was raised from [[F1:baseline]] to [[F1]].', { findings: all })).toEqual([]);
  });
});

describe('T3a: global negatives', () => {
  const same = finding(1, { verdict: 'unchanged_confirmed' });
  const same2 = finding(2, { verdict: 'unchanged_confirmed' });
  const quiet = finding(3, { verdict: 'no_evidence_of_change' });
  const none = finding(4, { intent: 'releases', verdict: 'none_found' });
  const unable = finding(5, { verdict: 'unable_to_verify', currentStatus: 'unable_to_verify' });
  const changed = finding(6, { verdict: 'changed', direction: 'up' });

  it('is allowed when every finding is unchanged_confirmed', () => {
    expect(check('Nothing changed.', { findings: [same, same2] })).toEqual([]);
    expect(check('None of them changed.', { findings: [same, same2] })).toEqual([]);
    expect(check('All the same.', { findings: [same, same2] })).toEqual([]);
  });

  it('is flagged when any finding changed or could not be verified', () => {
    for (const phrase of ['Nothing changed.', 'No changes were found.', 'None of them changed.']) {
      expect(check(phrase, { findings: [same, changed] })).toEqual(['unsupported_global_negative']);
      expect(check(phrase, { findings: [same, unable] })).toEqual(['unsupported_global_negative']);
    }
  });

  it('is flagged with no findings at all', () => {
    expect(check('Nothing changed.', { findings: [] })).toEqual(['unsupported_global_negative']);
  });

  it('with a no_evidence or none_found verdict it must use the "no sign / no evidence" wording', () => {
    expect(check('Nothing changed.', { findings: [same, quiet] })).toEqual([
      'unsupported_global_negative',
    ]);
    expect(check('Nothing changed.', { findings: [none] })).toEqual([
      'unsupported_global_negative',
    ]);
    expect(
      check('There was no sign of any change, and nothing changed.', { findings: [same, quiet] }),
    ).toEqual([]);
  });
});

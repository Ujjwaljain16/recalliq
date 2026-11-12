import { describe, expect, it } from 'vitest';
import { parsePlaceholderBody } from '../../../src/answer/placeholders.js';
import { checkFreeText } from '../../../src/answer/t3a.js';
import type { Finding } from '../../../src/shared/findings.js';
import { finding } from './builders.js';

function check(template: string, findings: Finding[]) {
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

describe('wording that contradicts the verdict is refused (gaps found by independent mutation checks)', () => {
  const differs = [finding(1, { verdict: 'differs_timing_unknown' })];

  it.each([
    ['The price is unchanged: [[F1:verdict]].', 'unsupported_verdict_word'],
    ['It is the same price: [[F1:verdict]].', 'unsupported_verdict_word'],
    ['There was no change: [[F1:verdict]].', 'unsupported_verdict_word'],
    ['Nothing changed, the price stays the same [[F1:verdict]].', 'unsupported_global_negative'],
  ] as const)('differs_timing_unknown never permits "no change" wording: %s', (template, issue) => {
    expect(check(template, differs)).toContain(issue);
  });

  it('the neutral wording for differs_timing_unknown is still accepted', () => {
    expect(check('The values differ and the timing is unknown: [[F1:verdict]].', differs)).toEqual(
      [],
    );
  });

  it.each(['contested', 'stale', 'unknown', 'unable_to_verify'] as const)(
    'a changed verdict on a %s finding authorises no change wording (defensive: the assembler never builds this)',
    (status) => {
      const odd = [finding(1, { verdict: 'changed', direction: 'up', currentStatus: status })];
      expect(check('It was changed: [[F1:verdict]].', odd)).toContain('unsupported_verdict_word');
      expect(check('It went up: [[F1:verdict]].', odd)).toContain('unsupported_verdict_word');
    },
  );
});

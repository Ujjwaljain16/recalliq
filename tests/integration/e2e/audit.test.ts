import { afterEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../../../src/temporal/clock.js';
import { acknowledge, ask, DAY, HOUR, scalar, startE2e, TUE, type E2eApp } from './harness.js';
import { auditOf, extractionOf, fixture, priceSearch, researchOf, say } from './scenarios.js';

let t: E2eApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

const FIRST = 'What does Acme CRM cost?';
const AGAIN = 'Is the Acme CRM price you gave me still correct?';

function auditFixture(prices: Array<number | 'unavailable'>, amountsExtracted: number[]) {
  return fixture({
    analysis: [researchOf(FIRST, ['Acme CRM']), auditOf(AGAIN, 'Acme CRM')],
    extraction: amountsExtracted.map((a) => extractionOf('Acme CRM', a)),
    synthesis: [
      say(FIRST, 'Acme CRM Pro is [[F1]].'),
      say(AGAIN, 'I said [[F1:baseline]]. Now the page shows [[F1]]. Acme CRM: [[F1:verdict]].'),
    ],
    search: [priceSearch('Acme CRM', ...prices)],
  });
}

describe('T-E2E audit: the verdict is only as strong as the proof', () => {
  it('differs_timing_unknown when one observation after the answer shows a different price', async () => {
    t = await startE2e({ fixture: auditFixture([90, 100], [90, 100]) });
    const user = t.client();
    const conv = await user.newConversation();

    const first = await ask(user, conv, FIRST);
    expect(first.status).toBe('complete');
    expect(first.sentences[0]).toContain('US$90');
    await acknowledge(user, first);

    // more than the 7-day contest window later, so two official values are not a contest
    t.clock.advance(8 * DAY);
    const second = await ask(user, conv, AGAIN);
    const findings = second.read.events.filter((e) => e.event === 'finding');
    expect(findings).toHaveLength(1);
    const finding = findings[0]?.data as {
      verdict: string;
      baseline?: { value: { amount: number } };
    };
    expect(finding.baseline?.value.amount).toBe(90);
    expect(finding.verdict).toBe('differs_timing_unknown');
    expect(second.sentences.join(' ')).toContain('US$100');
    expect(second.sentences.join(' ')).toContain("can't tell whether it changed");
    // the event written for this verdict is not a world change
    expect(
      scalar<string>(t.app, 'SELECT status FROM assertion_events ORDER BY rowid DESC LIMIT 1'),
    ).toBe('differs_timing_unknown');
  });

  it('changed only with an old-value re-observation after the answer and a later new-value one on the same url', async () => {
    // The answer (90) is acknowledged; a later check sees 90 again; a still later check sees 100.
    t = await startE2e({
      fixture: auditFixture([90, 90, 100], [90, 100]),
      clock: new FixedClock(TUE),
    });
    const user = t.client();
    const conv = await user.newConversation();
    const first = await ask(user, conv, FIRST);
    await acknowledge(user, first);

    t.clock.advance(8 * DAY);
    const second = await ask(user, conv, AGAIN);
    const v2 = (second.read.events.find((e) => e.event === 'finding')?.data as { verdict: string })
      .verdict;
    // not acknowledged: the second answer cannot become a baseline
    expect(v2).toBe('unchanged_confirmed');

    t.clock.advance(8 * DAY + HOUR);
    const third = await ask(user, conv, AGAIN);
    const f3 = third.read.events.find((e) => e.event === 'finding')?.data as {
      verdict: string;
      verdictReason: string;
      changeWindow?: { after: number; notAfter: number };
    };
    expect(f3.verdict).toBe('changed');
    expect(f3.verdictReason).toBe('same_source_bracketing');
    expect(f3.changeWindow?.after).toBe(TUE + 8 * DAY);
    expect(f3.changeWindow?.notAfter).toBe(TUE + 16 * DAY + HOUR);
  });
});

/** The same fixture with every provider marker removed: freshness is then unknown for every result. */
function withoutMarkers(f: ReturnType<typeof auditFixture>) {
  return {
    ...f,
    search: (f.search ?? []).map((entry) => ({
      ...entry,
      steps: entry.steps.map((step) =>
        'hits' in step
          ? {
              ...step,
              hits: step.hits.map((h) => ({ ...h, marker: undefined })),
            }
          : step,
      ),
    })),
  };
}

describe('T-E2E audit: freshness without provider provenance never becomes confirmation', () => {
  it('with no marker the same old-value / new-value history is never changed or unchanged_confirmed', async () => {
    t = await startE2e({
      fixture: withoutMarkers(auditFixture([90, 90, 100], [90, 100])),
      clock: new FixedClock(TUE),
    });
    const user = t.client();
    const conv = await user.newConversation();
    const first = await ask(user, conv, FIRST);
    await acknowledge(user, first);

    t.clock.advance(8 * DAY);
    const second = await ask(user, conv, AGAIN);
    const v2 = (second.read.events.find((e) => e.event === 'finding')?.data as { verdict: string })
      .verdict;
    expect(v2).not.toBe('unchanged_confirmed');

    t.clock.advance(8 * DAY + HOUR);
    const third = await ask(user, conv, AGAIN);
    const f3 = third.read.events.find((e) => e.event === 'finding')?.data as { verdict: string };
    expect(f3.verdict).not.toBe('changed');
    // Without a confirmed observation the first answer was about a stale finding, which is not an eligible
    // baseline (ADR-38 rule 6), so there is usually no verdict at all; a weaker verdict would also be acceptable.
    expect([null, 'differs_timing_unknown', 'no_evidence_of_change']).toContain(f3.verdict ?? null);
    // and nothing was stored as a confirmed live crawl
    expect(
      scalar(t.app, "SELECT count(*) FROM source_snapshots WHERE crawl_basis = 'confirmed_live'"),
    ).toBe(0);
    expect(scalar(t.app, 'SELECT count(*) FROM source_snapshots WHERE fresh_fetch = 1')).toBe(0);
  });

  it('with the marker the same history is changed, so the test above fails for the right reason', async () => {
    t = await startE2e({
      fixture: auditFixture([90, 90, 100], [90, 100]),
      clock: new FixedClock(TUE),
    });
    const user = t.client();
    const conv = await user.newConversation();
    await acknowledge(user, await ask(user, conv, FIRST));
    t.clock.advance(8 * DAY);
    await ask(user, conv, AGAIN);
    t.clock.advance(8 * DAY + HOUR);
    const third = await ask(user, conv, AGAIN);
    const f3 = third.read.events.find((e) => e.event === 'finding')?.data as { verdict: string };
    expect(f3.verdict).toBe('changed');
    expect(
      scalar(t.app, "SELECT count(*) FROM source_snapshots WHERE crawl_basis = 'confirmed_live'"),
    ).toBeGreaterThan(0);
  });
});

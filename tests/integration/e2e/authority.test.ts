import { afterEach, describe, expect, it } from 'vitest';
import { OfficialDomains } from '../../../src/app/live/registry.js';
import { acknowledge, ask, DAY, eventsOf, startE2e, type E2eApp } from './harness.js';
import {
  auditOf,
  extractionOf,
  fixture,
  priceSearch,
  priceSearchAt,
  researchOf,
  say,
} from './scenarios.js';

let t: E2eApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

const Q = 'What does Acme CRM cost?';
const AUDIT = 'Is the Acme CRM price you gave me still correct?';
const LOOK_ALIKE = 'https://acme.sample/en-gb/pricing';
const FALLBACK = 'Acme CRM pricing plans per user 2026';

const tiers = (turn: Awaited<ReturnType<typeof ask>>): string[] =>
  (eventsOf(turn, 'source') as Array<{ tier: string }>).map((s) => s.tier);

describe('T-E2E official-domain authority comes only from the owner registry', () => {
  it('a domain listed in the registry is tier A1', async () => {
    t = await startE2e({
      fixture: fixture({
        analysis: [researchOf(Q, ['Acme CRM'])],
        extraction: [extractionOf('Acme CRM', 90)],
        search: [priceSearch('Acme CRM', 90)],
        synthesis: [say(Q, 'Acme CRM Pro is [[F1]].')],
      }),
    });
    const user = t.client();
    const turn = await ask(user, await user.newConversation(), Q);
    expect(tiers(turn)).toEqual(['A1']);
  });

  it('a look-alike host with the same name label is not official when only the real domain is listed', async () => {
    t = await startE2e({
      fixture: fixture({
        analysis: [researchOf(Q, ['Acme CRM'])],
        extraction: [extractionOf('Acme CRM', 90)],
        search: [
          priceSearchAt(LOOK_ALIKE, 'Acme CRM', 'Acme CRM pricing', 90),
          priceSearchAt(LOOK_ALIKE, 'Acme CRM', FALLBACK, 90),
        ],
        synthesis: [say(Q, 'Acme CRM Pro is [[F1]].')],
      }),
    });
    const user = t.client();
    const turn = await ask(user, await user.newConversation(), Q);
    expect(tiers(turn)).toEqual(['C']);
    const finding = eventsOf(turn, 'finding')[0] as { coverage: { freshOfficialFetched: boolean } };
    expect(finding.coverage.freshOfficialFetched).toBe(false);
  });

  it('with no registry at all, even the matching name and the analysis guess make nothing official', async () => {
    t = await startE2e({
      registry: OfficialDomains.none(),
      fixture: fixture({
        analysis: [researchOf(Q, ['Acme CRM'])],
        extraction: [extractionOf('Acme CRM', 90)],
        search: [priceSearch('Acme CRM', 90), { ...priceSearch('Acme CRM', 90), query: FALLBACK }],
        synthesis: [say(Q, 'Acme CRM Pro is [[F1]].')],
      }),
    });
    const user = t.client();
    const turn = await ask(user, await user.newConversation(), Q);
    expect(tiers(turn)).toEqual(['C']);
    // nothing was stored as an official domain either
    expect(t.app.db.prepare('SELECT count(*) FROM entity_domains').pluck().get()).toBe(0);
  });
});

describe('T-E2E audit verdicts stay strict when the evidence is below tier A', () => {
  const lowerTier = (prices: number[]) =>
    fixture({
      analysis: [researchOf(Q, ['Acme CRM']), auditOf(AUDIT, 'Acme CRM')],
      extraction: [...new Set(prices)].map((p) => extractionOf('Acme CRM', p)),
      search: [
        priceSearch('Acme CRM', ...prices),
        { ...priceSearch('Acme CRM', ...prices), query: FALLBACK },
        // a stored entity without registry domains gets a discovery search; it is a hint and finds nothing here
        { query: 'Acme CRM official site', steps: prices.map(() => ({ hits: [] })) },
      ],
      synthesis: [
        say(Q, 'Acme CRM Pro is [[F1]].'),
        say(AUDIT, 'I said [[F1:baseline]]. Now [[F1]]. Acme CRM: [[F1:verdict]].'),
      ],
    });

  it('differs_timing_unknown, not changed, when one later observation differs', async () => {
    t = await startE2e({ registry: OfficialDomains.none(), fixture: lowerTier([90, 100]) });
    const user = t.client();
    const conv = await user.newConversation();
    await acknowledge(user, await ask(user, conv, Q));
    t.clock.advance(8 * DAY);
    const second = await ask(user, conv, AUDIT);
    expect(tiers(second).every((x) => x === 'C')).toBe(true);
    const f = eventsOf(second, 'finding')[0] as { verdict: string };
    expect(f.verdict).toBe('differs_timing_unknown');
  });

  it('re-observation bracketing on tier C pages alone never proves a change', async () => {
    t = await startE2e({ registry: OfficialDomains.none(), fixture: lowerTier([90, 90, 100]) });
    const user = t.client();
    const conv = await user.newConversation();
    await acknowledge(user, await ask(user, conv, Q));
    t.clock.advance(8 * DAY);
    const second = await ask(user, conv, AUDIT);
    // "unchanged_confirmed" needs a fresh A1 observation, so below tier A the strongest same-value verdict is weaker
    expect((eventsOf(second, 'finding')[0] as { verdict: string }).verdict).toBe(
      'no_evidence_of_change',
    );
    t.clock.advance(8 * DAY);
    const third = await ask(user, conv, AUDIT);
    const f = eventsOf(third, 'finding')[0] as { verdict: string; verdictReason: string };
    // A tier C baseline and tier C pages cannot support a computed change (docs/security.md, baseline poisoning)
    expect(f.verdict).toBe('differs_timing_unknown');
    expect(f.verdictReason).toBe('low_authority_source');
  });
});

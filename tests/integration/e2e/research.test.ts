import { afterEach, describe, expect, it } from 'vitest';
import { ask, eventsOf, startE2e, type E2eApp } from './harness.js';
import { extractionOf, fixture, priceSearch, researchOf, say } from './scenarios.js';

let t: E2eApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

const QUESTION = 'Compare the prices of Acme CRM, Beta Suite and Gamma Desk.';

interface FindingEvent {
  entityName: string;
  currentStatus: string;
  verdict: string | null;
  coverage: { failure: string | null; searchesFailed: number };
  current?: { value: { amount: number }; citations: string[] };
}

describe('T-E2E research across several tools', () => {
  it('reports findings with citations per entity, and never claims success for the entity whose search failed', async () => {
    t = await startE2e({
      fixture: fixture({
        analysis: [researchOf(QUESTION, ['Acme CRM', 'Beta Suite', 'Gamma Desk'])],
        extraction: [extractionOf('Acme CRM', 90), extractionOf('Beta Suite', 80)],
        search: [
          priceSearch('Acme CRM', 90),
          priceSearch('Beta Suite', 80),
          // the first attempt and its one retry both fail, then the fallback query fails the same way
          priceSearch('Gamma Desk', 'unavailable', 'unavailable'),
          {
            query: 'Gamma Desk pricing plans per user 2026',
            steps: [{ error: 'unavailable' }, { error: 'unavailable' }],
          },
        ],
        synthesis: [say(QUESTION, 'Acme CRM: [[F1]]. Beta Suite: [[F2]]. Gamma Desk: [[F3]].')],
      }),
    });
    const user = t.client();
    const conv = await user.newConversation();
    const turn = await ask(user, conv, QUESTION);

    const findings = eventsOf(turn, 'finding') as FindingEvent[];
    const by = (n: string): FindingEvent => {
      const f = findings.find((x) => x.entityName === n);
      if (!f) throw new Error(`no finding for ${n}`);
      return f;
    };
    expect(findings).toHaveLength(3);
    expect(by('Acme CRM').currentStatus).toBe('confirmed');
    expect(by('Acme CRM').current?.value.amount).toBe(90);
    expect(by('Acme CRM').current?.citations).toHaveLength(1);
    expect(by('Beta Suite').current?.value.amount).toBe(80);
    expect(by('Gamma Desk').currentStatus).toBe('unable_to_verify');
    // a first-time question has no baseline, so there is no verdict to state: the status carries it
    expect(by('Gamma Desk').verdict).toBeNull();
    expect(by('Gamma Desk').coverage.failure).toBe('search_unavailable');
    expect(by('Gamma Desk').current).toBeUndefined();

    // the sources that were read arrive as events, and the answer cites exactly them
    expect(eventsOf(turn, 'source')).toHaveLength(2);
    expect(turn.completed?.sentences.map((s) => s.status)).toEqual([
      'verified',
      'verified',
      'verified',
    ]);
    const text = turn.sentences.join(' ');
    expect(text).toContain('US$90');
    expect(text).toContain('US$80');
    expect(text).toContain(
      "Gamma Desk: couldn't be checked this time (the search service was unavailable).",
    );
    expect(text).not.toMatch(/Gamma Desk: [^.]*US[$]/);
    expect(text.match(/\[\d\]/g)).toHaveLength(2);

    // partial, not complete: something could not be checked
    expect(turn.status).toBe('partial');
    expect(eventsOf(turn, 'warning').map((w) => (w as { code: string }).code)).toContain(
      'search_partial',
    );
  });

  // A finding that is unable_to_verify and has no verdict (a first-time question) must say the check failed,
  // not that nothing exists: the reader has to be able to tell the two apart.
  it('an unable_to_verify finding without a verdict is rendered as "could not be checked", not as "nothing found"', async () => {
    t = await startE2e({
      fixture: fixture({
        analysis: [researchOf(QUESTION, ['Gamma Desk'])],
        search: [
          priceSearch('Gamma Desk', 'unavailable', 'unavailable'),
          {
            query: 'Gamma Desk pricing plans per user 2026',
            steps: [{ error: 'unavailable' }, { error: 'unavailable' }],
          },
        ],
        synthesis: [say(QUESTION, 'Gamma Desk: [[F1]].')],
      }),
    });
    const user = t.client();
    const turn = await ask(user, await user.newConversation(), QUESTION);
    expect(turn.sentences.join(' ')).toMatch(/could(n't| not) be checked/);
  });
});

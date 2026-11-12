import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledge,
  ask,
  dbContains,
  DAY,
  eventsOf,
  scalar,
  startE2e,
  type E2eApp,
} from './harness.js';
import { auditOf, extractionOf, fixture, priceSearch, researchOf, say } from './scenarios.js';

let t: E2eApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

const BOTH = 'Which costs what, Acme CRM or Beta Suite?';
const AUDIT_ACME = 'Is the Acme CRM price you gave me still correct?';
const AUDIT_BETA = 'Is the Beta Suite price you gave me still correct?';

describe('T-E2E acknowledgement decides what the assistant said', () => {
  it('only acknowledged sentences become baselines; a streamed-but-unacknowledged claim is not one', async () => {
    t = await startE2e({
      fixture: fixture({
        analysis: [
          researchOf(BOTH, ['Acme CRM', 'Beta Suite']),
          auditOf(AUDIT_ACME, 'Acme CRM'),
          auditOf(AUDIT_BETA, 'Beta Suite'),
        ],
        extraction: [extractionOf('Acme CRM', 90), extractionOf('Beta Suite', 80)],
        search: [priceSearch('Acme CRM', 90, 90), priceSearch('Beta Suite', 80, 80)],
        synthesis: [
          say(BOTH, 'Acme CRM: [[F1]].', ' Beta Suite: [[F2]].'),
          say(AUDIT_ACME, 'I said [[F1:baseline]]. Acme CRM: [[F1:verdict]].'),
          say(AUDIT_BETA, 'Beta Suite: [[F1]].'),
        ],
      }),
    });
    const user = t.client();
    const conv = await user.newConversation();
    const first = await ask(user, conv, BOTH);
    expect(first.sentences).toHaveLength(2);

    // the browser rendered sentence 0 only
    const ack = await acknowledge(user, first, 0);
    expect(ack).toEqual({ status: 200, body: { renderedThrough: 0, newlyPresented: 1 } });
    expect(scalar(t.app, 'SELECT count(*) FROM assertions WHERE presented_at IS NOT NULL')).toBe(1);
    expect(scalar(t.app, 'SELECT count(*) FROM assertions')).toBe(2);

    t.clock.advance(8 * DAY);
    const acme = await ask(user, conv, AUDIT_ACME);
    const f = eventsOf(acme, 'finding') as Array<{ baseline?: { value: { amount: number } } }>;
    expect(f).toHaveLength(1);
    expect(f[0]?.baseline?.value.amount).toBe(90);

    // Beta's claim was streamed but never acknowledged: it is no baseline. The current price is researched and
    // the answer says plainly that nothing earlier can be compared against.
    const beta = await ask(user, conv, AUDIT_BETA);
    const betaFindings = eventsOf(beta, 'finding') as Array<{ baseline?: unknown }>;
    expect(betaFindings).toHaveLength(1);
    expect(betaFindings[0]?.baseline).toBeUndefined();
    expect(beta.sentences.join(' ')).toContain('no earlier answer of my own on record');
  });

  it('a withheld sentence never reaches the stream or the database, and leaves nothing to acknowledge', async () => {
    const Q = 'What does Acme CRM cost?';
    t = await startE2e({
      fixture: fixture({
        analysis: [researchOf(Q, ['Acme CRM'])],
        extraction: [extractionOf('Acme CRM', 90)],
        search: [priceSearch('Acme CRM', 90)],
        // the second sentence types a price itself
        synthesis: [say(Q, 'Acme CRM Pro is [[F1]].', ' The current plan costs $100/month.')],
      }),
    });
    const user = t.client();
    const turn = await ask(user, await user.newConversation(), Q);

    expect(turn.sentences).toHaveLength(1);
    expect(turn.read.raw).not.toContain('$100/month');
    const warnings = eventsOf(turn, 'warning') as Array<{ code: string; text: string }>;
    expect(warnings.map((w) => w.code)).toContain('sentence_withheld');
    expect(warnings.find((w) => w.code === 'sentence_withheld')?.text).toContain('free_currency');
    expect(dbContains(t.app, '$100/month')).toBe(false);
    expect(dbContains(t.app, '100/month')).toBe(false);

    // one sentence was released; renderedThrough beyond it is refused, so the withheld one cannot be presented
    const beyond = await user.json('POST', `/api/turns/${turn.turnId}/ack`, {
      renderedThrough: 1,
      complete: false,
    });
    expect(beyond.status).toBe(400);
    expect((beyond.body as { error: { code: string; reason: string } }).error).toMatchObject({
      code: 'invalid_ack',
      reason: 'beyond_streamed_extent',
    });
    expect(scalar(t.app, 'SELECT count(*) FROM assertions WHERE presented_at IS NOT NULL')).toBe(0);
    expect(scalar(t.app, 'SELECT count(*) FROM assertions')).toBe(1);
  });

  it('rejects an acknowledgement past what was streamed, and a complete flag that does not match', async () => {
    const Q = 'What does Acme CRM cost?';
    t = await startE2e({
      fixture: fixture({
        analysis: [researchOf(Q, ['Acme CRM'])],
        extraction: [extractionOf('Acme CRM', 90)],
        search: [priceSearch('Acme CRM', 90)],
        synthesis: [say(Q, 'Acme CRM Pro is [[F1]].', ' Check the page yourself.')],
      }),
    });
    const user = t.client();
    const turn = await ask(user, await user.newConversation(), Q);
    const post = (body: object) => user.json('POST', `/api/turns/${turn.turnId}/ack`, body);

    expect((await post({ renderedThrough: 2, complete: false })).status).toBe(400);
    expect((await post({ renderedThrough: 0, complete: true })).status).toBe(400);
    expect(scalar(t.app, 'SELECT count(*) FROM assertions WHERE presented_at IS NOT NULL')).toBe(0);
    expect((await post({ renderedThrough: 1, complete: true })).status).toBe(200);
  });
});

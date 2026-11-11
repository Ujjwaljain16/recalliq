import { describe, expect, it } from 'vitest';
import { LlmAnswerPipeline } from '../../../src/answer/pipeline.js';
import { FakeLlm } from '../../../src/llm/fake.js';
import type { FindingSet } from '../../../src/shared/findings.js';
import type { MessageId, SnapshotId } from '../../../src/shared/ids.js';
import { FakeBudget } from '../../helpers/budget.js';
import { T_NOV_3, context, finding, sink } from '../../unit/answer/builders.js';

/** [SYNTHETIC] sources: one page per entity. */
const G2 = 'src_g2' as SnapshotId;
const LEAD = 'src_leadhaste' as SnapshotId;
const SF = 'src_sf' as SnapshotId;

const page = (domain: string, text: string) => ({
  url: `https://${domain}/page`,
  title: `[SYNTHETIC] ${domain}`,
  domain,
  tier: 'B' as const,
  observedAt: T_NOV_3,
  content: { text, publishedAt: T_NOV_3 },
});

const zoho = finding(1, { entityName: 'Zoho CRM', current: undefined });
const sales = finding(2, {
  entityName: 'Freshsales',
  currentStatus: 'unable_to_verify',
  current: undefined,
  verdictReason: 'search_timeout',
});
const force = finding(3, { entityName: 'Salesforce', current: undefined });

const set = (findings: FindingSet['findings']): FindingSet => ({
  turnId: 'trn_1',
  createdAt: T_NOV_3,
  findings,
  sources: {
    [G2]: page(
      'g2.com',
      'Zoho CRM pricing in 2026 starts at $14.00 and can reach $52.00 depending on the plan.',
    ),
    [LEAD]: page(
      'leadhaste.com',
      'Freshsales has four plan tiers and starts at $9 per user per month.',
    ),
    [SF]: page('salesforce.com', 'Salesforce Starter Suite costs $25 per user per month.'),
  },
});

async function run(deltas: string[], findings: FindingSet['findings']) {
  const llm = new FakeLlm().queueStream({ deltas });
  const s = sink();
  const r = await new LlmAnswerPipeline({ llm }).run(
    {
      findings: set(findings),
      recall: new Map<MessageId, { text: string; localTime: string }>(),
      ctx: context(),
      userMessage: 'What do Zoho CRM, Freshsales and Salesforce cost?',
      window: [],
      tz: 'UTC',
    },
    new FakeBudget(60_000),
    s.emit,
  );
  const streamed = s.events.flatMap((e) => (e.event === 'answer.delta' ? [e.data.text] : []));
  return { r, streamed };
}

describe('a negative finding line and a sourced sentence about the same entity', () => {
  it('Zoho CRM: one statement, the negative as a qualifier after the sourced sentence', async () => {
    const { r, streamed } = await run(
      [
        'Zoho CRM: [[F1]]. ',
        `According to g2.com, Zoho CRM pricing in 2026 starts at $14.00 and can reach $52.00 depending on the plan [[S:${G2}]].`,
      ],
      [zoho],
    );
    const text =
      'According to g2.com, Zoho CRM pricing in 2026 starts at $14.00 and can reach $52.00 depending on the plan [1] — not confirmed by my own checks.';
    expect(r.rendered).toBe(text);
    expect(streamed.join('')).toBe(text);
    expect(r.sentences).toHaveLength(1);
    expect(r.sentences[0]).toMatchObject({ kind: 'sourced', status: 'verified', index: 0 });
    expect(r.sentences[0]?.template).toContain('[[F1]]');
    expect(r.rendered).not.toContain('I could not confirm a price');
  });

  it('Freshsales: a failed check becomes the qualifier with its reason', async () => {
    const { r } = await run(
      [
        'Freshsales: [[F2]]. ',
        `According to leadhaste.com, Freshsales has four plan tiers and starts at $9 per user per month [[S:${LEAD}]].`,
      ],
      [sales],
    );
    expect(r.rendered).toBe(
      'According to leadhaste.com, Freshsales has four plan tiers and starts at $9 per user per month [2] — my own check of the page failed (the search timed out).',
    );
  });

  it('keeps each entity separate in paragraphs, with one space inside a paragraph', async () => {
    const { r, streamed } = await run(
      [
        'Zoho CRM: [[F1]]. ',
        `According to g2.com, Zoho CRM pricing in 2026 starts at $14.00 [[S:${G2}]]. `,
        'Salesforce: [[F3]]. ',
        `Salesforce Starter Suite costs $25 per user per month [[S:${SF}]]. `,
        'Freshsales: [[F2]].',
      ],
      [zoho, force, sales],
    );
    expect(r.rendered).toBe(
      [
        'According to g2.com, Zoho CRM pricing in 2026 starts at $14.00 [1] — not confirmed by my own checks.',
        'Salesforce Starter Suite costs $25 per user per month [3] — not confirmed by my own checks.',
        "Freshsales: couldn't be checked this time (the search timed out).",
      ].join('\n\n'),
    );
    expect(streamed.join('')).toBe(r.rendered);
  });

  it('leaves the negative line as it is when no sourced sentence follows', async () => {
    const { r } = await run(['Zoho CRM: [[F1]].'], [zoho]);
    expect(r.rendered).toBe('Zoho CRM: I could not confirm a price through my checks.');
  });

  it('does not merge a sourced sentence about another entity', async () => {
    const { r } = await run(
      ['Zoho CRM: [[F1]]. ', `Salesforce Starter Suite costs $25 per user per month [[S:${SF}]].`],
      [zoho, force],
    );
    expect(r.sentences).toHaveLength(2);
    expect(r.sentences[0]?.text).toBe('Zoho CRM: I could not confirm a price through my checks.');
  });
});

describe('the kind of a sentence that only says there is no verified value', () => {
  it('is unconfirmed for a no-price line and for a failed check, verified for a confirmed value', async () => {
    const ok = finding(4, { entityName: 'Acme' });
    const a = await run(['Zoho CRM: [[F1]]. '], [zoho]);
    expect(a.r.sentences[0]?.kind).toBe('unconfirmed');
    const b = await run(['Freshsales: [[F2]].'], [sales]);
    expect(b.r.sentences[0]?.kind).toBe('unconfirmed');
    const c = await run(['Acme: [[F4]].'], [ok]);
    expect(c.r.sentences[0]?.kind).toBe('verified');
  });
});

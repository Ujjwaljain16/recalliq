import { describe, expect, it } from 'vitest';
import { auditLane } from '../../../src/orchestration/lanes/audit.js';
import { chatLane } from '../../../src/orchestration/lanes/chat.js';
import { clarifyLane } from '../../../src/orchestration/lanes/clarify.js';
import { recallLane } from '../../../src/orchestration/lanes/recall.js';
import { researchLane } from '../../../src/orchestration/lanes/research.js';
import { ContractViolationError } from '../../../src/orchestration/errors.js';
import { newId, type ConversationId, type EntityId } from '../../../src/shared/ids.js';
import type { Baseline, DecisionRecord } from '../../../src/shared/memory.js';
import type { TemporalMention } from '../../../src/shared/understanding.js';
import {
  analysis,
  CONV,
  entityRecord,
  FakeResearch,
  findingSet,
  laneDeps,
  laneInput,
  mention,
  messageHit,
  NOW,
  SpyBaselines,
  SpyMemory,
  unableFinding,
  finding,
  USER,
} from './fakes.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const yesterday: TemporalMention = {
  text: 'yesterday',
  expr: { kind: 'yesterday' },
  role: 'reference_conversation',
};
const lastTuesday: TemporalMention = {
  text: 'last Tuesday',
  expr: { kind: 'weekday', weekday: 2, modifier: 'last' },
  role: 'reference_conversation',
};
const YESTERDAY_NOON = Date.UTC(2026, 10, 10, 12);

describe('chat lane', () => {
  it('makes no database read, no baseline read, no search and no plan', async () => {
    const memory = new SpyMemory();
    const baselines = new SpyBaselines();
    const research = new FakeResearch((r) => findingSet(r.turnId, []));
    const { input, states } = laneInput(analysis({ laneHint: 'chat' }));
    const out = await chatLane(input, laneDeps({ memory, baselines, research }));
    expect(out).toMatchObject({ kind: 'synthesize', lane: 'chat', findings: null });
    expect(memory.calls).toEqual([]);
    expect(baselines.calls).toEqual([]);
    expect(research.calls).toEqual([]);
    expect(states).toEqual([]);
  });
});

describe('recall lane', () => {
  it('answers from the stored message, passing it to synthesis as recall text', async () => {
    const hit = messageHit(YESTERDAY_NOON, CONV, 'What does Notion cost?');
    const memory = new SpyMemory({ messages: [hit] });
    const { input, events } = laneInput(analysis({ laneHint: 'recall', temporal: [yesterday] }));
    const out = await recallLane(input, laneDeps({ memory }));
    expect(out.kind).toBe('synthesize');
    if (out.kind !== 'synthesize') return;
    expect(out.ctx.memoryHits.map((h) => h.messageId)).toEqual([hit.messageId]);
    expect(out.recall.get(hit.messageId)?.text).toBe('What does Notion cost?');
    expect(events.some((e) => e.event === 'context')).toBe(true);
  });

  it('with no stored record says so in a fixed reply and hands synthesis nothing to quote', async () => {
    const { input } = laneInput(analysis({ laneHint: 'recall', temporal: [yesterday] }));
    const out = await recallLane(input, laneDeps({ memory: new SpyMemory({ messages: [] }) }));
    expect(out.kind).toBe('reply');
    if (out.kind !== 'reply') return;
    expect(out.reason).toBe('no_record');
    expect(out.sentences[0]).toMatch(/no record of a conversation/i);
    expect(out.sentences.join(' ')).toContain('2026-11-10');
    expect(out.ctx.memoryHits).toEqual([]);
  });

  it('asks, never picks, when two candidate days both match', async () => {
    const memory = new SpyMemory({
      messages: [
        messageHit(Date.UTC(2026, 10, 3, 12), CONV, 'Tuesday 3rd question'),
        messageHit(Date.UTC(2026, 10, 10, 12), 'cnv_other', 'Tuesday 10th question'),
      ],
    });
    const { input, events } = laneInput(analysis({ laneHint: 'recall', temporal: [lastTuesday] }));
    const out = await recallLane(input, laneDeps({ memory }));
    expect(out.kind).toBe('clarify');
    if (out.kind !== 'clarify') return;
    expect(out.reason).toBe('ambiguous_day');
    expect(out.options.map((o) => o.ref).sort()).toEqual(['day:2026-11-03', 'day:2026-11-10']);
    expect(out.ctx.clarification?.options).toEqual(out.options);
    expect(events.some((e) => e.event === 'clarification')).toBe(true);
  });

  it('asks which conversation when several on the day match the topic', async () => {
    const memory = new SpyMemory({
      messages: [
        messageHit(YESTERDAY_NOON, CONV, 'hosting question one'),
        messageHit(YESTERDAY_NOON + HOUR, 'cnv_two', 'hosting question two'),
      ],
    });
    const { input } = laneInput(
      analysis({ laneHint: 'recall', temporal: [yesterday], topicTerms: ['hosting'] }),
    );
    const out = await recallLane(input, laneDeps({ memory }));
    expect(out).toMatchObject({ kind: 'clarify', reason: 'ambiguous_conversation' });
  });

  it('asks for the date when none was given or it cannot be worked out', async () => {
    const none = await recallLane(laneInput(analysis({ laneHint: 'recall' })).input, laneDeps());
    expect(none).toMatchObject({ kind: 'clarify', reason: 'no_date' });
    const bad: TemporalMention = {
      text: 'sometime',
      expr: { kind: 'calendar_date', day: 31, month: 2 },
      role: 'reference_conversation',
    };
    const unresolved = await recallLane(
      laneInput(analysis({ laneHint: 'recall', temporal: [bad] })).input,
      laneDeps(),
    );
    expect(unresolved).toMatchObject({ kind: 'clarify', reason: 'unresolved_date' });
  });
});

describe('clarify lane', () => {
  it('builds a typed question from the unresolved reference', async () => {
    const { input, events } = laneInput(
      analysis({ laneHint: 'clarify', references: [{ text: 'that one', kind: 'conversation' }] }),
    );
    const out = await clarifyLane(input, laneDeps());
    expect(out).toMatchObject({ kind: 'clarify', reason: 'analysis_requested', options: [] });
    if (out.kind === 'clarify') expect(out.question).toContain('that one');
    expect(events.map((e) => e.event)).toContain('clarification');
  });

  it('asks a generic question when the analysis named nothing', async () => {
    const out = await clarifyLane(laneInput(analysis({ laneHint: 'clarify' })).input, laneDeps());
    expect(out.kind).toBe('clarify');
  });
});

describe('research lane', () => {
  const hubspot = entityRecord('HubSpot', { domains: ['hubspot.com'] });
  const researching = analysis({
    laneHint: 'research',
    intents: ['pricing'],
    entities: [mention('HubSpot')],
  });

  it('plans, runs the service with the same budget and ctx, and walks the existing edges', async () => {
    const research = new FakeResearch((r) => ({
      ...findingSet(r.turnId, [finding(1)]),
      sources: { src_a: {} as never },
    }));
    const h = laneInput(researching);
    const out = await researchLane(
      h.input,
      laneDeps({ memory: new SpyMemory({ entities: [hubspot] }), research }),
    );
    expect(out.kind).toBe('synthesize');
    expect(research.calls).toHaveLength(1);
    const req = research.calls[0];
    expect(req?.budget).toBe(h.input.budget);
    expect(req?.ctx.entities.map((e) => e.name)).toEqual(['HubSpot']);
    expect(req?.plan.specs[0]?.request.query).toBe('HubSpot pricing');
    expect(h.states).toEqual([
      'PLANNING',
      'SEARCHING',
      'EXTRACTING',
      'VERIFYING',
      'RESOLVING_BELIEFS',
    ]);
    expect(h.events.find((e) => e.event === 'plan')?.data).toMatchObject({
      entities: ['HubSpot'],
      plannedSearches: 1,
    });
  });

  it('skips extraction and verification when the service returned no sources (SEARCHING to RESOLVING_BELIEFS)', async () => {
    const research = new FakeResearch((r) => findingSet(r.turnId, [unableFinding(1)]));
    const h = laneInput(researching);
    await researchLane(
      h.input,
      laneDeps({ memory: new SpyMemory({ entities: [hubspot] }), research }),
    );
    expect(h.states).toEqual(['PLANNING', 'SEARCHING', 'RESOLVING_BELIEFS']);
  });

  it('propagates a failure of the service: it is never converted into a result', async () => {
    const boom = new Error('database is locked');
    const research = new FakeResearch(() => boom);
    await expect(researchLane(laneInput(researching).input, laneDeps({ research }))).rejects.toBe(
      boom,
    );
  });

  it('refuses a self-contradicting finding set (provider failure shown as success)', async () => {
    const lie = finding(1, {
      coverage: {
        ...finding(1).coverage,
        searchesOk: 0,
        searchesFailed: 1,
        failure: 'search_unavailable',
      },
    });
    const research = new FakeResearch((r) => findingSet(r.turnId, [lie]));
    await expect(
      researchLane(laneInput(researching).input, laneDeps({ research })),
    ).rejects.toBeInstanceOf(ContractViolationError);
  });

  it('asks which one when a mention matches two stored entities', async () => {
    const a = entityRecord('Mercury', { aliases: ['mercury'] });
    const b = entityRecord('Mercury Bank', { aliases: ['mercury'] });
    const research = new FakeResearch((r) => findingSet(r.turnId, []));
    const out = await researchLane(
      laneInput(
        analysis({ laneHint: 'research', intents: ['pricing'], entities: [mention('Mercury')] }),
      ).input,
      laneDeps({ memory: new SpyMemory({ entities: [a, b] }), research }),
    );
    expect(out.kind).toBe('clarify');
    if (out.kind !== 'clarify') return;
    expect(out.reason).toBe('ambiguous_entity');
    expect(out.options.map((o) => o.ref).sort()).toEqual(
      [`entity:${a.id}`, `entity:${b.id}`].sort(),
    );
    expect(research.calls).toEqual([]);
  });

  it('resolves the "shortlist since Monday" from stored decisions and asks when none is stored', async () => {
    const slack = entityRecord('Slack');
    const decision: DecisionRecord = {
      id: newId('dec'),
      payload: { kind: 'shortlist', entities: ['Slack'] },
      entityIds: [slack.id],
      createdAt: NOW - DAY,
      messageId: newId('msg'),
      version: 1,
    };
    const a = analysis({
      laneHint: 'research',
      intents: ['pricing'],
      references: [{ text: 'my shortlist', kind: 'entity_set' }],
    });
    const research = new FakeResearch((r) => findingSet(r.turnId, [finding(1)]));
    const found = await researchLane(
      laneInput(a).input,
      laneDeps({ memory: new SpyMemory({ decisions: [decision], entities: [slack] }), research }),
    );
    expect(found.kind).toBe('synthesize');
    expect(research.calls[0]?.ctx.entities.map((e) => e.name)).toEqual(['Slack']);
    expect(research.calls[0]?.ctx.decisions).toEqual([decision]);

    const empty = await researchLane(
      laneInput(a).input,
      laneDeps({ research: new FakeResearch((r) => findingSet(r.turnId, [])) }),
    );
    expect(empty).toMatchObject({ kind: 'clarify', reason: 'missing_referent' });
  });

  it('warns when more than six companies were named', async () => {
    const names = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7'];
    const records = names.map((n) => entityRecord(n));
    const h = laneInput(
      analysis({ laneHint: 'research', intents: ['pricing'], entities: names.map(mention) }),
    );
    const research = new FakeResearch((r) => findingSet(r.turnId, [finding(1)]));
    await researchLane(
      h.input,
      laneDeps({ memory: new SpyMemory({ entities: records }), research }),
    );
    expect(h.events.find((e) => e.event === 'warning')?.data).toMatchObject({ code: 'entity_cap' });
    expect(research.calls[0]?.ctx.entities).toHaveLength(6);
  });

  it('asks which company when there is nothing to plan', async () => {
    const out = await researchLane(
      laneInput(analysis({ laneHint: 'research', queries: [] })).input,
      laneDeps(),
    );
    // routing would have sent this to chat; the lane itself still never invents a subject
    expect(out).toMatchObject({ kind: 'clarify', reason: 'nothing_to_research' });
  });
});

describe('audit lane', () => {
  const notion = entityRecord('Notion');
  const baseline = (entityId: EntityId, convId?: ConversationId): Baseline =>
    ({
      assertionId: newId('asr'),
      beliefKey: 'k',
      entityId,
      presentedAt: Date.UTC(2026, 10, 3, 10),
      value: { amount: 10 },
      convId,
    }) as unknown as Baseline;
  const auditing = analysis({
    laneHint: 'audit',
    intents: ['pricing'],
    entities: [mention('Notion')],
  });

  it('puts eligible baselines in the context handed to the service, for the asked entity only', async () => {
    const other = entityRecord('Other');
    const mine = baseline(notion.id);
    const baselines = new SpyBaselines([mine, baseline(other.id)]);
    const research = new FakeResearch((r) => findingSet(r.turnId, [finding(1)]));
    const out = await auditLane(
      laneInput(auditing).input,
      laneDeps({ memory: new SpyMemory({ entities: [notion, other] }), baselines, research }),
    );
    expect(out.kind).toBe('synthesize');
    expect(research.calls[0]?.ctx.baselines).toEqual([mine]);
    expect(baselines.calls).toEqual([`eligible:${CONV}`, `unverified:${CONV}`]);
  });

  it('presents ineligible claims as unverified history, never as baselines', async () => {
    const msg = newId('msg');
    const baselines = new SpyBaselines(
      [],
      [
        {
          assertionId: 'asr_1',
          messageId: msg,
          conversationId: CONV,
          turnId: newId('trn'),
          presentedAt: Date.UTC(2026, 10, 3, 10),
          renderedText: 'Notion costs US$10 [1]',
          reasons: ['sentence_not_verified'],
        },
      ],
    );
    const research = new FakeResearch((r) => findingSet(r.turnId, [finding(1)]));
    const out = await auditLane(
      laneInput(auditing).input,
      laneDeps({ memory: new SpyMemory({ entities: [notion] }), baselines, research }),
    );
    expect(out.kind).toBe('synthesize');
    if (out.kind !== 'synthesize') return;
    expect(research.calls[0]?.ctx.baselines).toEqual([]);
    expect(out.recall.get(msg)?.text).toBe('[not verified] Notion costs US$10 [1]');
    expect(out.ctx.memoryHits[0]?.excerpt).toMatch(/^\[not verified\]/);
  });

  it('with no earlier claim but a company to research, researches it and opens with the no-baseline statement', async () => {
    const research = new FakeResearch((r) => findingSet(r.turnId, [finding(1)]));
    const out = await auditLane(
      laneInput(auditing).input,
      laneDeps({
        memory: new SpyMemory({ entities: [notion] }),
        baselines: new SpyBaselines(),
        research,
      }),
    );
    expect(out.kind).toBe('synthesize');
    expect(research.calls).toHaveLength(1);
    expect(out).toMatchObject({ lead: [expect.stringContaining('no earlier answer of my own')] });
  });

  it('with no earlier claim and nothing to research, replies with the fixed text and runs no research', async () => {
    const research = new FakeResearch((r) => findingSet(r.turnId, []));
    const out = await auditLane(
      laneInput(analysis({ laneHint: 'audit', intents: ['pricing'] })).input,
      laneDeps({ baselines: new SpyBaselines(), research }),
    );
    expect(out).toMatchObject({ kind: 'reply', reason: 'no_prior_claims' });
    expect(research.calls).toEqual([]);
  });

  it('with a date, audits the conversation the recall found; no record means no audit', async () => {
    const day = Date.UTC(2026, 10, 3, 12);
    const found = messageHit(day, 'cnv_nov3', 'what does Notion cost');
    const withDate = analysis({
      laneHint: 'audit',
      intents: ['pricing'],
      entities: [mention('Notion')],
      temporal: [
        {
          text: '3 November',
          expr: { kind: 'calendar_date', day: 3, month: 11 },
          role: 'reference_conversation',
        },
      ],
    });
    const baselines = new SpyBaselines([baseline(notion.id)]);
    const research = new FakeResearch((r) => findingSet(r.turnId, [finding(1)]));
    const ok = await auditLane(
      laneInput(withDate).input,
      laneDeps({
        memory: new SpyMemory({ entities: [notion], messages: [found] }),
        baselines,
        research,
      }),
    );
    expect(ok.kind).toBe('synthesize');
    expect(baselines.calls[0]).toBe('eligible:cnv_nov3');

    const none = await auditLane(
      laneInput(withDate).input,
      laneDeps({
        memory: new SpyMemory({ entities: [notion], messages: [] }),
        baselines: new SpyBaselines(),
        research,
      }),
    );
    expect(none).toMatchObject({ kind: 'reply', reason: 'no_record' });
  });

  it('asks which day when the date is ambiguous and which company when the name is', async () => {
    const memory = new SpyMemory({
      entities: [notion],
      messages: [
        messageHit(Date.UTC(2026, 10, 3, 12), CONV, 'a'),
        messageHit(Date.UTC(2026, 10, 10, 12), CONV, 'b'),
      ],
    });
    const a = analysis({
      laneHint: 'audit',
      entities: [mention('Notion')],
      temporal: [lastTuesday],
    });
    const day = await auditLane(laneInput(a).input, laneDeps({ memory }));
    expect(day).toMatchObject({ kind: 'clarify', reason: 'ambiguous_day' });

    const twin = entityRecord('Notion Labs', { aliases: ['notion'] });
    const entity = await auditLane(
      laneInput(auditing).input,
      laneDeps({ memory: new SpyMemory({ entities: [notion, twin] }) }),
    );
    expect(entity).toMatchObject({ kind: 'clarify', reason: 'ambiguous_entity' });
  });

  it('keeps USER scope: every port call is made for the turn user and turn id', async () => {
    const seen: Array<{ userId: string; currentTurnId: string }> = [];
    const baselines = {
      eligible: (q: { userId: string; currentTurnId: string }) => {
        seen.push(q);
        return [];
      },
      unverified: () => [],
    };
    await auditLane(
      laneInput(auditing).input,
      laneDeps({ memory: new SpyMemory({ entities: [notion] }), baselines }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.userId).toBe(USER);
  });
});

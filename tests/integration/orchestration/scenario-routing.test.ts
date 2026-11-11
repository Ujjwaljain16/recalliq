import { describe, expect, it } from 'vitest';
import { SqliteMemoryRetriever } from '../../../src/app/memory-adapter.js';
import { LoaderBaselineSource, MessageWindowReader } from '../../../src/app/store-adapters.js';
import { LlmTurnAnalyzer } from '../../../src/llm/analysis/analyzer.js';
import { analysisModelSchema, toTurnAnalysis } from '../../../src/llm/analysis/schema.js';
import { FakeLlm } from '../../../src/llm/fake.js';
import { DefaultTurnOrchestrator } from '../../../src/orchestration/orchestrator.js';
import {
  newId,
  type ConversationId,
  type EntityId,
  type Ms,
  type UserId,
} from '../../../src/shared/ids.js';
import type { TurnAnalyzer } from '../../../src/shared/pipeline.js';
import type { SseEvent } from '../../../src/shared/sse.js';
import type { TurnAnalysis } from '../../../src/shared/understanding.js';
import { DefaultTemporalResolver } from '../../../src/temporal/resolver.js';
import { insertMessageSearch, openTestDb, type TestDb } from '../../helpers/db.js';
import {
  analysis,
  answerOf,
  FakeAnalyzer,
  FakeAnswer,
  FakeResearch,
  finding,
  findingSet,
  sentence,
  unableFinding,
} from '../../unit/orchestration/fakes.js';

/**
 * The three questions the owner ran through the real application, driven through the REAL coordinator with real
 * SQLite, the real temporal resolver, the real memory retriever and the real baseline source. Only the analyzer,
 * the research service and the answer pipeline are doubles (their output is canned), so these tests show what
 * the coordinator retrieves, whom it researches and what it says, not what a model would do.
 *
 * The calendar: today is Thursday 2026-11-12 10:00 UTC.
 */

const NOW: Ms = Date.UTC(2026, 10, 12, 10, 0);
const MONDAY: Ms = Date.UTC(2026, 10, 9, 9, 30);
const THREE_NOV: Ms = Date.UTC(2026, 10, 3, 9, 15);
const TUESDAY: Ms = Date.UTC(2026, 10, 10, 10, 0);

const CRM = ['HubSpot', 'Pipedrive', 'Zoho CRM', 'Salesforce', 'Freshsales'];
const MONDAY_TEXT =
  'Shortlist for the 20-person sales team: HubSpot, Pipedrive, Zoho CRM, Salesforce and Freshsales. CRM tools only.';
const NEON_TEXT = 'What does Neon charge per month for its Postgres plans?';
const HOSTING_TEXT =
  'Which managed Postgres host should we use? Compare Neon and Supabase pricing.';

const S1_MESSAGE =
  'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?';

/** The analysis the real analyzer returned for the first question, verbatim. */
const CAPTURED_S1 = {
  laneHint: 'audit',
  intents: ['pricing', 'releases'],
  temporal: [
    {
      text: 'Monday',
      expr: { kind: 'weekday', weekday: 1, modifier: 'last' },
      role: 'event_time',
    },
    {
      text: 'since',
      expr: { kind: 'since', anchor: { kind: 'weekday', weekday: 1, modifier: 'last' } },
      role: 'change_since',
    },
  ],
  entities: [],
  references: [{ text: '5 CRM tools', kind: 'entity_set' }],
  topicTerms: ['crm'],
  asksStillCorrect: false,
  queries: ['CRM software pricing updates releases 2024', 'CRM tool new features price change'],
  alternateQueries: ['CRM pricing changes recent updates', 'CRM platforms news pricing releases'],
  userFacts: [
    {
      kind: 'shortlist',
      quote: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team.',
      data: { kind: 'shortlist', label: 'CRM tools' },
    },
    {
      kind: 'constraint',
      quote: 'for a 20-person sales team',
      data: { kind: 'constraint', constraint: { key: 'team_size', value: 20, unit: 'people' } },
    },
  ],
};

/** The same analysis with the role a correct analyzer gives "Monday". */
const CORRECTED_S1 = {
  ...CAPTURED_S1,
  temporal: [
    { ...CAPTURED_S1.temporal[0], role: 'reference_conversation' },
    CAPTURED_S1.temporal[1],
  ],
};

const analysisOf = (raw: unknown): TurnAnalysis => toTurnAnalysis(analysisModelSchema.parse(raw));

const S2_MESSAGE = 'What did I ask you on 3 November? Is your answer still correct today?';
const S2_ANALYSIS = analysis({
  laneHint: 'recall',
  intents: ['general'],
  temporal: [
    {
      text: '3 November',
      expr: { kind: 'calendar_date', day: 3, month: 11 },
      role: 'reference_conversation',
    },
    { text: 'today', expr: { kind: 'today' }, role: 'event_time' },
  ],
  references: [{ text: 'your answer', kind: 'previous_answer' }],
  asksStillCorrect: true,
});

const S3_MESSAGE =
  'Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?';
const S3_ANALYSIS = analysis({
  laneHint: 'audit',
  intents: ['pricing'],
  temporal: [
    {
      text: 'Last Tuesday',
      expr: { kind: 'weekday', weekday: 2, modifier: 'last' },
      role: 'reference_conversation',
    },
    {
      text: 'since then',
      expr: { kind: 'since', anchor: { kind: 'weekday', weekday: 2, modifier: 'last' } },
      role: 'change_since',
    },
  ],
  references: [{ text: 'Postgres hosting', kind: 'conversation' }],
  topicTerms: ['postgres', 'hosting'],
});

const NO_BASELINE =
  'I have no earlier answer of my own on record to compare against, so I cannot establish whether anything changed since then.';
/** What the audit lane said before: it ignored the question it had found. */
const OLD_REPLY =
  'I have no earlier claim of mine on this that I can compare against. If you want, I can look up the current state on the web instead.';

function world(analyzer: TurnAnalyzer | TurnAnalysis) {
  const t: TestDb = openTestDb('real');
  const userId: UserId = t.users.create();
  const seedConversation = (): ConversationId => t.conversations.create({ userId }).id;

  const message = (conversationId: ConversationId, text: string, at: Ms, tz = 'UTC') => {
    t.clock.set(at);
    const m = t.messages.insert({ userId, conversationId, role: 'user', content: text, tz });
    insertMessageSearch(t.db, { messageId: m.id, userId, body: text });
    t.clock.set(NOW);
    return m;
  };
  const entity = (name: string): EntityId => {
    const id = newId('ent');
    t.db
      .prepare(
        'INSERT INTO entities (id, user_id, canonical, norm, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, userId, name, name.toLowerCase(), MONDAY);
    return id;
  };
  const shortlist = (
    conversationId: ConversationId,
    messageId: string,
    names: string[],
    at: Ms,
    label = 'CRM tools',
  ): string => {
    const id = newId('dec');
    t.db
      .prepare(
        `INSERT INTO decisions (id, user_id, conversation_id, message_id, kind, payload_json, user_quote,
           version, created_at) VALUES (?, ?, ?, ?, 'shortlist', ?, 'q', 1, ?)`,
      )
      .run(
        id,
        userId,
        conversationId,
        messageId,
        JSON.stringify({ kind: 'shortlist', entities: names, label }),
        at,
      );
    return id;
  };

  const current = seedConversation();
  const research = new FakeResearch((r) => {
    // what the real service does: a company researched by name gets a stored entity
    const known = r.ctx.entities.map((e) => ({ id: e.id, name: e.name }));
    const extra = r.analysis.entities
      .filter((m) => !known.some((k) => k.name.toLowerCase() === m.normalized))
      .map((m) => ({ id: entity(m.text), name: m.text }));
    return findingSet(
      r.turnId,
      [...known, ...extra].map((e, i) => finding(i + 1, { entityId: e.id, entityName: e.name })),
    );
  });
  const answer = new FakeAnswer(() =>
    answerOf([sentence(0, 'Here is what I can verify now.', { status: 'no_claims' })]),
  );
  const events: SseEvent[] = [];
  const orchestrator = new DefaultTurnOrchestrator({
    turns: t.turns,
    analyzer: 'analyze' in analyzer ? analyzer : new FakeAnalyzer(analyzer),
    research,
    answer,
    memory: new SqliteMemoryRetriever(t.db),
    resolver: new DefaultTemporalResolver(),
    baselines: new LoaderBaselineSource(t.db),
    window: new MessageWindowReader(t.messages),
    clock: t.clock,
  });
  t.clock.set(NOW);
  let key = 0;
  const ask = async (text: string, tz = 'UTC') => {
    events.length = 0;
    const result = await orchestrator.run(
      { userId, conversationId: current, text, tz, idempotencyKey: `k${++key}` },
      (e) => events.push(e),
    );
    const stored = t.messages
      .listByConversation(userId, current)
      .filter((m) => m.role === 'assistant')
      .at(-1);
    return { result, reply: stored?.content ?? '', sentences: stored?.sentences ?? [] };
  };
  const eventsOf = (name: string): unknown[] =>
    events.filter((e) => e.event === name).map((e) => e.data);
  const contextEvent = () =>
    eventsOf('context')[0] as { memoryHits: Array<{ excerpt: string }>; decisionIds: string[] };

  /** The Monday world of the first question: the conversation, its message, the entities, one shortlist. */
  const seedMonday = (names: string[] = CRM) => {
    const conv = seedConversation();
    const m = message(conv, MONDAY_TEXT, MONDAY);
    for (const n of names) entity(n);
    const decision = shortlist(conv, m.id, names, MONDAY);
    return { conv, message: m, decision };
  };
  return {
    t,
    userId,
    research,
    answer,
    ask,
    eventsOf,
    contextEvent,
    message,
    entity,
    shortlist,
    seedConversation,
    seedMonday,
  };
}

const names = (w: ReturnType<typeof world>): string[] =>
  w.research.calls[0]?.ctx.entities.map((e) => e.name) ?? [];

describe('question one: "On Monday we shortlisted 5 CRM tools ... changed pricing or shipped something big since?"', () => {
  it('with the corrected analysis the Monday message and shortlist are retrieved and all five tools are researched', async () => {
    const w = world(analysisOf(CORRECTED_S1));
    const monday = w.seedMonday();
    const { result, reply } = await w.ask(S1_MESSAGE);

    expect(result.status).toBe('complete');
    // what was retrieved
    const ctx = w.contextEvent();
    expect(ctx.memoryHits.map((h) => h.excerpt)).toEqual([MONDAY_TEXT]);
    expect(ctx.decisionIds).toEqual([monday.decision]);
    // whom the research covers: the five, in shortlist order, with their stored ids
    expect(w.research.calls).toHaveLength(1);
    expect(names(w)).toEqual(CRM);
    expect(w.research.calls[0]?.plan.specs.length).toBeGreaterThan(0);
    expect((w.eventsOf('plan')[0] as { entities: string[] }).entities).toEqual(CRM);
    // the reply: what was written and when, then the plain statement, then the findings
    expect(reply).toBe(
      `On 2026-11-09 at 09:30 you wrote: "${MONDAY_TEXT}" ${NO_BASELINE} Here is what I can verify now.`,
    );
    // the written parts came from code: the answer pipeline was called once and was not given them
    expect(w.answer.calls).toHaveLength(1);
    expect(w.answer.calls[0]?.findings?.findings).toHaveLength(5);
  });

  it('numbers the model sentences after the code-written ones, in the stream and in storage', async () => {
    const w = world(analysisOf(CORRECTED_S1));
    w.seedMonday();
    // an answer pipeline that streams its one sentence, numbering it from 0 as the real one does
    w.answer.streams = [
      {
        event: 'answer.delta',
        data: { sentenceIndex: 0, text: 'Here is what I can verify now.' },
      },
      { event: 'answer.sentence_end', data: { index: 0, status: 'no_claims', issues: [] } },
    ];
    const { sentences } = await w.ask(S1_MESSAGE);
    expect(sentences.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(sentences.map((s) => s.status)).toEqual(['no_claims', 'no_claims', 'no_claims']);
    const deltas = w.eventsOf('answer.delta') as Array<{ sentenceIndex: number; text: string }>;
    expect(deltas.map((d) => d.sentenceIndex)).toEqual([0, 1, 2]);
    expect(deltas[2]?.text).toBe(' Here is what I can verify now.');
    const ends = w.eventsOf('answer.sentence_end') as Array<{ index: number }>;
    expect(ends.map((e) => e.index)).toEqual([0, 1, 2]);
  });

  it('with unable_to_verify findings the same opening is followed by their state, not by a change claim', async () => {
    const w = world(analysisOf(CORRECTED_S1));
    w.seedMonday();
    w.research.run = (req) =>
      Promise.resolve(
        findingSet(
          req.turnId,
          req.ctx.entities.map((e, i) => ({ ...unableFinding(i + 1), entityId: e.id })),
        ),
      );
    const { result, reply } = await w.ask(S1_MESSAGE);
    expect(result.status).toBe('partial');
    expect(reply).toContain(NO_BASELINE);
    expect(reply).not.toMatch(/has changed|did change|price rose|increased/i);
  });

  it('with the analysis exactly as captured (role event_time) nothing is recalled, but the shortlist still names the five', async () => {
    const w = world(analysisOf(CAPTURED_S1));
    w.seedMonday();
    const { reply } = await w.ask(S1_MESSAGE);
    expect(w.contextEvent().memoryHits).toEqual([]);
    expect(names(w)).toEqual(CRM);
    // no stored message was found by a date reference, so none is described; the statement still opens the answer
    expect(reply).toBe(`${NO_BASELINE} Here is what I can verify now.`);
  });

  it('caps the shortlist at the per-turn entity limit and says so', async () => {
    const eight = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8'].map((n) => `Vendor ${n}`);
    const w = world(analysisOf(CORRECTED_S1));
    w.seedMonday(eight);
    await w.ask(S1_MESSAGE);
    expect(names(w)).toEqual(eight.slice(0, 6));
    const warnings = w.eventsOf('warning') as Array<{ code: string; text: string }>;
    const cap = warnings.find((x) => x.code === 'entity_cap');
    expect(cap?.text).toContain('first 6');
  });

  it('researches a shortlisted name that has no stored entity yet, by name', async () => {
    const w = world(analysisOf(CORRECTED_S1));
    const conv = w.seedConversation();
    const m = w.message(conv, MONDAY_TEXT, MONDAY);
    w.entity('HubSpot');
    w.shortlist(conv, m.id, ['HubSpot', 'Pipedrive'], MONDAY);
    await w.ask(S1_MESSAGE);
    expect(w.research.calls[0]?.ctx.entities.map((e) => e.name)).toEqual(['HubSpot']);
    expect(w.research.calls[0]?.analysis.entities.map((e) => e.text)).toEqual(['Pipedrive']);
    expect((w.eventsOf('plan')[0] as { entities: string[] }).entities).toEqual([
      'HubSpot',
      'Pipedrive',
    ]);
  });

  it('two shortlists stored on Monday are a question, never a pick', async () => {
    const w = world(analysisOf(CORRECTED_S1));
    const monday = w.seedMonday();
    const other = w.seedConversation();
    const m2 = w.message(other, 'Another shortlist: Notion and Asana', MONDAY + 3_600_000);
    w.shortlist(other, m2.id, ['Notion', 'Asana'], MONDAY + 3_600_000, 'Work tools');
    const { result, reply } = await w.ask(S1_MESSAGE);

    // CRM topic terms select the CRM message, so the day is unambiguous, but the two shortlists are not
    expect(result.status).toBe('clarify');
    expect(w.research.calls).toHaveLength(0);
    expect(w.answer.calls).toHaveLength(0);
    expect(reply).toContain('more than one saved shortlist on 2026-11-09');
    const clarification = w.eventsOf('clarification')[0] as {
      options: Array<{ label: string; ref: string }>;
    };
    expect(clarification.options.map((o) => o.label).sort()).toEqual(['CRM tools', 'Work tools']);
    expect(clarification.options.map((o) => o.ref)).toContain(`decision:${monday.decision}`);
  });

  it('a Monday with no stored shortlist and nothing named gets the fixed reply with the found message, and no research', async () => {
    const w = world(analysisOf(CORRECTED_S1));
    w.message(w.seedConversation(), MONDAY_TEXT, MONDAY);
    const { reply } = await w.ask(S1_MESSAGE);
    expect(w.research.calls).toHaveLength(0);
    expect(w.answer.calls).toHaveLength(0);
    expect(reply).toContain(`you wrote: "${MONDAY_TEXT}"`);
    expect(reply).toContain('no earlier answer of my own on record');
  });

  it('resolves the shortlist the same way when the analysis routes to the research lane', async () => {
    const w = world(analysisOf({ ...CORRECTED_S1, laneHint: 'research' }));
    w.seedMonday();
    await w.ask(S1_MESSAGE);
    expect(names(w)).toEqual(CRM);
  });
});

describe('question two: "What did I ask you on 3 November? Is your answer still correct today?"', () => {
  it('says what was asked and when, then that no earlier answer is on record, then offers a lookup; no model is called', async () => {
    const w = world(S2_ANALYSIS);
    w.message(w.seedConversation(), NEON_TEXT, THREE_NOV);
    const { result, reply, sentences } = await w.ask(S2_MESSAGE);

    expect(result.status).toBe('complete');
    expect(sentences.map((s) => s.text)).toEqual([
      `On 2026-11-03 at 09:15 you asked: "${NEON_TEXT}"`,
      'I have no earlier answer of my own on record to check, so I cannot say whether it is still correct.',
      'If you want, I can look the question up now.',
    ]);
    expect(reply).toContain(NEON_TEXT);
    // fixed text: neither research nor the answer model ran
    expect(w.research.calls).toHaveLength(0);
    expect(w.answer.calls).toHaveLength(0);
    expect(sentences.every((s) => s.status === 'no_claims')).toBe(true);
    // the retrieved message is in the stored context
    expect(w.contextEvent().memoryHits.map((h) => h.excerpt)).toEqual([NEON_TEXT]);
  });

  it('states the time in the zone of the stored message and the request', async () => {
    const w = world(S2_ANALYSIS);
    w.message(w.seedConversation(), NEON_TEXT, THREE_NOV, 'Asia/Kolkata');
    const { reply } = await w.ask(S2_MESSAGE, 'Asia/Kolkata');
    expect(reply).toContain('On 2026-11-03 at 14:45 you asked:');
  });

  it('never claims a conversation took place when none was found', async () => {
    const w = world(S2_ANALYSIS);
    const { reply } = await w.ask(S2_MESSAGE);
    expect(reply).toContain('no record of a conversation on 2026-11-03');
    expect(reply).not.toMatch(/you asked|you wrote/);
    expect(w.research.calls).toHaveLength(0);
  });

  it('the old reply, which ignored the found question, does not satisfy the expectation', async () => {
    const w = world(S2_ANALYSIS);
    w.message(w.seedConversation(), NEON_TEXT, THREE_NOV);
    const { reply } = await w.ask(S2_MESSAGE);
    const tellsWhatWasAsked = (text: string): boolean =>
      text.includes(NEON_TEXT) && text.includes('2026-11-03') && text.includes('09:15');
    expect(tellsWhatWasAsked(reply)).toBe(true);
    expect(tellsWhatWasAsked(OLD_REPLY)).toBe(false);
    expect(reply).not.toBe(OLD_REPLY);
  });
});

describe('question three: "Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?"', () => {
  it('opens with what was found, then says no earlier answer exists and offers a lookup', async () => {
    const w = world(S3_ANALYSIS);
    w.message(w.seedConversation(), HOSTING_TEXT, TUESDAY);
    const { reply, sentences } = await w.ask(S3_MESSAGE);
    expect(sentences.map((s) => s.text)).toEqual([
      `On 2026-11-10 at 10:00 you asked: "${HOSTING_TEXT}"`,
      'I have no earlier answer of my own on record to check, so I cannot say whether it is still correct.',
      'If you want, I can look the question up now.',
    ]);
    expect(reply).not.toBe(OLD_REPLY);
    expect(w.research.calls).toHaveLength(0);
    expect(w.answer.calls).toHaveLength(0);
  });

  it('with a vendor named in the analysis it researches it and still opens with what was asked', async () => {
    const w = world({ ...S3_ANALYSIS, entities: [{ text: 'Neon', normalized: 'neon' }] });
    w.message(w.seedConversation(), HOSTING_TEXT, TUESDAY);
    const { reply } = await w.ask(S3_MESSAGE);
    expect(w.research.calls).toHaveLength(1);
    expect(
      reply.startsWith(`On 2026-11-10 at 10:00 you asked: "${HOSTING_TEXT}" ${NO_BASELINE}`),
    ).toBe(true);
  });
});

describe('years the user did not write never reach the searches', () => {
  it('the captured queries lose 2024 on the way from the analyzer to the research request', async () => {
    const llm = new FakeLlm().queueStructured(CORRECTED_S1);
    const w = world(new LlmTurnAnalyzer({ llm }));
    w.seedMonday();
    await w.ask(S1_MESSAGE);
    const request = w.research.calls[0]?.analysis;
    expect(request?.queries).toEqual([
      'CRM software pricing updates releases',
      'CRM tool new features price change',
    ]);
    expect(JSON.stringify(request)).not.toContain('2024');
  });

  it('keeps a year the user wrote', async () => {
    const llm = new FakeLlm().queueStructured(CORRECTED_S1);
    const w = world(new LlmTurnAnalyzer({ llm }));
    w.seedMonday();
    await w.ask(`${S1_MESSAGE} I mean prices for 2024.`);
    expect(w.research.calls[0]?.analysis.queries[0]).toBe(
      'CRM software pricing updates releases 2024',
    );
  });
});

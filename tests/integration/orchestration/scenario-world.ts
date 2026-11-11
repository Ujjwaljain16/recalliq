import { SqliteMemoryRetriever } from '../../../src/app/memory-adapter.js';
import { LoaderBaselineSource, MessageWindowReader } from '../../../src/app/store-adapters.js';
import { analysisModelSchema, toTurnAnalysis } from '../../../src/llm/analysis/schema.js';
import { DefaultTurnOrchestrator } from '../../../src/orchestration/orchestrator.js';
import {
  newId,
  type ConversationId,
  type EntityId,
  type Ms,
  type UserId,
} from '../../../src/shared/ids.js';
import type { TurnAnalyzer } from '../../../src/shared/pipeline.js';
import type { MemoryRetriever } from '../../../src/shared/memory.js';
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
} from '../../unit/orchestration/fakes.js';

export const NOW: Ms = Date.UTC(2026, 10, 12, 10, 0);
export const MONDAY: Ms = Date.UTC(2026, 10, 9, 9, 30);
export const THREE_NOV: Ms = Date.UTC(2026, 10, 3, 9, 15);
export const TUESDAY: Ms = Date.UTC(2026, 10, 10, 10, 0);

export const CRM = ['HubSpot', 'Pipedrive', 'Zoho CRM', 'Salesforce', 'Freshsales'];
export const MONDAY_TEXT =
  'Shortlist for the 20-person sales team: HubSpot, Pipedrive, Zoho CRM, Salesforce and Freshsales. CRM tools only.';
export const NEON_TEXT = 'What does Neon charge per month for its Postgres plans?';
export const HOSTING_TEXT =
  'Which managed Postgres host should we use? Compare Neon and Supabase pricing.';

export const S1_MESSAGE =
  'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?';

/** The analysis the real analyzer returned for the first question, verbatim. */
export const CAPTURED_S1 = {
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
export const CORRECTED_S1 = {
  ...CAPTURED_S1,
  temporal: [
    { ...CAPTURED_S1.temporal[0], role: 'reference_conversation' },
    CAPTURED_S1.temporal[1],
  ],
};

export const analysisOf = (raw: unknown): TurnAnalysis =>
  toTurnAnalysis(analysisModelSchema.parse(raw));

export const S2_MESSAGE = 'What did I ask you on 3 November? Is your answer still correct today?';
export const S2_ANALYSIS = analysis({
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

export const S3_MESSAGE =
  'Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?';
export const S3_ANALYSIS = analysis({
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

export const NO_BASELINE =
  'I have no earlier answer of my own on record to compare against, so I cannot establish whether anything changed since then.';
/** What the audit lane said before: it ignored the question it had found. */
export const OLD_REPLY =
  'I have no earlier claim of mine on this that I can compare against. If you want, I can look up the current state on the web instead.';

export function world(analyzer: TurnAnalyzer | TurnAnalysis) {
  const t: TestDb = openTestDb('real');
  const userId: UserId = t.users.create();
  const seedConversation = (): ConversationId => t.conversations.create({ userId }).id;

  const message = (conversationId: ConversationId, text: string, at: Ms, tz = 'UTC', tags = '') => {
    t.clock.set(at);
    const m = t.messages.insert({ userId, conversationId, role: 'user', content: text, tz });
    insertMessageSearch(t.db, { messageId: m.id, userId, body: text, tags });
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
  /** The order in which the coordinator touched memory, planned, searched and answered. */
  const log: string[] = [];
  const research = new FakeResearch((r) => {
    log.push('research');
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
  const answer = new FakeAnswer(() => {
    log.push('answer');
    return answerOf([sentence(0, 'Here is what I can verify now.', { status: 'no_claims' })]);
  });
  const sql = new SqliteMemoryRetriever(t.db);
  const memory: MemoryRetriever = {
    messagesInIntervals: (...a) => {
      log.push('recall');
      return sql.messagesInIntervals(...a);
    },
    searchAll: (...a) => sql.searchAll(...a),
    decisions: (...a) => sql.decisions(...a),
    entitiesByAlias: (...a) => sql.entitiesByAlias(...a),
  };
  const events: SseEvent[] = [];
  const orchestrator = new DefaultTurnOrchestrator({
    turns: t.turns,
    analyzer: 'analyze' in analyzer ? analyzer : new FakeAnalyzer(analyzer),
    research,
    answer,
    memory,
    resolver: new DefaultTemporalResolver(),
    baselines: new LoaderBaselineSource(t.db),
    window: new MessageWindowReader(t.messages),
    clock: t.clock,
  });
  t.clock.set(NOW);
  let key = 0;
  const ask = async (text: string, tz = 'UTC') => {
    events.length = 0;
    log.length = 0;
    const result = await orchestrator.run(
      { userId, conversationId: current, text, tz, idempotencyKey: `k${++key}` },
      (e) => {
        events.push(e);
        if (e.event === 'plan') log.push('plan');
      },
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
    log,
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

export const names = (w: ReturnType<typeof world>): string[] =>
  w.research.calls[0]?.ctx.entities.map((e) => e.name) ?? [];

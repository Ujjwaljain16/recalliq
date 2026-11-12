import { describe, expect, it } from 'vitest';
import { normalizeEntityName } from '../../../src/orchestration/planner.js';
import type { TurnAnalyzer } from '../../../src/shared/pipeline.js';
import type { ResearchPlanner } from '../../../src/shared/research.js';
import type { TurnAnalysis } from '../../../src/shared/understanding.js';
import { analysis } from '../../unit/orchestration/fakes.js';
import {
  analysisOf,
  CAPTURED_S1,
  CORRECTED_S1,
  HOSTING_TEXT,
  NEON_TEXT,
  S1_MESSAGE,
  S2_ANALYSIS,
  S2_MESSAGE,
  S3_ANALYSIS,
  S3_MESSAGE,
  THREE_NOV,
  TUESDAY,
  world,
} from './scenario-world.js';

/**
 * A reviewer's first contact: the three example questions asked on an empty database, on Thursday 12 November
 * 2026 at 10:00 in Europe/London. The no-record sentences are written in code and name one day, in words.
 */
const LONDON = 'Europe/London';

const SHORTLIST_QUESTION =
  "I have no record of a conversation on Monday 9 November, so I don't have that shortlist on record. Which five CRM tools did you shortlist? I'll check their current pricing and recent releases.";
const NO_CHANGE_SINCE =
  "I have no record of a conversation on Tuesday 10 November, so I can't say what changed since then; here is what I found now.";

/** The analysis the question gets once the analyzer gives queries for a stated subject. */
const S3_WITH_SUBJECT: TurnAnalysis = {
  ...S3_ANALYSIS,
  queries: ['managed Postgres hosting pricing'],
};

/**
 * A planner that can search a subject without a company, one search per query. It stands in for planning that
 * searches a stated category, so the hand-over from the audit lane to research is observable on its own.
 */
const subjectPlanner: ResearchPlanner = {
  plan: (_ctx, a) => ({
    specs: a.queries.map((query, i) => ({
      id: `${normalizeEntityName(query)}:pricing:q${i}:1`,
      entityId: null,
      intent: 'pricing' as const,
      round: 1 as const,
      request: {
        query,
        numResults: 5,
        freshness: 'cached' as const,
        contentMode: 'highlights' as const,
        contentChars: 1_500,
      },
    })),
    fallback: [],
    budget: { maxSearches: 16, maxPerEntity: 4, concurrency: 4 },
  }),
};

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

describe('cold start, question one: "On Monday we shortlisted 5 CRM tools ..."', () => {
  it('asks which five tools, naming the one Monday it looked at, and searches nothing', async () => {
    const w = world(analysisOf(CORRECTED_S1), { planner: subjectPlanner });
    const { result, reply } = await w.ask(S1_MESSAGE, LONDON);

    expect(result.status).toBe('clarify');
    expect(reply).toBe(SHORTLIST_QUESTION);
    expect(w.research.calls).toHaveLength(0);
    expect(w.answer.calls).toHaveLength(0);
    const clarification = w.eventsOf('clarification') as Array<{ options: unknown[] }>;
    expect(clarification).toHaveLength(1);
    expect(clarification[0]?.options).toEqual([]);
    expect(reply).not.toContain('2026-11-02');
    expect(reply).not.toContain(' or ');
  });

  it('asks the same with the analysis as captured, where Monday is not marked as a conversation day', async () => {
    const w = world(analysisOf(CAPTURED_S1), { planner: subjectPlanner });
    const { result, reply } = await w.ask(S1_MESSAGE, LONDON);
    expect(result.status).toBe('clarify');
    expect(reply).toBe(
      "I don't have a shortlist from Monday 9 November on record. Which five CRM tools did you shortlist? I'll check their current pricing and recent releases.",
    );
    expect(w.research.calls).toHaveLength(0);
  });

  it('offers a shortlist stored on another day as an option, never as a pick', async () => {
    const w = world(analysisOf(CORRECTED_S1), { planner: subjectPlanner });
    const conv = w.seedConversation();
    const m = w.message(conv, 'Shortlist: Notion and Coda.', THREE_NOV);
    const id = w.shortlist(conv, m.id, ['Notion', 'Coda'], THREE_NOV, 'Work tools');
    const { reply } = await w.ask(S1_MESSAGE, LONDON);
    expect(reply).toBe(SHORTLIST_QUESTION);
    const [clarification] = w.eventsOf('clarification') as Array<{
      options: Array<{ label: string; ref: string }>;
    }>;
    expect(clarification?.options).toEqual([{ label: 'Work tools', ref: `decision:${id}` }]);
    expect(w.research.calls).toHaveLength(0);
  });
});

describe('cold start, question two: "What did I ask you on 3 November? Is your answer still correct today?"', () => {
  it('says there is no record of that day, that this is the first conversation, and invites the question; no search', async () => {
    const w = world(S2_ANALYSIS);
    const { result, sentences } = await w.ask(S2_MESSAGE, LONDON);
    expect(result.status).toBe('complete');
    expect(sentences.map((s) => s.text)).toEqual([
      'I have no record of a conversation on Tuesday 3 November.',
      'This looks like our first conversation.',
      "Tell me what the question was and I'll check it against current sources.",
    ]);
    expect(w.research.calls).toHaveLength(0);
    expect(w.answer.calls).toHaveLength(0);
  });

  it('does not call it the first conversation when another one is on record', async () => {
    const w = world(S2_ANALYSIS);
    w.message(w.seedConversation(), NEON_TEXT, TUESDAY);
    const { sentences } = await w.ask(S2_MESSAGE, LONDON);
    expect(sentences.map((s) => s.text)).toEqual([
      'I have no record of a conversation on Tuesday 3 November.',
      "Tell me what the question was and I'll check it against current sources.",
    ]);
  });
});

describe('cold start, question three: "Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?"', () => {
  it('says once that no change can be established, then researches the stated subject', async () => {
    const w = world(S3_WITH_SUBJECT, { planner: subjectPlanner });
    const { result, reply, sentences } = await w.ask(S3_MESSAGE, LONDON);

    expect(result.status).toBe('complete');
    expect(w.research.calls).toHaveLength(1);
    expect(w.research.calls[0]?.plan.specs.map((s) => s.request.query)).toEqual([
      'managed Postgres hosting pricing',
    ]);
    expect(w.eventsOf('plan')).toHaveLength(1);
    expect(sentences[0]?.text).toBe(NO_CHANGE_SINCE);
    expect(reply).toBe(`${NO_CHANGE_SINCE} Here is what I can verify now.`);
    expect(occurrences(reply, 'changed since then')).toBe(1);
    expect(reply).not.toContain('2026-11-03');
  });

  it('with a vendor named, the real planner searches it and the statement still appears exactly once', async () => {
    const w = world({ ...S3_WITH_SUBJECT, entities: [{ text: 'Neon', normalized: 'neon' }] });
    const { reply } = await w.ask(S3_MESSAGE, LONDON);
    expect(w.research.calls).toHaveLength(1);
    expect(w.research.calls[0]?.plan.specs.length).toBeGreaterThan(0);
    expect(w.answer.calls[0]?.findings?.findings.map((f) => f.entityName)).toEqual(['Neon']);
    expect(reply.startsWith(NO_CHANGE_SINCE)).toBe(true);
    expect(occurrences(reply, 'changed since then')).toBe(1);
    expect(occurrences(reply, 'no record of a conversation')).toBe(1);
  });

  it('with the stated subject and no vendor, the real planner searches the subject itself, extracting nothing', async () => {
    const w = world(S3_WITH_SUBJECT);
    await w.ask(S3_MESSAGE, LONDON);
    expect(w.research.calls).toHaveLength(1);
    const specs = w.research.calls[0]?.plan.specs ?? [];
    expect(specs.map((x) => [x.request.query, x.entityId, x.intent])).toEqual([
      ['managed Postgres hosting pricing', null, 'general'],
    ]);
  });

  it('when nothing can be searched for the subject, asks which providers, saying why, with the date once', async () => {
    // the real planner now searches a stated subject, so an empty plan is simulated here
    const empty: ResearchPlanner = {
      plan: () => ({
        specs: [],
        fallback: [],
        budget: { maxSearches: 0, maxPerEntity: 0, concurrency: 1 },
      }),
    };
    const w = world(S3_WITH_SUBJECT, { planner: empty });
    const { result, reply } = await w.ask(S3_MESSAGE, LONDON);
    expect(result.status).toBe('clarify');
    expect(reply).toBe(
      "I have no record of a conversation on Tuesday 10 November, so I can't say what changed since then. I look things up per company or product, so I need at least one name. Which Postgres hosting providers should I check? I'll check their current pricing.",
    );
    expect(w.research.calls).toHaveLength(0);
  });

  it('with the earlier conversation on record it behaves as before: what was asked, no research', async () => {
    const w = world(S3_ANALYSIS);
    w.message(w.seedConversation(), HOSTING_TEXT, TUESDAY);
    const { reply } = await w.ask(S3_MESSAGE);
    expect(reply).toContain(`you asked: "${HOSTING_TEXT}"`);
    expect(reply).not.toContain('no record of a conversation');
    expect(w.research.calls).toHaveLength(0);
  });
});

/** One analysis per turn, in order. */
class SequenceAnalyzer implements TurnAnalyzer {
  constructor(private readonly queue: TurnAnalysis[]) {}
  analyze() {
    const next = this.queue.shift();
    if (next === undefined) return Promise.reject(new Error('no analysis left'));
    return Promise.resolve(next);
  }
}

const CHAT = analysis({ laneHint: 'chat' });
const FIRST_THREE = [
  'Hello, what can you do?',
  'What does Neon charge per month?',
  'And does Supabase have a free tier?',
];

describe('recall without a day: "What have we talked about so far?"', () => {
  for (const [label, recallAnalysis] of [
    [
      'hinted as recall with the conversation scope',
      analysis({ laneHint: 'recall', recallScope: 'conversation' }),
    ],
    [
      'hinted as clarify with the conversation scope',
      analysis({ laneHint: 'clarify', recallScope: 'conversation' }),
    ],
    ['hinted as recall with no day and no scope', analysis({ laneHint: 'recall' })],
  ] as const) {
    it(`lists the three earlier messages of this conversation in order, ${label}`, async () => {
      const w = world(new SequenceAnalyzer([CHAT, CHAT, CHAT, recallAnalysis]));
      for (const text of FIRST_THREE) await w.ask(text, LONDON);
      const { result, reply } = await w.ask('What have we talked about so far?', LONDON);

      expect(result.status).toBe('complete');
      expect(w.eventsOf('clarification')).toEqual([]);
      const recalled = w.answer.calls.at(-1)?.recall;
      expect([...(recalled?.values() ?? [])].map((r) => r.text)).toEqual(FIRST_THREE);
      expect(w.contextEvent().memoryHits.map((h) => h.excerpt)).toEqual(FIRST_THREE);
      expect(reply.startsWith('You have sent me 3 messages in this conversation so far.')).toBe(
        true,
      );
      expect(w.research.calls).toHaveLength(0);
    });
  }

  it('says how many earlier conversations are on record', async () => {
    const w = world(
      new SequenceAnalyzer([CHAT, analysis({ laneHint: 'recall', recallScope: 'conversation' })]),
    );
    w.message(w.seedConversation(), NEON_TEXT, TUESDAY);
    await w.ask(FIRST_THREE[0] ?? '', LONDON);
    const { reply } = await w.ask('What have we talked about so far?', LONDON);
    expect(reply).toContain(
      "You have sent me 1 message in this conversation so far. There is also 1 earlier conversation on record; name a day and I'll recall it.",
    );
    // the other conversation's message is counted, never quoted as part of this one
    expect([...(w.answer.calls.at(-1)?.recall.values() ?? [])].map((r) => r.text)).toEqual([
      FIRST_THREE[0],
    ]);
  });

  it('in an empty conversation says there is nothing yet, without a question and without a model', async () => {
    const w = world(analysis({ laneHint: 'recall', recallScope: 'conversation' }));
    const { result, sentences } = await w.ask('What have we talked about so far?', LONDON);
    expect(result.status).toBe('complete');
    expect(sentences.map((s) => s.text)).toEqual([
      'There is nothing earlier in this conversation yet.',
      'This looks like our first conversation.',
      "Ask me about a company's prices or recent releases and I'll check current sources.",
    ]);
    expect(w.eventsOf('clarification')).toEqual([]);
    expect(w.answer.calls).toHaveLength(0);
  });
});

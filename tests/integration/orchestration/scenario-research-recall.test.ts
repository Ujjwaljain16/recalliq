import { describe, expect, it } from 'vitest';
import { newId } from '../../../src/shared/ids.js';
import { insertMessageSearch } from '../../helpers/db.js';
import {
  analysisOf,
  CRM,
  HOSTING_TEXT,
  S1_MESSAGE,
  S3_MESSAGE,
  TUESDAY,
  world,
} from './scenario-world.js';

/**
 * What the owner's live rerun showed for the research lane: the analyses below are the ones the real analyzer
 * returned, replayed through the real coordinator with real SQLite, resolver, retriever and baseline source (the
 * analyzer, research service and answer pipeline are doubles). They show what is recalled, whom is researched and
 * what the code writes, not what a model would do.
 */

const NINE = Date.UTC(2026, 10, 9, 9, 0);
const LIVE_MONDAY_TEXT =
  "We're choosing a CRM for a 20-person sales team. Our shortlist is HubSpot, Pipedrive, Zoho CRM, Salesforce and Freshsales.";

const LIVE_S1 = analysisOf({
  laneHint: 'research',
  intents: ['pricing', 'releases'],
  temporal: [
    {
      text: 'Monday',
      expr: { kind: 'weekday', weekday: 1, modifier: 'last' },
      role: 'reference_conversation',
    },
    {
      text: 'since',
      expr: { kind: 'since', anchor: { kind: 'weekday', weekday: 1, modifier: 'last' } },
      role: 'change_since',
    },
  ],
  entities: [],
  references: [{ text: '5 CRM tools', kind: 'entity_set' }],
  topicTerms: ['CRM'],
  asksStillCorrect: false,
  queries: ['CRM pricing changes and releases'],
  alternateQueries: [],
  userFacts: [],
});

const liveS3 = (topicTerms: string[] = ['Postgres', 'hosting']) =>
  analysisOf({
    laneHint: 'research',
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
    entities: [],
    references: [{ text: 'then', kind: 'conversation' }],
    topicTerms,
    asksStillCorrect: true,
    queries: ['Postgres hosting pricing changes'],
    alternateQueries: [],
    userFacts: [],
  });

const ASKED = `On 2026-11-10 at 10:00 you asked: "${HOSTING_TEXT}"`;
const TOOK = 'I took the companies from that earlier message: Neon and Supabase.';
const NOT_ESTABLISHED = (day: string): string =>
  `I have no earlier prices of my own on record from before ${day}, so I cannot establish whether anything changed since then; what follows is what I could find now.`;

describe('research lane: the first question as captured now (role reference_conversation)', () => {
  it('recalls the Monday message, opens with what was written, and researches the five shortlisted tools', async () => {
    const w = world(LIVE_S1);
    const conv = w.seedConversation();
    const m = w.message(conv, LIVE_MONDAY_TEXT, NINE);
    for (const n of CRM) w.entity(n);
    const decision = w.shortlist(conv, m.id, CRM, NINE);

    const { reply } = await w.ask(S1_MESSAGE);

    const ctx = w.contextEvent();
    expect(ctx.memoryHits.map((h) => h.excerpt)).toEqual([LIVE_MONDAY_TEXT]);
    expect(ctx.decisionIds).toEqual([decision]);
    expect(w.research.calls[0]?.ctx.entities.map((e) => e.name)).toEqual(CRM);
    expect(reply).toBe(
      `On 2026-11-09 at 09:00 you wrote: "${LIVE_MONDAY_TEXT}" ${NOT_ESTABLISHED('2026-11-09')} Here is what I can verify now.`,
    );
    // written in code: the answer pipeline got no lead text and the stored sentences are numbered in order
    expect(w.answer.calls).toHaveLength(1);
  });
});

describe('research lane: the third question as captured now (nothing named, nothing shortlisted)', () => {
  const seedTuesday = (w: ReturnType<typeof world>, tags: string) =>
    w.message(w.seedConversation(), HOSTING_TEXT, TUESDAY, 'UTC', tags);

  it('recalls the Tuesday message and takes Neon and Supabase from its tags, never the category Postgres', async () => {
    const w = world(liveS3());
    // tags as enrichment writes them: topic terms and entity names, all normalised
    seedTuesday(w, 'postgres hosting pricing neon supabase');
    const { reply, result } = await w.ask(S3_MESSAGE);

    expect(result.status).toBe('complete');
    expect(w.contextEvent().memoryHits.map((h) => h.excerpt)).toEqual([HOSTING_TEXT]);
    expect(w.research.calls).toHaveLength(1);
    const call = w.research.calls[0];
    expect(call?.ctx.entities).toEqual([]);
    expect(call?.analysis.entities.map((e) => e.text)).toEqual(['Neon', 'Supabase']);
    expect(reply).toBe(
      `${ASKED} ${TOOK} ${NOT_ESTABLISHED('2026-11-10')} Here is what I can verify now.`,
    );
    expect(reply).not.toContain('Postgres hosting pricing');
  });

  it('takes them from the entities the user already has when the message names them, with no tags', async () => {
    const w = world(liveS3());
    w.entity('Neon');
    w.entity('Supabase');
    seedTuesday(w, '');
    const { reply } = await w.ask(S3_MESSAGE);
    expect(w.research.calls[0]?.ctx.entities.map((e) => e.name)).toEqual(['Neon', 'Supabase']);
    expect(w.research.calls[0]?.analysis.entities).toEqual([]);
    expect(reply).toBe(
      `${ASKED} ${TOOK} ${NOT_ESTABLISHED('2026-11-10')} Here is what I can verify now.`,
    );
  });

  it('claims nothing the message does not contain: a stored entity that it never names is left out', async () => {
    const w = world(liveS3());
    w.entity('Neon');
    w.entity('Supabase');
    w.entity('PlanetScale');
    seedTuesday(w, '');
    await w.ask(S3_MESSAGE);
    expect(w.research.calls[0]?.ctx.entities.map((e) => e.name)).toEqual(['Neon', 'Supabase']);
  });

  it('with no derivable company keeps the clarification and says what was found', async () => {
    const w = world(liveS3());
    w.message(w.seedConversation(), 'Which managed Postgres host should we use?', TUESDAY);
    const { result, reply } = await w.ask(S3_MESSAGE);
    expect(result.status).toBe('clarify');
    expect(w.research.calls).toHaveLength(0);
    expect(w.answer.calls).toHaveLength(0);
    expect(reply).toBe(
      `On 2026-11-10 at 10:00 you asked: "Which managed Postgres host should we use?" I could not tell which company you mean from it, and I won't guess. Which company or product should I look into? I'll check its current pricing and recent releases.`,
    );
  });

  it('two candidate conversations on the day are a question with one quoted option each, never a pick', async () => {
    const w = world(liveS3());
    const first = seedTuesday(w, 'neon supabase');
    const otherText = 'Postgres hosting for the analytics team: is PlanetScale an option?';
    const second = w.message(
      w.seedConversation(),
      otherText,
      TUESDAY + 3_600_000,
      'UTC',
      'planetscale',
    );
    const { result } = await w.ask(S3_MESSAGE);

    expect(result.status).toBe('clarify');
    expect(w.research.calls).toHaveLength(0);
    const options = (
      w.eventsOf('clarification')[0] as { options: Array<{ label: string; ref: string }> }
    ).options;
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.ref).sort()).toEqual(
      [`conv:${first.conversationId}`, `conv:${second.conversationId}`].sort(),
    );
    expect(options.find((o) => o.ref === `conv:${first.conversationId}`)?.label).toBe(
      `2026-11-10 10:00: ${HOSTING_TEXT.slice(0, 80)}`,
    );
  });

  it('the same two conversations without topic terms are asked about too', async () => {
    const w = world(liveS3([]));
    seedTuesday(w, 'neon supabase');
    w.message(w.seedConversation(), 'Something else entirely about Acme', TUESDAY + 3_600_000);
    const { result } = await w.ask(S3_MESSAGE);
    expect(result.status).toBe('clarify');
    expect(w.research.calls).toHaveLength(0);
    expect((w.eventsOf('clarification')[0] as { options: unknown[] }).options).toHaveLength(2);
  });

  it("never uses another user's tagged message or entities", async () => {
    const w = world(liveS3());
    // the caller's own Tuesday message has nothing derivable
    w.message(w.seedConversation(), 'Which managed Postgres host should we use?', TUESDAY);
    // another user has a tagged message on the same day and the entities by name
    const other = w.t.users.create();
    const otherConv = w.t.conversations.create({ userId: other }).id;
    w.t.clock.set(TUESDAY);
    const m = w.t.messages.insert({
      userId: other,
      conversationId: otherConv,
      role: 'user',
      content: HOSTING_TEXT,
      tz: 'UTC',
    });
    insertMessageSearch(w.t.db, {
      messageId: m.id,
      userId: other,
      body: HOSTING_TEXT,
      tags: 'neon supabase',
    });
    for (const n of ['Neon', 'Supabase']) {
      w.t.db
        .prepare(
          'INSERT INTO entities (id, user_id, canonical, norm, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(newId('ent'), other, n, n.toLowerCase(), TUESDAY);
    }
    w.t.clock.set(Date.UTC(2026, 10, 12, 10, 0));

    const { result, reply } = await w.ask(S3_MESSAGE);
    expect(result.status).toBe('clarify');
    expect(w.research.calls).toHaveLength(0);
    expect(reply).not.toContain('Neon');
  });
});

describe('the audit lane quotes candidate conversations the same way', () => {
  it('relabels its conversation options to the time and the first 80 characters', async () => {
    const w = world(analysisOf({ ...{ laneHint: 'audit', intents: ['pricing'] }, ...liveRaw() }));
    w.message(w.seedConversation(), HOSTING_TEXT, TUESDAY);
    w.message(w.seedConversation(), `Postgres hosting: ${'x'.repeat(200)}`, TUESDAY + 3_600_000);
    await w.ask(S3_MESSAGE);
    const options = (w.eventsOf('clarification')[0] as { options: Array<{ label: string }> })
      .options;
    expect(options.every((o) => o.label.length <= 80 + '2026-11-10 10:00: '.length)).toBe(true);
  });
});

function liveRaw() {
  return {
    temporal: [
      {
        text: 'Last Tuesday',
        expr: { kind: 'weekday', weekday: 2, modifier: 'last' },
        role: 'reference_conversation',
      },
    ],
    entities: [],
    references: [],
    topicTerms: ['Postgres', 'hosting'],
    asksStillCorrect: false,
    queries: [],
    alternateQueries: [],
    userFacts: [],
  };
}

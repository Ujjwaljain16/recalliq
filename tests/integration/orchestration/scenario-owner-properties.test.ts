import { describe, expect, it } from 'vitest';
import type { TemporalExpression } from '../../../src/shared/understanding.js';
import { insertMessageSearch } from '../../helpers/db.js';
import { findingSet, unableFinding } from '../../unit/orchestration/fakes.js';
import {
  analysisOf,
  CRM,
  HOSTING_TEXT,
  MONDAY,
  MONDAY_TEXT,
  S1_MESSAGE,
  S3_MESSAGE,
  TUESDAY,
  world,
} from './scenario-world.js';

/**
 * Properties the owner asked to see verified by name, through the real coordinator with real SQLite, resolver,
 * retriever and baseline source. The analyzer, research service and answer pipeline are recording doubles. Today
 * is Thursday 2026-11-12 10:00 UTC.
 */

type World = ReturnType<typeof world>;

const research = (
  temporal: Array<{
    text: string;
    expr: TemporalExpression;
    role: 'reference_conversation' | 'change_since';
  }>,
  topicTerms: string[],
  over: Record<string, unknown> = {},
) =>
  analysisOf({
    laneHint: 'research',
    intents: ['pricing'],
    temporal,
    entities: [],
    references: [{ text: 'then', kind: 'conversation' }],
    topicTerms,
    asksStillCorrect: false,
    queries: ['pricing changes'],
    alternateQueries: [],
    userFacts: [],
    ...over,
  });

const tuesday = (terms: string[] = ['Postgres', 'hosting']) =>
  research(
    [
      {
        text: 'Last Tuesday',
        expr: { kind: 'weekday', weekday: 2, modifier: 'last' },
        role: 'reference_conversation',
      },
    ],
    terms,
  );

const seedTuesday = (w: World, tags = 'neon supabase') =>
  w.message(w.seedConversation(), HOSTING_TEXT, TUESDAY, 'UTC', tags);

const lead = (when: string, verb: string, text: string) => `On ${when} you ${verb}: "${text}"`;

/** Every finding unable_to_verify: what a failed search or an empty result looks like to the coordinator. */
function everythingUnverifiable(w: World): void {
  w.research.run = (req) => {
    w.log.push('research');
    const ids = [
      ...req.ctx.entities.map((e) => e.id),
      ...req.analysis.entities.map((m) => w.entity(m.text)),
    ];
    return Promise.resolve(
      findingSet(
        req.turnId,
        ids.map((id, i) => ({ ...unableFinding(i + 1), entityId: id })),
      ),
    );
  };
}

describe('(a) the earlier conversation is retrieved before anything is planned or searched', () => {
  it('recall, then plan, then research, then answer', async () => {
    const w = world(tuesday());
    seedTuesday(w);
    await w.ask(S3_MESSAGE);
    expect(w.log).toEqual(['recall', 'plan', 'research', 'answer']);
  });

  it('also when the companies come from a stored shortlist', async () => {
    const w = world(
      research(
        [
          {
            text: 'Monday',
            expr: { kind: 'weekday', weekday: 1, modifier: 'last' },
            role: 'reference_conversation',
          },
        ],
        ['CRM'],
        { references: [{ text: '5 CRM tools', kind: 'entity_set' }] },
      ),
    );
    w.seedMonday();
    await w.ask(S1_MESSAGE);
    expect(w.log.indexOf('recall')).toBe(0);
    expect(w.log.indexOf('recall')).toBeLessThan(w.log.indexOf('plan'));
    expect(w.log.indexOf('plan')).toBeLessThan(w.log.indexOf('research'));
  });
});

describe('(b) companies derived from stored tags; categories are never vendors', () => {
  it.each([
    ['postgres hosting pricing neon supabase', ['Neon', 'Supabase']],
    ['neon supabase postgres', ['Neon', 'Supabase']],
    ['database crm hosting neon', ['Neon']],
  ])('tags "%s" give %j and no category', async (tags, expected) => {
    const w = world(tuesday());
    seedTuesday(w, tags);
    await w.ask(S3_MESSAGE);
    const researched = w.research.calls[0]?.analysis.entities.map((e) => e.text);
    expect(researched).toEqual(expected);
    for (const category of ['Postgres', 'hosting', 'CRM', 'database', 'pricing']) {
      expect(researched).not.toContain(category);
    }
  });

  it('a stored entity named like a category is still not promoted', async () => {
    const w = world(tuesday());
    for (const category of ['Postgres', 'Hosting', 'Database']) w.entity(category);
    seedTuesday(w, 'postgres hosting database');
    const { result } = await w.ask(S3_MESSAGE);
    expect(w.research.calls).toHaveLength(0);
    expect(result.status).toBe('clarify');
  });
});

describe('(c) several candidate conversations are a question, never a pick', () => {
  it('one option per candidate; no plan, no research, no answer call', async () => {
    const w = world(tuesday());
    const first = seedTuesday(w);
    const second = w.message(
      w.seedConversation(),
      'Postgres hosting for analytics: is PlanetScale an option?',
      TUESDAY + 3_600_000,
      'UTC',
      'planetscale',
    );
    const { result } = await w.ask(S3_MESSAGE);
    expect(result.status).toBe('clarify');
    const options = (w.eventsOf('clarification')[0] as { options: Array<{ ref: string }> }).options;
    expect(options.map((o) => o.ref).sort()).toEqual(
      [`conv:${first.conversationId}`, `conv:${second.conversationId}`].sort(),
    );
    expect(w.research.calls).toHaveLength(0);
    expect(w.answer.calls).toHaveLength(0);
    expect(w.log).not.toContain('plan');
  });
});

describe('(d) the lead sentence quotes the retrieved message and nothing else', () => {
  it('equals the retrieved excerpt', async () => {
    const w = world(tuesday());
    seedTuesday(w);
    const { sentences } = await w.ask(S3_MESSAGE);
    const excerpt = w.contextEvent().memoryHits[0]?.excerpt;
    expect(excerpt).toBe(HOSTING_TEXT);
    expect(sentences[0]?.text).toBe(lead('2026-11-10 at 10:00', 'asked', excerpt ?? ''));
  });

  it('for a long message it quotes the excerpt as the retriever returned it, cut marker included', async () => {
    const w = world(tuesday());
    const long = `Which managed Postgres host should we use? Compare Neon and Supabase pricing. ${'Details. '.repeat(60)}`;
    w.message(w.seedConversation(), long, TUESDAY, 'UTC', 'neon supabase');
    const { sentences } = await w.ask(S3_MESSAGE);
    const excerpt = w.contextEvent().memoryHits[0]?.excerpt ?? '';
    expect(excerpt.endsWith('…')).toBe(true);
    expect(sentences[0]?.text).toBe(lead('2026-11-10 at 10:00', 'asked', excerpt));
  });

  it('is absent when nothing was retrieved', async () => {
    const w = world(tuesday());
    const { reply } = await w.ask(S3_MESSAGE);
    expect(w.contextEvent().memoryHits).toEqual([]);
    expect(reply).not.toMatch(/you asked|you wrote/);
  });

  it('is absent when the stored message is from another day', async () => {
    const w = world(tuesday());
    w.message(w.seedConversation(), HOSTING_TEXT, TUESDAY - 86_400_000, 'UTC', 'neon supabase');
    const { reply } = await w.ask(S3_MESSAGE);
    expect(reply).not.toMatch(/you asked|you wrote/);
    // nothing names a company, so only the analysis query is searched, as a general query with no entity
    expect(
      w.research.calls[0]?.plan.specs.every((x) => x.entityId === null && x.intent === 'general'),
    ).toBe(true);
  });
});

describe('(e) retrieval does not depend on the topic terms or on how the day is phrased', () => {
  const TERMS: string[][] = [
    ['Postgres'],
    ['postgres', 'hosting'],
    ['managed', 'database'],
    ['Neon'],
    [],
    ['hosting'],
  ];
  const DAYS: Array<{
    label: string;
    expr: TemporalExpression;
    at: number;
    when: string;
  }> = [
    {
      label: 'last Tuesday',
      expr: { kind: 'weekday', weekday: 2, modifier: 'last' },
      at: TUESDAY,
      when: '2026-11-10 at 10:00',
    },
    {
      label: '10 November',
      expr: { kind: 'calendar_date', day: 10, month: 11 },
      at: TUESDAY,
      when: '2026-11-10 at 10:00',
    },
    {
      label: 'two days ago',
      expr: { kind: 'days_ago', n: 2 },
      at: TUESDAY,
      when: '2026-11-10 at 10:00',
    },
    {
      label: 'the day before yesterday',
      expr: { kind: 'days_ago', n: 2 },
      at: TUESDAY,
      when: '2026-11-10 at 10:00',
    },
    {
      label: 'yesterday',
      expr: { kind: 'yesterday' },
      at: Date.UTC(2026, 10, 11, 15, 0),
      when: '2026-11-11 at 15:00',
    },
    {
      label: 'earlier today',
      expr: { kind: 'today' },
      at: Date.UTC(2026, 10, 12, 8, 0),
      when: '2026-11-12 at 08:00',
    },
  ];

  const cases = DAYS.flatMap((d) => TERMS.map((terms) => [d.label, terms, d] as const));
  it.each(cases)(
    '"%s" with topic terms %j finds the message and researches Neon and Supabase',
    async (_label, terms, day) => {
      const w = world(
        research([{ text: day.label, expr: day.expr, role: 'reference_conversation' }], [...terms]),
      );
      w.message(w.seedConversation(), HOSTING_TEXT, day.at, 'UTC', 'neon supabase');
      const { reply } = await w.ask(S3_MESSAGE);
      expect(w.contextEvent().memoryHits.map((h) => h.excerpt)).toEqual([HOSTING_TEXT]);
      expect(w.research.calls[0]?.analysis.entities.map((e) => e.text)).toEqual([
        'Neon',
        'Supabase',
      ]);
      expect(reply.startsWith(lead(day.when, 'asked', HOSTING_TEXT))).toBe(true);
    },
  );

  const MONDAYS: Array<[string, TemporalExpression]> = [
    ['Monday', { kind: 'weekday', weekday: 1, modifier: 'last' }],
    ['9 November', { kind: 'calendar_date', day: 9, month: 11 }],
    ['three days ago', { kind: 'days_ago', n: 3 }],
  ];
  const mondayCases = MONDAYS.flatMap(([label, expr]) =>
    [['CRM'], [], ['shortlist'], ['sales', 'team']].map((terms) => [label, expr, terms] as const),
  );
  it.each(mondayCases)(
    '"%s" with topic terms %j finds the Monday shortlist message',
    async (label, expr, terms) => {
      const w = world(
        research([{ text: label, expr, role: 'reference_conversation' }], [...terms], {
          references: [{ text: '5 CRM tools', kind: 'entity_set' }],
        }),
      );
      const conv = w.seedConversation();
      const m = w.message(conv, MONDAY_TEXT, MONDAY);
      for (const n of CRM) w.entity(n);
      w.shortlist(conv, m.id, CRM, MONDAY);
      await w.ask(S1_MESSAGE);
      expect(w.contextEvent().memoryHits.map((h) => h.excerpt)).toEqual([MONDAY_TEXT]);
      expect(w.research.calls[0]?.ctx.entities.map((e) => e.name)).toEqual(CRM);
    },
  );
});

describe('(f) the day is right, the analysis names nobody, the message names two companies', () => {
  it('researches both without asking the user to repeat them, from tags alone', async () => {
    const w = world(tuesday([]));
    seedTuesday(w, 'neon supabase');
    const { result, reply } = await w.ask(S3_MESSAGE);
    expect(result.status).not.toBe('clarify');
    expect(w.research.calls[0]?.analysis.entities.map((e) => e.text)).toEqual(['Neon', 'Supabase']);
    expect(reply).not.toContain('Which company or product');
  });

  it('researches both from the stored entities alone, with no tags', async () => {
    const w = world(tuesday([]));
    w.entity('Neon');
    w.entity('Supabase');
    seedTuesday(w, '');
    const { result, reply } = await w.ask(S3_MESSAGE);
    expect(result.status).not.toBe('clarify');
    expect(w.research.calls[0]?.ctx.entities.map((e) => e.name)).toEqual(['Neon', 'Supabase']);
    expect(reply).not.toContain('Which company or product');
  });
});

describe('(g) what the user wrote earlier is independent of whether the research found anything', () => {
  it('derived companies, every finding unable_to_verify: the answer still opens with the lead', async () => {
    const w = world(tuesday());
    seedTuesday(w);
    everythingUnverifiable(w);
    const { result, reply } = await w.ask(S3_MESSAGE);
    expect(result.status).toBe('partial');
    expect(w.log).toContain('research');
    expect(reply.startsWith(lead('2026-11-10 at 10:00', 'asked', HOSTING_TEXT))).toBe(true);
  });

  it('a stored shortlist, every finding unable_to_verify: the answer still opens with the lead', async () => {
    const w = world(
      research(
        [
          {
            text: 'Monday',
            expr: { kind: 'weekday', weekday: 1, modifier: 'last' },
            role: 'reference_conversation',
          },
        ],
        ['CRM'],
        { references: [{ text: '5 CRM tools', kind: 'entity_set' }] },
      ),
    );
    w.seedMonday();
    everythingUnverifiable(w);
    const { result, reply } = await w.ask(S1_MESSAGE);
    expect(result.status).toBe('partial');
    expect(reply.startsWith(lead('2026-11-09 at 09:30', 'wrote', MONDAY_TEXT))).toBe(true);
  });

  it('the audit lane too', async () => {
    const w = world(
      analysisOf({
        laneHint: 'audit',
        intents: ['pricing'],
        temporal: [
          {
            text: 'Last Tuesday',
            expr: { kind: 'weekday', weekday: 2, modifier: 'last' },
            role: 'reference_conversation',
          },
        ],
        entities: [{ text: 'Neon', normalized: 'neon' }],
        references: [],
        topicTerms: ['Postgres'],
        asksStillCorrect: true,
        queries: [],
        alternateQueries: [],
        userFacts: [],
      }),
    );
    seedTuesday(w);
    everythingUnverifiable(w);
    const { result, reply } = await w.ask(S3_MESSAGE);
    expect(result.status).toBe('partial');
    expect(reply.startsWith(lead('2026-11-10 at 10:00', 'asked', HOSTING_TEXT))).toBe(true);
  });
});

describe('retrieval is not simply everything stored on the day', () => {
  const OTHER_TUESDAY = Date.UTC(2026, 10, 3, 10, 0);

  /** The matching Tuesday conversation among conversations that must never be used. */
  function crowded(): World {
    const w = world(tuesday(['Postgres', 'hosting']));
    seedTuesday(w, 'postgres hosting neon supabase');
    w.message(
      w.seedConversation(),
      'CRM shortlist: HubSpot and Pipedrive for the sales team',
      TUESDAY + 3_600_000,
      'UTC',
      'hubspot pipedrive',
    );
    w.message(
      w.seedConversation(),
      'How long should I roast a chicken?',
      TUESDAY + 7_200_000,
      'UTC',
      'recipe',
    );
    w.message(
      w.seedConversation(),
      'Is Postgres 16 slow on ARM?',
      OTHER_TUESDAY,
      'UTC',
      'postgres planetscale',
    );
    w.message(
      w.seedConversation(),
      'Postgres hosting on Fly: any good?',
      TUESDAY - 86_400_000,
      'UTC',
      'fly',
    );
    // another user's conversation that matches perfectly
    const other = w.t.users.create();
    const otherConv = w.t.conversations.create({ userId: other }).id;
    w.t.clock.set(TUESDAY + 60_000);
    const m = w.t.messages.insert({
      userId: other,
      conversationId: otherConv,
      role: 'user',
      content: 'Postgres hosting: should we pick PlanetScale or Aiven?',
      tz: 'UTC',
    });
    insertMessageSearch(w.t.db, {
      messageId: m.id,
      userId: other,
      body: 'Postgres hosting: should we pick PlanetScale or Aiven?',
      tags: 'planetscale aiven',
    });
    w.t.clock.set(Date.UTC(2026, 10, 12, 10, 0));
    return w;
  }

  it('recalls only the matching Tuesday conversation and takes companies only from it', async () => {
    const w = crowded();
    const { reply } = await w.ask(S3_MESSAGE);
    expect(w.contextEvent().memoryHits.map((h) => h.excerpt)).toEqual([HOSTING_TEXT]);
    expect(w.research.calls[0]?.analysis.entities.map((e) => e.text)).toEqual(['Neon', 'Supabase']);
    expect(reply).not.toMatch(/HubSpot|chicken|PlanetScale|Aiven|ARM/);
  });

  it('an unrelated stored entity the message does not mention is never researched', async () => {
    const w = crowded();
    w.entity('Acme');
    w.entity('Neon');
    w.entity('Supabase');
    await w.ask(S3_MESSAGE);
    expect(w.research.calls[0]?.ctx.entities.map((e) => e.name)).toEqual(['Neon', 'Supabase']);
    expect(w.research.calls[0]?.analysis.entities).toEqual([]);
  });

  it('two matching conversations give a question with exactly those two options', async () => {
    const w = crowded();
    const second = w.message(
      w.seedConversation(),
      'Postgres hosting again: what about Crunchy Bridge?',
      TUESDAY + 5_400_000,
      'UTC',
      'crunchy',
    );
    const first = w.t.db
      .prepare("SELECT conversation_id FROM messages WHERE content = ? AND role = 'user'")
      .pluck()
      .get(HOSTING_TEXT) as string;
    const { result } = await w.ask(S3_MESSAGE);
    expect(result.status).toBe('clarify');
    const options = (w.eventsOf('clarification')[0] as { options: Array<{ ref: string }> }).options;
    expect(options.map((o) => o.ref).sort()).toEqual(
      [`conv:${first}`, `conv:${second.conversationId}`].sort(),
    );
    expect(w.research.calls).toHaveLength(0);
    expect(w.answer.calls).toHaveLength(0);
  });

  it.each(['search_timeout', 'deadline', 'search_unavailable'] as const)(
    'the lead is present when both vendors fail with %s',
    async (failure) => {
      const w = crowded();
      w.research.run = (req) => {
        w.log.push('research');
        const ids = req.analysis.entities.map((m) => w.entity(m.text));
        return Promise.resolve(
          findingSet(
            req.turnId,
            ids.map((id, i) => ({ ...unableFinding(i + 1, failure), entityId: id })),
          ),
        );
      };
      const { result, reply } = await w.ask(S3_MESSAGE);
      expect(result.status).toBe('partial');
      expect(w.log).toContain('research');
      expect(reply.startsWith(lead('2026-11-10 at 10:00', 'asked', HOSTING_TEXT))).toBe(true);
    },
  );
});

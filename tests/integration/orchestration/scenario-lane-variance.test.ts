import { describe, expect, it } from 'vitest';
import { findingSet, unableFinding } from '../../unit/orchestration/fakes.js';
import {
  analysisOf,
  CRM,
  HOSTING_TEXT,
  MONDAY_TEXT,
  NO_BASELINE,
  S1_MESSAGE,
  S3_MESSAGE,
  TUESDAY,
  world,
} from './scenario-world.js';

/**
 * The model's lane hint for the same sentence varies between runs (research, audit, recall). What is researched
 * and what the answer opens with must not depend on it. Real coordinator, SQLite, resolver and retriever; the
 * analyzer, research service and answer pipeline are doubles.
 */

type World = ReturnType<typeof world>;
type Hint = 'research' | 'audit' | 'recall';

const analysisFor = (
  hint: Hint,
  stillCorrect: boolean,
  day: { text: string; weekday: number },
  terms: string[],
  over: Record<string, unknown> = {},
) =>
  analysisOf({
    laneHint: hint,
    intents: ['pricing'],
    temporal: [
      {
        text: day.text,
        expr: { kind: 'weekday', weekday: day.weekday, modifier: 'last' },
        role: 'reference_conversation',
      },
      {
        text: 'since then',
        expr: {
          kind: 'since',
          anchor: { kind: 'weekday', weekday: day.weekday, modifier: 'last' },
        },
        role: 'change_since',
      },
    ],
    entities: [],
    references: [{ text: 'then', kind: 'conversation' }],
    topicTerms: terms,
    asksStillCorrect: stillCorrect,
    queries: ['pricing changes'],
    alternateQueries: [],
    userFacts: [],
    ...over,
  });

const tuesdayAnalysis = (hint: Hint, stillCorrect = false) =>
  analysisFor(hint, stillCorrect, { text: 'Last Tuesday', weekday: 2 }, ['Postgres', 'hosting']);

const ASKED = `On 2026-11-10 at 10:00 you asked: "${HOSTING_TEXT}"`;
const TOOK = 'I took the companies from that earlier message: Neon and Supabase.';

const seedTuesday = (w: World, tags = 'neon supabase') =>
  w.message(w.seedConversation(), HOSTING_TEXT, TUESDAY, 'UTC', tags);

const researched = (w: World): string[] => [
  ...(w.research.calls[0]?.ctx.entities.map((e) => e.name) ?? []),
  ...(w.research.calls[0]?.analysis.entities.map((e) => e.text) ?? []),
];

describe('the lane hint does not change what is researched', () => {
  const combos = (['research', 'audit', 'recall'] as const).flatMap((hint) =>
    [true, false].map((still) => [hint, still] as const),
  );

  it.each(combos)(
    'scenario 3 with hint %s and asksStillCorrect %s: Neon and Supabase, opened by what was asked',
    async (hint, still) => {
      const w = world(tuesdayAnalysis(hint, still));
      seedTuesday(w);
      const { reply } = await w.ask(S3_MESSAGE);
      expect(researched(w).sort()).toEqual(['Neon', 'Supabase']);
      expect(reply.startsWith(`${ASKED} ${TOOK}`)).toBe(true);
      expect(w.answer.calls).toHaveLength(1);
    },
  );

  it.each(combos)(
    'scenario 1 with hint %s and asksStillCorrect %s: the five tools, opened by what was written',
    async (hint, still) => {
      const w = world(
        analysisFor(hint, still, { text: 'Monday', weekday: 1 }, ['CRM'], {
          references: [{ text: '5 CRM tools', kind: 'entity_set' }],
        }),
      );
      w.seedMonday();
      const { reply } = await w.ask(S1_MESSAGE);
      expect(researched(w)).toEqual(CRM);
      expect(reply.startsWith(`On 2026-11-09 at 09:30 you wrote: "${MONDAY_TEXT}"`)).toBe(true);
    },
  );
});

describe('scenario 3 in the audit lane', () => {
  const audit = () => tuesdayAnalysis('audit', true);

  it('researches Neon and Supabase from the tags, then says nothing earlier can be compared against', async () => {
    const w = world(audit());
    seedTuesday(w);
    const { result, reply } = await w.ask(S3_MESSAGE);
    expect(result.status).toBe('complete');
    expect(researched(w)).toEqual(['Neon', 'Supabase']);
    expect(reply).toBe(`${ASKED} ${TOOK} ${NO_BASELINE} Here is what I can verify now.`);
    expect(w.log).toEqual(['recall', 'plan', 'research', 'answer']);
  });

  it('takes them from stored entity rows when there are no tags, and never an unrelated stored entity', async () => {
    const w = world(audit());
    for (const n of ['Neon', 'Supabase', 'Acme']) w.entity(n);
    seedTuesday(w, '');
    await w.ask(S3_MESSAGE);
    expect(w.research.calls[0]?.ctx.entities.map((e) => e.name)).toEqual(['Neon', 'Supabase']);
  });

  it('ignores a competing unrelated Postgres question on the other candidate Tuesday', async () => {
    const w = world(audit());
    seedTuesday(w);
    w.message(
      w.seedConversation(),
      'Is Postgres 16 slow on ARM?',
      Date.UTC(2026, 10, 3, 10, 0),
      'UTC',
      'postgres planetscale',
    );
    await w.ask(S3_MESSAGE);
    expect(researched(w)).toEqual(['Neon', 'Supabase']);
    expect(w.contextEvent().memoryHits.map((h) => h.excerpt)).toEqual([HOSTING_TEXT]);
  });

  it('two matching conversations are a question with two options, and nothing is researched', async () => {
    const w = world(audit());
    const first = seedTuesday(w);
    const second = w.message(
      w.seedConversation(),
      'Postgres hosting again: what about Crunchy Bridge?',
      TUESDAY + 3_600_000,
      'UTC',
      'crunchy',
    );
    const { result } = await w.ask(S3_MESSAGE);
    expect(result.status).toBe('clarify');
    const options = (w.eventsOf('clarification')[0] as { options: Array<{ ref: string }> }).options;
    expect(options.map((o) => o.ref).sort()).toEqual(
      [`conv:${first.conversationId}`, `conv:${second.conversationId}`].sort(),
    );
    expect(w.research.calls).toHaveLength(0);
    expect(w.answer.calls).toHaveLength(0);
  });

  it('with every finding unable_to_verify the answer still opens with what was asked', async () => {
    const w = world(audit());
    seedTuesday(w);
    w.research.run = (req) => {
      w.log.push('research');
      const ids = req.analysis.entities.map((m) => w.entity(m.text));
      return Promise.resolve(
        findingSet(
          req.turnId,
          ids.map((id, i) => ({ ...unableFinding(i + 1, 'search_timeout'), entityId: id })),
        ),
      );
    };
    const { result, reply } = await w.ask(S3_MESSAGE);
    expect(result.status).toBe('partial');
    expect(reply.startsWith(`${ASKED} ${TOOK} ${NO_BASELINE}`)).toBe(true);
  });

  it('keeps the fixed reply, with what was asked, when nothing can be derived', async () => {
    const w = world(audit());
    w.message(w.seedConversation(), 'Which managed Postgres host should we use?', TUESDAY);
    const { reply } = await w.ask(S3_MESSAGE);
    expect(w.research.calls).toHaveLength(0);
    expect(w.answer.calls).toHaveLength(0);
    expect(reply).toContain('you asked: "Which managed Postgres host should we use?"');
    expect(reply).toContain('If you want, I can look the question up now.');
  });
});

import { describe, expect, it } from 'vitest';
import { finding, findingSet } from '../../unit/orchestration/fakes.js';
import { analysisOf, CRM, MONDAY_TEXT, S1_MESSAGE, world } from './scenario-world.js';

/**
 * A price seen now, with no earlier price of the system's own to compare it with, cannot establish that
 * anything changed since a day. The coordinator says so in a sentence written in code, before the findings.
 * Real coordinator, SQLite, resolver and retriever; the analyzer, research service and answer pipeline are
 * doubles. Today is Thursday 2026-11-12.
 */

type World = ReturnType<typeof world>;

const MONDAY_ANCHOR = { kind: 'weekday', weekday: 1, modifier: 'last' } as const;
const sentenceFor = (day: string, names = ''): string =>
  `I have no earlier prices of my own on record from before ${day}${names}, so I cannot establish whether anything changed since then; what follows is what I could find now.`;

const analysis = (
  lane: 'research' | 'audit',
  over: Record<string, unknown> = {},
  withReferenceDay = true,
) =>
  analysisOf({
    laneHint: lane,
    intents: ['pricing', 'releases'],
    temporal: [
      ...(withReferenceDay
        ? [{ text: 'Monday', expr: MONDAY_ANCHOR, role: 'reference_conversation' }]
        : []),
      { text: 'since', expr: { kind: 'since', anchor: MONDAY_ANCHOR }, role: 'change_since' },
    ],
    entities: [],
    references: [{ text: '5 CRM tools', kind: 'entity_set' }],
    topicTerms: ['CRM'],
    asksStillCorrect: false,
    queries: ['CRM pricing changes'],
    alternateQueries: [],
    userFacts: [],
    ...over,
  });

const count = (text: string, part: string): number => text.split(part).length - 1;

/** Research that returns one finding per researched company; `verdicts` gives some of them a change verdict. */
function researchWith(w: World, verdicts: Record<string, 'changed' | 'unchanged_confirmed'>): void {
  w.research.run = (req) => {
    w.log.push('research');
    return Promise.resolve(
      findingSet(
        req.turnId,
        req.ctx.entities.map((e, i) => {
          const verdict = verdicts[e.name];
          return {
            ...finding(i + 1, { entityId: e.id, entityName: e.name }),
            ...(verdict ? { verdict } : {}),
          } as ReturnType<typeof finding>;
        }),
      ),
    );
  };
}

describe('a change since a day that cannot be established is said so', () => {
  it('research lane, five tools and no baselines: the sentence appears once, with the date, after the lead', async () => {
    const w = world(analysis('research'));
    w.seedMonday();
    const { reply } = await w.ask(S1_MESSAGE);
    expect(count(reply, 'I have no earlier prices of my own')).toBe(1);
    expect(reply).toBe(
      `On 2026-11-09 at 09:30 you wrote: "${MONDAY_TEXT}" ${sentenceFor('2026-11-09')} Here is what I can verify now.`,
    );
  });

  it('audit lane with no baseline keeps its one statement and does not repeat itself', async () => {
    const w = world(analysis('audit'));
    w.seedMonday();
    const { reply } = await w.ask(S1_MESSAGE);
    expect(reply).toContain('I have no earlier answer of my own on record to compare against');
    expect(reply).not.toContain('I have no earlier prices of my own');
    expect(count(reply, 'cannot establish')).toBe(1);
  });

  it('takes the date from the since anchor when no earlier conversation was recalled', async () => {
    const w = world(analysis('research', {}, false));
    const conv = w.seedConversation();
    const m = w.message(conv, 'unrelated', Date.UTC(2026, 10, 9, 9, 30));
    for (const n of CRM) w.entity(n);
    w.shortlist(conv, m.id, CRM, Date.UTC(2026, 10, 9, 9, 30));
    const { reply } = await w.ask(S1_MESSAGE);
    // "last Monday" has two candidate days; the most recent one that is not in the future is used
    expect(reply).toBe(`${sentenceFor('2026-11-09')} Here is what I can verify now.`);
  });

  it('every finding unable_to_verify still gets the sentence, and no claim of change', async () => {
    const w = world(analysis('research'));
    w.seedMonday();
    w.research.run = (req) =>
      Promise.resolve(
        findingSet(
          req.turnId,
          req.ctx.entities.map((e, i) => ({
            ...finding(i + 1, { entityId: e.id, entityName: e.name }),
            currentStatus: 'unable_to_verify' as const,
            verdict: 'unable_to_verify' as const,
          })),
        ),
      );
    const { reply } = await w.ask(S1_MESSAGE);
    expect(count(reply, 'I have no earlier prices of my own')).toBe(1);
  });

  it('when one tool has a change verdict, only the others are named', async () => {
    const w = world(analysis('research'));
    w.seedMonday();
    researchWith(w, { HubSpot: 'unchanged_confirmed' });
    const { reply } = await w.ask(S1_MESSAGE);
    expect(reply).toContain(
      sentenceFor('2026-11-09', ' for Pipedrive, Zoho CRM, Salesforce and Freshsales'),
    );
    expect(count(reply, 'I have no earlier prices of my own')).toBe(1);
    expect(reply).not.toMatch(/for [^.]*HubSpot[^.]*, so I cannot establish/);
  });

  it('when every tool has a verdict, nothing is added', async () => {
    const w = world(analysis('research'));
    w.seedMonday();
    researchWith(
      w,
      Object.fromEntries(CRM.map((n) => [n, 'changed' as const])) as Record<string, 'changed'>,
    );
    const { reply } = await w.ask(S1_MESSAGE);
    expect(reply).not.toContain('I have no earlier prices of my own');
  });

  it('a plain price question with no "since" mention gets no such sentence', async () => {
    const w = world(
      analysisOf({
        laneHint: 'research',
        intents: ['pricing'],
        temporal: [],
        entities: [{ text: 'Acme CRM', normalized: 'acme crm' }],
        references: [],
        topicTerms: [],
        asksStillCorrect: false,
        queries: [],
        alternateQueries: [],
        userFacts: [],
      }),
    );
    const { reply } = await w.ask('What does Acme CRM cost?');
    expect(w.research.calls).toHaveLength(1);
    expect(reply).toBe('Here is what I can verify now.');
  });

  it('is code-written: the answer model is not given it, and it is numbered before the model sentences', async () => {
    const w = world(analysis('research'));
    w.seedMonday();
    w.answer.streams = [
      { event: 'answer.delta', data: { sentenceIndex: 0, text: 'Here is what I can verify now.' } },
      { event: 'answer.sentence_end', data: { index: 0, status: 'no_claims', issues: [] } },
    ];
    const { sentences } = await w.ask(S1_MESSAGE);
    expect(JSON.stringify(w.answer.calls)).not.toContain('earlier prices of my own');
    expect(sentences.map((s) => s.text)).toEqual([
      `On 2026-11-09 at 09:30 you wrote: "${MONDAY_TEXT}"`,
      sentenceFor('2026-11-09'),
      'Here is what I can verify now.',
    ]);
    expect(sentences.map((s) => s.index)).toEqual([0, 1, 2]);
    const deltas = w.eventsOf('answer.delta') as Array<{ sentenceIndex: number; text: string }>;
    expect(deltas.map((d) => d.sentenceIndex)).toEqual([0, 1, 2]);
    expect(deltas[1]?.text).toBe(` ${sentenceFor('2026-11-09')}`);
  });
});

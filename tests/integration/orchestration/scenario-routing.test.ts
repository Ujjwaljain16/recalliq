import { describe, expect, it } from 'vitest';
import { LlmTurnAnalyzer } from '../../../src/llm/analysis/analyzer.js';
import { FakeLlm } from '../../../src/llm/fake.js';
import { findingSet, unableFinding } from '../../unit/orchestration/fakes.js';
import {
  analysisOf,
  CAPTURED_S1,
  CORRECTED_S1,
  CRM,
  HOSTING_TEXT,
  MONDAY,
  MONDAY_TEXT,
  NEON_TEXT,
  NO_BASELINE,
  OLD_REPLY,
  S1_MESSAGE,
  S2_ANALYSIS,
  S2_MESSAGE,
  S3_ANALYSIS,
  S3_MESSAGE,
  THREE_NOV,
  TUESDAY,
  names,
  world,
} from './scenario-world.js';

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

import { describe, expect, it } from 'vitest';
import { SqliteMessageMemory } from '../../../src/db/repositories/memory-retriever.js';
import { resolveRecall } from '../../../src/memory/recall.js';
import { DefaultTemporalResolver } from '../../../src/temporal/resolver.js';
import { insertEntity, openTestDb, T0 } from '../../helpers/db.js';
import { advance, buildCompletion, startTurn } from '../../helpers/turns.js';

/**
 * Date resolution, retrieval and recall together, on the real write path: a turn is completed with write-time enrichment
 * (message_search written by complete()), then the resolver and the retriever recall it by date and by
 * topic. Nothing here inserts into message_search by hand.
 */
function completedTurn(text: string, tags: string[]) {
  const t = openTestDb('real');
  const userId = t.users.create();
  const conversationId = t.conversations.create({ userId }).id;
  const { turnId } = startTurn(t, userId, conversationId, { text });
  advance(t, userId, turnId);
  const entityId = insertEntity(t.db, { userId, norm: 'hubspot' });
  t.turns.complete(
    userId,
    turnId,
    buildCompletion({
      turnId,
      userId,
      entityId,
      sentences: 2,
      claimsAt: [0],
      streamedThrough: 1,
      override: { enrichment: { tags, entities: [], decisions: [] } },
    }),
  );
  const deps = { resolver: new DefaultTemporalResolver(), memory: new SqliteMessageMemory(t.db) };
  const ask = (terms: string[], expr: Parameters<typeof resolveRecall>[1]['mentions'][0]['expr']) =>
    resolveRecall(deps, {
      userId,
      mentions: [{ text: 'q', expr, role: 'reference_conversation' }],
      topicTerms: terms,
      tz: 'UTC',
      now: T0 + 24 * 3_600_000, // the next day
    });
  return { t, userId, conversationId, ask };
}

describe('memory and recall: enrichment -> resolver -> retriever -> recall', () => {
  it('recalls yesterday by body text, by an enrichment tag, and with no terms', () => {
    const { conversationId, ask } = completedTurn('Which CRM should we shortlist?', ['pipeline']);
    for (const terms of [['shortlist'], ['pipeline'], []]) {
      const out = ask(terms, { kind: 'yesterday' });
      expect(out.kind, terms.join(',')).toBe('answer');
      if (out.kind !== 'answer') continue;
      expect(out.localDate).toBe('2026-11-11');
      expect(out.conversationIds).toEqual([conversationId]);
      // only the user's own message is a recall candidate, even though complete() indexes the answer too
      expect(out.hits).toHaveLength(1);
    }
  });

  it('a topic that was never discussed is an honest "none"', () => {
    const { ask } = completedTurn('Which CRM should we shortlist?', ['pipeline']);
    expect(ask(['kubernetes'], { kind: 'yesterday' }).kind).toBe('none');
  });

  it('the wrong day is "none", not a near match', () => {
    const { ask } = completedTurn('Which CRM should we shortlist?', []);
    expect(ask([], { kind: 'days_ago', n: 3 }).kind).toBe('none');
  });

  it('T-MEM-08: a deleted conversation cannot be recalled, by date, by topic or by tag', () => {
    const { t, userId, conversationId, ask } = completedTurn('Which CRM should we shortlist?', [
      'pipeline',
    ]);
    expect(ask(['shortlist'], { kind: 'yesterday' }).kind).toBe('answer');

    t.turns.deleteConversation(userId, conversationId);

    for (const terms of [['shortlist'], ['pipeline'], []]) {
      expect(ask(terms, { kind: 'yesterday' }).kind, terms.join(',')).toBe('none');
    }
  });
});

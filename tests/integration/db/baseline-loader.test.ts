import { describe, expect, it } from 'vitest';
import { BaselineLoader, type IneligibleReason } from '../../../src/db/index.js';
import type { SentenceStatus } from '../../../src/shared/answer.js';
import type { NormalizedValue } from '../../../src/shared/evidence.js';
import {
  newId,
  type AssertionId,
  type ConversationId,
  type EvidenceId,
  type TurnId,
  type UserId,
} from '../../../src/shared/ids.js';
import { insertEntity, insertSnapshot, openTestDb, T0, type TestDb } from '../../helpers/db.js';
import { advance, buildCompletion, startTurn, USD_90 } from '../../helpers/turns.js';

/**
 * ADR-38: baseline eligibility (rules 1 to 5) and the separate recall of presented-but-unverified claims.
 * Every claim is stored through the real completion and acknowledgement path.
 */

const KEY = 'price:v1|e=hubspot|pro';

interface ClaimSpec {
  userId: UserId;
  conversationId?: ConversationId;
  sentenceStatus?: SentenceStatus;
  placeholder?: string;
  beliefKey?: string | null;
  value?: NormalizedValue | null;
  /** One verification status per linked evidence statement; empty means no links. */
  evidence?: Array<'pass' | 'weak' | 'fail'>;
  /** 'ack' = acknowledged, 'streamed' = streamed but never acknowledged, 'never' = never streamed. */
  delivery?: 'ack' | 'streamed' | 'never';
}

interface Claim {
  turnId: TurnId;
  assertionId: AssertionId;
  conversationId: ConversationId;
}

function insertEvidenceWith(
  t: TestDb,
  p: { userId: UserId; turnId: TurnId; entityId: ReturnType<typeof insertEntity>; status: string },
): EvidenceId {
  const snapshotId = insertSnapshot(t.db, { userId: p.userId });
  const id = newId('ev');
  t.db
    .prepare(
      `INSERT INTO evidence_statements (id, user_id, snapshot_id, turn_id, entity_id, kind, belief_key,
         payload_json, quote, polarity, modality, displayed_at_basis, authority_tier,
         verification_status, verification_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'price', ?, '{}', 'Pro $90', 'affirmed', 'current', 'fresh_fetch', 'A1',
         ?, '{}', ?)`,
    )
    .run(id, p.userId, snapshotId, p.turnId, p.entityId, KEY, p.status, T0);
  return id;
}

/** One completed turn holding one assertion, delivered as `spec.delivery` says. */
function claim(t: TestDb, spec: ClaimSpec): Claim {
  const conversationId = spec.conversationId ?? t.conversations.create({ userId: spec.userId }).id;
  const { turnId } = startTurn(t, spec.userId, conversationId);
  advance(t, spec.userId, turnId);
  const entityId = insertEntity(t.db, { userId: spec.userId, norm: `e-${turnId}` });
  const evidenceIds = (spec.evidence ?? ['pass']).map((status) =>
    insertEvidenceWith(t, { userId: spec.userId, turnId, entityId, status }),
  );
  const placeholder = spec.placeholder ?? 'F1';
  const base = buildCompletion({
    turnId,
    userId: spec.userId,
    entityId,
    sentences: 1,
    claimsAt: [0],
    streamedThrough: spec.delivery === 'never' ? -1 : 0,
    evidenceIds,
  });
  const assistant = base.assistant;
  const assertion = base.assertions[0];
  const sentence = assistant?.sentences[0];
  const ph = sentence?.placeholders[0];
  if (!assistant || !assertion || !sentence || !ph) throw new Error('unexpected fixture shape');
  const completion = {
    ...base,
    assistant: {
      ...assistant,
      sentences: [
        {
          ...sentence,
          status: spec.sentenceStatus ?? 'verified',
          placeholders: [{ ...ph, token: `[[${placeholder}]]` }],
        },
      ],
    },
    assertions: [
      {
        ...assertion,
        placeholder,
        beliefKey: spec.beliefKey === undefined ? KEY : spec.beliefKey,
        value: spec.value === undefined ? USD_90 : spec.value,
      },
    ],
  };
  t.turns.complete(spec.userId, turnId, completion);
  if ((spec.delivery ?? 'ack') === 'ack') {
    t.turns.ack(spec.userId, turnId, { renderedThrough: 0, complete: true }, T0 + 1_000);
  }
  const row = t.db.prepare('SELECT id FROM assertions WHERE turn_id = ?').get(turnId) as
    { id: AssertionId } | undefined;
  if (!row) throw new Error('no assertion stored');
  t.clock.advance(10_000);
  return { turnId, assertionId: row.id, conversationId };
}

/** A later turn in the same conversation, the one an audit would run as. */
function laterTurn(t: TestDb, userId: UserId, conversationId: ConversationId): TurnId {
  return startTurn(t, userId, conversationId).turnId;
}

function setup() {
  const t = openTestDb();
  return { t, loader: new BaselineLoader(t.db), userId: t.users.create() };
}

describe('ADR-38: a fully valid claim is a baseline', () => {
  it('returns the presented, verified, current-value claim with its evidence, and not as recall', () => {
    const { t, loader, userId } = setup();
    const c = claim(t, { userId, evidence: ['pass', 'pass'] });
    const now = laterTurn(t, userId, c.conversationId);

    const baselines = loader.loadBaselines(userId, now);
    expect(baselines).toHaveLength(1);
    expect(baselines[0]).toMatchObject({
      assertionId: c.assertionId,
      turnId: c.turnId,
      placeholder: 'F1',
      beliefKey: KEY,
      value: USD_90,
      sentenceStatus: 'verified',
    });
    expect(baselines[0]?.evidenceIds).toHaveLength(2);
    expect(loader.recallUnverified(userId, now)).toEqual([]);
  });
});

describe('ADR-38: each baseline rule, broken alone, makes a claim recall-only', () => {
  const cases: Array<[string, Partial<ClaimSpec>, IneligibleReason]> = [
    [
      'rule 2: :baseline restatement',
      { placeholder: 'F1:baseline' },
      'placeholder_not_current_value',
    ],
    ['rule 2: :verdict comparison', { placeholder: 'F1:verdict' }, 'placeholder_not_current_value'],
    ['rule 2: :derived value', { placeholder: 'F1:derived:2' }, 'placeholder_not_current_value'],
    ['rule 3: unverified sentence', { sentenceStatus: 'unverified' }, 'sentence_not_verified'],
    ['rule 3: unchecked sentence', { sentenceStatus: 'unchecked' }, 'sentence_not_verified'],
    ['rule 3: truncated sentence', { sentenceStatus: 'truncated' }, 'sentence_not_verified'],
    ['rule 4: no belief key', { beliefKey: null }, 'missing_belief_key'],
    ['rule 4: no value', { value: null }, 'missing_or_invalid_value'],
    ['rule 5: no evidence links (e.g. deleted evidence)', { evidence: [] }, 'no_evidence'],
    ['rule 5: weak evidence', { evidence: ['weak'] }, 'evidence_not_passed'],
    ['rule 5: failed evidence', { evidence: ['fail'] }, 'evidence_not_passed'],
    [
      'rule 5: one weak link among passing ones',
      { evidence: ['pass', 'weak'] },
      'evidence_not_passed',
    ],
  ];

  it.each(cases)('%s', (_name, broken, reason) => {
    const { t, loader, userId } = setup();
    const valid = claim(t, { userId });
    const ineligible = claim(t, { userId, conversationId: valid.conversationId, ...broken });
    const now = laterTurn(t, userId, valid.conversationId);

    expect(loader.loadBaselines(userId, now).map((b) => b.assertionId)).toEqual([
      valid.assertionId,
    ]);
    const recalled = loader.recallUnverified(userId, now);
    expect(recalled.map((r) => r.assertionId)).toEqual([ineligible.assertionId]);
    expect(recalled[0]).toMatchObject({ verification: 'unverified' });
    expect(recalled[0]?.reasons).toEqual([reason]);
  });

  it.each(['contested', 'stale', 'unknown', 'unable_to_verify'] as const)(
    'rule 6: a claim about a %s finding records an uncertainty and is recall-only',
    (status) => {
      const { t, loader, userId } = setup();
      const valid = claim(t, { userId });
      const hedged = claim(t, { userId, conversationId: valid.conversationId });
      t.db
        .prepare('UPDATE findings SET current_status = ? WHERE turn_id = ?')
        .run(status, hedged.turnId);
      const now = laterTurn(t, userId, valid.conversationId);

      expect(loader.loadBaselines(userId, now).map((b) => b.assertionId)).toEqual([
        valid.assertionId,
      ]);
      const recalled = loader.recallUnverified(userId, now);
      expect(recalled.map((r) => r.assertionId)).toEqual([hedged.assertionId]);
      expect(recalled[0]?.reasons).toEqual(['finding_not_confirmed']);
    },
  );

  it('rule 4: a value_json that is not a valid NormalizedValue is ineligible', () => {
    const { t, loader, userId } = setup();
    const c = claim(t, { userId });
    // Corrupt the stored value the only way possible: on this throwaway database, without the immutability trigger.
    t.db.exec('DROP TRIGGER assertions_presented_once');
    t.db
      .prepare('UPDATE assertions SET value_json = \'{"amount":"ninety"}\' WHERE id = ?')
      .run(c.assertionId);
    const now = laterTurn(t, userId, c.conversationId);
    expect(loader.loadBaselines(userId, now)).toEqual([]);
    expect(loader.recallUnverified(userId, now)[0]?.reasons).toContain('missing_or_invalid_value');
  });

  it('rule 5: evidence removed after the claim was made leaves it recall-only', () => {
    const { t, loader, userId } = setup();
    const c = claim(t, { userId });
    t.db.prepare('DELETE FROM evidence_statements WHERE user_id = ?').run(userId);
    const now = laterTurn(t, userId, c.conversationId);
    expect(loader.loadBaselines(userId, now)).toEqual([]);
    expect(loader.recallUnverified(userId, now)[0]?.reasons).toEqual(['no_evidence']);
  });
});

describe('ADR-38 rule 1: only presented claims, only from earlier turns', () => {
  it('never returns a streamed-but-unacknowledged or never-streamed claim, by either method', () => {
    const { t, loader, userId } = setup();
    const first = claim(t, { userId, delivery: 'streamed' });
    claim(t, { userId, conversationId: first.conversationId, delivery: 'never' });
    const now = laterTurn(t, userId, first.conversationId);
    expect(loader.loadBaselines(userId, now)).toEqual([]);
    expect(loader.recallUnverified(userId, now)).toEqual([]);
  });

  it('excludes a claim made in the current turn itself', () => {
    const { t, loader, userId } = setup();
    const c = claim(t, { userId });
    expect(loader.loadBaselines(userId, c.turnId)).toEqual([]);
    expect(loader.recallUnverified(userId, c.turnId)).toEqual([]);
    expect(loader.loadBaselines(userId, laterTurn(t, userId, c.conversationId))).toHaveLength(1);
  });
});

describe('ADR-38: user scope and filters', () => {
  it('never returns another user’s claims', () => {
    const { t, loader, userId } = setup();
    const other = t.users.create();
    const mine = claim(t, { userId });
    const theirs = claim(t, { userId: other });
    claim(t, { userId: other, sentenceStatus: 'unverified' });
    const now = laterTurn(t, userId, mine.conversationId);

    expect(loader.loadBaselines(userId, now).map((b) => b.assertionId)).toEqual([mine.assertionId]);
    expect(loader.recallUnverified(userId, now)).toEqual([]);

    const otherNow = laterTurn(t, other, theirs.conversationId);
    expect(loader.loadBaselines(other, otherNow).map((b) => b.assertionId)).toEqual([
      theirs.assertionId,
    ]);
    expect(loader.recallUnverified(other, otherNow)).toHaveLength(1);
  });

  it('does not return a user’s claim when asked as another user, even with the other user’s turn id', () => {
    const { t, loader, userId } = setup();
    const other = t.users.create();
    const c = claim(t, { userId });
    const now = laterTurn(t, userId, c.conversationId);
    expect(loader.loadBaselines(other, now)).toEqual([]);
    expect(loader.recallUnverified(other, now)).toEqual([]);
  });

  it('filters by belief key and conversation, and honours the limit', () => {
    const { t, loader, userId } = setup();
    const a = claim(t, { userId, beliefKey: 'price:v1|a' });
    const b = claim(t, { userId, beliefKey: 'price:v1|b' });
    const now = laterTurn(t, userId, a.conversationId);

    expect(
      loader.loadBaselines(userId, now, { beliefKeys: ['price:v1|b'] }).map((x) => x.assertionId),
    ).toEqual([b.assertionId]);
    expect(loader.loadBaselines(userId, now, { beliefKeys: [] })).toEqual([]);
    expect(
      loader
        .loadBaselines(userId, now, { conversationId: b.conversationId })
        .map((x) => x.assertionId),
    ).toEqual([b.assertionId]);
    expect(loader.loadBaselines(userId, now, { limit: 1 })).toHaveLength(1);
    expect(loader.loadBaselines(userId, now)).toHaveLength(2);
  });
});

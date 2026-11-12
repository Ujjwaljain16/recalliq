import { describe, expect, it } from 'vitest';
import { InvalidCompletionError } from '../../../src/db/index.js';
import type { ConversationId, UserId } from '../../../src/shared/ids.js';
import type { TurnCompletion } from '../../../src/shared/repositories.js';
import { count, insertEntity, openTestDb, type TestDb } from '../../helpers/db.js';
import { advance, buildCompletion, startTurn } from '../../helpers/turns.js';

const USER_TEXT = 'We must stay under 50 dollars per seat, and HubSpot is my shortlist pick.';

type Enrichment = TurnCompletion['enrichment'];

const EMPTY: Enrichment = { tags: [], entities: [], decisions: [] };

const VALID: Enrichment = {
  tags: ['  HubSpot  ', 'Per   Seat Pricing', 'hubspot'],
  entities: [{ text: 'HubSpot', normalized: 'HubSpot CRM' }],
  decisions: [
    {
      kind: 'constraint',
      quote: 'stay under 50 dollars per seat',
      data: { kind: 'constraint', constraint: { key: 'max_price', value: 50, unit: 'USD' } },
    },
    {
      kind: 'shortlist',
      quote: 'HubSpot is my shortlist pick',
      data: { kind: 'shortlist', entities: ['HubSpot  CRM'] },
    },
  ],
};

/** A turn in PERSISTING whose user wrote `text`. */
function turn(
  t: TestDb,
  opts: { userId?: UserId; conversationId?: ConversationId; text?: string } = {},
) {
  const userId = opts.userId ?? t.users.create();
  const conversationId = opts.conversationId ?? t.conversations.create({ userId }).id;
  const { turnId, userMessageId } = startTurn(t, userId, conversationId, {
    text: opts.text ?? USER_TEXT,
  });
  advance(t, userId, turnId);
  const entityId = insertEntity(t.db, { userId, norm: `hubspot-${turnId}` });
  return { userId, conversationId, turnId, userMessageId, entityId };
}

function completion(
  t: ReturnType<typeof turn>,
  enrichment: Enrichment,
  override: Partial<TurnCompletion> = {},
): TurnCompletion {
  return buildCompletion({
    turnId: t.turnId,
    userId: t.userId,
    entityId: t.entityId,
    sentences: 2,
    claimsAt: [0],
    streamedThrough: 1,
    override: { enrichment, ...override },
  });
}

const written = (t: TestDb) => ({
  search: count(t.db, 'message_search'),
  fts: count(t.db, 'message_fts', 'message_fts MATCH ?', 'hubspot OR seat OR sentence'),
  decisions: count(t.db, 'decisions'),
  links: count(t.db, 'decision_entities'),
  assistantMessages: count(t.db, 'messages', "role = 'assistant'"),
});
const NOTHING = { search: 0, fts: 0, decisions: 0, links: 0, assistantMessages: 0 };

const ftsHits = (t: TestDb, query: string) =>
  (
    t.db
      .prepare(
        `SELECT ms.message_id AS id FROM message_fts
           JOIN message_search ms ON ms.rowid = message_fts.rowid
          WHERE message_fts MATCH ? ORDER BY ms.rowid`,
      )
      .all(query) as Array<{ id: string }>
  ).map((r) => r.id);

describe('write-time enrichment: search rows', () => {
  it('indexes the user and assistant message with normalised tags and entity names', () => {
    const t = openTestDb();
    const w = turn(t);
    t.turns.complete(w.userId, w.turnId, completion(w, VALID));

    const assistantId = t.turns.get(w.userId, w.turnId)?.assistantMessageId;
    expect(assistantId).toBeTruthy();
    const rows = t.db
      .prepare(
        'SELECT message_id, user_id, created_at, body, tags FROM message_search ORDER BY rowid',
      )
      .all();
    const userMessage = t.messages.getOwned(w.userId, w.userMessageId);
    const assistant = assistantId ? t.messages.getOwned(w.userId, assistantId) : null;
    const tags = 'hubspot per seat pricing hubspot crm';
    expect(rows).toEqual([
      {
        message_id: w.userMessageId,
        user_id: w.userId,
        created_at: userMessage?.createdAt,
        body: USER_TEXT,
        tags,
      },
      {
        message_id: assistantId,
        user_id: w.userId,
        created_at: assistant?.createdAt,
        body: assistant?.content,
        tags,
      },
    ]);
  });

  it('keeps the FTS index in step: body and tag matches, scoped by user', () => {
    const t = openTestDb();
    const w = turn(t);
    const other = turn(t, { text: 'Something about Zoho only.' });
    t.turns.complete(w.userId, w.turnId, completion(w, VALID));
    t.turns.complete(other.userId, other.turnId, completion(other, EMPTY));
    const assistantId = t.turns.get(w.userId, w.turnId)?.assistantMessageId;

    expect(ftsHits(t, 'shortlist')).toEqual([w.userMessageId]); // body only
    expect(ftsHits(t, 'tags:pricing')).toEqual([w.userMessageId, assistantId]); // tags column only
    expect(ftsHits(t, 'zoho')).toEqual([other.userMessageId]);
    expect(count(t.db, 'message_search')).toBe(count(t.db, 'message_fts_docsize'));

    const mine = t.db
      .prepare(
        `SELECT ms.message_id FROM message_fts JOIN message_search ms ON ms.rowid = message_fts.rowid
          WHERE message_fts MATCH 'zoho' AND ms.user_id = ?`,
      )
      .all(w.userId);
    expect(mine).toEqual([]);
  });

  it('indexes both messages even when there is no enrichment', () => {
    const t = openTestDb();
    const w = turn(t);
    t.turns.complete(w.userId, w.turnId, completion(w, EMPTY));
    expect(written(t)).toMatchObject({ search: 2, decisions: 0 });
    expect(t.db.prepare('SELECT DISTINCT tags FROM message_search').all()).toEqual([{ tags: '' }]);
  });

  it('indexes only the user message when the turn stored no answer', () => {
    const t = openTestDb();
    const w = turn(t);
    t.turns.complete(
      w.userId,
      w.turnId,
      completion(w, EMPTY, {
        status: 'failed',
        assistant: null,
        findings: null,
        assertions: [],
        events: [],
      }),
    );
    expect(t.db.prepare('SELECT message_id FROM message_search').all()).toEqual([
      { message_id: w.userMessageId },
    ]);
  });
});

describe('write-time enrichment: decisions', () => {
  it('stores each decision with its verified quote and links it to the user’s own entities', () => {
    const t = openTestDb();
    const w = turn(t);
    const hubspot = insertEntity(t.db, { userId: w.userId, norm: 'hubspot crm' });
    const strangers = turn(t);
    insertEntity(t.db, { userId: strangers.userId, norm: 'hubspot crm' }); // same norm, other user
    t.turns.complete(w.userId, w.turnId, completion(w, VALID));

    const rows = t.db
      .prepare(
        'SELECT user_id, conversation_id, message_id, kind, user_quote, version, supersedes_id, origin, payload_json FROM decisions ORDER BY rowid',
      )
      .all();
    expect(rows).toEqual([
      {
        user_id: w.userId,
        conversation_id: w.conversationId,
        message_id: w.userMessageId,
        kind: 'constraint',
        user_quote: 'stay under 50 dollars per seat',
        version: 1,
        supersedes_id: null,
        origin: 'live',
        payload_json: JSON.stringify(VALID.decisions[0]?.data),
      },
      expect.objectContaining({ kind: 'shortlist', user_quote: 'HubSpot is my shortlist pick' }),
    ]);
    expect(t.db.prepare('SELECT entity_id FROM decision_entities').all()).toEqual([
      { entity_id: hubspot },
    ]);
  });

  it('a correction supersedes the active decision of the kind it corrects, as the next version', () => {
    const t = openTestDb();
    const w = turn(t);
    t.turns.complete(w.userId, w.turnId, completion(w, VALID));
    const second = turn(t, {
      userId: w.userId,
      conversationId: w.conversationId,
      text: 'Actually I meant under 80 dollars per seat.',
    });
    t.turns.complete(
      w.userId,
      second.turnId,
      completion(second, {
        ...EMPTY,
        decisions: [
          {
            kind: 'correction',
            correctsDecisionKind: 'constraint',
            quote: 'under 80 dollars per seat',
            data: { kind: 'constraint', constraint: { key: 'max_price', value: 80 } },
          },
        ],
      }),
    );
    const rows = t.db
      .prepare(
        'SELECT id, kind, version, supersedes_id FROM decisions WHERE kind = ? ORDER BY version',
      )
      .all('constraint') as Array<{ id: string; version: number; supersedes_id: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ version: 2, supersedes_id: rows[0]?.id });
  });

  it('never supersedes another user’s decision', () => {
    const t = openTestDb();
    const a = turn(t);
    t.turns.complete(a.userId, a.turnId, completion(a, VALID));
    const b = turn(t, { text: 'Actually I meant under 80 dollars per seat.' });
    t.turns.complete(
      b.userId,
      b.turnId,
      completion(b, {
        ...EMPTY,
        decisions: [
          {
            kind: 'correction',
            correctsDecisionKind: 'constraint',
            quote: 'under 80 dollars per seat',
            data: { kind: 'constraint' },
          },
        ],
      }),
    );
    expect(
      t.db.prepare('SELECT version, supersedes_id FROM decisions WHERE user_id = ?').all(b.userId),
    ).toEqual([{ version: 1, supersedes_id: null }]);
  });
});

describe('write-time enrichment: invalid enrichment rejects the whole completion', () => {
  const quote = (q: string, extra: Partial<Enrichment['decisions'][number]> = {}) => ({
    ...EMPTY,
    decisions: [
      { kind: 'preference' as const, quote: q, data: { kind: 'preference' as const }, ...extra },
    ],
  });
  const cases: Array<[string, unknown]> = [
    ['a decision quote that is not in the user message', quote('a sentence nobody wrote')],
    ['a decision quote with different case', quote('HUBSPOT IS MY SHORTLIST PICK')],
    ['an empty quote', quote('')],
    ['a tag that is only whitespace', { ...EMPTY, tags: ['   '] }],
    ['a tag with a control character', { ...EMPTY, tags: ['bad\u0000tag'] }],
    ['an over-long tag', { ...EMPTY, tags: ['x'.repeat(81)] }],
    ['too many tags', { ...EMPTY, tags: Array.from({ length: 51 }, (_, i) => `tag${i}`) }],
    ['a non-string tag', { ...EMPTY, tags: [42] }],
    ['an entity without a normalised name', { ...EMPTY, entities: [{ text: 'HubSpot' }] }],
    ['an unknown key on enrichment', { ...EMPTY, extra: true }],
    [
      'an unknown key on a decision',
      quote('stay under 50 dollars per seat', { extra: 1 } as never),
    ],
    [
      'a correction that does not say what it corrects',
      quote('stay under 50 dollars per seat', { kind: 'correction' }),
    ],
    [
      'a decision whose data.kind disagrees with kind',
      quote('stay under 50 dollars per seat', { kind: 'choice' }),
    ],
    [
      'a constraint with a non-finite value',
      {
        ...EMPTY,
        decisions: [
          {
            kind: 'constraint',
            quote: 'stay under 50 dollars per seat',
            data: { kind: 'constraint', constraint: { key: 'k', value: Infinity } },
          },
        ],
      },
    ],
    ['decisions that are not an array', { ...EMPTY, decisions: 'drop table' }],
  ];

  it.each(cases)('%s', (_name, enrichment) => {
    const t = openTestDb();
    const w = turn(t);
    // A valid tag-bearing completion shape, with the invalid enrichment swapped in: nothing may be written.
    const bad = completion(w, EMPTY, { enrichment: enrichment as Enrichment });
    expect(() => t.turns.complete(w.userId, w.turnId, bad)).toThrow(InvalidCompletionError);
    expect(written(t)).toEqual(NOTHING);
    expect(t.turns.get(w.userId, w.turnId)).toMatchObject({
      status: 'running',
      state: 'PERSISTING',
    });

    // and the turn is still completable with valid enrichment
    t.turns.complete(w.userId, w.turnId, completion(w, VALID));
    expect(written(t).search).toBe(2);
  });
});

describe('write-time enrichment: atomicity', () => {
  it('rolls back search rows, FTS rows and decisions when a later step of the completion fails', () => {
    const t = openTestDb();
    const w = turn(t);
    t.db.exec(
      `CREATE TEMP TRIGGER boom BEFORE UPDATE ON turns WHEN NEW.state = 'COMPLETED'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    expect(() => t.turns.complete(w.userId, w.turnId, completion(w, VALID))).toThrow(/boom/);
    expect(written(t)).toEqual(NOTHING);
    expect(count(t.db, 'message_fts_docsize')).toBe(0);

    t.db.exec('DROP TRIGGER temp.boom');
    t.turns.complete(w.userId, w.turnId, completion(w, VALID));
    expect(written(t)).toMatchObject({ search: 2, decisions: 2 });
  });

  it('rolls back everything when a decision quote fails after the search rows were written', () => {
    const t = openTestDb();
    const w = turn(t);
    const bad: Enrichment = {
      ...VALID,
      decisions: [...VALID.decisions, { ...VALID.decisions[0]!, quote: 'never said this' }],
    };
    expect(() => t.turns.complete(w.userId, w.turnId, completion(w, bad))).toThrow(
      InvalidCompletionError,
    );
    expect(written(t)).toEqual(NOTHING);
  });

  it('still rejects touchedBeliefKeys (belief recomputation is not supported yet)', () => {
    const t = openTestDb();
    const w = turn(t);
    expect(() =>
      t.turns.complete(
        w.userId,
        w.turnId,
        completion(w, VALID, { touchedBeliefKeys: ['price:v1|x'] }),
      ),
    ).toThrow(InvalidCompletionError);
    expect(written(t)).toEqual(NOTHING);
  });
});

import { describe, expect, it } from 'vitest';
import { ExampleHistory } from '../../../src/app/example-history.js';
import { SqliteMemoryRetriever } from '../../../src/app/memory-adapter.js';
import { openTestDb, T0 } from '../../helpers/db.js';

const DAY = 86_400_000;

function seeded(now = T0, tz = 'UTC') {
  const t = openTestDb('real');
  const userId = t.users.create('real');
  const result = new ExampleHistory(t.db).seed(userId, now, tz);
  return { t, userId, result };
}

describe('example history for reviewers', () => {
  it('writes three titled conversations on last Monday, last Tuesday and the most recent 3 November', () => {
    // T0 is Wednesday 11 November 2026, 10:00 UTC.
    const { t, userId, result } = seeded();
    expect(result.created).toBe(3);
    const rows = t.db
      .prepare('SELECT title, created_at FROM conversations WHERE user_id = ? ORDER BY created_at')
      .all(userId) as Array<{ title: string; created_at: number }>;
    expect(rows.map((r) => [r.title, new Date(r.created_at).toISOString()])).toEqual([
      ['Example: Neon pricing', '2026-11-03T11:00:00.000Z'],
      ['Example: CRM shortlist', '2026-11-09T09:00:00.000Z'],
      ['Example: Postgres hosting', '2026-11-10T10:00:00.000Z'],
    ]);
  });

  it('dates the days in the user time zone', () => {
    const { t, userId } = seeded(T0, 'America/Los_Angeles');
    const monday = t.db
      .prepare("SELECT created_at FROM conversations WHERE user_id = ? AND title LIKE '%CRM%'")
      .get(userId) as { created_at: number };
    // 09:00 in Los Angeles on Monday 9 November is 17:00 UTC.
    expect(new Date(monday.created_at).toISOString()).toBe('2026-11-09T17:00:00.000Z');
  });

  it('is found by recall and stores the shortlist with its five companies, as a real turn would', () => {
    const { t, userId } = seeded();
    const memory = new SqliteMemoryRetriever(t.db);
    const monday = {
      startMs: Date.UTC(2026, 10, 9),
      endMs: Date.UTC(2026, 10, 10),
      localDate: '2026-11-09',
      tz: 'UTC',
    };
    const hits = memory.messagesInIntervals(userId, [monday], ['crm']);
    expect(hits.map((h) => h.excerpt).join(' ')).toContain('Our shortlist is HubSpot');
    const shortlist = memory.decisions(userId, 'shortlist', null);
    expect(shortlist).toHaveLength(1);
    expect(shortlist[0]?.payload.entities).toEqual([
      'HubSpot',
      'Pipedrive',
      'Zoho CRM',
      'Salesforce',
      'Freshsales',
    ]);
    const linked = t.db.prepare('SELECT count(*) FROM decision_entities').pluck().get();
    expect(linked).toBe(5);
  });

  it('states no price or fact in the replies, and running it twice adds nothing', () => {
    const { t, userId } = seeded();
    const replies = t.db
      .prepare("SELECT content FROM messages WHERE user_id = ? AND role = 'assistant'")
      .pluck()
      .all(userId) as string[];
    expect(replies).toHaveLength(3);
    for (const r of replies) expect(r).not.toMatch(/\$|\d+ ?(per|\/)/);
    expect(new ExampleHistory(t.db).seed(userId, T0 + DAY, 'UTC').created).toBe(0);
    expect(t.db.prepare('SELECT count(*) FROM conversations').pluck().get()).toBe(3);
  });

  it('on 3 November itself uses 3 November of the year before', () => {
    const { t, userId } = seeded(Date.UTC(2026, 10, 3, 12));
    const nov3 = t.db
      .prepare("SELECT created_at FROM conversations WHERE user_id = ? AND title LIKE '%Neon%'")
      .get(userId) as { created_at: number };
    expect(new Date(nov3.created_at).toISOString().slice(0, 10)).toBe('2025-11-03');
  });
});

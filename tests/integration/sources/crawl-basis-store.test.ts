import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../../src/db/index.js';
import { normaliseExaResponse } from '../../../src/search/exa-adapter.js';
import type { CrawlBasis, SearchHit } from '../../../src/shared/search.js';
import { crawlBasisOfHit, SnapshotStore } from '../../../src/sources/snapshot-store.js';
import { FixedClock } from '../../../src/temporal/clock.js';
import { openTestDb, T0 } from '../../helpers/db.js';

const BASES: CrawlBasis[] = ['confirmed_live', 'requested_live', 'cached', 'unknown'];

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  url: 'https://acme.example/pricing',
  title: 'T',
  text: '## Plans\n\n| Plan | Price |\n|---|---|\n| Pro | $15 |\n',
  publishedAt: null,
  lastUpdatedAt: null,
  providerScore: null,
  freshFetch: false,
  crawlStatus: 'unknown',
  ...over,
});
const withBasis = (basis: CrawlBasis): SearchHit =>
  hit({
    crawlBasis: basis,
    freshFetch: basis === 'confirmed_live',
    crawlStatus: basis === 'confirmed_live' ? 'ok' : 'unknown',
    text: `## Plans ${basis}\n\n| Plan | Price |\n|---|---|\n| Pro | $15 |\n`,
  });

type TestDb = ReturnType<typeof openTestDb>;

function setup() {
  const t = openTestDb('real');
  return { t, store: new SnapshotStore(t.db), a: t.users.create(), b: t.users.create() };
}
const input = (userId: ReturnType<TestDb['users']['create']>, h: SearchHit) => ({
  userId,
  hit: h,
  contentMode: 'text' as const,
  provider: 'exa',
  observedAt: T0,
  origin: 'live' as const,
});

/** A row as a version-8 database wrote it (no crawl_basis column). */
const LEGACY_INSERT = `INSERT INTO source_snapshots (id, user_id, url, url_norm, domain, content_text, content_mode,
  content_sha256, provider, observed_at, fresh_fetch, crawl_status, origin)
  VALUES (?, ?, 'https://a.example/', 'a.example/', 'a.example', 'x', 'text', ?, 'p', 5, ?, 'ok', 'live')`;
const BASIS_INSERT = `INSERT INTO source_snapshots (id, user_id, url, url_norm, domain, content_text, content_mode,
  content_sha256, provider, observed_at, fresh_fetch, crawl_basis, crawl_status, origin)
  VALUES (?, ?, 'https://a.example/', 'a.example/', 'a.example', 'x', 'text', ?, 'p', 5, ?, ?, 'ok', 'live')`;

describe('snapshot crawl basis: store round trip (migration 009)', () => {
  it('round-trips each of the four states, with freshFetch equal to (basis === confirmed_live)', () => {
    const { store, a } = setup();
    for (const basis of BASES) {
      const id = store.insert(input(a, withBasis(basis)));
      const [s] = store.getMany(a, id ? [id] : []);
      expect(s?.crawlBasis, basis).toBe(basis);
      expect(s?.freshFetch, basis).toBe(basis === 'confirmed_live');
    }
  });

  it('a hit with no basis is derived from freshFetch', () => {
    expect(crawlBasisOfHit(hit({ freshFetch: true, crawlStatus: 'ok' }))).toBe('confirmed_live');
    expect(crawlBasisOfHit(hit())).toBe('unknown');
  });

  it('refuses a hit whose freshFetch contradicts its basis, and stores nothing', () => {
    const { t, store, a } = setup();
    for (const bad of [
      hit({ crawlBasis: 'requested_live', freshFetch: true }),
      hit({ crawlBasis: 'cached', freshFetch: true }),
      hit({ crawlBasis: 'confirmed_live', freshFetch: false }),
    ]) {
      expect(() => store.insert(input(a, bad))).toThrow(/contradicts/);
    }
    expect(t.db.prepare('SELECT count(*) AS n FROM source_snapshots').get()).toEqual({ n: 0 });
  });

  it('the database refuses a row that contradicts itself, and a basis outside the four values', () => {
    const { t, a } = setup();
    const insert = (freshFetch: number, basis: string, sha: string) =>
      t.db.prepare(BASIS_INSERT).run(`src_${sha}`, a, sha, freshFetch, basis);
    expect(() => insert(0, 'confirmed_live', 'a1')).toThrow(/contradicts fresh_fetch/);
    expect(() => insert(1, 'requested_live', 'a2')).toThrow(/contradicts fresh_fetch/);
    expect(() => insert(1, 'cached', 'a3')).toThrow(/contradicts fresh_fetch/);
    expect(() => insert(0, 'live', 'a4')).toThrow(/CHECK/);
    expect(() => insert(0, 'requested_live', 'a5')).not.toThrow();
    expect(() => insert(1, 'confirmed_live', 'a6')).not.toThrow();
  });

  it('snapshots stay immutable: the basis cannot be updated', () => {
    const { t, store, a } = setup();
    const id = store.insert(input(a, withBasis('requested_live')));
    expect(() =>
      t.db
        .prepare("UPDATE source_snapshots SET crawl_basis = 'confirmed_live' WHERE id = ?")
        .run(id),
    ).toThrow(/append-only/);
  });

  it('user scoping is unchanged: another user cannot read the snapshot or its basis', () => {
    const { store, a, b } = setup();
    const id = store.insert(input(a, withBasis('requested_live')));
    expect(store.getMany(b, id ? [id] : [])).toEqual([]);
    expect(store.getMany(a, id ? [id] : [])).toHaveLength(1);
  });

  it('the same page for two users keeps each basis separately', () => {
    const { store, a, b } = setup();
    const ia = store.insert(input(a, withBasis('cached')));
    const ib = store.insert(input(b, withBasis('requested_live')));
    expect(store.getMany(a, ia ? [ia] : [])[0]?.crawlBasis).toBe('cached');
    expect(store.getMany(b, ib ? [ib] : [])[0]?.crawlBasis).toBe('requested_live');
  });
});

describe('migration 009 on a populated version-8 database', () => {
  it('keeps existing rows valid and reads them back consistently', () => {
    const t = openTestDb('real', 8);
    const user = t.users.create();
    t.db.prepare(LEGACY_INSERT).run('src_legacy_fresh', user, 'sha-1', 1);
    t.db.prepare(LEGACY_INSERT).run('src_legacy_plain', user, 'sha-2', 0);
    const before = t.db.prepare('PRAGMA table_info(source_snapshots)').all() as Array<{
      name: string;
    }>;
    expect(before.some((c) => c.name === 'crawl_basis')).toBe(false);

    const result = initializeDatabase(t.db, { mode: 'real', clock: new FixedClock(T0) });
    expect(result).toMatchObject({ schemaVersion: 9, created: false });

    const raw = t.db
      .prepare('SELECT id, fresh_fetch, crawl_basis FROM source_snapshots ORDER BY id')
      .all();
    // The immutable rows were not rewritten: both carry the column default.
    expect(raw).toEqual([
      { id: 'src_legacy_fresh', fresh_fetch: 1, crawl_basis: 'unknown' },
      { id: 'src_legacy_plain', fresh_fetch: 0, crawl_basis: 'unknown' },
    ]);

    const store = new SnapshotStore(t.db);
    const [fresh, plain] = store.getMany(user, ['src_legacy_fresh', 'src_legacy_plain']);
    expect(fresh).toMatchObject({ freshFetch: true, crawlBasis: 'confirmed_live' });
    expect(plain).toMatchObject({ freshFetch: false, crawlBasis: 'unknown' });
    for (const s of [fresh, plain]) {
      expect(s?.freshFetch).toBe(s?.crawlBasis === 'confirmed_live');
    }
  });

  it('keeps the earlier triggers working after the upgrade', () => {
    const t = openTestDb('real', 8);
    initializeDatabase(t.db, { mode: 'real', clock: new FixedClock(T0) });
    const user = t.users.create();
    t.db.prepare(LEGACY_INSERT).run('src_after', user, 'sha-3', 0);
    expect(() =>
      t.db.prepare("UPDATE source_snapshots SET title = 'x' WHERE id = 'src_after'").run(),
    ).toThrow(/append-only/);
    expect(() =>
      t.db.prepare(LEGACY_INSERT).run('src_orphan', 'usr_missing', 'sha-4', 0),
    ).toThrow();
  });
});

describe('retrieval time stays separate from source time', () => {
  it('a stale-dated page retrieved now keeps observedAt = retrieval time, and no field blends them', () => {
    const { store, a } = setup();
    const STALE = Date.UTC(2020, 0, 1);
    const url = 'https://acme.example/pricing';
    const raw = JSON.stringify({
      results: [
        {
          id: url,
          url,
          title: 'Old page',
          publishedDate: new Date(STALE).toISOString(),
          text: '## Plans\n\n' + 'Pro costs $15 per user per month. '.repeat(40),
        },
      ],
    });
    const response = normaliseExaResponse(
      raw,
      { query: 'q', numResults: 1, freshness: 'live', contentMode: 'text', contentChars: 1500 },
      { provider: 'exa', observedAt: T0, latencyMs: 1 },
    );
    const h = response.hits[0];
    if (!h) throw new Error('no hit');
    expect(h.crawlBasis).toBe('requested_live');
    const id = store.insert({ ...input(a, h), observedAt: response.observedAt });
    const [s] = store.getMany(a, id ? [id] : []);
    expect(s).toMatchObject({
      observedAt: T0,
      providerPublishedAt: STALE,
      providerLastUpdatedAt: null,
      crawlBasis: 'requested_live',
      freshFetch: false,
    });
    expect(s?.observedAt).not.toBe(s?.providerPublishedAt);
  });
});

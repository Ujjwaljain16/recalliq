import { describe, expect, it } from 'vitest';
import type { SearchHit } from '../../../src/shared/search.js';
import { sha256Hex, SnapshotStore } from '../../../src/sources/snapshot-store.js';
import { count, openTestDb, T0 } from '../../helpers/db.js';

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  url: 'https://www.acme.example/pricing?utm_source=x&plan=pro',
  title: 'T',
  text: '## Plans\n\n| Plan | Price |\n|---|---|\n| Pro | €15 EUR |\n',
  publishedAt: 5,
  lastUpdatedAt: null,
  providerScore: null,
  freshFetch: false,
  crawlStatus: 'unknown',
  ...over,
});

function setup() {
  const t = openTestDb('real');
  return { t, store: new SnapshotStore(t.db), a: t.users.create(), b: t.users.create() };
}
const input = (
  userId: ReturnType<ReturnType<typeof openTestDb>['users']['create']>,
  h = hit(),
) => ({
  userId,
  hit: h,
  contentMode: 'text' as const,
  provider: 'exa',
  observedAt: T0,
  origin: 'live' as const,
});

describe('SnapshotStore', () => {
  it('stores identity, provenance and the exact text with its sha256', () => {
    const { store, a } = setup();
    const id = store.insert(input(a));
    const [s] = store.getMany(a, id ? [id] : []);
    expect(s).toMatchObject({
      urlNorm: 'https://acme.example/pricing?plan=pro',
      domain: 'acme.example',
      text: hit().text,
      sha256: sha256Hex(hit().text),
      providerPublishedAt: 5,
      providerLastUpdatedAt: null,
      observedAt: T0,
      freshFetch: false,
      crawlStatus: 'unknown',
      contentMode: 'text',
      provider: 'exa',
    });
  });

  it('is idempotent for the same user, page, content and observation time', () => {
    const { t, store, a } = setup();
    expect(store.insert(input(a))).toBe(store.insert(input(a)));
    expect(count(t.db, 'source_snapshots')).toBe(1);
  });

  it('different content or time makes a new snapshot; a different user gets its own', () => {
    const { t, store, a, b } = setup();
    store.insert(input(a));
    store.insert(input(a, hit({ text: 'changed' })));
    store.insert({ ...input(a), observedAt: T0 + 1 });
    store.insert(input(b));
    expect(count(t.db, 'source_snapshots')).toBe(4);
  });

  it('returns null for an unusable URL and writes nothing', () => {
    const { t, store, a } = setup();
    expect(store.insert(input(a, hit({ url: 'file:///etc/passwd' })))).toBeNull();
    expect(count(t.db, 'source_snapshots')).toBe(0);
  });

  it('getMany is user-scoped: another user never sees the snapshot', () => {
    const { store, a, b } = setup();
    const id = store.insert(input(a));
    expect(store.getMany(b, id ? [id] : [])).toEqual([]);
    expect(store.getMany(a, id ? [id] : [])).toHaveLength(1);
  });

  it('getMany keeps order, collapses duplicates, ignores unknown ids and handles many ids', () => {
    const { store, a } = setup();
    const ids = [1, 2, 3].map((n) => store.insert(input(a, hit({ text: `v${n}` }))));
    const [x, y, z] = ids;
    if (!x || !y || !z) throw new Error('setup');
    const out = store.getMany(a, [z, x, z, 'src_nope', y]);
    expect(out.map((s) => s.id)).toEqual([z, x, y]);
    const lots = Array.from({ length: 1200 }, (_, i) => `src_missing${i}` as const);
    expect(store.getMany(a, [...lots, x])).toHaveLength(1);
    expect(store.getMany(a, [])).toEqual([]);
  });

  it('keeps huge and exotic text intact', () => {
    const { store, a } = setup();
    const text = `${'€'.repeat(6000)}\u{1F600}\u0000end`;
    const id = store.insert(input(a, hit({ text })));
    expect(store.getMany(a, id ? [id] : [])[0]?.text).toBe(text);
  });

  it('a non-live origin is refused in a real database (propagates)', () => {
    const { store, a } = setup();
    expect(() => store.insert({ ...input(a), origin: 'synthetic' })).toThrow(
      /non-live snapshot in real db/,
    );
  });
});

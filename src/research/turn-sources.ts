import type { AuthorityTier, SourceSnapshot } from '../shared/evidence.js';
import type { FindingSet } from '../shared/findings.js';
import type { SnapshotId } from '../shared/ids.js';
import { termHits } from '../shared/terms.js';

/** At most this many sources of the turn that no finding cites are offered to the answer for quoting. */
export const MAX_EXTRA_SOURCES = 6;

/**
 * The sources an answer may cite. The finding sources come first and keep their order (and so their citation
 * numbers); a finding source obtained by this turn's searches gets its stored text as `content`. Then up to
 * `MAX_EXTRA_SOURCES` other sources of this turn's searches are added, with their content: non-empty text, one per
 * normalised URL, those whose title or text contains more of the query terms first (ties keep search order).
 *
 * A source of an earlier turn (a baseline citation) never gets content: a sourced sentence cannot rest on it.
 */
export function withTurnSources(
  sources: FindingSet['sources'],
  turn: ReadonlyMap<SnapshotId, SourceSnapshot>,
  terms: readonly string[],
  tierOf: (s: SourceSnapshot) => AuthorityTier,
): FindingSet['sources'] {
  const out: FindingSet['sources'] = {};
  const urls = new Set<string>();
  for (const [key, src] of Object.entries(sources)) {
    const id = key as SnapshotId;
    const snap = turn.get(id);
    out[id] = snap ? { ...src, content: contentOf(snap) } : src;
    urls.add(snap?.urlNorm ?? src.url);
  }
  const candidates = [...turn.values()]
    .map((snap, order) => ({
      snap,
      order,
      score: termHits(`${snap.title ?? ''}\n${snap.text}`, terms),
    }))
    .filter((c) => !Object.hasOwn(out, c.snap.id) && c.snap.text.trim().length > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  let added = 0;
  for (const { snap } of candidates) {
    if (added >= MAX_EXTRA_SOURCES) break;
    if (urls.has(snap.urlNorm)) continue;
    urls.add(snap.urlNorm);
    out[snap.id] = {
      url: snap.url,
      title: snap.title,
      domain: snap.domain,
      tier: tierOf(snap),
      observedAt: snap.observedAt,
      content: contentOf(snap),
    };
    added++;
  }
  return out;
}

function contentOf(snap: SourceSnapshot): {
  text: string;
  publishedAt: SourceSnapshot['providerPublishedAt'];
} {
  return { text: snap.text, publishedAt: snap.providerPublishedAt };
}

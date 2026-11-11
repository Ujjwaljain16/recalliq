import type { PlaceholderRef } from '../shared/answer.js';
import type { MessageId, SnapshotId } from '../shared/ids.js';

/** An opening `[[` is held for at most this many characters while waiting for its `]]` (contracts §3). */
export const MAX_PLACEHOLDER_CHARS = 64;

const FINDING = /^F([1-9][0-9]{0,2})(?::(baseline|verdict)|:derived:([0-9]{1,3}))?$/;
const MESSAGE = /^M:(msg_[A-Za-z0-9_-]{1,60})$/;
const SOURCE = /^S:(src_[A-Za-z0-9_-]{1,60})$/;

/**
 * Parses the text between `[[` and `]]`. Null when it does not match the grammar. (Contracts §3 writes
 * INT := [1-9][0-9]{0,2} for finding ords; the derived index is 0-based in its own example `F3:derived:0`, so
 * it accepts 0.)
 */
export function parsePlaceholderBody(body: string): PlaceholderRef | null {
  const f = FINDING.exec(body);
  if (f) {
    const ord = Number(f[1]);
    if (f[3] !== undefined) return { kind: 'finding_derived', ord, index: Number(f[3]) };
    return {
      kind: 'finding',
      ord,
      variant: f[2] === 'baseline' ? 'baseline' : f[2] === 'verdict' ? 'verdict' : 'current',
    };
  }
  const m = MESSAGE.exec(body);
  if (m?.[1]) return { kind: 'message', messageId: m[1] as MessageId };
  const s = SOURCE.exec(body);
  if (s?.[1]) return { kind: 'source', snapshotId: s[1] as SnapshotId };
  return null;
}

/** The token as it is stored in a template: `[[F3:baseline]]`. */
export function tokenOf(ref: PlaceholderRef): string {
  switch (ref.kind) {
    case 'finding':
      return `[[F${ref.ord}${ref.variant === 'current' ? '' : `:${ref.variant}`}]]`;
    case 'finding_derived':
      return `[[F${ref.ord}:derived:${ref.index}]]`;
    case 'message':
      return `[[M:${ref.messageId}]]`;
    case 'source':
      return `[[S:${ref.snapshotId}]]`;
  }
}

export type StreamItem =
  | { type: 'text'; text: string }
  | { type: 'placeholder'; token: string; ref: PlaceholderRef }
  /** Dropped from the output; the sentence is flagged `malformed_placeholder`. */
  | { type: 'malformed'; raw: string };

/**
 * Splits a stream of text deltas into text, valid placeholders and malformed fragments, however the deltas are
 * cut. An opening `[[` is held until its `]]` arrives, for at most 64 characters counted from the first `[`.
 * A lone trailing `[` is held too, because the next delta may complete `[[`. The result for a given text is
 * the same for every way of chunking it.
 */
export class PlaceholderParser {
  private held = '';

  push(delta: string): StreamItem[] {
    let s = this.held + delta;
    this.held = '';
    const out: StreamItem[] = [];
    const text = (t: string): void => {
      if (t !== '') out.push({ type: 'text', text: t });
    };
    for (;;) {
      const open = s.indexOf('[[');
      if (open === -1) {
        if (s.endsWith('[')) {
          text(s.slice(0, -1));
          this.held = '[';
        } else text(s);
        return out;
      }
      text(s.slice(0, open));
      s = s.slice(open);
      const close = s.indexOf(']]', 2);
      if (close !== -1 && close + 2 <= MAX_PLACEHOLDER_CHARS) {
        const body = s.slice(2, close);
        const ref = parsePlaceholderBody(body);
        out.push(
          ref
            ? { type: 'placeholder', token: tokenOf(ref), ref }
            : { type: 'malformed', raw: s.slice(0, close + 2) },
        );
        s = s.slice(close + 2);
        continue;
      }
      if (s.length >= MAX_PLACEHOLDER_CHARS) {
        // No closing `]]` within the limit: give up on this fragment and drop it.
        out.push({ type: 'malformed', raw: s.slice(0, MAX_PLACEHOLDER_CHARS) });
        s = s.slice(MAX_PLACEHOLDER_CHARS);
        continue;
      }
      this.held = s; // still within the limit: wait for more
      return out;
    }
  }

  /** End of stream: an unfinished fragment is dropped and flagged; a lone `[` was ordinary text. */
  flush(): StreamItem[] {
    const h = this.held;
    this.held = '';
    if (h === '') return [];
    return h === '[' ? [{ type: 'text', text: '[' }] : [{ type: 'malformed', raw: h }];
  }

  /** What is currently held back (for tests and for the truncated-sentence bookkeeping). */
  get pending(): string {
    return this.held;
  }
}

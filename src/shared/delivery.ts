/** POST /api/turns/:turnId/ack. The unit of acknowledgement is the sentence. */
export interface AckRequest {
  renderedThrough: number;
  complete: boolean;
}

export type DeliveryState = 'presented' | 'streamed_unacknowledged' | 'not_streamed';

/**
 * Where a sentence stands, derived from two distinct extents of its message:
 *
 * - `streamedThrough`: highest sentence index the server fully wrote to the stream (null: nothing was streamed,
 *   as for a user message);
 * - `renderedThrough`: highest sentence index the browser acknowledged as rendered (-1: none).
 *
 * Presented requires an acknowledgement. A streamed sentence nobody acknowledged is *not* presented, and
 * never becomes a baseline. The database refuses an extent pair where rendered exceeds streamed, and this
 * function throws on one rather than guessing.
 */
export function deliveryState(
  sentenceIndex: number,
  msg: { renderedThrough: number; streamedThrough: number | null },
): DeliveryState {
  if (!Number.isInteger(sentenceIndex) || sentenceIndex < 0) {
    throw new RangeError(`sentenceIndex must be a non-negative integer, got ${sentenceIndex}`);
  }
  const streamed = msg.streamedThrough ?? -1;
  if (msg.renderedThrough > streamed) {
    throw new RangeError(
      `renderedThrough (${msg.renderedThrough}) exceeds streamedThrough (${streamed}): impossible delivery state`,
    );
  }
  if (sentenceIndex <= msg.renderedThrough) return 'presented';
  if (sentenceIndex <= streamed) return 'streamed_unacknowledged';
  return 'not_streamed';
}

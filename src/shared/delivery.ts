// `deliveryState(sentenceIndex, { renderedThrough, streamedThrough })` is part of the contract and
// is implemented with the acknowledgement handler in the conversation-lifecycle milestone.

/** POST /api/turns/:turnId/ack. The unit of acknowledgement is the sentence. */
export interface AckRequest {
  renderedThrough: number;
  complete: boolean;
}

export type DeliveryState = 'presented' | 'streamed_unacknowledged' | 'not_streamed';

import { randomUUID } from 'node:crypto';

/** Epoch milliseconds, UTC. Every instant in the system has this representation. */
export type Ms = number;
export type IanaTz = string;

export type Id<P extends string> = `${P}_${string}`;
export type UserId = Id<'usr'>;
export type ConversationId = Id<'cnv'>;
export type MessageId = Id<'msg'>;
export type TurnId = Id<'trn'>;
export type EntityId = Id<'ent'>;
export type SnapshotId = Id<'src'>;
export type EvidenceId = Id<'ev'>;
export type FindingId = Id<'fnd'>;
export type AssertionId = Id<'asr'>;
export type DecisionId = Id<'dec'>;

export type Origin = 'live' | 'recorded' | 'synthetic';

export function newId<P extends string>(prefix: P): Id<P> {
  return `${prefix}_${randomUUID()}`;
}

export function isId<P extends string>(prefix: P, value: string): value is Id<P> {
  return value.startsWith(`${prefix}_`) && value.length > prefix.length + 1;
}

/** Narrows a string read from storage or the network to a branded id, or throws. */
export function parseId<P extends string>(prefix: P, value: string): Id<P> {
  if (!isId(prefix, value)) throw new TypeError(`Expected an id with prefix "${prefix}_"`);
  return value;
}

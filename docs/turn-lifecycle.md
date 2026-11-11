# Turn lifecycle, delivery and migrations (Milestone 2)

What the persistence layer guarantees about turns, acknowledgements and assertions, and where each guarantee is
enforced. The normative contracts ([stage-3-contracts.md](stage-3-contracts.md)) were **not** modified; the
migrations below add to them.

## Migrations

| # | File | Protects | Resolves |
|---|---|---|---|
| 001 | `001_init.sql` | The contract schema, unchanged except that the two PRAGMAs are connection settings | (Q-003) |
| 002 | `002_demo_isolation.sql` | A real database rejects non-live data: messages, entities and decisions on insert, relabelling of users, conversations, entities and decisions, and `db_mode` itself (immutable) | Q-002 |
| 003 | `003_ownership_consistency.sql` | Evidence, findings and assertions only reference rows owned by the same user as their turn; links cannot be edited | Q-007 (evidence, findings, assertions) |
| 004 | `004_turn_lifecycle.sql` | The turn state machine, finality of finished turns, immutable turn identity, state/status coupling | Q-006 (with the contract's `turns_one_running` index) |
| 005 | `005_delivery_acknowledgement.sql` | Streamed vs rendered extents, "presented only if acknowledged", the rules for `presented` / `not_presented` / verdict events | Delivery boundary (architecture R4) |

Migration 002 went slightly beyond the three tables Q-002 named (relabelling and `db_mode` immutability); that
was the validated proposal in [proposals/q-002-demo-isolation.md](proposals/q-002-demo-isolation.md), and it is
reported as such. Migration 003 does not cover `search_requests`, `decisions`, `beliefs` or snapshot-to-turn links:
Q-007 stays partly open.

## State machine

19 edges. The table is in `src/shared/turn-state-machine.ts` and again in migration 004's trigger; a test probes
all 182 ordered pairs against the database and compares with the TypeScript table.

| From | To |
|---|---|
| RECEIVED | ANALYZING |
| ANALYZING | RESOLVING_CONTEXT, PERSISTING (LLM outage) |
| RESOLVING_CONTEXT | CLARIFYING, SYNTHESIZING (chat, recall), PLANNING (research, audit) |
| CLARIFYING | PERSISTING |
| PLANNING | SEARCHING |
| SEARCHING | EXTRACTING, RESOLVING_BELIEFS (no snapshots) |
| EXTRACTING | VERIFYING |
| VERIFYING | SEARCHING (fallback round), RESOLVING_BELIEFS |
| RESOLVING_BELIEFS | SYNTHESIZING |
| SYNTHESIZING | POST_VERIFYING, PERSISTING (stream failure, deadline) |
| POST_VERIFYING | PERSISTING |
| PERSISTING | COMPLETED, FAILED |
| COMPLETED, FAILED | nothing (final) |

`state` is where the pipeline is; `status` is the outcome (`running`, `complete`, `partial`, `clarify`,
`interrupted`, `failed`).

- `setState` moves a running turn along an edge. It refuses a final target: **COMPLETED** is set by `complete()`
  (persistence succeeded, whatever the outcome, including status `failed`); **FAILED** is set by `fail()` (the
  persistence itself failed).
- A running turn can never be in a final state, and a finished turn always has `finished_at`.
- A finished turn is final: its status, state and result columns cannot change.
- A turn recovered after a crash keeps the state it had reached and gets status `interrupted`.

## Repository operations

| Operation | Behaviour |
|---|---|
| `begin` | One `BEGIN IMMEDIATE` transaction. Same idempotency key for the same user returns `{ existing, status }`; the same key with different text or conversation throws `IdempotencyConflictError`. Otherwise a running turn in RECEIVED is created with its user message, unless the conversation already has a running turn (`TurnInProgressError`). `retryOfTurnId` must name a turn of the same user and conversation |
| `setState` | Validates the edge, then updates only if the state still matches (`InvalidTransitionError` otherwise) |
| `complete` | Needs a running turn in PERSISTING. In one transaction: assistant message, findings, assertions (unpresented), evidence links, `not_presented` events for never-streamed claims, verdict events on earlier presented claims, final turn row |
| `fail` | PERSISTING to FAILED |
| `ack` | See below |
| `recoverRunning` | Every running turn becomes `interrupted` (error code `recovered_after_restart`), state unchanged. Creates no message, acknowledgement, presented claim or baseline |
| `deleteConversation` | The privacy-deletion procedure (contracts §1.1) with an injected belief rebuilder |

## Acknowledgement semantics

A message has two extents, and they are never the same thing.

| Extent | Meaning | Written by |
|---|---|---|
| `streamed_through` | Highest sentence index the server wrote to the stream. Fixed when the answer is stored (`-1`: none) | `complete()` |
| `rendered_through` | Highest sentence index the browser acknowledged as rendered. Starts at `-1` | `ack()` |

An assertion's delivery state is derived from the two (`deliveryState`):

| Sentence index | State | Meaning |
|---|---|---|
| ≤ `rendered_through` | `presented` | The user's browser rendered it. Eligible to be a baseline |
| ≤ `streamed_through`, beyond rendered | `streamed_unacknowledged` | Sent, never confirmed. **Not** told, never a baseline |
| beyond `streamed_through` | `not_streamed` | Never sent. Born with a `not_presented` event |

`ack(user, turn, { renderedThrough, complete }, now)`:

- **Monotonic and idempotent.** The extent only moves forward. A repeated, lower or out-of-order acknowledgement
  changes nothing, writes nothing (not even `last_ack_at`), and reports the stored extent.
- **Cannot exceed the streamed extent.** `renderedThrough > streamed_through` throws `InvalidAckError`; it is never
  clamped, because it cannot be true. The database refuses it too.
- **`complete: true`** claims the browser rendered everything that was streamed, so it must equal `streamed_through`
  exactly, otherwise `InvalidAckError`.
- **Presents exactly the newly covered claims**, each with one `presented` event (a partial unique index makes a
  second impossible).
- **Needs a stored answer.** A turn that is still running, or was recovered before it persisted, has nothing to
  acknowledge: `TurnNotFinishedError`.

Examples, from the tests. An answer has 7 sentences with the price claimed in sentences 0, 2, 4 and 6, all streamed:

| Call | Result | Presented claims afterwards |
|---|---|---|
| `ack(6, complete)` | `{ rendered: 6, newlyPresented: 4 }` | 0, 2, 4, 6 |
| `ack(3)` | `{ rendered: 3, newlyPresented: 2 }` | 0, 2; claims 4 and 6 stay `streamed_unacknowledged` |
| `ack(3)` again | `{ rendered: 3, newlyPresented: 0 }`, nothing written | 0, 2 |
| `ack(5)` then `ack(2)` | second returns `{ rendered: 5, newlyPresented: 0 }` | 0, 2, 4 |
| `ack(1)`, an hour later `ack(6, complete)` | the later call presents 2, 4, 6 and leaves claim 0's `presented_at` as it was | all four, each with one event |

An interrupted answer streamed through sentence 2 of 5, with claims in 1, 3 and 4: `ack(1)` presents claim 1;
`ack(2, complete)` is accepted; `ack(3)` and `ack(4, complete)` throw `InvalidAckError`; claims 3 and 4 keep their
`not_presented` event and are never presented.

## What the database refuses on its own (migration 005)

- `presented_at` set for a sentence beyond `rendered_through`;
- `rendered_through` beyond `streamed_through`, or above `-1` on a user message;
- an assertion created already presented, on a user message, on another turn's message, or for a sentence that does not exist;
- a `presented` event without `presented_at`; a `not_presented` event for a sentence that was streamed or presented;
- a verdict event (`reaffirmed`, `superseded_world_changed`, …) on a claim that was never presented;
- a message stored already rendered, or with a streamed extent outside its sentences.

## Known limitations

See [questions.md](questions.md) Q-011 to Q-018. The ones that matter most: an acknowledgement sent before the
answer is stored is rejected (the browser must re-acknowledge after rendering the stored answer); `recoverRunning`
assumes one application process per database file; enrichment and belief recomputation in `complete()` are rejected
until milestones 3 and 4.

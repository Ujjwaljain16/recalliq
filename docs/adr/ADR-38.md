# ADR-38: Which assertions may become historical baselines

- **Status:** Proposed
- **Implementation:** partly implemented
- **Decided:** Direction given by the owner (review, 2026-11-11); details still open (Q-015)
- **Recorded:** 2026-11-11
- **Related:** [ADR-23](ADR-23.md), [ADR-32](ADR-32.md), [Q-015](../questions.md)

## Context

The system must remember what it said without treating everything it said as verified truth.

## Options considered

- Any stored assertion.
- Presented assertions only.
- Presented assertions from verified sentences, using the current-value placeholder only.

## Decision

Direction: presented only, never streamed-but-unacknowledged; an unverified sentence is not a factual baseline merely because it was rendered; a baseline retains the original evidence references and verification status. To be finalised at the start of milestone 3: whether `F<n>:baseline` and `F<n>:verdict` assertions can themselves be baselines, and what sentence statuses qualify.

## Consequences and trade-offs

- The baseline loader (milestone 3) must apply these rules; the database cannot decide eligibility on its own.

## Evidence and implementation references

- Already enforced: a verdict event or a finding's baseline may only target an assertion that was presented to the same user in an earlier turn (T-ASR-05 in [tests/integration/db/turn-completion.test.ts](../../tests/integration/db/turn-completion.test.ts)); delivery state is derived (ADR-31). The baseline loader does not exist.

## Revisit when

- Finalise before the baseline loader is written.

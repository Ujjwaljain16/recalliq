# ADR-36: Stricter proof for a post-baseline change

- **Status:** Accepted
- **Implementation:** not implemented
- **Decided:** Owner decision, 2026-11-11 (Q-001), and the effective-date distinction, 2026-11-12. Proposed answers to the other Q-001 sub-questions (what an observation is, source identity, comparable context) are defaults, not yet confirmed by the owner
- **Recorded:** 2026-11-11, updated 2026-11-12
- **Related:** [ADR-22](ADR-22.md), [ADR-37](ADR-37.md), [Q-001](../questions.md)

## Context

A different current value does not prove it changed after the earlier answer. The earlier design allowed an observation up to 48 hours before the answer to count, or a stated effective date.

## Options considered

- The earlier same-source bracketing with a 48 hour tolerance, or a stated effective date.
- The stricter rule below.

## Decision

`changed` needs one of two proofs.

1. **Re-observation bracketing.** All of: an observation of the old value later than the previous answer was presented; a later observation of the new value; matching source identity; comparable locale, plan, billing arrangement and pricing context. The 48 hour window is removed.
2. **Explicit effective date.** An effective date that is explicitly associated with the new price, comes from a reliable source (tier A1 or A2) and is later than the previous answer establishes timing. A publication date or a fetch date alone never does; a fresh fetch never sets an effective date.

If neither can be established, the verdict is `differs_timing_unknown`.

## Consequences and trade-offs

- The baseline's own observation precedes its presentation, so the first audit that sees a different price will usually be `differs_timing_unknown` unless an explicit effective date is stated. `changed` by bracketing needs a re-observation of the old value after the answer, so the demo recordings must include one.
- Architecture §8, scenarios 2 and 3, the scenario matrix and open items U12 and U19 were corrected on 2026-11-12; the old text is kept there as history. The contract's reason values (`same_source_bracketing`, `stated_effective_date`) still fit and are unchanged.

## Evidence and implementation references

- A recorded owner decision only. Nothing is implemented or tested; the change detector is milestone 4.

## Revisit when

- The change detector is written, and when the owner confirms the proposed answers to the Q-001 sub-questions.

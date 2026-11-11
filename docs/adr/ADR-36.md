# ADR-36: Stricter proof for a post-baseline change

- **Status:** Accepted
- **Implementation:** not implemented
- **Decided:** Owner decision, 2026-11-11 (Q-001); sub-questions still open
- **Recorded:** 2026-11-11
- **Related:** [ADR-22](ADR-22.md), [ADR-37](ADR-37.md), [Q-001](../questions.md)

## Context

A different current value does not prove it changed after the earlier answer. The earlier design allowed an observation up to 48 hours before the answer to count.

## Options considered

- The earlier same-source bracketing with a 48 hour tolerance, or a stated effective date.
- The stricter rule below.

## Decision

All of: (1) an observation of the old value later than the previous answer was presented; (2) a later observation of the new value; (3) matching source identity; (4) comparable locale, plan, billing arrangement and pricing context. If these cannot be established, the verdict is `differs_timing_unknown`. The 48 hour window is removed.

## Consequences and trade-offs

- The baseline's own observation precedes its presentation, so the first audit that sees a different price will usually be `differs_timing_unknown`. `changed` needs a re-observation of the old value after the answer, so the demo recordings must include one.
- Architecture §8, scenarios 2 and 3 and open item U19 describe the older rule and are now inconsistent with this decision (documented in Q-001; the architecture file is not edited).

## Evidence and implementation references

- A recorded owner decision only. Nothing is implemented or tested; the change detector is blocked until the sub-questions are settled.

## Revisit when

- Open sub-questions in Q-001: what an observation is, what source identity means, what comparable means, and whether a stated effective date still counts.

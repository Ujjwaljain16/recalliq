# ADR-07: Temporal resolution in code; ask when several candidates remain

- **Status:** Accepted
- **Implementation:** not implemented
- **Decided:** Owner confirmed U3, 2026-11-11
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture §20 register and the Stage 3 / 3.1 design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-05](ADR-05.md), [ADR-22](ADR-22.md), [ADR-36](ADR-36.md)

## Context

"Last Tuesday" is ambiguous (two candidate days when today is Wednesday); "3 November" depends on the user's timezone and daylight saving.

## Options considered

- Let the LLM compute dates.
- Rules only, picking a fixed meaning.
- Structured expression from the model, interval arithmetic and disambiguation in code.

## Decision

The third. Intervals are half-open UTC ranges for local calendar days (Luxon). `last <weekday>` yields two candidates and stored data decides; if both match, ask. Never pick arbitrarily.

## Consequences and trade-offs

- More deterministic code to test (weekday, modifier, timezone, DST, year boundary).

## Evidence and implementation references

- Types only: [src/shared/temporal.ts](../../src/shared/temporal.ts), [src/shared/understanding.ts](../../src/shared/understanding.ts). Nothing is implemented or tested yet (milestone 3).

## Revisit when

- Real conversations show the two-candidate rule asks too often.

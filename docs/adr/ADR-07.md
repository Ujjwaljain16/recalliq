# ADR-07: Temporal resolution in code; ask when several candidates remain

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner confirmed U3, 2026-11-11
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
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

- Resolver: [src/temporal/resolver.ts](../../src/temporal/resolver.ts), tested by [tests/unit/temporal.test.ts](../../tests/unit/temporal.test.ts) (T-TEMP-01..12: every weekday and modifier, DST, skipped midnights and days, year boundary). Ask-when-several: [src/memory/recall.ts](../../src/memory/recall.ts), tested by [tests/integration/db/recall.test.ts](../../tests/integration/db/recall.test.ts).
- Implemented with `Intl` instead of Luxon, to avoid a dependency; the interface is unchanged. Interpretations the contract left open (a bare weekday on the same weekday is ambiguous; `this <weekday>` in the future is ambiguous; `last_week` is the previous Monday to Sunday) are written in the header of the resolver and tested.
- The resolver is wired into the application in [src/app/application.ts](../../src/app/application.ts) and used by the lanes and by recall.

## Revisit when

- Real conversations show the two-candidate rule asks too often.

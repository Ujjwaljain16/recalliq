# ADR-03: Modular monolith; no queues, workers or services

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner approval, 2026-11-11 (Stage 3)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture §20 register and the Stage 3 / 3.1 design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-01](ADR-01.md), [ADR-04](ADR-04.md)

## Context

The workload is one user or a handful, a few turns a minute. Separate services would add serialisation, partial-failure modes and deployment steps without solving a problem the system has.

## Options considered

- Microservices.
- A queue with worker processes.
- A single process (modular monolith).

## Decision

Single process. Every component boundary is a module interface, not a network boundary.

## Consequences and trade-offs

- No independent scaling. Concurrency inside the process is bounded by design (ADR-24, ADR-09).

## Evidence and implementation references

- [package.json](../../package.json) has no server, queue or service dependency; [src](../../src) is one codebase. No HTTP server exists yet, so the single-process property is a property of the code layout, not of a running system, and no test covers it.

## Revisit when

- More than one process needs to write to the database, or research workers must scale independently. That would also mean leaving SQLite (ADR-04).

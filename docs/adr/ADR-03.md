# ADR-03: Modular monolith; no queues, workers or services

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
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

- [package.json](../../package.json) has two runtime dependencies, `better-sqlite3` and `zod`: no queue, worker or service library. [src/main.ts](../../src/main.ts) starts one process that holds the HTTP server ([src/server/](../../src/server)), the orchestrator and SQLite; module boundaries are the interfaces in [src/shared/](../../src/shared).
- The end-to-end tests run the whole server in one process, for example [tests/integration/server/journey.test.ts](../../tests/integration/server/journey.test.ts). No test asserts the dependency list itself.
- The single-process assumption for a database file is not enforced: see ADR-34.

## Revisit when

- More than one process needs to write to the database, or research workers must scale independently. That would also mean leaving SQLite (ADR-04).

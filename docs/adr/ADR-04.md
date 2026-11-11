# ADR-04: SQLite via better-sqlite3 (pinned), WAL, FTS5

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner confirmed "SQLite + FTS5 for v1", 2026-11-11
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture §20 register and the Stage 3 / 3.1 design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-05](ADR-05.md), [ADR-25](ADR-25.md), [ADR-26](ADR-26.md)

## Context

Evaluators run `npm install` and the app with no other service. Queries are mostly exact time ranges, user-scoped lookups and keyword search over a small corpus.

## Options considered

- PostgreSQL in Docker.
- PGlite (embedded WebAssembly Postgres).
- `node:sqlite`.
- `@libsql/client`.
- sql.js.

## Decision

SQLite through better-sqlite3, pinned to exactly 13.0.3 (the Stage 2 review found 13.1.0 broken on Windows ARM). Migrations are explicit SQL files.

## Consequences and trade-offs

- A single writer; fine for this workload.
- A native module: install can fail on an unusual platform.
- A schema portable to Postgres if ever needed (integer milliseconds, JSON as text).

## Evidence and implementation references

- [research-notes.md](../research-notes.md) §6: a review of official documentation and package pages. It is a documentation review, not a benchmark.
- Pin in [package.json](../../package.json); connection setup in [src/db/connection.ts](../../src/db/connection.ts); migration runner [src/db/migrate.ts](../../src/db/migrate.ts).
- Installed and run on one machine only (Windows 11, Node 22.19). Behaviour on other platforms is **not verified**. FTS5 behaviour is tested in [tests/integration/db/invariants.test.ts](../../tests/integration/db/invariants.test.ts).

## Revisit when

- The install fails on an evaluator platform (fallback: `node:sqlite`).
- The system needs more than one writer, or multiple users on one deployment (PostgreSQL).

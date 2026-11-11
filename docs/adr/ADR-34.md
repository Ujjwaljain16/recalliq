# ADR-34: Single-instance guard for a database file

- **Status:** Proposed
- **Implementation:** not implemented
- **Decided:** Pending. Owner requirement: startup must prevent accidental concurrent instances (review, 2026-11-11)
- **Recorded:** 2026-11-11
- **Related:** [ADR-33](ADR-33.md), [Q-016](../questions.md)

## Context

`recoverRunning` would interrupt a live process's turns if a second instance started. SQLite transactions serialise writes but do not establish one application instance.

## Options considered

- An exclusive lock file or advisory lock taken at startup.
- A lease or heartbeat row, so a stale holder can be recognised.
- SQLite locking modes (to be evaluated, not assumed to suffice).
- Documentation only (does not meet the requirement).

## Decision

None yet. The requirement is decided; the mechanism is not.

## Consequences and trade-offs

- Until implemented, the single-process assumption is a documented limitation, not a guarantee.

## Evidence and implementation references

- Nothing implemented. The option list has not been evaluated.

## Revisit when

- Before the server starts accepting requests (milestone 5).

# ADR-12: Code renders facts into answers through placeholders

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner approval, 2026-11-11 (Stage 3)
- **Recorded:** 2026-11-11
- **Related:** [ADR-11](ADR-11.md), [ADR-16](ADR-16.md), [ADR-32](ADR-32.md)

## Context

A model that never types a price cannot misstate one.

## Options considered

- The model writes numbers and citations.
- Placeholders rendered by code.

## Decision

Placeholders (`[[F3]]`, `[[F3:baseline]]`, `[[F3:verdict]]`, `[[F3:derived:0]]`, `[[M:…]]`, `[[S:…]]`).

## Consequences and trade-offs

- Prose is constrained.

## Evidence and implementation references

- Persistence side implemented: a completion's assertion must match a rendered placeholder of its sentence ([src/db/repositories/turn-completion.ts](../../src/db/repositories/turn-completion.ts), tests T-ASR-03 in [tests/integration/db/turn-completion.test.ts](../../tests/integration/db/turn-completion.test.ts)).
- Not implemented: the placeholder parser and renderer, the render-integrity check and the free-text checker (milestone 5).

## Revisit when

- Answer quality suffers materially under the constraint.

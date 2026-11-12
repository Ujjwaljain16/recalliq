# ADR-19: Evaluation data classes: recorded, synthetic, live

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-18](ADR-18.md), [ADR-28](ADR-28.md)

## Context

Seeded data must not contaminate real history, and synthetic data must never read as real-world accuracy.

## Options considered

- Mixed fixtures.
- Three labelled classes.

## Decision

Three classes, each row tagged by `origin`, demo data in a separate database.

## Consequences and trade-offs

- Recorded scenarios must be captured on real dates; nothing may be backdated.

## Evidence and implementation references

- `origin` columns and the real-database isolation triggers exist (ADR-28).
- Recorded: the extraction calibration set holds captured real pages with gold labels ([tests/fixtures/calibration/](../../tests/fixtures/calibration)), and a recording adapter exists ([src/search/recording.ts](../../src/search/recording.ts)). Synthetic: fixtures are labelled `[SYNTHETIC]` ([tests/fixtures/search/](../../tests/fixtures/search)). Live: gated smoke tests ([tests/integration/e2e/live-smoke.test.ts](../../tests/integration/e2e/live-smoke.test.ts)).
- The extraction evaluation runner ([src/evidence/eval/](../../src/evidence/eval), [scripts/extraction-eval.ts](../../scripts/extraction-eval.ts)) covers one stage only. There is no single runner that grades whole turns across the three classes.

## Revisit when

- Not planned.

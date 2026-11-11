# Development history

These documents record how RecallIQ was designed and planned. They are **historical development and planning records**, kept for the decisions and reasoning they contain. They are **not** current specifications: the code, `docs/architecture.md`, `docs/contracts.md`, the decision records in `docs/adr/` and `docs/testing.md` are authoritative, and where they disagree with these files, they win.

| Document | What it is |
|---|---|
| [research-notes.md](research-notes.md) | The research on search providers, models and storage that informed the early decisions. A documentation review, not a benchmark. |
| [design-review.md](design-review.md) | The first reconciliation of the architecture and contracts: what was inconsistent and how it was settled. |
| [implementation-brief.md](implementation-brief.md) | The original instructions for building the system, written before any code existed. |
| [design-doc-blueprint.md](design-doc-blueprint.md) | The plan for the final design document: what it must claim, which evidence backs each claim, and the documentation checks. |
| [parallel-execution-plan.md](parallel-execution-plan.md) | How the evidence, memory and orchestration work was divided between engineers, with the shared interface freeze and file ownership. |

They use the project's planning vocabulary (stages, milestones, phases, workers). That wording is left as it was written.

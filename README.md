# RecallIQ

A conversational research agent that answers questions with web search and can audit its own earlier
answers against current evidence. Design: [docs/stage-3-architecture.md](docs/stage-3-architecture.md),
contracts: [docs/stage-3-contracts.md](docs/stage-3-contracts.md).

**Status: Milestone 1 (foundation).** There is no server, search or LLM code yet; see
[docs/questions.md](docs/questions.md) for open decisions.

## Requirements

- Node.js 22 or newer
- No other services. Storage is a local SQLite file.

## Commands

```bash
npm install
cp .env.example .env     # optional: Milestone 1 needs no secrets

npm run check            # typecheck, lint, format check, tests
npm test                 # tests only (offline, no network)
npm run db:migrate       # create or open the database for APP_MODE (data/app.db or data/demo.db)
```

`APP_MODE=demo` uses a separate database file, and a database refuses to be opened in the other mode.
A `real` database also rejects fixture users, non-live conversations and non-live snapshots on insert,
**but demo isolation is incomplete**: messages, entities and decisions are not guarded, and the checks
can be bypassed by updates. See [docs/questions.md](docs/questions.md) (Q-002) and
[docs/proposals/q-002-demo-isolation.md](docs/proposals/q-002-demo-isolation.md).

Test documentation: [docs/testing.md](docs/testing.md).

# RecallIQ

A conversational research agent that answers questions with web search and can audit its own earlier
answers against current evidence. Design: [docs/stage-3-architecture.md](docs/stage-3-architecture.md),
contracts: [docs/stage-3-contracts.md](docs/stage-3-contracts.md).

**Status: Milestone 2 (conversation lifecycle).** The persistence layer is in place: turn lifecycle, sentence-level
delivery acknowledgement, assertion persistence and recovery, all enforced by the database. There is no server, search or LLM
code yet; see [docs/questions.md](docs/questions.md) for open decisions.

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

`APP_MODE=demo` uses a separate database file, and a database refuses to be opened in the other mode. A `real` database also
rejects non-live data (fixture users, recorded or synthetic conversations, messages, entities, decisions, snapshots) and any
attempt to relabel it or change `db_mode`. That is not _complete_ isolation: see [docs/proposals/q-002-demo-isolation.md](docs/proposals/q-002-demo-isolation.md).

- Architecture decision records (39, with status and implementation for each): [docs/adr/README.md](docs/adr/README.md)
- Database schema as an ER diagram: [docs/diagrams/er.mmd](docs/diagrams/er.mmd)
- Turn lifecycle, acknowledgement semantics and migrations: [docs/turn-lifecycle.md](docs/turn-lifecycle.md)
- Test documentation and test-ID mapping: [docs/testing.md](docs/testing.md)

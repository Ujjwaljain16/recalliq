# Parallel execution plan: milestones 4 and 5

Status: **approved 2026-11-12, interfaces frozen.** Written against the repository as it actually is (checked, not taken from earlier reports).

## 0. Approval record (2026-11-12)

| Item | Decision |
|---|---|
| D1 locale | Approved: canonical BCP-47 in `PriceBeliefKey` and the encoded key, `und` for unknown, regional distinctions kept, different locales incomparable, an unknown locale cannot independently establish `changed`. Applied to ADR-37, contracts §2 and `src/shared/belief.ts`. |
| D2 Q-001 | Approved: observation = immutable timestamped snapshot with sufficient content and validated supporting pricing evidence; source identity = `url_norm` keeping meaningful query parameters and removing only tracking ones; comparability = `comparableKeys === 'equal'` including locale; the baseline's own fetch never counts; effective dates may establish timing, publication and fetch dates may not. Applied to ADR-36, architecture §8 and Q-001. No weaker rule may be implemented. |
| D3 benchmarks | Adapters and harnesses against recorded fixtures first. ADR-08 and ADR-14 stay Proposed until a benchmark has actually run. The owner configures credentials in an ignored `.env` and approves live spending separately. No credential is committed and no result is invented. |
| D2 amendment | The fresh-crawl reading of "sufficient content" is relaxed: provider-cached copies may be observations under the conditions in ADR-36 (content as-of time required for a positive `changed`). Cache age or capture time in the contract is open (Q-019). |
| D4 application surface | A separate **milestone 5.5**: HTTP server, SSE endpoint, acknowledgement endpoint, session handling, a minimal usable web client and `npm run dev`. Reviewers must be able to interact with the agent; this is not deferred into milestone 6. |
| D5 sequencing | Done: M3 merged on `m3/integration`, full suite and fresh-database initialisation (schema version 6) verified before the M4/M5 worktrees were created. M3 is **not** merged into `main`. |
| D6 agents | Four implementation agents plus the orchestrator. |
| Correction | `ResearchService` turns provider, extraction and deadline failures into typed coverage outcomes. Database persistence failures and programmer errors propagate and are never reported as incomplete coverage. Written into `src/shared/pipeline.ts`. |

The sections below were written before the approval; where they say "proposed" or list D1 to D6 as open, §0 supersedes them.

## 1. Verified starting point

| Item | State |
|---|---|
| `main` | `b1fd8ab`, clean, equal to `origin/main` plus one local docs commit. Contains M1, M2 and the documentation pass. |
| M3 | In progress on branches, not merged. `m3/temporal` (`1c184eb`, resolver, 81 tests) and `m3/memory-retriever` (`8c4151f`, SQLite message retriever, 26 tests) are committed and merged on `m3/integration` (`8b310cc`) together with the recall/clarify decision in `src/memory/recall.ts`. `m3/enrichment` (enrichment, baseline loader, migration 006) has **uncommitted** work in its worktree and has not reported. |
| M4 / M5 code | None. `src/` contains only `config`, `db`, `shared`, `temporal` (and `memory` on the integration branch). |
| Shared contracts | `src/shared/*` already types most seams: `SearchPort`, `LlmPort`, `EvidenceExtractor`, `ExtractionBatcher`, `EvidenceVerifier`, `AuthorityClassifier`, `BeliefResolver`, `ChangeDetector`, `ResearchPlanner`, `ResearchExecutor`, `AnswerPipeline`, `TurnOrchestrator`, `TurnRepository`, `TurnBudget`, `MemoryRetriever`, `BaselineLoader`, `FindingSet`. Only types exist; the belief-key functions and every implementation are missing. |
| Dependencies | `better-sqlite3`, `zod` only. No HTTP, SDK or Luxon dependency. |
| Keys | `.env.example` lists empty `ANTHROPIC_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, `PERPLEXITY_API_KEY`. No `.env` is present in the repository (ignored by git). |

## 2. Blockers and decisions needed before workers start

| # | Item | Who decides | Effect if unresolved |
|---|---|---|---|
| D1 | **Locale in the belief key** (ADR-37, accepted). Applying it changes normative contracts §2 and `src/shared/belief.ts` (`PriceBeliefKey.locale`, `keyForEvidence(e, { domain, urlNorm })`, `|loc=` encoding). | Owner | Agent B cannot write belief keys. |
| D2 | **Q-001 sub-questions a, b, c, e** (what an observation is; source identity = same `url_norm`; comparable = `comparableKeys === 'equal'`; the baseline's own fetch does not count). Only (d) is decided. | Owner | Agent B builds everything else; the `ChangeDetector` is **not** implemented until these are confirmed. |
| D3 | **API keys and a spending cap** for the provider bake-off (ADR-08) and model benchmark (ADR-14). | Owner (put keys in an ignored `.env`) | Adapters and harnesses are built and tested against fixtures, but **no benchmark is run**, ADR-08 and ADR-14 stay Proposed, and no latency, cost or accuracy figure is written anywhere. |
| D4 | **HTTP server, SSE endpoint, ack endpoint and web client** belong to neither M4 nor M5 as listed. Proposed: a later milestone. M5 ends at `TurnOrchestrator` plus `AnswerPipeline`. | Owner | The result is a tested library with no UI until then. |
| D5 | **Sequencing with M3.** Base must contain M3 so that migration numbers and `turn-completion.ts` are stable. Proposed: wait for `m3/enrichment` to commit, merge it into `m3/integration`, run the full suite, then fork all four workers from that commit. | Orchestrator (me) | Otherwise workers would fork from a base that omits M3's migration 006 and enrichment changes. |
| D6 | The limit of four implementation agents: `m3/enrichment`'s agent is still running, so spawning now would make five. | Orchestrator | Spawn after it finishes. |

Native subagent worktree isolation exists (`isolation: "worktree"`), but I create the named worktrees myself and confine each worker to one. That is how the M3 workers ran; I verified afterwards that `main` was untouched and each branch held only its owner's files. It is a convention, not a sandbox, so every diff is inspected before merging.

## 3. Branches, worktrees, migrations

All from one approved base commit (the M3 integration head once D5 is done):

| Agent | Branch | Worktree | Migration |
|---|---|---|---|
| A, search and sources | `m4/search-evidence` | `../recalliq-m4-search` | **007**: ownership triggers for `search_requests`, `search_results`, `source_snapshots` links (Q-007 plan) |
| B, verification and beliefs | `m4/verification-beliefs` | `../recalliq-m4-verification` | **008**: ownership triggers for `beliefs`, `belief_history` (Q-007 plan) |
| C, coordinator | `m5/coordinator` | `../recalliq-m5-coordinator` | none |
| D, LLM and streaming | `m5/llm-streaming` | `../recalliq-m5-llm` | none |

006 is taken by M3. Migrations are additive only; a worker adds triggers only together with cross-user tests.

## 4. Frozen interfaces

### 4.1 Existing contracts (frozen as they are)
`SearchPort`/`SearchRequest`/`SearchResponse`, `LlmPort` (`structured`, `stream`), `EvidenceExtractor`, `ExtractionBatcher`, `EvidenceVerifier`, `AuthorityClassifier`, `BeliefResolver`, `ChangeDetector`, `ResearchPlanner`, `ResearchExecutor`, `AnswerPipeline`, `TurnOrchestrator`, `TurnBudget`, `MemoryRetriever`, `BaselineLoader`, `FindingSet`/`Finding`, and the M2 delivery contracts (`AckRequest`, `deliveryState`, `TurnRepository.ack`). No second acknowledgement mechanism is introduced.

### 4.2 Additions (new file `src/shared/pipeline.ts`, orchestrator-owned, frozen; the code in that file is authoritative)

```ts
/** What a research or audit turn needs. Baselines arrive inside ctx. */
export interface ResearchRequest {
  userId: UserId; turnId: TurnId;
  ctx: ResolvedContext; analysis: TurnAnalysis; plan: ResearchPlan;
  now: Ms; budget: TurnBudget; emit: EventSink;
}
/** Search -> snapshots -> extraction -> T0-T3 -> beliefs -> verdicts -> findings.
 *  Never throws for provider, extraction or deadline failure: those become
 *  Coverage failures and 'unable_to_verify' findings. Throws only for programmer error. */
export interface ResearchService { run(req: ResearchRequest): Promise<FindingSet>; }

/** Read side of the snapshot store, user-scoped. */
export interface SnapshotReader { getMany(userId: UserId, ids: SnapshotId[]): SourceSnapshot[]; }

/** The analysis role. Failure returns degraded: true rather than throwing. */
export interface TurnAnalyzer {
  analyze(input: { userMessage: string; window: Array<{ role: 'user' | 'assistant'; content: string }>;
                   tz: IanaTz; now: Ms }, budget: TurnBudget): Promise<TurnAnalysis>;
}
```

Everything else a worker needs already exists. Plan-time duties (which searches to run) stay with the coordinator through `ResearchPlanner`; execution of a plan is `ResearchExecutor`.

### 4.3 Contract edits for D1 (applied 2026-11-12)
`PriceBeliefKey` gains `locale: string`; the encoding gains `|loc=<locale>`; `keyForEvidence` takes `{ domain, urlNorm }`; `comparableKeys` treats differing locales as `different`. Applied by the orchestrator in contracts §2 and `src/shared/belief.ts`, with ADR-37 and Q-001 updated, before Agent B starts.

## 5. Agents

### Agent A: search and source evidence (M4)
- **Owns:** `src/search/**` (provider adapter, request construction, response validation with zod, normalisation, replay and record support), `src/sources/**` (URL normalisation, source identity, snapshot persistence, `SnapshotReader`, a pure `parseSourceStructure(text)` that reports headings and tables found in the text), `src/research/executor.ts` (`ResearchExecutor`: concurrency, bounded retry, admission through `TurnBudget`), migration 007, `tests/fixtures/search/**`, `scripts/` bake-off harness, `docs/provider-evaluation.md`.
- **Implements:** `SearchPort`, `ResearchExecutor`, `SnapshotReader`. **Consumes:** `TurnBudget` (interface), repositories.
- **Rules:** one external capability, web search. No crawler, browser or page-fetch capability and no extraction endpoint; several HTTP calls to the same search API are allowed. Replay mode never falls back to live: a miss throws `ReplayMissError`. Text is preserved as returned; nothing is flattened or reformatted. Provider is configurable behind the port; ADR-08 stays Proposed.
- **Bake-off:** the harness and fixed benchmark are built; they run only after D3. Until then the report states "not run".
- **Acceptance:** fixture-driven adapter tests, malformed-response, timeout, cancel, rate-limit and quota tests, replay-miss test, ownership tests for 007, mutation spot checks, full suite green.

### Agent B: evidence verification and beliefs (M4)
- **Owns:** `src/evidence/**` (batching, extraction prompts and schema, verifier T0–T2, entailment judge T3, authority classifier), `src/belief/**` (typed keys, resolver, finding assembly, `ChangeDetector` after D2), `src/research/service.ts` (`ResearchService`, composing A's executor through its interface), evidence and belief repositories, migration 008, tests and fixtures.
- **Implements:** `EvidenceExtractor`, `ExtractionBatcher`, `EvidenceVerifier`, `AuthorityClassifier`, `BeliefResolver`, `ResearchService`, and `ChangeDetector` once D1 and D2 are done. **Consumes:** `LlmPort`, `SearchPort`/`ResearchExecutor`, `SnapshotReader`, `TurnBudget` (interfaces, with fakes).
- **Rules:** the LLM only proposes candidate evidence and may confirm or downgrade at T3; it never authors a belief or verdict, and cannot upgrade anything that failed T0–T2. A conflict is `contested`, never "newest wins". `changed` follows the Q-001 rule; otherwise `differs_timing_unknown`.
- **Acceptance:** one test per T0–T3 check including adversarial cases, resolver tests for tiers, freshness, conflicts, modality, currency, unit and billing period, key round-trip, and the T-BEL cases that do not depend on D2.

### Agent C: coordinator and routing (M5)
- **Owns:** `src/orchestration/**`: `TurnOrchestrator` implementation, lane routing, `ResearchPlanner`, the real `TurnBudget` (constants in `src/shared/infrastructure.ts` comments), clarification handling, error classification, response preparation; one handler per lane (chat, recall, research, audit, clarify) behind small typed route contracts; mock-based tests.
- **Consumes only interfaces:** `TurnAnalyzer`, `MemoryRetriever`, `BaselineLoader`, `resolveRecall` (`src/memory/recall.ts`), `ResearchService`, `AnswerPipeline`, `TurnRepository`. It implements no search, extraction or verification.
- **Rules:** one absolute deadline propagated through `TurnBudget`; bounded retries; a failed provider is never reported as a successful search; a global "nothing changed" is impossible when any finding is `unable_to_verify`; the chat lane makes no database or search call beyond persisting the turn; a recall with no record says so.
- **Acceptance:** deterministic routing tests, a test per lane, deadline and cancellation tests, error-class tests, mock integration tests. These show the wiring only, not that the real pipeline works.

### Agent D: LLM adapter and safe streaming (M5)
- **Owns:** `src/llm/**` (provider adapter behind `LlmPort`, zod-validated structured output with bounded repair, model configuration from env, usage accounting, budget-aware calls), `src/llm/analysis/**` (`TurnAnalyzer`), `src/answer/**` (`AnswerPipeline`: synthesis prompt, placeholder parsing and authorisation per contracts §3, raw-text check after removing valid placeholders, rendered-value check, sentence splitting and statuses, streaming, interruption), `tests/fixtures/llm/**`, a model benchmark harness and `docs/model-evaluation.md`.
- **Implements:** `LlmPort`, `TurnAnalyzer`, `AnswerPipeline`. **Consumes:** `TurnBudget`, `EventSink` (interfaces).
- **Rules:** no SDK type leaves the adapter; model names come from configuration, ADR-14 stays Proposed. Streamed and rendered extents stay separate: nothing is marked presented without an acknowledgement, and an interruption preserves the exact streamed extent. Unknown or malformed placeholders are dropped and flagged. No unsupported number or verdict word may pass in free text.
- **Acceptance:** placeholder grammar tests (split across deltas, 64-character limit, unknown ref, inapplicable variant), T3a family tests, render-integrity fault injection, interruption tests, fake-LLM tests. The benchmark runs only after D3.

Extraction prompts are Agent B's (they are evidence-specific); the analysis and synthesis prompts are Agent D's. Both call `LlmPort`.

## 6. Shared rules for every worker
Strict TypeScript, no `any`, `unknown` at untrusted boundaries, zod at those boundaries, parameterised SQL, explicit dependency injection, no new dependency without a stated reason (HTTP via Node's `fetch`; an SDK only if the owner approves), no circular imports, tests alongside code, no weakened tests or constraints, Conventional Commits with no attribution trailers, no push, no merge to `main`, changes to `src/shared/**` and `docs/**` proposed to the orchestrator and not applied. Each worker reports files, interfaces, decisions, migrations, tests, exact commands, actual results, commit hashes, TODOs and limitations.

## 7. Integration order
1. M3: merge `m3/enrichment`, run the full suite, check migrations from a fresh database. This commit is the base.
2. Apply D1 (and D2 if confirmed); add `src/shared/pipeline.ts`; commit as the frozen base.
3. Fork A, B, C, D.
4. M5.5 (HTTP server, SSE and ack endpoints, session handling, minimal web client, `npm run dev`, end-to-end tests of a real user interaction) is staffed when Agent C has reported and its coordinator interface has passed review, in the freed slot; it consumes only the coordinator's public interface. Merge A, then B (against A's `SnapshotReader` and executor), then C (mocks first), then D. Run the full suite after each merge.
5. Wire the real `ResearchService` and `AnswerPipeline` into the coordinator; replace the mocks; write the first end-to-end test with recorded fixtures.
6. Implement the `ChangeDetector` if D2 was deferred.
7. Offline replay, then controlled live runs (only after D3), reported separately.
8. Update ADRs, `docs/testing.md`, DESIGN.md evidence.

## 8. Evaluation preparation (starts with the workers)
Recorded fixtures labelled real or `[SYNTHETIC]`; scenario scripts for the three challenge questions (shortlist since Monday, audit of 3 November, last-Tuesday hosting check); a metrics sheet for routing accuracy, clarification correctness, grounding, citation correctness, change false positives and negatives, unsupported-number rate, partial-delivery correctness, deadline compliance, latency and cost. Nothing is filled in until measured, and no target is set before a baseline exists.

## 9. Known limitations of this plan
- Mock-based integration in step 4 does not prove end-to-end behaviour; step 5 does, on fixtures only.
- Without D3, provider and model choices remain unmeasured.
- Retrieval returns at most eight candidates, so a second conversation can be missed when one conversation fills all eight; the recall layer flags this as `truncated` but does not yet ask.

## 10. Ownership check (frozen)

Each path has exactly one owner. Everything not listed is orchestrator-owned and changed only at integration.

| Path | Owner |
|---|---|
| `src/search/**`, `src/sources/**`, `src/research/executor.ts`, `src/db/migrations/007_*.sql`, `tests/**/search/**`, `tests/**/sources/**`, `tests/fixtures/search/**`, `scripts/bakeoff*`, `docs/provider-evaluation.md` | A |
| `src/evidence/**`, `src/belief/**`, `src/research/service.ts`, `src/db/migrations/008_*.sql`, `tests/**/evidence/**`, `tests/**/belief/**`, `tests/fixtures/evidence/**` | B |
| `src/orchestration/**`, `tests/**/orchestration/**` | C |
| `src/llm/**`, `src/answer/**`, `tests/**/llm/**`, `tests/**/answer/**`, `tests/fixtures/llm/**`, `scripts/model-bench*`, `docs/model-evaluation.md` | D |
| `src/shared/**`, `src/config/**`, `src/db/index.ts`, existing `src/db/**` and migrations 001 to 006, `package.json`, lockfile, `docs/**` (other than the two evaluation reports), `tests/helpers/**`, existing tests | Orchestrator |

Rules that follow: repositories for new tables live inside their owner's module (not in `src/db/repositories`), so `src/db/index.ts` is never edited by a worker. Configuration is injected; a worker that needs a new setting proposes it. HTTP calls use Node's `fetch`; no worker adds a dependency. Test files go in per-module subfolders so names cannot collide. `tests/helpers/budget.ts` (`FakeBudget`) is shared and read-only. The one directory two workers share is `src/research/`, with separate files (`executor.ts` for A, `service.ts` for B).

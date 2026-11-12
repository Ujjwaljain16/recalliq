# RecallIQ — design

A chat agent with one tool, web search, that remembers your conversations and can check its own earlier answers
against today's sources. **Every statement in an answer says how sure it is: verified, sourced, or not found.**

## How a turn works

1. **Understand** (one model call): intent, entities, search queries and time references ("on Monday", "since
   then"). Times are resolved by code in the user's time zone, not by the model.
2. **Reconstruct context before routing.** Stored messages, shortlists and entities for the referenced day are
   retrieved (SQLite FTS5), _then_ a deterministic router picks a lane: chat, recall, research, audit or clarify.
   History is an input to routing, never something only one lane can see.
3. **Research, bounded.** A planner (code) turns the analysis into at most 16 searches (4 per entity, 6 entities).
   Search goes through Exa under a per-process limiter. One absolute 60 s deadline covers the whole turn, with a
   budget per stage.
4. **Two kinds of statement.**
   - **Verified:** prices and releases are extracted as atomic claims with a verbatim quote, then checked by
     code (quote present, value in quote, plan/billing/unit binding, owner of the page). Code renders them into
     the answer through placeholders; the model never types a verified number.
   - **Sourced:** for everything else the model writes from source excerpts and must cite one. A deterministic
     check withholds the sentence unless every number, date, amount and name appears in _one_ cited excerpt.
5. **Temporal truth.** Snapshots, evidence, assertions (what we actually said) and beliefs are separate,
   append-only layers. "Changed" is only ever said when the old value was observed after our answer and the new
   value later on the same page, or the page states an effective date. Otherwise the answer says the values
   differ and the timing is unknown. Our earlier answer is a baseline only if it was actually shown to the user
   (client acknowledgement) and was verified.
6. **Safe delivery.** Sentences stream as they pass validation; a sentence that fails is withheld whole, never
   cut. Change words ("raised", "launched", "unchanged") need a matching verdict from code.

## Why this shape

- **Reason with the model, decide with code.** The model interprets language and writes prose; code owns time,
  routing, budgets, verification, belief resolution and state transitions (a 26-edge turn state machine with
  typed failures). The model cannot silently rewrite what the system believes or what it said before.
- **The examples are about time and memory.** "Has it changed since Monday?" needs to separate _the world
  changed_, _my answer was wrong_ and _I can't tell when_. That is only possible if what was said, what each
  source said and when are stored separately.
- **Modular monolith + SQLite.** One process, transactional storage with triggers for ownership and
  immutability, `npm install && npm run dev`, no infrastructure to run.

## Considered and rejected

- **Vector-store RAG as the whole memory.** Good at "what did we discuss", but it cannot say what was asserted
  when, so it cannot audit an old answer. FTS5 over stored messages plus structured records was enough; no
  embeddings until a measurement shows recall failing.
- **An unrestricted agent loop / multi-agent orchestration.** Harder to bound in time and cost under a 60 s turn
  and free-tier rate limits; a planner with a fallback round gives most of the benefit.
- **LLM-only verification.** A model judge is used only for entailment ambiguity; it never decides on its own
  that a number is supported.
- **Letting the model speak freely about prices.** Fast, but unauditable. Sourced statements keep speed for
  general questions while only verified statements can claim a change.
- **Graph database, microservices.** Not justified for one user's history on one machine.

## What has been measured (single runs, `gemini-3.5-flash-lite` free tier + Exa)

- **Latency, live runs (single samples):** chat and memory 1.4–3.3 s to first text; general research 5–10 s. Price
  questions stream a cited answer from the sources at 8–12 s (22 s total for one vendor, 43 s for five) while the
  checks run; before this they showed nothing for 20–36 s. Each model has its own rolling per-minute budget, and a
  call goes to a fallback model instead of waiting when the main model's budget is used up.
- **Temporal rules:** 55 holdout cases written from the specification and committed before the first run
  (`docs/holdout-evaluation.md`); all pass. About 2,470 automated tests, with mutation checks on every protection
  added recently.
- **Extraction:** on 20 real pricing pages (AI-labelled, partly reviewed), the current prompt reached 58% claim
  precision without an official-domain registry and 0 false passes in every run (`docs/extraction-calibration.md`).
- **Security review:** no critical or high findings; rebinding, quota, CORS and baseline-poisoning issues fixed
  (`docs/security.md`).
- **Public benchmarks** (FreshQA, SimpleQA, LongMemEval; `docs/benchmarks.md`): 30-question dev samples, then
  100-question test samples, one run each, all finished. SimpleQA 80/100 (80%, 95% range 71–87%; 13% declined,
  7% wrong). FreshQA 69/100 (69%, 59–77%); fast-changing facts are weak (11 of 27, 41%) and its answer key dates
  from April 2026. LongMemEval 37/100 (37%, 28–47%): single-session questions 15 of 24 on the user and assistant
  sides, but multi-session (3 of 24) and temporal reasoning (6 of 25) are weak because counting and date
  arithmetic across messages are not supported. Median time to first text 4–7 s. Graders: SimpleQA uses the
  published template; the other two are our wording of each paper's description. Small samples, a lite model on
  a free tier, with some provider failures retried: read them as a rough picture, not a score to compare with
  other systems.

## Known limits

- Without an owner list of official domains (`OFFICIAL_DOMAINS_FILE`) ordinary pages count as low authority, so a
  live run will say "differs, timing unknown" rather than "changed". This is deliberate: an unknown page must not
  be able to manufacture a change.
- Exa reports no per-result crawl marker, so freshness is "last seen" rather than "confirmed live".
- Grounding is lexical: a correct number attached to the wrong plan in the same excerpt passes.
- Memory search reads the user's side of conversations; the assistant's side is audited through stored
  assertions instead.

## With another week

1. Counting and date arithmetic across remembered messages (the weak LongMemEval types).
2. Gap-directed second search round (search for _why_ a claim failed: plan, billing period, owner page).
3. A small, reviewed official-domain registry flow so change verdicts work out of the box.
4. Evaluate stronger models per role (analysis, extraction, synthesis) on the dev sets.

Details: `docs/architecture.md`, `docs/adr/`, `docs/running.md`, `docs/testing.md`.

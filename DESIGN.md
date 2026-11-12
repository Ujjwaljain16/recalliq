# RecallIQ — design

RecallIQ is a conversational assistant with one external tool: web search. Its distinguishing feature is
time-aware memory. It remembers what you asked, what it answered and when, so when you come back with a
follow-up it can separate what it said before, what the evidence says now, and what cannot be established.

It is built for ordinary conversation as much as for current information: it answers directly when it can, uses
your history when the question refers to it, searches the web when outside information adds something, and asks
when the question is ambiguous. One principle runs through it: **the model reasons; deterministic code controls
time, routing, verification and memory.**

## How a turn works

1. **Understand.** One model call reads the message: what kind of question it is, the companies or topics, search
   queries, and time phrases ("on Monday", "since then"). Code, not the model, turns those phrases into dates in
   your time zone.
2. **Remember, then route.** If the message refers to earlier conversations, they are fetched first (SQLite
   full-text search over your messages, shortlists and companies). Only then does a deterministic router pick a
   lane:
   - **chat:** greetings, explanations, follow-ups the model can answer itself, with the current
     conversation as context. No search.
   - **recall:** "What did I ask you on 3 November?" is answered from stored history, with no search.
   - **research:** a question that needs current facts searches the web, then answers with citations.
   - **audit:** "Is your answer still correct?" finds the earlier answer and checks it against today's sources.
   - **clarify:** "the five tools" with no shortlist on record gets a question back, saying why, not a guess.
3. **Search, bounded.** A planner written in code turns the analysis into at most 16 searches. One 60 s deadline
   covers the turn, with a budget per stage so a slow step cannot starve the answer.
4. **Answer early, then check.** As soon as pages arrive, a short cited answer streams. Meanwhile prices and
   releases are extracted as small claims with a verbatim quote and checked by code: the quote is on the page,
   the number is in the quote, plan, unit and billing period bind to it, and the page belongs to the company.
5. **Write with placeholders.** For checked facts the model writes `[[F3]]`-style placeholders and code fills in
   the values, so the model never types a verified number. Any sentence citing a page is released only if every
   number, date and name in it appears in that page's excerpt. A sentence that fails is withheld whole, never cut
   mid-way.
6. **Keep the record.** What each page said, what the assistant claimed, and what it now believes are separate
   append-only layers. An earlier answer becomes a baseline only if it was verified _and_ the browser confirmed
   it was shown to you. That is what an audit compares against.

## Why this shape

- **The model reasons, code decides.** Language is the model's job; time, routing, budgets, verification and
  state changes are code (a 26-edge turn state machine with typed failures). The model cannot quietly rewrite
  what the system said before or what it believes.
- **The hard questions are about time.** "Has it changed since Monday?" is unanswerable unless what was said,
  what each source said, and when, are stored separately. That drove the data model.
- **One process, one SQLite file.** Triggers enforce ownership and immutability; `npm install && npm run dev` is
  the whole setup.

## What broke along the way, and what we changed

Most of the design was written first. Most of what makes it work live came from running it and watching it fail.

- **The planned model fell over.** `gemini-3.5-flash` returned 503s and 429s on the free tier. We moved to
  `flash-lite` with a fallback model and a limiter per model. Then our own limiter (15 calls a minute) starved the
  final answer until the deadline cut it off; calls now divert to the fallback instead of waiting, and a call
  still running after a few seconds is also sent there (first answer wins).
- **Checked answers felt dead.** Price questions showed nothing for 20–36 s while extraction ran, so we added the
  early cited answer. A live rerun showed it silently switched off for exactly the history questions, because the
  recalled-message opening had to come first; now the opening goes out first and the early answer follows.
- **A safety check ate the memory feature.** A guard against repeating a value also withheld every answer that
  quoted your earlier message. Fixing it, and searching across all your conversations, took the LongMemEval dev
  sample from 13% to 38%.
- **Right numbers, wrong labels.** Correct prices were discarded because the extractor called "$100 per user per
  month, billed annually" an annual price, or a bare "$" US dollars. Code now resets a label to what the text says
  and checks again; amounts and quotes are never touched.
- **Strict by design, and switched off by it.** On a fresh install a vendor's own site counted as unofficial,
  and the search provider never confirms a live crawl, so no earlier answer could ever become a baseline: the
  audit could not fire. We relaxed both rules deliberately ([ADR-44](docs/adr/ADR-44.md)): a domain that is
  exactly the company's name is official, and a requested live crawl dates the page. "Changed on <date>" still
  needs proof of when.
- **Smaller ones:** saying the same price twice, a second search round that used up the deadline, one plan listed
  in four currencies, an early sentence about a release that the release check then denied. Each has a test that
  fails if it comes back.

## Considered and rejected

- **Vector RAG as the whole memory.** Good for "what did we discuss", but it cannot say what was asserted when.
  Full-text search plus structured records was enough; no embeddings until a measurement says otherwise.
- **An open-ended agent loop or several agents.** Hard to bound under a 60 s deadline and free-tier limits; a
  planner with one fallback round gives most of the benefit.
- **Letting the model talk freely about prices.** Fast and unauditable. Cited sentences keep general answers
  fast; only verified ones can claim a change.
- **A model as the verifier.** A model judge only settles ambiguous comparisons; it never decides on its own that
  a number is supported.

## Evidence (all with `gemini-3.5-flash-lite` on the free tier, Exa search)

- **Benchmarks** (method in `docs/benchmarks.md`). One run each on a 100-question test sample per dataset, drawn
  with a fixed seed, stratified (SimpleQA by topic, FreshQA by fact type and premise from its own test split,
  LongMemEval by question type), not hand-picked; the committed manifest lists the ids. Accuracy is correct ÷
  graded; a decline counts as not correct. Graders run on `gemini-3.1-flash-lite`: the official SimpleQA template,
  and for FreshQA and LongMemEval our own wording of each paper's judging rules.
  - SimpleQA: 80% correct (95% interval 71–87%), 7% wrong, 13% declined.
  - FreshQA (release of 2026-04-21): 69% (59–77%); fast-changing facts 41%, partly because the answer key is
    seven months old.
  - LongMemEval, oracle variant: 37% (28–47%); recall within one conversation 15 of 24, counting across
    conversations 3 of 24. History is seeded straight into the database and the judge is ours, so this is **not**
    comparable with published LongMemEval scores.
- **Observed latency, not a load test.** Across the 300 benchmark questions: median first text 4–7 s and median
  completion 6–8 s, 90th percentile 12–15 s. Price questions with several companies are slower: in live runs,
  first text after 5–13 s and completion in 20–50 s, and a five-company question occasionally hits the 60 s limit.
- **Correctness:** 2,600+ automated tests, mutation-checked protections, 55 temporal cases written before the
  first run (all pass), and an independent security review with no critical or high findings.

## Known limits

- The exact-name rule can be wrong when someone else owns the name (linear.com is not Linear's site); an
  `OFFICIAL_DOMAINS_FILE` entry overrides it.
- Grounding is lexical: a right number attached to the wrong plan inside one excerpt passes.
- Counting and date arithmetic across remembered conversations is not supported.
- On the free tier, rate limits can slow or interrupt a turn; the app says so and offers a retry.

## With another week

1. **Ordinary questions, measured.** A set of everyday questions (explanations, comparisons, follow-ups,
   cold-start "what did I ask?" with no history) graded for quality and for searching only when needed.
2. **Speed.** A proper latency sweep (p50/p95 for first text and completion per lane), then extraction that starts
   per company as its pages arrive instead of after all searches.
3. **Memory arithmetic.** Counting and date reasoning across conversations, the weakest LongMemEval types.
4. **Coverage.** Fetch a vendor's own pricing page when search returns only blogs, with SSRF defences, and a
   second search round aimed at why a claim failed.

More depth: [docs/architecture.md](docs/architecture.md), [docs/adr/](docs/adr/README.md),
[docs/security.md](docs/security.md), [docs/testing.md](docs/testing.md).

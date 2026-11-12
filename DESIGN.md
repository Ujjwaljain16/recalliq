# RecallIQ — design

RecallIQ is a chat agent with one tool, web search. What makes it different is memory with a sense of time: it
remembers what you asked and what it answered, and when you come back ("On Monday we shortlisted five CRM tools.
Has anything changed since?") it can tell apart three things most assistants blur together: _the world changed_,
_my earlier answer was wrong_, and _I can't tell when it changed_. Every sentence it shows carries how sure it is:
**verified** by code against a quote, **sourced** from a cited page, or **not found**.

## How a turn works

1. **Understand.** One model call turns the message into intent, companies, search queries and time phrases
   ("on Monday", "since then"). Code, not the model, turns those phrases into dates in your time zone.
2. **Remember before deciding.** Messages, shortlists and companies from the day you referred to are fetched
   (SQLite full-text search). Only then does a deterministic router pick a lane: chat, recall, research, audit or
   clarify. History is an input to routing, not a feature of one lane.
3. **Search, bounded.** A planner written in code turns the analysis into at most 16 searches. One 60 s deadline
   covers the whole turn, and each stage has its own budget, so a slow step cannot starve the answer.
4. **Answer early, then check.** As soon as pages arrive, a short sourced answer streams ("Here is what the
   sources say while I check the details"). Meanwhile prices and releases are extracted as small claims with a
   verbatim quote and checked by code: the quote is on the page, the number is in the quote, the plan, unit and
   billing period bind to it, and the page belongs to the company.
5. **Write with placeholders.** The model writes the checked part with `[[F3]]`-style placeholders and code fills
   in the verified values, so the model never types a verified number. A sentence citing a page is released only
   if every number, date and name in it appears in that page's excerpt. A sentence that fails is withheld whole,
   never cut mid-way, and a finding the model forgot is added as a line written in code.
6. **Keep the record.** What each page said, what the agent claimed, and what it now believes are separate
   append-only layers. An earlier answer counts as a baseline only if it was verified _and_ the browser confirmed
   it was shown to you. Asking "Is the price you gave me still correct?" compares against exactly that.

## Why this shape

- **The model reasons, code decides.** Language is the model's job; time, routing, budgets, verification and
  state changes are code (a 26-edge turn state machine with typed failures). The model cannot quietly rewrite
  what the system said before or what it believes.
- **The example questions are about time.** "Has it changed since Monday?" is unanswerable unless what was said,
  what each source said, and when, are stored separately. That drove the whole data model.
- **One process, one SQLite file.** Triggers enforce ownership and immutability; `npm install && npm run dev` is
  the whole setup.

## What broke along the way, and what we changed

Most of the design above was written first. Most of what makes it work live came from running it and watching it
fail.

- **The planned model fell over.** `gemini-3.5-flash` returned 503s and 429s on the free tier. We moved to
  `flash-lite` with a fallback model and a rate limiter per model. Then our own limiter (15 calls a minute) starved
  the final answer until the 60 s deadline cut it off; calls now divert to the fallback model instead of waiting,
  and a call still running after a few seconds is also sent there (first answer wins).
- **Checked answers felt dead.** Price questions showed nothing for 20–36 s while extraction ran, so we added the
  quick sourced answer. A live rerun then showed it silently switched off for exactly the history questions,
  because the recalled-message opening had to come first. The opening now goes out first and the quick answer
  follows it (first text 31 s → 9–12 s).
- **Saying things twice.** The quick and checked parts repeated the same price. Comparing words failed on
  paraphrases and wrongly matched two products at the same price; comparing the numbers plus the product names
  works.
- **A safety check ate the memory feature.** A guard against repeating a value also withheld every answer that
  quoted your earlier message, so memory answers became "I could not process that". Fixing it, and searching
  across all your conversations, took the LongMemEval dev sample from 13% to 38%.
- **Right numbers, wrong labels.** Correct prices were thrown away because the extractor called "$100 per user per
  month, billed annually" an annual price, or a bare "$" US dollars. Code now resets a label to what the text
  says and checks again; amounts and quotes are never touched. Salesforce went from one verified price to four.
- **Strict by design, and switched off by it.** On a fresh install Supabase's own site counted as an unofficial
  page, and Exa never confirms a live crawl, so every price was "last seen date unknown" and no earlier answer
  could become a baseline. The self-audit could not fire at all, and a "still correct?" question was even routed
  past it. We relaxed both rules on purpose ([ADR-44](docs/adr/ADR-44.md)): a domain that is exactly the company's
  name is official, and a requested live crawl dates the page. It now answers "no sign of a change in what I
  could check" against its own earlier answer; "changed on <date>" still needs proof of when.
- **Smaller ones:** a second search round that used up the deadline, a benchmark harness throttled by our own
  new-session quota, one plan listed in four currencies, a quick sentence about a release that the release check
  then said did not exist. Each has a test that fails if it comes back.

## Considered and rejected

- **Vector RAG as the whole memory.** Good for "what did we discuss", but it cannot say what was asserted when.
  Full-text search over stored messages plus structured records was enough; no embeddings until a measurement
  says otherwise.
- **An open-ended agent loop or several agents.** Hard to bound under a 60 s deadline and free-tier limits; a
  planner with one fallback round gives most of the benefit.
- **Letting the model talk freely about prices.** Fast and unauditable. Sourced sentences keep general answers
  fast; only verified ones can claim a change.
- **A model as the verifier.** A model judge only settles ambiguous comparisons; it never decides on its own that
  a number is supported.
- **Graph database, microservices.** Not justified for one person's history on one machine.

## What we measured (single runs, `gemini-3.5-flash-lite` free tier + Exa)

- **Speed:** chat and memory 2–4 s; general research 5–10 s; price questions show sourced text after 5–13 s and
  finish in 20–50 s.
- **Benchmarks, 100-question samples** (`docs/benchmarks.md`): SimpleQA 80% (95% range 71–87%, 7% wrong, 13%
  declined); FreshQA 69% (59–77%; fast-changing facts 41%, and its answer key is from April 2026); LongMemEval 37%
  (28–47%; single-session recall 15 of 24, counting across conversations 3 of 24). Small samples and our own
  grader wording for two of them: a rough picture, not a leaderboard score.
- **Correctness:** 2,600+ automated tests, mutation-checked protections, 55 temporal cases written before the
  first run (all pass), and an independent security review with no critical or high findings.

## Known limits

- The exact-name rule can be wrong when someone else owns the name (linear.com is not Linear's site); an
  `OFFICIAL_DOMAINS_FILE` entry overrides it.
- Grounding is lexical: a right number attached to the wrong plan inside one excerpt passes.
- Counting and date arithmetic across remembered conversations is not supported.
- On the free tier, rate limits can slow or interrupt a turn; the app says so and offers a retry.

## With another week

1. Counting and date arithmetic across remembered conversations.
2. A second search round aimed at _why_ a claim failed (missing plan, billing period, the company's own page).
3. Fetch the vendor's pricing page directly when search only returns blogs, with proper SSRF defences.
4. Compare stronger models per role on the benchmark dev sets.

More: [docs/architecture.md](docs/architecture.md), [docs/adr/](docs/adr/README.md),
[docs/security.md](docs/security.md), [docs/testing.md](docs/testing.md).

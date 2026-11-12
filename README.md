# RecallIQ

A conversational assistant with one external tool: web search. It remembers what you asked, what it answered and
when, so a conversation continues with context instead of starting from zero.

Ask it ordinary questions, look up current information, revisit an earlier conversation, or check whether
something it told you is still correct. It keeps apart what it remembers, what current sources support, and what
it cannot establish. Its guiding principle: **answer usefully, remember accurately, and never pretend to know
what it cannot verify.**

**How it works and why:** [DESIGN.md](DESIGN.md) (one page). Decisions: [docs/adr/README.md](docs/adr/README.md).

![A live run, no edits: adding the example history, a question about "Monday" answered from memory and then researched, and the agent checking its own earlier Supabase answer](docs/media/demo.gif)

_A real run on the free Gemini tier, recorded without edits and sped up only where nothing changed on screen
(80 s). The CRM answer is partial: some vendors' prices could not be confirmed, and it says which._

## Run it (about two minutes to get running)

Needs Node.js 22 or newer. No database server: storage is one local SQLite file.

**1. Install**

```bash
npm install
```

**2. Configure**

```bash
cp .env.example .env           # macOS / Linux
```

```powershell
Copy-Item .env.example .env    # Windows PowerShell
```

In `.env`, set `APP_COMPONENTS=live`, plus `GEMINI_API_KEY` ([Google AI Studio](https://aistudio.google.com/apikey),
the free tier works) and `EXA_API_KEY` ([exa.ai](https://exa.ai)). Leave `GEMINI_MODEL` empty for the default.
`live` is required for the real agent; the default `scripted` mode only plays canned answers so the interface can be
explored without keys.

**3. Start**

```bash
npm run dev
```

Open <http://127.0.0.1:3001>.

## A suggested path through it

**First, a cold start.** On a fresh install there is no history. Try:

- _On Monday we shortlisted five CRM tools. Has anything changed since?_ It should say it has no shortlist from
  that Monday on record and ask which tools you meant, not invent one.
- _What did I ask you on 3 November?_ It should say it has no record of a conversation that day.

**Then, ordinary questions.** For example _What's new in Node.js 24?_, _Explain how TCP congestion control works_,
or _Compare PostgreSQL and MongoDB for a small SaaS_, and then a follow-up such as _What about memory usage?_
These questions are answered from web sources: expect short, attributed sentences with numbered citations rather
than long essays, and expect a sentence to be left out (with a quiet note) when it could not be checked against its
source.

**Then, memory.** The challenge questions refer to earlier conversations, and a fresh database has none. The
**Add example history** button on the start screen writes three dated example conversations: last Monday's CRM
shortlist, a Neon question on 3 November and last Tuesday's Postgres question. They are titled "Example: …" and
state no prices, so nothing the agent later checks was planted. Now the first two questions above find their
conversations, and these work too:

- _On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped
  something big since?_
- _Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?_
- _What did I ask you on 3 November? Is your answer still correct today?_

**Finally, the self-audit, in one sitting.** Ask _What does Supabase charge for its Pro plan?_, wait for the
answer, then ask _Is the Supabase price you gave me still correct?_ It looks up what it told you, reads the pages
again, and compares against its own earlier verified answer.

## What to look for

- **What I remembered:** the message it found for "Monday" or "3 November", quoted with its date, and the
  companies it took from it. Dates are resolved in your time zone by code, not by the model.
- **A quick cited answer first** ("Here is what the sources say while I check the details"), then checked
  findings per company with numbered sources. A sentence marked with a dotted underline is taken from a cited
  source: the current policy releases it only if every number, date and name in it appears in one cited excerpt.
  That is a mechanical check, not a guarantee that the source is right or that the sentence means what the page
  means.
- **A ✓** marks a price or release that passed code checks: the quote is on the page, the number is in the
  quote, and plan, unit, billing period and owner bind to it. It means the defined evidence constraints held, not
  that the number is true for every customer or region.
- **Honest gaps.** "I have no earlier prices of my own on record from before 2026-11-09, so I cannot establish
  whether anything changed" is the right answer when the agent never answered that question itself. "Couldn't be
  checked (the pages could not be read)" says which check failed and why. **"No sign of a change in what I could
  check"** means no supported difference was established from a bounded search. It is not proof that nothing
  changed.
- **The activity trail** above each answer: what it searched and read, and how long it took.

## How fast, and how good

Observed latency on the free Gemini tier, single runs, not a guarantee: chat and memory questions about 2–4 s;
general research 5–10 s to first text; a pricing question with several companies shows cited text after 5–13 s
and finishes in 20–50 s. Free-tier rate limits can slow or interrupt a turn; the app says so and offers a retry.

Small-sample internal evaluation, one run each on 100 questions per dataset, graded by a model. Not a leaderboard
comparison; method, graders and caveats are in [docs/benchmarks.md](docs/benchmarks.md).

| Benchmark   | Result (95% interval) | Note                                                                                                               |
| ----------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| SimpleQA    | 80% (71–87%)          | 13% declined, 7% wrong                                                                                             |
| FreshQA     | 69% (59–77%)          | fast-changing facts 41%; the answer key is from April 2026                                                         |
| LongMemEval | 37% (28–47%)          | our own seeding and judge, so not comparable with published scores; counting across conversations is the weak part |

## Commands

```bash
npm run check     # typecheck, lint, format check, all tests (offline, no keys needed)
npm test          # tests only
npm run bench     # public benchmarks (FreshQA, SimpleQA, LongMemEval); see docs/benchmarks.md
```

## Documentation

- [DESIGN.md](DESIGN.md): how a turn works, why this shape, what broke along the way, what was measured, next steps.
- [docs/architecture.md](docs/architecture.md) and [docs/adr/README.md](docs/adr/README.md): the full design
  and its decision records.
- [docs/running.md](docs/running.md): the three component sets (scripted, replay, live) and every setting.
- [docs/security.md](docs/security.md): threat model, prompt-injection defences, quotas.
- [docs/benchmarks.md](docs/benchmarks.md) and [docs/testing.md](docs/testing.md): how it is measured and tested.

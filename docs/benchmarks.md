# Public benchmarks

A reproducible harness that measures the agent on three public benchmarks by talking to the real
application over HTTP, exactly as the browser client does. It lives in [scripts/bench](../scripts/bench/cli.ts);
its tests are in `tests/unit/bench/` and run offline against the scripted components.

Nothing here produces a number by itself: the harness was built and tested offline, and every figure must
come from a live run recorded with its date, model, grader and sample.

## What each benchmark measures, and why it was chosen

| Benchmark | What it measures here | Why |
|---|---|---|
| **SimpleQA** (OpenAI, 4,326 short fact-seeking questions) | Whether a searched answer to a single, unambiguous factual question is correct, and whether the agent declines rather than guesses (CORRECT / INCORRECT / NOT_ATTEMPTED) | The agent's research lane answers factual questions from web evidence; SimpleQA rewards correct answers and penalises confident wrong ones, which matches the project's "never state what you cannot support" rule |
| **FreshQA** (Vu et al., 600 questions, release of 2026-04-21) | Answers to questions whose answers never change, change slowly or change fast, plus questions with a false premise | The agent's purpose is current answers from current evidence; FreshQA separates fast-changing facts and false premises, which a static model gets wrong |
| **LongMemEval** (Wu et al., oracle variant, 500 questions) | Whether the agent uses the user's own earlier conversations: single-session facts, multi-session aggregation, temporal reasoning, knowledge updates, preferences, and abstention when the history does not contain the answer | The agent has long-term conversation memory; this is the public benchmark for exactly that |

The oracle variant of LongMemEval gives only the sessions that contain the evidence, so it measures use of
memory, not retrieval from a large haystack.

## Protocol

- **Samples.** `sample` draws, per dataset, a dev sample (default 30) and a test sample (default 100) with a
  seeded, stratified, deterministic procedure ([sampler.ts](../scripts/bench/sampler.ts)): each item is ranked by
  sha256(seed:id), each stratum is filled in rank order, test first, then dev from the places after it, so
  the two never overlap and the test sample does not move when the dev size changes. Strata: SimpleQA by
  topic; FreshQA by fact type and premise (test drawn from FreshQA's own TEST split, dev from its DEV
  split); LongMemEval by question type, with each type's abstention questions as their own stratum. Every
  stratum gets at least one item when the sample is large enough, the rest proportionally.
- **Recorded samples.** The full samples (with question text) go to `data/benchmarks/samples/` (git-ignored).
  The committed [manifest](../scripts/bench/manifest.json) holds only the ids, seed, sizes, strata counts and the
  sha256 of the source file each sample was drawn from, so anyone with the same files can reproduce the
  samples exactly without the repository redistributing benchmark content.
- **Dev versus test.** Use the dev sample for everything iterative: checking the harness, looking at failures,
  changing prompts or the agent. Run the test sample **once per release candidate**, after the change is
  final, and never tune anything on what the test run shows. A test result is reported together with the
  commit it ran on.
- **One fresh user per question.** SimpleQA and FreshQA questions are each asked in a new conversation of a
  new anonymous user (a new cookie), so nothing one question leaves in memory reaches the next. Each
  LongMemEval question gets its own database file, a new user created through the API, its history seeded,
  and is then asked in a new conversation with the application clock set to the question date (UTC).
- **Graders recorded.** Grading is a separate step that reads stored results. Every grade file records the
  grader model, the prompt version and, for SimpleQA, whether the embedded grader template matched the
  downloaded upstream source. Changing a grader prompt means changing its version, which forces a re-grade.
- **Errors are not wrong answers.** A question whose turn was spoiled by a rate limit, a quota or another
  provider failure is recorded as an error and excluded from accuracy (shown separately in the report). A
  rate limit the application retried through cleanly counts as a normal answer. A run stops cleanly after
  three consecutive rate-limited questions (configurable) or at once on a daily quota; re-running the same
  command resumes, retrying errored questions and skipping answered ones.

## How to run

Keys come from the environment only. `npm run bench` loads an ignored `.env` if present
(`GEMINI_API_KEY`, `GEMINI_MODEL`, `EXA_API_KEY`, and `GRADER_MODEL` for grading); nothing prints a key.

```sh
# once: data files (git-ignored) with checksums, then the samples
npm run bench -- download                       # FreshQA needs --freshqa-url or a manual CSV export
npm run bench -- sample                         # all datasets, seed recalliq-bench-1, 30 dev + 100 test

# a harness check with no network (scripted components, not a score)
npm run bench -- run --dataset simpleqa --split dev --components scripted --max-questions 2

# a live dev run, graded and reported
npm run bench -- run --dataset simpleqa --split dev --pause-ms 10000
npm run bench -- grade --dataset simpleqa --split dev
npm run bench -- report
```

Flags: `sample [--dataset d] [--split dev|test --n N] [--seed s]`;
`run --dataset d --split dev|test [--components live|scripted] [--n N] [--pause-ms ms] [--max-questions N]
[--max-rate-limited N] [--out file.jsonl] [--keep-dbs] [--verbose]`;
`grade --dataset d --split dev|test [--results file.jsonl] [--grader-model name] [--pause-ms ms]`;
`report [--grades a.json,b.json] [--out file.md]`.

Results are appended to `data/benchmarks/results/<dataset>-<split>-<components>.jsonl` (one line per question:
the released answer, the same answer with withheld sentences marked, lane, turn status, wall time, time to
first event and first text, server metrics, Gemini and Exa call counts with statuses, cited sources and
domains, warnings and errors). Grades go to the matching `.grades.json`, reports to `report-*.md`.

## Grading

| Dataset | Grader prompt | Score |
|---|---|---|
| SimpleQA | The official simple-evals `GRADER_TEMPLATE` (MIT), embedded unchanged in [prompts.ts](../scripts/bench/prompts.ts) and checked against the downloaded `simpleqa_eval.py` | correct, incorrect, not attempted, correct given attempted, and the F-score (harmonic mean of correct and correct given attempted), as simple-evals defines them |
| FreshQA | Written for this harness from the FreshQA paper's description of FreshEval's RELAXED mode: the primary answer must be correct and match one of `answer_0..answer_9`; outdated or wrong material elsewhere is tolerated; a false-premise question is credited only if the response points out the false premise | accuracy overall, by fact type, by premise, with fast-changing questions and questions whose review date had passed reported separately |
| LongMemEval | Written after the paper's and repository's per-type yes/no judge: temporal reasoning tolerates off-by-one day counts, knowledge-update accepts the latest answer even with older information present, preference questions are judged against a rubric, abstention questions are credited when the response says it cannot answer | accuracy per question type |

The grader model is chosen with `GRADER_MODEL` (a Gemini model called with plain `fetch`, temperature 0).
An empty response is graded NOT_ATTEMPTED without a grader call; a reply the parser cannot read stays
UNGRADED and is retried on the next `grade`.

## What the numbers can and cannot claim

- **Small samples.** 100 test questions give a 95% interval roughly ±10 points wide around 50%. The report
  prints Wilson intervals; differences inside them are not differences.
- **LLM graders.** Grades come from a model, not from people. They are consistent for one grader model and
  prompt version, and not comparable across graders. Spot-check a sample of grades by hand before quoting a
  number.
- **FreshQA answers are dated 2026-04-21.** A fast-changing answer may have changed since; a correct current
  answer can then be graded wrong. The report shows fast-changing questions and questions whose
  maintainers' review date had passed separately, so the rest can be read without that doubt.
- **LongMemEval in this application.** The history is written into the database directly, not produced by
  live turns, so some of what a live turn would store does not exist (below). The numbers measure the agent
  on seeded history.
- **No comparisons.** The report never compares with other systems: published results use other samples,
  graders, dates and protocols.
- **Scripted runs are not scores.** A run with `--components scripted` checks the harness only, and the report
  says so on that section.

## LongMemEval seeding: what is and is not represented

Each haystack session becomes one conversation; its user and assistant messages are inserted in order with
origin `live`, time zone UTC, and timestamps from the session's date (one second apart, since the dataset
gives one time per session). Every message gets a `message_search` row, so the FTS index holds it exactly as
a committed turn would. Assistant messages carry one sentence with status `unchecked` (the application never
validated them) and are acknowledged as rendered. Everything is accepted by the schema's triggers for a
`real` database ([seed.ts](../scripts/bench/seed.ts)).

Not represented:

- **Turns.** No `turns` row exists for a seeded exchange (no analysis, lane, events or metrics ever existed);
  `messages.turn_id` is null.
- **Write-time enrichment.** Tags, entities and decisions that a live turn would extract with the model are
  absent; `message_search.tags` is empty.
- **Assistant replies in recall.** They are stored and indexed, but the application's memory retrieval reads
  user messages only, by design; questions about what the assistant said earlier (the
  `single-session-assistant` type) can only be answered from the user side of those sessions.
- **Message times.** Within a session the dataset has one timestamp; the spacing of one second is invented.
- **`has_answer` flags.** Evaluation metadata, not conversation content; not stored.
- **The user's first conversation.** Creating the user through the API creates one empty conversation,
  dated just before the earliest session.

The application clock for a LongMemEval question is a clock that starts at the question date and runs at
real speed ([clock.ts](../scripts/bench/clock.ts)), not a frozen one, so turn deadlines, the provider request
limiter and timeouts still see time pass.

## Licences

| Data | Licence | Source |
|---|---|---|
| SimpleQA test set and grader template | MIT (openai/simple-evals) | https://openaipublic.blob.core.windows.net/simple-evals/simple_qa_test_set.csv |
| FreshQA (2026-04-21) | Apache-2.0 (freshllms/freshqa) | Google Sheet linked from https://github.com/freshllms/freshqa, exported as CSV |
| LongMemEval (oracle, cleaned) | MIT | https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned |

The data files stay in `data/benchmarks/` (git-ignored) and are never committed; the repository commits only
sample ids and checksums. The FreshQA and LongMemEval grader prompts are this project's own wording after the
papers' descriptions; the SimpleQA template is reproduced with its MIT attribution.

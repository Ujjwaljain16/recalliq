/**
 * Extraction evaluation. NOT RUN by the test suite. See docs/extraction-calibration.md.
 *
 *   # offline, no model: wiring check and verifier ceiling
 *   npx tsx scripts/extraction-eval.ts run --adapter oracle --prompt extract-v1
 *   npx tsx scripts/extraction-eval.ts run --adapter oracle-best
 *   npx tsx scripts/extraction-eval.ts run --adapter empty
 *
 *   # live, the real model (the caller supplies GEMINI_API_KEY and GEMINI_MODEL in the environment)
 *   npx tsx scripts/extraction-eval.ts run --adapter gemini --prompt extract-v1 --max-calls 40 --confirm-live-calls --out before.json
 *   npx tsx scripts/extraction-eval.ts run --adapter gemini --prompt extract-v2 --max-calls 40 --confirm-live-calls --out after.json
 *
 *   # with an owner registry (JSON entity name -> domains, the OFFICIAL_DOMAINS_FILE format; default none)
 *   npx tsx scripts/extraction-eval.ts run --adapter oracle --registry ./registry.json
 *
 *   # re-score recorded replies without calling the model again
 *   npx tsx scripts/extraction-eval.ts run --adapter gemini ... --record-to replies-v2.json
 *   npx tsx scripts/extraction-eval.ts run --adapter replay --replay replies-v2.json --prompt extract-v2
 *
 *   # capture another page with the project's Exa adapter (EXA_API_KEY in the environment)
 *   npx tsx scripts/extraction-eval.ts capture --domain example.com --query "Example pricing" --out-dir ./new-pages --confirm-live-calls
 *
 * A live run refuses to start without --confirm-live-calls and --max-calls N. The number is a hard cap on HTTP
 * requests to the provider (retries and repairs included): the run stops spending when it is reached. Output
 * tokens per call are capped (--max-output-tokens, default the extractor's own cap, at most 4000). The script
 * never reads a .env file and never prints a key: keys and the model name come from process.env only, and only
 * the model name is ever written to a report.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { realSleep } from '../src/llm/abort.js';
import { GeminiLlm } from '../src/llm/gemini/adapter.js';
import { geminiConfigFromApp } from '../src/llm/gemini/config.js';
import { ClientLimiter, DEFAULT_LIMITER } from '../src/llm/limiter.js';
import { RecordingLlm, ReplayLlm, type ReplayStore } from '../src/llm/replay.js';
import { ExaSearchAdapter } from '../src/search/exa-adapter.js';
import type { LlmPort } from '../src/shared/llm.js';
import {
  EXTRACTION_MAX_TOKENS,
  EXTRACTION_PROMPTS,
  extractionPromptFor,
} from '../src/evidence/prompts/extraction.js';
import { captureRequest, pageFromHit } from '../src/evidence/eval/capture.js';
import { loadCalibrationSet } from '../src/evidence/eval/gold.js';
import { EmptyLlm, MeteredLlm, OracleLlm } from '../src/evidence/eval/llm.js';
import { buildReport, formatTable, type RunMeta } from '../src/evidence/eval/report.js';
import { loadRegistryFile } from '../src/evidence/eval/registry.js';
import { runExtraction, scoreRuns } from '../src/evidence/eval/runner.js';

const DEFAULT_DATASET = 'tests/fixtures/calibration';
const MAX_OUTPUT_TOKENS_CEILING = 4000;
const MAX_CALLS_CEILING = 400;

function fail(message: string): never {
  process.stderr.write(`extraction-eval: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith('--')) fail(`unexpected argument "${a}"`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.set(a.slice(2), next);
      i++;
    } else out.set(a.slice(2), true);
  }
  return out;
}

function intArg(
  args: Map<string, string | true>,
  name: string,
  min: number,
  max: number,
): number | null {
  const v = args.get(name);
  if (v === undefined) return null;
  const n = Number(v);
  if (typeof v !== 'string' || !Number.isInteger(n) || n < min || n > max)
    fail(`--${name} must be an integer from ${min} to ${max}`);
  return n;
}

const replayFileSchema = z.object({
  version: z.literal(1),
  store: z.record(z.string(), z.unknown()),
});

async function runCommand(args: Map<string, string | true>): Promise<void> {
  const adapter = args.get('adapter');
  if (
    adapter !== 'gemini' &&
    adapter !== 'replay' &&
    adapter !== 'oracle' &&
    adapter !== 'oracle-best' &&
    adapter !== 'empty'
  )
    fail('--adapter must be one of gemini, replay, oracle, oracle-best, empty');
  const promptVersion =
    typeof args.get('prompt') === 'string' ? String(args.get('prompt')) : 'extract-v1';
  if (!(promptVersion in EXTRACTION_PROMPTS))
    fail(`--prompt must be one of ${Object.keys(EXTRACTION_PROMPTS).join(', ')}`);
  const prompt = extractionPromptFor(promptVersion);
  const set = loadCalibrationSet(resolve(String(args.get('dataset') ?? DEFAULT_DATASET)));
  const pageIds =
    typeof args.get('pages') === 'string' ? String(args.get('pages')).split(',') : undefined;
  if (pageIds) {
    const known = new Set(set.pages.map((p) => p.id));
    for (const id of pageIds) if (!known.has(id)) fail(`unknown page id "${id}"`);
  }
  const selected = pageIds ? pageIds.length : set.pages.length;
  const maxOutputTokens =
    intArg(args, 'max-output-tokens', 100, MAX_OUTPUT_TOKENS_CEILING) ?? EXTRACTION_MAX_TOKENS;

  let inner: LlmPort;
  let model: string | null = null;
  let maxCalls: number | null = null;
  let providerRequests = (): number | null => null;
  const notes: string[] = [];
  const recordTo = args.get('record-to');
  const store: ReplayStore = {};

  if (adapter === 'gemini') {
    if (args.get('confirm-live-calls') !== true)
      fail(
        'a live run sends page text to the provider and spends quota: pass --confirm-live-calls',
      );
    maxCalls = intArg(args, 'max-calls', 1, MAX_CALLS_CEILING);
    if (maxCalls === null) fail('--max-calls N is required for a live run');
    if (maxCalls < selected)
      fail(
        `--max-calls ${maxCalls} is smaller than the number of pages (${selected}): the run would be incomplete`,
      );
    const key = process.env.GEMINI_API_KEY;
    model = process.env.GEMINI_MODEL ?? null;
    if (!key || !model) fail('GEMINI_API_KEY and GEMINI_MODEL must be set in the environment');
    let used = 0;
    const cap = maxCalls;
    const countingFetch: typeof fetch = (input, init) => {
      if (used >= cap) return Promise.reject(new Error('extraction-eval: request cap reached'));
      used += 1;
      return fetch(input, init);
    };
    providerRequests = () => used;
    const clock = { now: () => Date.now() };
    inner = new GeminiLlm({
      // maxRetries 0: the cap is then also a cap on provider requests, and a failure is a recorded failure.
      config: geminiConfigFromApp(
        { gemini: { model }, secrets: { geminiApiKey: key } },
        { maxRetries: 0, requestTimeoutMs: 60_000 },
      ),
      fetch: countingFetch,
      clock,
      limiter: new ClientLimiter(DEFAULT_LIMITER, { clock, sleep: realSleep }),
    });
    process.stderr.write(
      `extraction-eval: live run, prompt ${promptVersion}, ${selected} pages, at most ${maxCalls} provider requests, at most ${maxOutputTokens} output tokens per call.\n`,
    );
    if (typeof recordTo === 'string') inner = new RecordingLlm(inner, store);
  } else if (adapter === 'replay') {
    const file = args.get('replay');
    if (typeof file !== 'string') fail('--replay <file> is required for the replay adapter');
    const parsed = replayFileSchema.safeParse(JSON.parse(readFileSync(resolve(file), 'utf8')));
    if (!parsed.success) fail('the replay file is not a recorded-replies file');
    inner = new ReplayLlm(parsed.data.store as ReplayStore);
    notes.push('replayed recorded replies: no model was called in this run');
  } else if (adapter === 'empty') {
    inner = new EmptyLlm();
    notes.push('the empty adapter proposes nothing: this is not a measurement');
  } else {
    inner = new OracleLlm(set.pages, { useBestAchievable: adapter === 'oracle-best' });
    notes.push(
      'the oracle adapter answers with the gold claims: it measures the verifier ceiling, not a model',
    );
  }

  const registryFile = args.get('registry');
  if (registryFile === true) fail('--registry needs a file');
  let registry: ReturnType<typeof loadRegistryFile> | undefined;
  if (typeof registryFile === 'string') {
    try {
      registry = loadRegistryFile(resolve(registryFile));
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }
  if (registry)
    notes.push(
      `an owner registry was supplied (${registryFile}): owned domains can bind a subject (ADR-41)`,
    );

  const llm = new MeteredLlm(inner, maxOutputTokens);
  const startedAt = new Date().toISOString();
  const runs = await runExtraction(set, {
    llm,
    prompt,
    now: Date.now(),
    ...(registry ? { registry } : {}),
    ...(pageIds ? { pageIds } : {}),
    onPage: (r, i, n) =>
      process.stderr.write(
        `extraction-eval: ${i}/${n} ${r.pageId}: ${r.extractionFailure ?? `${r.statements.length} statements`}\n`,
      ),
  });
  const failed = runs.filter((r) => r.extractionFailure !== null).length;
  if (failed > 0)
    notes.push(`${failed} page(s) had a failed extraction call and count as nothing extracted`);

  const meta: RunMeta = {
    promptVersion,
    adapter,
    model,
    startedAt,
    datasetPages: runs.length,
    datasetClaims: set.pages
      .filter((p) => runs.some((r) => r.pageId === p.id))
      .reduce((n, p) => n + p.gold.claims.length, 0),
    calls: llm.totals.calls,
    providerRequests: providerRequests(),
    maxCalls,
    maxOutputTokens,
    usage: llm.totals.usage,
    notes,
  };
  const report = buildReport(meta, scoreRuns(set, runs));

  if (typeof recordTo === 'string') {
    writeFileSync(
      resolve(recordTo),
      `${JSON.stringify({ version: 1, promptVersion, model, store }, null, 2)}\n`,
    );
  }
  const outFile = args.get('out');
  if (typeof outFile === 'string')
    writeFileSync(resolve(outFile), `${JSON.stringify(report, null, 2)}\n`);
  if (args.get('json') === true) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${formatTable(report)}\n`);
}

async function captureCommand(args: Map<string, string | true>): Promise<void> {
  if (args.get('confirm-live-calls') !== true)
    fail(
      'capture sends one request to the search provider (about USD 0.007): pass --confirm-live-calls',
    );
  const domain = args.get('domain');
  const query = args.get('query');
  const outDir = args.get('out-dir');
  if (typeof domain !== 'string' || typeof query !== 'string' || typeof outDir !== 'string')
    fail('--domain, --query and --out-dir are required');
  const n = intArg(args, 'num-results', 1, 5) ?? 3;
  const key = process.env.EXA_API_KEY;
  if (!key) fail('EXA_API_KEY must be set in the environment');
  let requestId: string | undefined;
  const search = new ExaSearchAdapter({
    apiKey: key,
    fetch: (input, init) => fetch(input, init),
    clock: { now: () => Date.now() },
    record: (ex) => {
      const raw = ex.providerRaw;
      if (
        typeof raw === 'object' &&
        raw !== null &&
        'requestId' in raw &&
        typeof raw.requestId === 'string'
      )
        requestId = raw.requestId;
    },
  });
  const res = await search.search(captureRequest(query, domain, n), AbortSignal.timeout(60_000));
  mkdirSync(resolve(outDir), { recursive: true });
  for (const hit of res.hits) {
    const page = pageFromHit(hit, {
      provider: search.provider,
      capturedAt: res.observedAt,
      ...(requestId !== undefined ? { requestId } : {}),
    });
    const slug = page.urlNorm
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
    const file = join(resolve(outDir), `${slug.slice(0, 80)}.json`);
    writeFileSync(file, `${JSON.stringify(page, null, 2)}\n`);
    process.stdout.write(`${page.url}  ${page.text.length} chars  ${file}\n`);
  }
  process.stdout.write(
    `1 request, cost ${res.costUsd === null ? 'not reported' : `USD ${res.costUsd}`}\n`,
  );
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'run') await runCommand(parseArgs(rest));
  else if (cmd === 'capture') await captureCommand(parseArgs(rest));
  else fail('usage: extraction-eval.ts run|capture [flags] (see the header of this file)');
}

await main();

/**
 * Model benchmark command. NOT RUN by the test suite and not run by the authors: see docs/model-evaluation.md.
 *
 *   npx tsx scripts/model-bench.ts --adapter fake --max-calls 10
 *   GEMINI_API_KEY=... GEMINI_MODEL=... npx tsx scripts/model-bench.ts --adapter gemini --max-calls 8 --confirm-live-calls
 *
 * It refuses to run without --max-calls, and refuses a live adapter without --confirm-live-calls. It reads the
 * key and model only from process.env (never from a file), sends only the fixed SYNTHETIC cases, and prints a
 * JSON report of observed values to stdout. The fake adapter answers with canned replies: its output is a wiring
 * check, not a measurement.
 */
import { fakeBenchLlm } from '../src/llm/bench/fake.js';
import { runBenchmark } from '../src/llm/bench/harness.js';
import { realSleep } from '../src/llm/abort.js';
import { GeminiLlm } from '../src/llm/gemini/adapter.js';
import { geminiConfigFromApp } from '../src/llm/gemini/config.js';
import { ClientLimiter, DEFAULT_LIMITER } from '../src/llm/limiter.js';
import type { LlmPort } from '../src/shared/llm.js';

function fail(message: string): never {
  process.stderr.write(`model-bench: ${message}\n`);
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const adapter = args.get('adapter');
  if (adapter !== 'fake' && adapter !== 'gemini') fail('--adapter must be "fake" or "gemini"');
  const maxCalls = Number(args.get('max-calls'));
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 50) {
    fail('--max-calls is required: an integer from 1 to 50');
  }

  const clock = { now: () => Date.now() };
  let llm: LlmPort;
  if (adapter === 'fake') {
    llm = fakeBenchLlm();
    process.stderr.write('model-bench: fake adapter, canned replies. This is not a measurement.\n');
  } else {
    if (args.get('confirm-live-calls') !== true) {
      fail(
        'a live run spends the free-tier quota and sends prompts to the provider: pass --confirm-live-calls',
      );
    }
    const key = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL;
    if (!key || !model) fail('GEMINI_API_KEY and GEMINI_MODEL must be set in the environment');
    llm = new GeminiLlm({
      // maxRetries 0: the call cap is then also a cap on provider requests.
      config: geminiConfigFromApp(
        { gemini: { model }, secrets: { geminiApiKey: key } },
        { maxRetries: 0, requestTimeoutMs: 30_000 },
      ),
      fetch,
      clock,
      limiter: new ClientLimiter(DEFAULT_LIMITER, { clock, sleep: realSleep }),
    });
    process.stderr.write(
      `model-bench: live run, at most ${maxCalls} calls, synthetic prompts only.\n`,
    );
  }

  const priceIn = args.get('price-in');
  const priceOut = args.get('price-out');
  const report = await runBenchmark({
    llm,
    clock,
    maxCalls,
    callTimeoutMs: 60_000,
    ...(typeof priceIn === 'string' && typeof priceOut === 'string'
      ? { prices: { inputPerMillion: Number(priceIn), outputPerMillion: Number(priceOut) } }
      : {}),
  });
  process.stdout.write(`${JSON.stringify({ adapter, ...report }, null, 2)}\n`);
}

await main();

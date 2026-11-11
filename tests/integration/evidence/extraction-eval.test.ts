import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCalibrationSet } from '../../../src/evidence/eval/gold.js';
import { EmptyLlm, MeteredLlm, OracleLlm } from '../../../src/evidence/eval/llm.js';
import { buildReport, formatTable, type RunMeta } from '../../../src/evidence/eval/report.js';
import { runExtraction, scoreRuns } from '../../../src/evidence/eval/runner.js';
import { extractionPromptFor } from '../../../src/evidence/prompts/extraction.js';
import { FakeLlm } from '../../../src/llm/fake.js';
import { RecordingLlm, ReplayLlm, type ReplayStore } from '../../../src/llm/replay.js';
import { LlmError } from '../../../src/shared/llm.js';

/**
 * The evaluation path end to end with models that need no network: the gold-answering oracle, an empty model,
 * a scripted fake, a recorded-and-replayed one, and failures. No model is measured here.
 */
const ROOT = join(import.meta.dirname, '..', '..', '..');
const set = loadCalibrationSet(join(ROOT, 'tests', 'fixtures', 'calibration'));
const NOW = Date.UTC(2026, 10, 12, 12);

const META: RunMeta = {
  promptVersion: 'extract-v1',
  adapter: 'oracle',
  model: null,
  startedAt: '2026-11-12T00:00:00.000Z',
  datasetPages: set.pages.length,
  datasetClaims: set.pages.reduce((n, p) => n + p.gold.claims.length, 0),
  calls: 0,
  providerRequests: null,
  maxCalls: null,
  maxOutputTokens: 2500,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  notes: [],
};

describe('evaluation over the gold pages with the oracle model', () => {
  it('extracts every gold claim through the real extractor and verifier, and scores it perfectly', async () => {
    const runs = await runExtraction(set, { llm: new OracleLlm(set.pages), now: NOW });
    expect(runs).toHaveLength(set.pages.length);
    expect(runs.every((r) => r.extractionFailure === null)).toBe(true);
    const scores = scoreRuns(set, runs);
    const report = buildReport(META, scores);
    const goldTotal = set.pages.reduce((n, p) => n + p.gold.claims.length, 0);
    expect(report.summary.precision).toEqual({
      numerator: goldTotal,
      denominator: goldTotal,
      value: 1,
    });
    expect(report.summary.recall.value).toBe(1);
    expect(report.summary.falsePassRate.value).toBe(0);
    for (const k of Object.values(report.summary.fieldAccuracy)) expect(k.value).toBe(1);
    expect(report.summary.quote.accurate.value).toBe(1);
    expect(report.summary.negativeControls.priceStatements).toBe(0);
  });

  it('verifies the oracle statements exactly as the oracle test does: same verdicts, via the model path', async () => {
    const runs = await runExtraction(set, { llm: new OracleLlm(set.pages), now: NOW });
    for (const r of runs) {
      const gold = set.pages.find((p) => p.id === r.pageId)?.gold.claims ?? [];
      const verdicts = r.statements.map((s) => s.verification.status);
      expect(verdicts, r.pageId).toEqual(gold.map((c) => c.expected.status));
    }
  });

  it('the best-achievable oracle verifies more claims than the plain one', async () => {
    const plain = buildReport(
      META,
      scoreRuns(set, await runExtraction(set, { llm: new OracleLlm(set.pages), now: NOW })),
    );
    const best = buildReport(
      META,
      scoreRuns(
        set,
        await runExtraction(set, {
          llm: new OracleLlm(set.pages, { useBestAchievable: true }),
          now: NOW,
        }),
      ),
    );
    expect(best.summary.statusCounts.pass).toBeGreaterThan(plain.summary.statusCounts.pass);
    expect(best.summary.falsePassRate.value).toBe(0);
  });

  it('the model that finds nothing has no precision and zero recall; negative controls are clean', async () => {
    const report = buildReport(
      META,
      scoreRuns(set, await runExtraction(set, { llm: new EmptyLlm(), now: NOW })),
    );
    expect(report.summary.precision.value).toBeNull();
    expect(report.summary.recall.value).toBe(0);
    expect(report.summary.negativeControls.pagesWithPriceStatements).toBe(0);
  });

  it('can be limited to some pages', async () => {
    const runs = await runExtraction(set, {
      llm: new OracleLlm(set.pages),
      now: NOW,
      pageIds: ['close-plans-and-billing'],
    });
    expect(runs.map((r) => r.pageId)).toEqual(['close-plans-and-billing']);
  });

  it('renders a readable table and a JSON report that holds no secret and no page text', async () => {
    const report = buildReport(
      META,
      scoreRuns(set, await runExtraction(set, { llm: new OracleLlm(set.pages), now: NOW })),
    );
    const table = formatTable(report);
    for (const heading of [
      'Claim level',
      'Field accuracy',
      'Supporting quote',
      'By category',
      'false-pass rate',
    ])
      expect(table).toContain(heading);
    for (const p of set.pages) expect(table).toContain(p.id);
    const json = JSON.stringify(report);
    expect(JSON.parse(json)).toMatchObject({ version: 1, meta: { promptVersion: 'extract-v1' } });
    expect(json).not.toContain(set.pages[0]?.page.text.slice(0, 80) ?? 'x');
  });
});

describe('the evaluation records what the model did, and survives its failures', () => {
  const page = set.pages.find((p) => p.id === 'close-plans-and-billing');
  if (!page) throw new Error('fixture page missing');
  const one = { ...set, pages: [page] };

  it('a failed extraction call is recorded for the page, not thrown, and scores as nothing extracted', async () => {
    const llm = new FakeLlm().queueStructured(new LlmError('unavailable', 'provider down'));
    const runs = await runExtraction(one, { llm, now: NOW });
    expect(runs[0]?.extractionFailure).toMatch(/unavailable/);
    const [score] = scoreRuns(one, runs);
    expect(score?.extractionFailure).toMatch(/unavailable/);
    expect(score?.matchedGold).toBe(0);
  });

  it('an output that fails the schema is a recorded failure too', async () => {
    const llm = new FakeLlm().queueStructured({ statements: 'nope' });
    const runs = await runExtraction(one, { llm, now: NOW });
    expect(runs[0]?.extractionFailure).toMatch(/invalid_output/);
  });

  it('a statement citing a source that was not supplied is dropped, not scored', async () => {
    const llm = new FakeLlm().queueStructured({
      statements: [
        {
          sourceId: 'S9',
          entityId: 'E1',
          kind: 'price',
          plan: 'Essentials',
          planNorm: 'essentials',
          value: null,
          releaseTitle: null,
          releaseKind: null,
          conditions: null,
          quote: 'x',
          contextQuote: null,
          polarity: 'affirmed',
          modality: 'current',
          effectiveFromText: null,
          eventDateText: null,
          significance: null,
          significanceReason: null,
        },
      ],
    });
    const runs = await runExtraction(one, { llm, now: NOW });
    expect(runs[0]?.droppedUnknownRef).toBe(1);
    expect(runs[0]?.statements).toEqual([]);
  });

  it('the selected prompt reaches the model, unchanged message and schema name', async () => {
    const llm = new FakeLlm().queueStructured({ statements: [] }, { statements: [] });
    await runExtraction(one, { llm, now: NOW });
    await runExtraction(one, { llm, now: NOW, prompt: extractionPromptFor('extract-v2') });
    const [a, b] = llm.structuredCalls;
    expect(a?.system).toBe(extractionPromptFor('extract-v1').system);
    expect(b?.system).toBe(extractionPromptFor('extract-v2').system);
    expect(a?.messages).toEqual(b?.messages);
    expect(a?.schemaName).toBe(b?.schemaName);
  });

  it('caps output tokens and counts calls and usage', async () => {
    const fake = new FakeLlm().queueStructured({ statements: [] });
    const metered = new MeteredLlm(fake, 1000);
    await runExtraction(one, { llm: metered, now: NOW });
    expect(metered.totals.calls).toBe(1);
    expect(fake.structuredCalls[0]?.maxTokens).toBe(1000);
    expect(() => new MeteredLlm(fake, 0)).toThrow(RangeError);
  });

  it('recorded replies can be scored again without calling the model', async () => {
    const store: ReplayStore = {};
    const recorder = new RecordingLlm(new OracleLlm(set.pages), store);
    const first = scoreRuns(one, await runExtraction(one, { llm: recorder, now: NOW }));
    expect(Object.keys(store)).toHaveLength(1);
    const again = scoreRuns(one, await runExtraction(one, { llm: new ReplayLlm(store), now: NOW }));
    expect(again.map((s) => s.matchedGoldIds)).toEqual(first.map((s) => s.matchedGoldIds));
  });
});

describe('the command line refuses to spend without explicit flags', () => {
  const script = join(ROOT, 'scripts', 'extraction-eval.ts');
  // No credentials in the child environment unless the test puts a canary there.
  const baseEnv = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: ROOT,
      env: { ...baseEnv, ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });
  const CANARY = 'canary-secret-value-do-not-print';

  it('refuses a live run without --confirm-live-calls', () => {
    const r = run(['run', '--adapter', 'gemini', '--max-calls', '30'], {
      GEMINI_API_KEY: CANARY,
      GEMINI_MODEL: 'some-model',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--confirm-live-calls');
    expect(r.stdout + r.stderr).not.toContain(CANARY);
  });

  it('refuses a live run without --max-calls', () => {
    const r = run(['run', '--adapter', 'gemini', '--confirm-live-calls'], {
      GEMINI_API_KEY: CANARY,
      GEMINI_MODEL: 'some-model',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--max-calls');
  });

  it('refuses a cap smaller than the number of pages', () => {
    const r = run(['run', '--adapter', 'gemini', '--confirm-live-calls', '--max-calls', '3'], {
      GEMINI_API_KEY: CANARY,
      GEMINI_MODEL: 'some-model',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('smaller than the number of pages');
  });

  it('refuses a live run when the key or model is not in the environment, and never reads a .env file', () => {
    const r = run(['run', '--adapter', 'gemini', '--confirm-live-calls', '--max-calls', '40']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GEMINI_API_KEY and GEMINI_MODEL must be set in the environment');
  });

  it('refuses an excessive output-token cap and unknown prompts or adapters', () => {
    expect(run(['run', '--adapter', 'oracle', '--max-output-tokens', '99999']).status).toBe(2);
    expect(run(['run', '--adapter', 'oracle', '--prompt', 'extract-v9']).status).toBe(2);
    expect(run(['run', '--adapter', 'live']).status).toBe(2);
    expect(run(['capture', '--domain', 'x.example']).status).toBe(2);
  });

  it('runs offline with the oracle adapter and prints the table', () => {
    const out = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        script,
        'run',
        '--adapter',
        'oracle',
        '--pages',
        'close-plans-and-billing',
      ],
      {
        cwd: ROOT,
        env: baseEnv,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(out).toContain('adapter oracle');
    expect(out).toContain('close-plans-and-billing');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import {
  assertKnownFlags,
  boolFlag,
  intFlag,
  parseArgs,
  stringFlag,
  type ParsedArgs,
} from './args.js';
import { DATA_FILES, DATASETS, isDatasetName, loadDataset, type DatasetName } from './datasets.js';
import { downloadAll, SIMPLEQA_GRADER_SOURCE } from './download.js';
import { defaultGradesPath, GeminiGrader, gradeResults, readGradeFile } from './grade.js';
import { CallRecorder } from './recorder.js';
import { buildReport } from './report.js';
import { RESULTS_DIR, RUNS_DIR } from './results.js';
import { liveLauncher, runBenchmark, scriptedLauncher, type ComponentsKind } from './run.js';
import {
  DEFAULT_SEED,
  DEFAULT_SIZES,
  drawSamples,
  manifestEntry,
  readManifest,
  readSample,
  sha256File,
  writeManifest,
  writeSample,
  type Split,
} from './sampler.js';

/**
 * Benchmark harness entry point: `npm run bench -- <command> [flags]`.
 *
 *   download  [--dataset d] [--freshqa-url url]
 *   sample    [--dataset d] [--split dev|test --n N] [--seed s]
 *   run       --dataset d --split dev|test [--components live|scripted] [--n N] [--seed s] [--out file.jsonl]
 *             [--pause-ms ms] [--max-questions N] [--max-rate-limited N] [--keep-dbs] [--verbose]
 *   grade     --dataset d --split dev|test [--components live|scripted] [--results file.jsonl] [--out file.json]
 *             [--grader-model name] [--pause-ms ms]
 *   report    [--grades a.json,b.json] [--out file.md]
 *
 * Keys are read from the environment only (npm run bench loads an ignored .env if present) and never printed.
 */

function datasetFlag(args: ParsedArgs, required: boolean): DatasetName | undefined {
  const v = stringFlag(args, 'dataset');
  if (v === undefined) {
    if (required) throw new Error(`--dataset is required (${DATASETS.join(', ')})`);
    return undefined;
  }
  if (!isDatasetName(v)) throw new Error(`--dataset must be one of ${DATASETS.join(', ')}`);
  return v;
}

function splitFlag(args: ParsedArgs, required: boolean): Split | undefined {
  const v = stringFlag(args, 'split');
  if (v === undefined) {
    if (required) throw new Error('--split dev|test is required');
    return undefined;
  }
  if (v !== 'dev' && v !== 'test') throw new Error('--split must be dev or test');
  return v;
}

function componentsFlag(args: ParsedArgs): ComponentsKind {
  const v = stringFlag(args, 'components') ?? 'live';
  if (v !== 'live' && v !== 'scripted') throw new Error('--components must be live or scripted');
  return v;
}

export function defaultResultsPath(
  dataset: DatasetName,
  split: Split,
  components: ComponentsKind,
): string {
  return path.join(RESULTS_DIR, `${dataset}-${split}-${components}.jsonl`);
}

async function sampleCommand(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ['dataset', 'split', 'n', 'seed']);
  const only = datasetFlag(args, false);
  const split = splitFlag(args, false);
  const seed = stringFlag(args, 'seed') ?? DEFAULT_SEED;
  const sizes = { ...DEFAULT_SIZES };
  if (args.flags.has('n')) {
    if (split === undefined) throw new Error('--n needs --split (the size of which sample)');
    sizes[split] = intFlag(args, 'n', sizes[split]);
  }
  const manifest = readManifest();
  for (const dataset of DATASETS) {
    if (only !== undefined && dataset !== only) continue;
    const file = DATA_FILES[dataset];
    const items = loadDataset(dataset, file);
    const samples = drawSamples(dataset, items, {
      seed,
      sizes,
      source: { file, sha256: sha256File(file) },
    });
    const entry = (manifest[dataset] ??= {});
    for (const s of [samples.dev, samples.test]) {
      const written = writeSample(s);
      entry[s.split] = manifestEntry(s);
      process.stdout.write(
        `${dataset}/${s.split}: ${s.n} items, seed ${seed} -> ${written} (${Object.entries(s.strata)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')})\n`,
      );
    }
  }
  await writeManifest(manifest);
  process.stdout.write('manifest (ids only) updated: scripts/bench/manifest.json\n');
}

async function runCommand(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, [
    'dataset',
    'split',
    'components',
    'n',
    'seed',
    'out',
    'pause-ms',
    'max-questions',
    'max-rate-limited',
    'keep-dbs',
    'verbose',
  ]);
  const dataset = datasetFlag(args, true) as DatasetName;
  const split = splitFlag(args, true) as Split;
  const components = componentsFlag(args);
  const sample = readSample(dataset, split);
  const seed = stringFlag(args, 'seed');
  if (seed !== undefined && seed !== sample.seed) {
    throw new Error(
      `the ${dataset}/${split} sample was drawn with seed "${sample.seed}"; re-run "sample" with --seed ${seed} first`,
    );
  }
  const items = sample.items.slice(0, intFlag(args, 'n', sample.items.length));
  const recorder = new CallRecorder();
  const launcher =
    components === 'live'
      ? liveLauncher(recorder, process.env, boolFlag(args, 'verbose'))
      : scriptedLauncher();
  const runId = `${dataset}-${split}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const summary = await runBenchmark({
    dataset,
    split,
    items,
    out: stringFlag(args, 'out') ?? defaultResultsPath(dataset, split, components),
    runId,
    components,
    model: components === 'live' ? (process.env['GEMINI_MODEL'] ?? null) : null,
    launcher,
    recorder,
    dbDir: RUNS_DIR,
    keepDbs: boolFlag(args, 'keep-dbs'),
    pauseMs: intFlag(args, 'pause-ms', components === 'live' ? 10_000 : 0),
    maxQuestions: args.flags.has('max-questions') ? intFlag(args, 'max-questions', 0) : null,
    maxConsecutiveRateLimited: intFlag(args, 'max-rate-limited', 3),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.stopped !== null) process.exitCode = 2;
}

async function gradeCommand(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, [
    'dataset',
    'split',
    'components',
    'results',
    'out',
    'grader-model',
    'pause-ms',
  ]);
  const dataset = datasetFlag(args, true) as DatasetName;
  const split = splitFlag(args, true) as Split;
  const results =
    stringFlag(args, 'results') ?? defaultResultsPath(dataset, split, componentsFlag(args));
  if (!fs.existsSync(results))
    throw new Error(`${results} does not exist: run the questions first`);
  const model = stringFlag(args, 'grader-model') ?? process.env['GRADER_MODEL'];
  if (!model) throw new Error('GRADER_MODEL is not set (or pass --grader-model)');
  const key = process.env['GEMINI_API_KEY'];
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const upstream = fs.existsSync(SIMPLEQA_GRADER_SOURCE.file)
    ? fs.readFileSync(SIMPLEQA_GRADER_SOURCE.file, 'utf8')
    : null;
  const out = stringFlag(args, 'out') ?? defaultGradesPath(results);
  const { file, stopped } = await gradeResults({
    dataset,
    split,
    items: readSample(dataset, split).items,
    resultsFile: results,
    out,
    grader: new GeminiGrader(model, key),
    upstreamSimpleQa: upstream,
    pauseMs: intFlag(args, 'pause-ms', 4000),
  });
  const counts: Record<string, number> = {};
  for (const g of file.items) counts[g.grade] = (counts[g.grade] ?? 0) + 1;
  process.stdout.write(`${out}: ${JSON.stringify(counts)}\n`);
  if (stopped !== null) {
    process.stdout.write(`stopped: ${stopped}; re-run the same command later to finish\n`);
    process.exitCode = 2;
  }
}

function reportCommand(args: ParsedArgs): void {
  assertKnownFlags(args, ['grades', 'out']);
  const listed = stringFlag(args, 'grades');
  const files =
    listed !== undefined
      ? listed.split(',').map((s) => s.trim())
      : fs.existsSync(RESULTS_DIR)
        ? fs
            .readdirSync(RESULTS_DIR)
            .filter((f) => f.endsWith('.grades.json'))
            .sort()
            .map((f) => path.join(RESULTS_DIR, f))
        : [];
  if (files.length === 0) throw new Error('no grade files found: run "grade" first');
  const now = new Date();
  const md = buildReport(files.map(readGradeFile), now);
  const out =
    stringFlag(args, 'out') ??
    path.join(RESULTS_DIR, `report-${now.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md);
  process.stdout.write(`${out}\n`);
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  switch (command) {
    case 'download': {
      assertKnownFlags(args, ['dataset', 'freshqa-url']);
      const only = datasetFlag(args, false);
      const freshQaUrl = stringFlag(args, 'freshqa-url') ?? process.env['FRESHQA_CSV_URL'];
      await downloadAll({
        ...(only !== undefined ? { only } : {}),
        ...(freshQaUrl ? { freshQaUrl } : {}),
      });
      return;
    }
    case 'sample':
      return sampleCommand(args);
    case 'run':
      return runCommand(args);
    case 'grade':
      return gradeCommand(args);
    case 'report':
      return reportCommand(args);
    default:
      throw new Error('usage: npm run bench -- download|sample|run|grade|report [flags]');
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

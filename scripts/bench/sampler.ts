import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BenchItem, DatasetName } from './datasets.js';

/**
 * Deterministic stratified sampling. Each item gets a rank from sha256(seed:id), so the order does not depend
 * on the order of the file. Within every stratum the items are taken in rank order: the test sample takes the
 * first places, the dev sample the places after them, so the two never overlap, and the test sample does not
 * change when the dev size changes. Sizes are proportional to the stratum sizes (largest remainder), with at
 * least one item per stratum whenever the sample is large enough to allow it.
 */

export type Split = 'dev' | 'test';
export const SPLITS: readonly Split[] = ['dev', 'test'];

export const DEFAULT_SEED = 'recalliq-bench-1';
export const DEFAULT_SIZES: Record<Split, number> = { dev: 30, test: 100 };

export function rank(seed: string, id: string): string {
  return createHash('sha256').update(`${seed}:${id}`).digest('hex');
}

export function stratumOf(item: BenchItem): string {
  switch (item.dataset) {
    case 'simpleqa':
      return item.topic;
    case 'freshqa':
      return `${item.factType}/${item.falsePremise ? 'false-premise' : 'valid-premise'}`;
    case 'longmemeval':
      return item.abstention ? `${item.questionType}/abstention` : item.questionType;
  }
}

/** The pool each split draws from. FreshQA ships its own DEV and TEST splits and they are kept apart. */
export function poolFor(dataset: DatasetName, split: Split, items: BenchItem[]): BenchItem[] {
  if (dataset !== 'freshqa') return items;
  const wanted = split === 'test' ? 'TEST' : 'DEV';
  return items.filter((i) => i.dataset === 'freshqa' && i.split === wanted);
}

/**
 * Splits `n` over strata of the given capacities, proportionally to `weights`. Every stratum with capacity
 * gets one first when `n` allows it; the rest go one at a time to the stratum furthest below its
 * proportional target, ties broken by position. Never exceeds a capacity; the sum is min(n, total capacity).
 */
export function allocate(
  n: number,
  capacities: number[],
  weights: number[] = capacities,
): number[] {
  const alloc = capacities.map(() => 0);
  const totalCap = capacities.reduce((a, b) => a + b, 0);
  let left = Math.min(n, totalCap);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const open = capacities.map((c, i) => ({ c, i })).filter((x) => x.c > 0);
  if (left >= open.length) {
    for (const { i } of open) alloc[i] = 1;
    left -= open.length;
  } else {
    // Not enough for one each: the largest strata first.
    const order = [...open].sort((a, b) => (weights[b.i] ?? 0) - (weights[a.i] ?? 0) || a.i - b.i);
    for (const { i } of order.slice(0, left)) alloc[i] = 1;
    return alloc;
  }
  const target = weights.map((w) => (totalWeight === 0 ? 0 : (n * w) / totalWeight));
  while (left > 0) {
    let best = -1;
    let bestGap = -Infinity;
    for (let i = 0; i < capacities.length; i++) {
      if ((alloc[i] ?? 0) >= (capacities[i] ?? 0)) continue;
      const gap = (target[i] ?? 0) - (alloc[i] ?? 0);
      if (gap > bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    if (best < 0) break;
    alloc[best] = (alloc[best] ?? 0) + 1;
    left -= 1;
  }
  return alloc;
}

export interface SampleMeta {
  dataset: DatasetName;
  split: Split;
  seed: string;
  n: number;
  /** The data file and its sha256, so a sample can be traced to the exact file it was drawn from. */
  source: { file: string; sha256: string };
  /** Items per stratum in this sample. */
  strata: Record<string, number>;
  /** In rank order, which interleaves the strata (a partial run still covers them). */
  ids: string[];
}

export interface Sample extends SampleMeta {
  items: BenchItem[];
}

function byStratum(items: BenchItem[], seed: string): Map<string, BenchItem[]> {
  const groups = new Map<string, BenchItem[]>();
  for (const item of items) {
    const key = stratumOf(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (rank(seed, a.id) < rank(seed, b.id) ? -1 : 1));
  }
  return new Map([...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/** Both samples of a dataset at once, so that disjointness holds by construction. */
export function drawSamples(
  dataset: DatasetName,
  items: BenchItem[],
  options: { seed: string; sizes: Record<Split, number>; source: SampleMeta['source'] },
): Record<Split, Sample> {
  const { seed, sizes, source } = options;
  const testGroups = byStratum(poolFor(dataset, 'test', items), seed);
  const testKeys = [...testGroups.keys()];
  const testAlloc = allocate(
    sizes.test,
    testKeys.map((k) => testGroups.get(k)?.length ?? 0),
  );
  const test: BenchItem[] = [];
  const taken = new Set<string>();
  testKeys.forEach((k, i) => {
    for (const item of (testGroups.get(k) ?? []).slice(0, testAlloc[i] ?? 0)) {
      test.push(item);
      taken.add(item.id);
    }
  });

  const devGroups = byStratum(
    poolFor(dataset, 'dev', items).filter((i) => !taken.has(i.id)),
    seed,
  );
  const devKeys = [...devGroups.keys()];
  // Proportions follow the whole pool, capacities what the test sample left.
  const fullGroups = byStratum(poolFor(dataset, 'dev', items), seed);
  const devAlloc = allocate(
    sizes.dev,
    devKeys.map((k) => devGroups.get(k)?.length ?? 0),
    devKeys.map((k) => fullGroups.get(k)?.length ?? 0),
  );
  const dev: BenchItem[] = [];
  devKeys.forEach((k, i) => {
    dev.push(...(devGroups.get(k) ?? []).slice(0, devAlloc[i] ?? 0));
  });

  const build = (split: Split, chosen: BenchItem[]): Sample => {
    const ordered = [...chosen].sort((a, b) => (rank(seed, a.id) < rank(seed, b.id) ? -1 : 1));
    const strata: Record<string, number> = {};
    for (const item of ordered) strata[stratumOf(item)] = (strata[stratumOf(item)] ?? 0) + 1;
    return {
      dataset,
      split,
      seed,
      n: ordered.length,
      source,
      strata: Object.fromEntries(Object.entries(strata).sort((a, b) => (a[0] < b[0] ? -1 : 1))),
      ids: ordered.map((i) => i.id),
      items: ordered,
    };
  };
  return { dev: build('dev', dev), test: build('test', test) };
}

// ── files ──

export const SAMPLES_DIR = 'data/benchmarks/samples';
export const MANIFEST_FILE = 'scripts/bench/manifest.json';

export function samplePath(dataset: DatasetName, split: Split, dir = SAMPLES_DIR): string {
  return path.join(dir, `${dataset}-${split}.json`);
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function writeSample(sample: Sample, dir = SAMPLES_DIR): string {
  const file = samplePath(sample.dataset, sample.split, dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(sample, null, 2) + '\n');
  return file;
}

const sampleFileSchema = z.object({
  dataset: z.enum(['simpleqa', 'freshqa', 'longmemeval']),
  split: z.enum(['dev', 'test']),
  seed: z.string(),
  n: z.number().int(),
  source: z.object({ file: z.string(), sha256: z.string() }),
  strata: z.record(z.string(), z.number()),
  ids: z.array(z.string()),
  items: z.array(z.record(z.string(), z.unknown())),
});

/** Reads a sample written by `writeSample`. Items are the loaders' validated output, stored as written. */
export function readSample(dataset: DatasetName, split: Split, dir = SAMPLES_DIR): Sample {
  const file = samplePath(dataset, split, dir);
  if (!fs.existsSync(file)) {
    throw new Error(`${file} is missing: run "npm run bench -- sample --dataset ${dataset}" first`);
  }
  const parsed = sampleFileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  return { ...parsed, items: parsed.items as unknown as BenchItem[] };
}

/** The committed manifest: ids, seed, sizes and source checksums only, never question or answer text. */
export type Manifest = Partial<Record<DatasetName, Partial<Record<Split, SampleMeta>>>>;

export function readManifest(file = MANIFEST_FILE): Manifest {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
}

export function manifestEntry(sample: Sample): SampleMeta {
  const { items: _items, ...meta } = sample;
  void _items;
  return meta;
}

export async function writeManifest(manifest: Manifest, file = MANIFEST_FILE): Promise<void> {
  const raw = JSON.stringify(manifest, null, 2);
  let text = raw + '\n';
  try {
    // Keep the committed file in the repository's own formatting, so format:check stays clean.
    const prettier = await import('prettier');
    text = await prettier.format(raw, { parser: 'json', printWidth: 100 });
  } catch {
    /* prettier is a development dependency; plain JSON is still valid */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

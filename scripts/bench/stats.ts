/** Small, dependency-free statistics for the benchmark report. */

export interface Interval {
  low: number;
  high: number;
}

/**
 * Wilson score interval for a binomial proportion (default 95%, z = 1.959964). With n = 0 there is no
 * information: the interval is the whole [0, 1].
 */
export function wilson(successes: number, n: number, z = 1.959963984540054): Interval {
  if (n <= 0) return { low: 0, high: 1 };
  if (successes < 0 || successes > n) throw new RangeError('successes must lie in [0, n]');
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Nearest-rank percentile (q in [0, 1]) of the finite values; null for none. */
export function percentile(values: readonly number[], q: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const k = Math.max(1, Math.ceil(q * xs.length));
  return xs[Math.min(xs.length, k) - 1] ?? null;
}

/** The median as the mean of the two middle values for an even count; null for none. */
export function median(values: readonly number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  if (xs.length % 2 === 1) return xs[mid] ?? null;
  return ((xs[mid - 1] ?? 0) + (xs[mid] ?? 0)) / 2;
}

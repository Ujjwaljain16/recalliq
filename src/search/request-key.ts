import { createHash } from 'node:crypto';
import type { SearchRequest } from '../shared/search.js';

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x)).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Stable hash of a request: key order and undefined fields do not matter. Used for replay lookup. */
export function requestKey(req: SearchRequest): string {
  return createHash('sha256').update(canonical(req)).digest('hex');
}

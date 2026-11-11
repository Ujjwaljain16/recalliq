import type { Finding, PriceVerdictReason } from '../../src/shared/findings.js';
import type { NormalizedValue } from '../../src/shared/evidence.js';

export interface Badge {
  kind: string;
  label: string;
  title: string;
}

export interface FindingRow {
  name: string;
  value: string;
  status: Badge | null;
  verdict: Badge | null;
  baseline: string | null;
  releases: Array<{ title: string; date: string | null; major: boolean }>;
  citations: Array<{ n: number; href: string; label: string; title: string }>;
}

export function formatValue(v: NormalizedValue): string;
export function reasonText(reason: PriceVerdictReason | null): string;
export function findingRow(
  f: Finding,
  sources: Array<{
    n: number;
    sourceId: string;
    url: string;
    domain: string;
    title?: string | null;
  }>,
  opts: { now: number; timeZone: string },
): FindingRow;
export function groupedFindingRows(
  findings: Finding[],
  sources: Parameters<typeof findingRow>[1],
  opts: { now: number; timeZone: string },
): FindingRow[];

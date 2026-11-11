import type { NormalizedValue } from '../shared/evidence.js';
import type { Finding, PriceVerdictReason } from '../shared/findings.js';
import type { Ms, SnapshotId } from '../shared/ids.js';
import type { AnswerRecords, PlaceholderRecord } from './records.js';

/**
 * Turns an authorised record into the text the user sees. The only writer of prices, dates and verdict phrases:
 * the model never types them. Injectable so the integrity check can be tested against a faulty renderer.
 */
export interface Renderer {
  render(record: PlaceholderRecord, records: AnswerRecords): string;
}

/** "3 Nov 2026", in the user's timezone. */
export function formatDate(ms: Ms, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: tz,
  }).format(new Date(ms));
}

/** "Tuesday 3 Nov, 14:05" from a "YYYY-MM-DD HH:mm" local time; anything else is shown as given. */
export function formatLocalTime(localTime: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(localTime);
  if (!m) return localTime;
  const [, y, mo, d, h, mi] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(
    date,
  );
  const dm = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
  return `${weekday} ${dm}, ${h}:${mi}`;
}

function amount(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 4,
  });
}

function money(amt: number, currency: string, symbol: string | null): string {
  if (symbol) return `${symbol}${/[A-Za-z]$/.test(symbol) ? ' ' : ''}${amount(amt)}`;
  if (currency !== 'unknown') return `${currency} ${amount(amt)}`;
  return amount(amt);
}

function unitPhrase(v: NormalizedValue): string {
  const per: Record<NormalizedValue['billingPeriod'], string> = {
    monthly: 'per month',
    annual: 'per year',
    monthly_billed_annually: 'per month, billed annually',
    one_time: 'one-time',
    unspecified: '',
  };
  const period = per[v.billingPeriod];
  if (v.unit === 'per_seat') {
    if (v.billingPeriod === 'one_time') return 'per user, one-time';
    return `per user${period ? ` ${period}` : ''}`;
  }
  if (v.unit === 'usage') {
    return `per ${v.usageUnit ?? 'unit of usage'}${period && v.billingPeriod !== 'one_time' ? `, ${period}` : ''}`;
  }
  return period;
}

/** Plan and arrangement as written into the canonical belief key, e.g. `|p=professional|a=promotional|`. */
export function keyHints(beliefKey: string | null): {
  plan: string | null;
  arrangement: string | null;
} {
  if (!beliefKey) return { plan: null, arrangement: null };
  const get = (k: string): string | null => {
    const m = new RegExp(`\\|${k}=([^|]*)`).exec(beliefKey);
    return m?.[1] && m[1] !== '-' ? m[1] : null;
  };
  const plan = get('p');
  return { plan: plan === 'unspecified' ? null : plan, arrangement: get('a') };
}

function cites(ids: readonly SnapshotId[], records: AnswerRecords): string {
  return ids
    .map((id) => records.citationNumber(id))
    .filter((n): n is number => n !== null)
    .map((n) => `[${n}]`)
    .join('');
}

const withCites = (text: string, c: string): string => (c ? `${text} ${c}` : text);

/** `US$90 per user per month (professional, promotional, currency not stated)` without citations. */
function valueText(v: NormalizedValue, beliefKey: string | null): string {
  const bound =
    v.valueKind === 'lower_bound' ? 'from ' : v.valueKind === 'upper_bound' ? 'up to ' : '';
  const { plan, arrangement } = keyHints(beliefKey);
  const notes = [
    plan,
    arrangement && arrangement !== 'list' ? arrangement : null,
    v.currency === 'unknown' ? 'currency not stated' : null,
  ].filter((x): x is string => x !== null);
  const unit = unitPhrase(v);
  return `${bound}${money(v.amount, v.currency, v.currencySymbol)}${unit ? ` ${unit}` : ''}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

const REASON_TEXT: Record<string, string> = {
  search_timeout: 'the search timed out',
  search_unavailable: 'the search service was unavailable',
  quota_exhausted: 'the search quota was used up',
  extraction_failed: 'the pages could not be read',
  deadline: 'time ran out',
  insufficient_coverage: 'too few recent release sources were found to say there were none',
  low_authority_source: 'only unofficial sources were found',
};

/**
 * A finding whose check failed says so, with the reason of the failure (the verdict reason, else the coverage
 * failure). A first-time research question has no verdict, so this is the only way the reader learns that the
 * search or extraction failed rather than found nothing.
 */
function unableText(f: Finding): string {
  return `couldn't be checked this time (${reasonText(f.verdictReason ?? f.coverage.failure)})`;
}

/** The first condition text of a contested value, trimmed to stay readable; null when there is none. */
function conditionText(conditions: readonly string[] | undefined): string | null {
  const c = conditions?.find((x) => x.trim() !== '')?.trim();
  if (c === undefined) return null;
  return c.length > 90 ? `${c.slice(0, 87).trimEnd()}...` : c;
}

function currentText(f: Finding, records: AnswerRecords): string {
  if (f.currentStatus === 'unable_to_verify') return unableText(f);
  if (f.intent === 'releases') return releasesText(f, records);
  const cur = f.current;
  const c = cites(cur?.citations ?? [], records);
  if (cur?.contested && cur.contested.length >= 2) {
    const per = cur.contested.map((cv, i) => {
      const own = cur.citations.length >= cur.contested!.length ? cur.citations[i] : undefined;
      const cond = conditionText(cv.conditions);
      return withCites(
        `${valueText(cv.value, f.beliefKey)}${cond === null ? '' : ` (${cond})`}`,
        own ? cites([own], records) : '',
      );
    });
    const joined =
      per.length === 2
        ? per.join(' and ')
        : `${per.slice(0, -1).join(', ')} and ${per[per.length - 1]}`;
    const extra = cur.citations.length < cur.contested.length ? ` ${c}` : '';
    // Values that each carry their own condition are a tiered listing, not a disagreement between sources.
    const tiered = cur.contested.every((cv) => conditionText(cv.conditions) !== null);
    return `listed as ${joined}${extra}${tiered ? ' depending on the conditions shown' : ' — official sources disagree'}`;
  }
  if (!cur?.value) return 'no verified price was found';
  const text = valueText(cur.value, f.beliefKey);
  if (f.currentStatus === 'stale') {
    const seen = cur.displayedAt ?? cur.verifiedAt;
    return withCites(
      `${text} (last seen ${seen === null ? 'date unknown' : formatDate(seen, records.tz)})`,
      c,
    );
  }
  return withCites(text, c);
}

function releasesText(f: Finding, records: AnswerRecords): string {
  const items = f.releases ?? [];
  if (items.length === 0) return 'no releases were found';
  return items
    .slice(0, 5)
    .map((r) => {
      const when = r.eventDate ?? r.providerPublishedAt;
      return withCites(
        `"${r.title}" (${r.kind}, ${when === null ? 'date unknown' : formatDate(when, records.tz)})`,
        cites(r.citations, records),
      );
    })
    .join('; ');
}

function reasonText(reason: PriceVerdictReason | null): string {
  return reason ? (REASON_TEXT[reason] ?? reason) : 'reason not recorded';
}

function verdictText(f: Finding, records: AnswerRecords): string {
  const tz = records.tz;
  const checked = f.current?.verifiedAt ?? f.current?.displayedAt ?? null;
  switch (f.verdict) {
    case 'unable_to_verify':
      return unableText(f);
    case 'contested':
      return f.verdictReason === 'timing_conflict'
        ? 'sources disagree about when this changed'
        : 'official sources disagree';
    case 'baseline_incorrect':
      return f.verdictReason === 'other_value_in_effect_at_T0'
        ? 'my earlier answer was already out of date'
        : "my earlier answer wasn't supported by its own source";
    case 'unchanged_confirmed':
      return `the official page still showed the same price${checked === null ? '' : ` when checked on ${formatDate(checked, tz)}`}`;
    case 'no_evidence_of_change': {
      if (f.currentStatus === 'stale' || f.currentStatus === 'unknown') {
        return `no current evidence either way${checked === null ? '' : ` (latest: ${formatDate(checked, tz)})`}`;
      }
      return f.verdictReason === 'listed_differently'
        ? 'no sign of a change in what I could check, though it is listed differently now'
        : 'no sign of a change in what I could check';
    }
    case 'changed':
      if (f.effectiveFrom !== undefined) return `changed from ${formatDate(f.effectiveFrom, tz)}`;
      if (f.changeWindow) {
        return `changed between ${formatDate(f.changeWindow.after, tz)} and ${formatDate(f.changeWindow.notAfter, tz)}`;
      }
      return 'changed';
    case 'differs_timing_unknown':
      return "is different now; I can't tell whether it changed after my answer or my answer was already out of date";
    case 'releases_found':
      return `${f.releases?.length ?? 0} release${f.releases?.length === 1 ? '' : 's'} found since my earlier answer`;
    case 'none_found': {
      const n = f.coverage.sourcesChecked;
      const newest = f.coverage.newestDatedSource;
      return `no releases found among ${n} source${n === 1 ? '' : 's'} checked${newest === null ? '' : ` (newest dated source: ${formatDate(newest, tz)})`}`;
    }
    case null:
      return '';
  }
}

/** The renderer used in production. Pure: the same record always renders to the same text. */
export const defaultRenderer: Renderer = {
  render(record, records) {
    switch (record.kind) {
      case 'finding':
        if (record.variant === 'verdict') return verdictText(record.finding, records);
        if (record.variant === 'baseline') {
          const b = record.finding.baseline;
          if (!b) return '';
          return withCites(
            `${valueText(b.value, record.finding.beliefKey)} as of ${formatDate(b.presentedAt, records.tz)}`,
            cites(b.citations, records),
          );
        }
        return currentText(record.finding, records);
      case 'derived': {
        const d = record.derived;
        return `${money(d.amount, d.currency, d.currencySymbol)} (${d.formula})`;
      }
      case 'message':
        return `"${record.text}" (${formatLocalTime(record.localTime)})`;
      case 'source':
        return cites([record.snapshotId], records);
    }
  },
};

/** The snapshots a record cites, in citation order (used to list the citations of an answer). */
export function recordCitations(record: PlaceholderRecord): SnapshotId[] {
  switch (record.kind) {
    case 'source':
      return [record.snapshotId];
    case 'derived':
      return [];
    case 'message':
      return [];
    case 'finding': {
      const f = record.finding;
      if (record.variant === 'baseline') return f.baseline?.citations ?? [];
      if (record.variant === 'verdict') return [];
      if (f.intent === 'releases')
        return (f.releases ?? []).slice(0, 5).flatMap((r) => r.citations);
      return f.current?.citations ?? [];
    }
  }
}

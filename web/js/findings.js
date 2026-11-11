// How a finding reads in the findings card: the value, a status badge, a verdict badge, the earlier value and
// the citations. Pure: no DOM, dates through time.js with an explicit zone.

import { shortDate } from './time.js';
import { safeHref, sourceLabel } from './format.js';

const PERIOD = {
  monthly: 'per month',
  annual: 'per year',
  monthly_billed_annually: 'per month, billed annually',
  one_time: 'one-time',
  unspecified: '',
};

function amount(n) {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 4,
  });
}

/** "US$25 per user per month", "from €10 per GB-month", "USD 9 per year". */
export function formatValue(v) {
  const bound =
    v.valueKind === 'lower_bound' ? 'from ' : v.valueKind === 'upper_bound' ? 'up to ' : '';
  const money = v.currencySymbol
    ? `${v.currencySymbol}${/[A-Za-z]$/.test(v.currencySymbol) ? ' ' : ''}${amount(v.amount)}`
    : v.currency && v.currency !== 'unknown'
      ? `${v.currency} ${amount(v.amount)}`
      : amount(v.amount);
  const period = PERIOD[v.billingPeriod] ?? '';
  let unit = period;
  if (v.unit === 'per_seat') {
    unit =
      v.billingPeriod === 'one_time'
        ? 'per user, one-time'
        : `per user${period ? ` ${period}` : ''}`;
  } else if (v.unit === 'usage') {
    const per = `per ${v.usageUnit ?? 'unit of usage'}`;
    unit = period && v.billingPeriod !== 'one_time' ? `${per}, ${period}` : per;
  }
  return `${bound}${money}${unit ? ` ${unit}` : ''}`;
}

/** Shorter value for the "listed as X / Y" line: the amount only. */
function shortValue(v) {
  return formatValue({ ...v, unit: 'flat', billingPeriod: 'unspecified', valueKind: 'exact' });
}

function currentText(f) {
  if (f.intent === 'releases') {
    const n = f.releases?.length ?? 0;
    if (f.currentStatus === 'unable_to_verify') return "couldn't check";
    return n === 0 ? 'nothing new found' : `${n} release${n === 1 ? '' : 's'}`;
  }
  const contested = f.current?.contested ?? [];
  if (f.currentStatus === 'contested' && contested.length > 1) {
    return `listed as ${contested.map((c) => shortValue(c.value)).join(' / ')}`;
  }
  const value = f.current?.value;
  return value ? formatValue(value) : 'no verified price';
}

function statusBadge(f, opts) {
  if (f.intent === 'releases' && f.currentStatus !== 'unable_to_verify') return null;
  switch (f.currentStatus) {
    case 'confirmed':
      return { kind: 'verified', label: 'verified', title: 'Read on a current source and checked' };
    case 'stale': {
      const at = f.current?.verifiedAt ?? f.current?.displayedAt ?? null;
      return {
        kind: 'stale',
        label:
          at === null ? 'not seen recently' : `last seen ${shortDate(at, opts.now, opts.timeZone)}`,
        title: 'No current source confirmed this value',
      };
    }
    case 'contested':
      return { kind: 'contested', label: 'contested', title: 'Sources list different values' };
    case 'unable_to_verify':
      return { kind: 'failed', label: "couldn't check", title: reasonText(f.verdictReason) };
    default:
      return { kind: 'unknown', label: 'unconfirmed', title: 'No source confirmed a value' };
  }
}

const REASONS = {
  unsupported_at_time: 'the earlier value was not supported by the sources of that time',
  other_value_in_effect_at_T0: 'a different value was in effect at the time',
  timing_conflict: 'the sources disagree about when it changed',
  same_source_bracketing: 'the same source showed both values',
  stated_effective_date: 'the source states when the change took effect',
  listed_differently: 'the source lists it differently',
  insufficient_coverage: 'too few sources could be checked',
  low_authority_source: 'it rests only on low-authority sources',
  search_timeout: 'the search timed out',
  search_unavailable: 'the search was unavailable',
  quota_exhausted: 'the search quota ran out',
  extraction_failed: 'the sources could not be read',
  deadline: 'time ran out',
};

/** A plain reason for a tooltip, or an empty string. */
export function reasonText(reason) {
  return reason ? (REASONS[reason] ?? reason.replace(/_/g, ' ')) : '';
}

function verdictBadge(f, opts) {
  const day = (ms) => shortDate(ms, opts.now, opts.timeZone);
  const title = reasonText(f.verdictReason);
  switch (f.verdict) {
    case 'changed': {
      const arrow = f.direction === 'up' ? ' ↑' : f.direction === 'down' ? ' ↓' : '';
      const when = f.effectiveFrom
        ? ` from ${day(f.effectiveFrom)}`
        : f.changeWindow
          ? ` between ${day(f.changeWindow.after)} and ${day(f.changeWindow.notAfter)}`
          : '';
      return { kind: 'changed', label: `changed${arrow}${when}`, title };
    }
    case 'baseline_incorrect':
      return { kind: 'changed', label: 'earlier answer was out of date', title };
    case 'differs_timing_unknown':
      return { kind: 'changed', label: 'differs — timing unknown', title };
    case 'unchanged_confirmed':
      return { kind: 'same', label: 'still the same', title };
    case 'no_evidence_of_change':
      return { kind: 'same', label: 'no sign of change', title };
    case 'contested':
      return { kind: 'contested', label: 'sources disagree', title };
    case 'releases_found':
      return { kind: 'changed', label: 'shipped something new', title };
    case 'none_found':
      return { kind: 'same', label: 'nothing new found', title };
    case 'unable_to_verify':
      return { kind: 'failed', label: "couldn't check", title };
    default:
      return null;
  }
}

function citations(ids, sources) {
  const out = [];
  for (const id of ids ?? []) {
    const s = sources.find((x) => x.sourceId === id);
    const href = s ? safeHref(s.url) : null;
    if (s && href && !out.some((c) => c.n === s.n)) {
      out.push({ n: s.n, href, label: s.domain, title: sourceLabel(s) });
    }
  }
  return out;
}

/**
 * One row of the findings card.
 *
 * @param {object} f  a Finding (src/shared/findings.ts)
 * @param {Array<{ n: number, sourceId: string, url: string, domain: string, title?: string | null }>} sources
 * @param {{ now: number, timeZone: string }} opts
 */
export function findingRow(f, sources, opts) {
  const ids = [
    ...(f.current?.citations ?? []),
    ...(f.baseline?.citations ?? []),
    ...(f.releases ?? []).flatMap((r) => r.citations),
  ];
  const status = statusBadge(f, opts);
  const verdict = verdictBadge(f, opts);
  return {
    name: f.entityName,
    value: currentText(f),
    status,
    // "couldn't check" twice says nothing new
    verdict: verdict && status && verdict.label === status.label ? null : verdict,
    baseline: f.baseline
      ? `earlier: ${formatValue(f.baseline.value)} on ${shortDate(f.baseline.presentedAt, opts.now, opts.timeZone)}`
      : null,
    releases: (f.releases ?? []).map((r) => {
      const at = r.eventDate ?? r.providerPublishedAt;
      return {
        title: r.title,
        date: at === null ? null : shortDate(at, opts.now, opts.timeZone),
        major: r.significance === 'major',
      };
    }),
    citations: citations(ids, sources),
  };
}

function planOf(f) {
  const m = /\|p=([^|]*)/.exec(f.beliefKey ?? '');
  const plan = m?.[1];
  if (!plan || plan === '-' || plan === 'unspecified') return null;
  const text = decodeURIComponent(plan.replace(/\+/g, ' ')).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The findings of ONE entity as one row: "Lite $19 · Growth $34 · Premium $64 per user per month · currency not
 * stated · not seen recently". A unit shared by every plan is said once at the end, a note shared by several
 * plans is said once. Findings are one per plan, so without this the card repeats the entity name per plan.
 */
function groupRow(group, sources, opts) {
  const rows = group.map((f) => findingRow(f, sources, opts));
  const parts = group.map((f, i) => {
    const v = f.current?.value;
    const plan = planOf(f);
    if (!v || f.intent !== 'pricing') return { plan, money: rows[i].value, unit: '' };
    const money = shortValue(v);
    return { plan, money, unit: formatValue(v).slice(money.length).trim() };
  });
  const units = new Set(parts.map((p) => p.unit));
  const shared = units.size === 1 ? [...units][0] : '';
  const body = parts
    .map((p) => {
      const unit = shared === '' && p.unit ? ` ${p.unit}` : '';
      return `${p.plan ? `${p.plan} ` : ''}${p.money}${unit}`;
    })
    .join(' · ');
  const notes = [];
  if (group.some((f) => f.current?.value?.currency === 'unknown'))
    notes.push('currency not stated');
  const staleBadge = rows.find((r) => r.status?.kind === 'stale')?.status ?? null;
  if (staleBadge)
    notes.push(staleBadge.label.startsWith('last seen') ? 'not seen recently' : staleBadge.label);
  const other = rows.find(
    (r) => r.status && r.status.kind !== 'stale' && r.status.kind !== 'verified',
  );
  const status = staleBadge
    ? { ...staleBadge, label: 'not seen recently' }
    : (other?.status ?? rows[0].status);
  const seen = new Set();
  const cites = rows
    .flatMap((r) => r.citations)
    .filter((c) => (seen.has(c.n) ? false : (seen.add(c.n), true)));
  return {
    name: rows[0].name,
    value: [body + (shared ? ` ${shared}` : ''), ...notes.filter((n) => n !== status?.label)].join(
      ' · ',
    ),
    status,
    verdict: rows.every((r) => r.verdict?.label === rows[0].verdict?.label)
      ? rows[0].verdict
      : null,
    baseline: rows.find((r) => r.baseline)?.baseline ?? null,
    releases: rows.flatMap((r) => r.releases),
    citations: cites,
  };
}

/** The rows of the findings card: findings of the same entity are one row, in the order of their first finding. */
export function groupedFindingRows(findings, sources, opts) {
  const sorted = [...findings].sort((a, b) => a.ord - b.ord);
  const groups = new Map();
  for (const f of sorted) {
    const key = f.entityId ?? f.entityName;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()].map((g) =>
    g.length === 1 ? findingRow(g[0], sources, opts) : groupRow(g, sources, opts),
  );
}

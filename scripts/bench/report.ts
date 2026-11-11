import type { GradeFile, GradeRecord } from './grade.js';
import { median, percentile, wilson } from './stats.js';

/**
 * Markdown report from grade files. It states what was measured, on how many questions, with which model
 * and grader, and with what uncertainty. It never compares with other systems: published numbers for other
 * systems come from different samples, graders and dates.
 */

export interface Tally {
  n: number;
  graded: number;
  correct: number;
  incorrect: number;
  notAttempted: number;
  excluded: number;
  ungraded: number;
}

export function tally(items: readonly GradeRecord[]): Tally {
  const t: Tally = {
    n: items.length,
    graded: 0,
    correct: 0,
    incorrect: 0,
    notAttempted: 0,
    excluded: 0,
    ungraded: 0,
  };
  for (const g of items) {
    if (g.grade === 'CORRECT') t.correct += 1;
    else if (g.grade === 'INCORRECT') t.incorrect += 1;
    else if (g.grade === 'NOT_ATTEMPTED') t.notAttempted += 1;
    else if (g.grade === 'EXCLUDED') t.excluded += 1;
    else t.ungraded += 1;
  }
  t.graded = t.correct + t.incorrect + t.notAttempted;
  return t;
}

/** simple-evals' aggregate: correct, given-attempted accuracy and their harmonic mean (F-score). */
export function simpleQaMetrics(t: Tally): {
  correct: number;
  incorrect: number;
  notAttempted: number;
  correctGivenAttempted: number | null;
  fScore: number | null;
} {
  if (t.graded === 0) {
    return { correct: 0, incorrect: 0, notAttempted: 0, correctGivenAttempted: null, fScore: null };
  }
  const correct = t.correct / t.graded;
  const attempted = (t.correct + t.incorrect) / t.graded;
  const cga = attempted > 0 ? correct / attempted : null;
  const f = cga !== null && cga + correct > 0 ? (2 * cga * correct) / (cga + correct) : null;
  return {
    correct,
    incorrect: t.incorrect / t.graded,
    notAttempted: t.notAttempted / t.graded,
    correctGivenAttempted: cga,
    fScore: f,
  };
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const secs = (x: number | null): string => (x === null ? 'n/a' : `${(x / 1000).toFixed(1)} s`);

function accuracyCell(t: Tally): string {
  if (t.graded === 0) return 'n/a';
  const ci = wilson(t.correct, t.graded);
  return `${pct(t.correct / t.graded)} [${pct(ci.low)}, ${pct(ci.high)}]`;
}

function row(label: string, items: readonly GradeRecord[]): string {
  const t = tally(items);
  return `| ${label} | ${t.n} | ${t.graded} | ${t.correct} | ${accuracyCell(t)} | ${t.graded === 0 ? 'n/a' : pct(t.notAttempted / t.graded)} | ${t.excluded} |`;
}

const BREAKDOWN_HEAD =
  '| group | n | graded | correct | accuracy [95% Wilson] | not attempted | excluded |\n|---|---|---|---|---|---|---|';

function groupBy(
  items: readonly GradeRecord[],
  key: (g: GradeRecord) => string,
): Map<string, GradeRecord[]> {
  const map = new Map<string, GradeRecord[]>();
  for (const g of items) {
    const k = key(g);
    map.set(k, [...(map.get(k) ?? []), g]);
  }
  return new Map([...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

export function datasetSection(file: GradeFile): string {
  const items = file.items;
  const t = tally(items);
  const wall = items.map((g) => g.wallMs).filter((v): v is number => v !== null);
  const ttft = items.map((g) => g.firstTextMs).filter((v): v is number => v !== null);
  const errorKinds = groupBy(
    items.filter((g) => g.errorKind !== null),
    (g) => g.errorKind ?? '',
  );
  const lines: string[] = [];
  lines.push(`## ${file.dataset} (${file.split})`);
  lines.push('');
  if (file.components.includes('scripted')) {
    lines.push(
      '> **Scripted components: these answers are canned demo responses. This section checks the harness only and is not a score.**',
    );
    lines.push('');
  }
  lines.push(
    `- Questions asked: from ${file.firstAskedAt?.slice(0, 10) ?? 'n/a'}; graded ${file.gradedAt.slice(0, 10)}`,
  );
  lines.push(
    `- Agent model: ${file.models.join(', ')} (components: ${file.components.join(', ')})`,
  );
  lines.push(`- Grader: ${file.graderModel}, prompt ${file.promptVersion}`);
  if (file.dataset === 'simpleqa') {
    lines.push(
      `- Grader template matches the downloaded simple-evals source: ${file.templateVerified === null ? 'not checked (upstream file not downloaded)' : file.templateVerified ? 'yes' : '**NO: check scripts/bench/prompts.ts against upstream before trusting these numbers**'}`,
    );
  }
  lines.push(`- Runs: ${file.runIds.join(', ')}`);
  lines.push('');
  lines.push(
    '| n | split | graded | correct | accuracy [95% Wilson] | not attempted | median wall | p90 wall | median first text | p90 first text | provider/harness errors (excluded) | ungraded |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  lines.push(
    `| ${t.n} | ${file.split} | ${t.graded} | ${t.correct} | ${accuracyCell(t)} | ${t.graded === 0 ? 'n/a' : pct(t.notAttempted / t.graded)} | ${secs(median(wall))} | ${secs(percentile(wall, 0.9))} | ${secs(median(ttft))} | ${secs(percentile(ttft, 0.9))} | ${t.excluded} | ${t.ungraded} |`,
  );
  lines.push('');
  lines.push(
    'Accuracy is correct / graded; excluded questions (rate limits, quota, provider or harness failures) are not counted as wrong and not in the denominator. First text is measured from sending the request to the first released sentence.',
  );
  if (errorKinds.size > 0) {
    lines.push('');
    lines.push(
      `Excluded by kind: ${[...errorKinds.entries()].map(([k, v]) => `${k} ${v.length}`).join(', ')}.`,
    );
  }
  const calls = items.reduce(
    (a, g) => ({
      gemini: a.gemini + g.geminiCalls,
      exa: a.exa + g.exaCalls,
      failed: a.failed + g.providerFailures,
    }),
    { gemini: 0, exa: 0, failed: 0 },
  );
  lines.push('');
  lines.push(
    `Provider calls: Gemini ${calls.gemini}, Exa ${calls.exa}, failed responses ${calls.failed} (including retried ones).`,
  );

  if (file.dataset === 'simpleqa') {
    const m = simpleQaMetrics(t);
    lines.push('');
    lines.push('simple-evals aggregate (over graded questions):');
    lines.push('');
    lines.push('| correct | incorrect | not attempted | correct given attempted | F-score |');
    lines.push('|---|---|---|---|---|');
    lines.push(
      `| ${pct(m.correct)} | ${pct(m.incorrect)} | ${pct(m.notAttempted)} | ${pct(m.correctGivenAttempted)} | ${m.fScore === null ? 'n/a' : m.fScore.toFixed(3)} |`,
    );
  }
  const breakdown = (title: string, groups: Map<string, GradeRecord[]>): void => {
    lines.push('');
    lines.push(`### ${title}`);
    lines.push('');
    lines.push(BREAKDOWN_HEAD);
    for (const [k, v] of groups) lines.push(row(k, v));
  };
  if (file.dataset === 'simpleqa')
    breakdown(
      'By topic',
      groupBy(items, (g) => g.stratum),
    );
  if (file.dataset === 'freshqa') {
    breakdown(
      'By fact type',
      groupBy(items, (g) => g.factType ?? 'unknown'),
    );
    breakdown(
      'By premise',
      groupBy(items, (g) => (g.falsePremise ? 'false premise' : 'valid premise')),
    );
    const fast = items.filter((g) => g.factType === 'fast-changing');
    const due = items.filter((g) => g.reviewDue === true);
    lines.push('');
    lines.push('### Possibly stale gold answers');
    lines.push('');
    lines.push(
      'The accepted answers are dated 2026-04-21. A fast-changing answer may have changed since, so a correct current answer can be graded wrong. These rows are reported separately and should be read with that in mind.',
    );
    lines.push('');
    lines.push(BREAKDOWN_HEAD);
    lines.push(row('fast-changing', fast));
    lines.push(
      row(
        'all except fast-changing',
        items.filter((g) => g.factType !== 'fast-changing'),
      ),
    );
    lines.push(row('review date passed before asking', due));
  }
  if (file.dataset === 'longmemeval')
    breakdown(
      'By question type',
      groupBy(items, (g) => g.stratum),
    );
  return lines.join('\n');
}

export function buildReport(files: readonly GradeFile[], generatedAt: Date): string {
  const lines = [
    `# Benchmark report, ${generatedAt.toISOString().slice(0, 10)}`,
    '',
    'Small stratified samples graded by an LLM. Intervals are 95% Wilson score intervals on the graded questions. These numbers describe this agent on these samples with this grader; they are not comparable with published results for other systems, which use other samples, graders and dates. See docs/benchmarks.md.',
    '',
  ];
  for (const f of files) lines.push(datasetSection(f), '');
  return lines.join('\n');
}

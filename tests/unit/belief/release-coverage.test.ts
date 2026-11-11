import { describe, expect, it } from 'vitest';
import { FindingAssembler } from '../../../src/belief/assembler.js';
import {
  MIN_RELEASE_COVERAGE,
  RuleChangeDetector,
  releaseCoverageGap,
} from '../../../src/belief/detector.js';
import type { Coverage, VerifiedEvidence } from '../../../src/shared/index.js';
import { DAY, ev, RELEASE_COVERAGE_AFTER_T0, T0 } from './support.js';
import { resolveRef } from '../../../src/answer/records.js';
import { defaultRenderer } from '../../../src/answer/render.js';
import { recordsFor } from '../answer/builders.js';

/**
 * "No releases found" is a negative conclusion, and not finding something is not proof that it did not happen.
 * The detector says none_found only when the coverage supports it; otherwise the verdict is unable_to_verify.
 * Every protection is tested on its own. All data is [SYNTHETIC].
 */

const detector = new RuleChangeDetector();
const none = (c: Coverage) => detector.releases([], c, T0).verdict;
const GOOD = RELEASE_COVERAGE_AFTER_T0;

const release = (id: string, over: Partial<VerifiedEvidence> = {}): VerifiedEvidence => ({
  ...ev({ id }),
  kind: 'release',
  beliefKey: null,
  fields: {
    plan: null,
    planNorm: null,
    attribute: 'release',
    value: null,
    conditions: null,
    releaseTitle: id,
    releaseKind: 'launch',
  },
  ...over,
});

describe('when none_found is justified', () => {
  it('T-REL-01: a successful search, a release source and one dated inside the interval support it', () => {
    expect(none(GOOD)).toBe('none_found');
  });

  it('T-REL-02: the minimum is a named, conservative constant', () => {
    expect(MIN_RELEASE_COVERAGE).toEqual({
      successfulSearches: 1,
      releaseSources: 1,
      datedReleaseSourcesInInterval: 1,
    });
  });
});

describe('when none_found is NOT produced', () => {
  it('T-REL-10: a search for the entity failed or timed out', () => {
    expect(none({ ...GOOD, searchesFailed: 1 })).toBe('unable_to_verify');
    expect(none({ ...GOOD, searchesFailed: 1, failure: 'search_timeout' })).toBe(
      'unable_to_verify',
    );
    expect(releaseCoverageGap({ ...GOOD, searchesFailed: 1 }, T0)).toBe('search_failed');
  });

  it('T-REL-11: extraction failed or hit the deadline', () => {
    expect(none({ ...GOOD, extractionFailed: true })).toBe('unable_to_verify');
    expect(none({ ...GOOD, failure: 'extraction_failed' })).toBe('unable_to_verify');
    expect(none({ ...GOOD, failure: 'deadline' })).toBe('unable_to_verify');
  });

  it('T-REL-12: no search succeeded', () => {
    expect(none({ ...GOOD, searchesOk: 0 })).toBe('unable_to_verify');
    expect(releaseCoverageGap({ ...GOOD, searchesOk: 0 }, T0)).toBe('too_few_searches');
  });

  it('T-REL-13: no release-capable source was obtained (only pricing pages), or the count is unknown', () => {
    expect(none({ ...GOOD, releaseSources: 0 })).toBe('unable_to_verify');
    const unknown: Coverage = { ...GOOD };
    delete unknown.releaseSources;
    expect(none(unknown)).toBe('unable_to_verify');
    expect(releaseCoverageGap({ ...GOOD, releaseSources: 0 }, T0)).toBe('no_release_source');
    // eleven pricing pages checked do not make up for it
    expect(none({ ...GOOD, sourcesChecked: 11, releaseSources: 0 })).toBe('unable_to_verify');
  });

  it('T-REL-14: no release source is dated, or the interval starts after every source date', () => {
    expect(none({ ...GOOD, newestDatedReleaseSource: null })).toBe('unable_to_verify');
    expect(none({ ...GOOD, newestDatedReleaseSource: T0 - DAY })).toBe('unable_to_verify');
    const unknown: Coverage = { ...GOOD };
    delete unknown.newestDatedReleaseSource;
    expect(none(unknown)).toBe('unable_to_verify');
    expect(releaseCoverageGap({ ...GOOD, newestDatedReleaseSource: T0 - 1 }, T0)).toBe(
      'no_source_in_interval',
    );
    // a dated pricing page does not stand in for a dated release source
    expect(none({ ...GOOD, newestDatedSource: T0 + DAY, newestDatedReleaseSource: null })).toBe(
      'unable_to_verify',
    );
  });

  it('T-REL-15: a source dated exactly at the start of the interval is inside it', () => {
    expect(none({ ...GOOD, newestDatedReleaseSource: T0 })).toBe('none_found');
  });

  it('T-REL-16: a release that was found is reported even when coverage is partial', () => {
    const out = detector.releases(
      [release('r', { eventDate: T0 + DAY })],
      { ...GOOD, searchesFailed: 1 },
      T0,
    );
    expect(out.verdict).toBe('releases_found');
  });

  it('T-REL-17: a coverage failure still wins over a found release (unchanged rule)', () => {
    const out = detector.releases(
      [release('r', { eventDate: T0 + DAY })],
      { ...GOOD, failure: 'deadline' },
      T0,
    );
    expect(out.verdict).toBe('unable_to_verify');
  });
});

describe('what the finding says', () => {
  const assembler = new FindingAssembler({ detector, newFindingId: () => 'fnd_1' });
  const entity = {
    id: 'ent_acme' as const,
    name: 'Acme CRM',
    aliases: ['Acme'],
    plans: [],
    officialDomains: ['acme.example'],
  };
  const build = (coverage: Coverage, intents: Array<'pricing' | 'releases'>) =>
    assembler.assemble({
      turnId: 'trn_1',
      createdAt: T0,
      snapshots: new Map(),
      entities: [
        {
          entity,
          intents,
          coverage,
          beliefs: [],
          evidenceByKey: new Map(),
          releaseEvidence: [],
          baselines: [],
          releaseSince: T0,
        },
      ],
    });

  it('T-REL-20: none_found carries exactly the coverage numbers the wording uses', () => {
    const set = build(GOOD, ['releases']);
    const f = set.findings[0];
    expect(f?.verdict).toBe('none_found');
    expect(f?.coverage).toEqual(GOOD);
    expect(f?.coverage.sourcesChecked).toBe(11);
    expect(f?.coverage.newestDatedSource).toBe(T0 + 5 * DAY);
  });

  it('T-REL-21: an unsupported negative is unable_to_verify with a reason a reader can be told', () => {
    const cases: Array<[Coverage, string]> = [
      [{ ...GOOD, searchesFailed: 1 }, 'search_unavailable'],
      [{ ...GOOD, searchesFailed: 1, failure: 'search_timeout' }, 'search_timeout'],
      [{ ...GOOD, extractionFailed: true }, 'extraction_failed'],
      [{ ...GOOD, releaseSources: 0 }, 'insufficient_coverage'],
      [{ ...GOOD, newestDatedReleaseSource: T0 - DAY }, 'insufficient_coverage'],
    ];
    for (const [coverage, reason] of cases) {
      const f = build(coverage, ['releases']).findings[0];
      expect(f, reason).toMatchObject({
        verdict: 'unable_to_verify',
        currentStatus: 'unable_to_verify',
        verdictReason: reason,
      });
    }
  });

  it('T-REL-22: research run without the releases intent makes no release claim at all', () => {
    const set = build(GOOD, ['pricing']);
    expect(set.findings.every((f) => f.intent !== 'releases')).toBe(true);
    expect(set.findings.some((f) => f.verdict === 'none_found')).toBe(false);
  });
});

describe('no interval start: no release conclusion has a window', () => {
  // The live case: "What is new in Node.js 24?" rendered "no releases found among 14 sources checked" with no
  // "since" and no earlier answer, a negative about no period at all.
  it('T-REL-30: with full coverage and nothing found, no interval start is unable_to_verify (no_time_window), never none_found', () => {
    const out = detector.releases([], GOOD, null);
    expect(out).toEqual({ verdict: 'unable_to_verify', items: [], reason: 'no_time_window' });
  });

  it('T-REL-31: even release evidence lists nothing without an interval to place it in', () => {
    const out = detector.releases([release('Smart Docs', { eventDate: T0 + DAY })], GOOD, null);
    expect(out.verdict).toBe('unable_to_verify');
    expect(out.items).toEqual([]);
  });

  it('T-REL-32: a coverage failure keeps its own reason', () => {
    expect(detector.releases([], { ...GOOD, failure: 'deadline' }, null).reason).toBeUndefined();
  });

  it('T-REL-33: the assembled finding carries no_time_window and renders the period request, not "no releases found"', () => {
    const assembler = new FindingAssembler({ detector, newFindingId: () => 'fnd_1' });
    const set = assembler.assemble({
      turnId: 'trn_1',
      createdAt: T0,
      snapshots: new Map(),
      entities: [
        {
          entity: {
            id: 'ent_node' as const,
            name: 'Node.js',
            aliases: [],
            plans: [],
            officialDomains: ['nodejs.org'],
          },
          intents: ['releases'],
          coverage: GOOD,
          beliefs: [],
          evidenceByKey: new Map(),
          releaseEvidence: [],
          baselines: [],
          releaseSince: null,
        },
      ],
    });
    const f = set.findings[0];
    expect(f).toMatchObject({
      intent: 'releases',
      verdict: 'unable_to_verify',
      currentStatus: 'unable_to_verify',
      verdictReason: 'no_time_window',
    });
    const records = recordsFor(f ? [f] : []);
    const view = (variant: 'current' | 'verdict') => {
      const r = resolveRef({ kind: 'finding', ord: 1, variant }, records);
      return r.ok ? defaultRenderer.render(r.record, records) : '';
    };
    expect(view('verdict')).toBe('I can only report releases for a period you name');
    expect(view('current')).toBe('I can only report releases for a period you name');
    expect(`${view('current')} ${view('verdict')}`).not.toMatch(/no releases/i);
  });
});

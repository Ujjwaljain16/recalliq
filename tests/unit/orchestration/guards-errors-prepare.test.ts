import { describe, expect, it } from 'vitest';
import {
  classifyError,
  isDatabaseBusy,
  withBoundedRetry,
} from '../../../src/orchestration/errors.js';
import {
  assertFindingSetConsistent,
  globalNegativeAllowed,
  guardGlobalNegatives,
} from '../../../src/orchestration/findings-guard.js';
import {
  buildAssertions,
  buildBaselineEvents,
  buildEnrichment,
  citationsOf,
  deterministicAnswer,
  statusForFindings,
} from '../../../src/orchestration/prepare.js';
import { DeadlineExceededError } from '../../../src/orchestration/turn-budget.js';
import { InvalidTransitionError } from '../../../src/db/errors.js';
import type { Finding, PriceVerdict, ReleaseVerdict } from '../../../src/shared/findings.js';
import { newId, type SnapshotId } from '../../../src/shared/ids.js';
import { LlmError } from '../../../src/shared/llm.js';
import { SearchError } from '../../../src/shared/search.js';
import { coverage, finding, findingSet, sentence, TURN, unableFinding, analysis } from './fakes.js';

function withVerdict(ord: number, verdict: PriceVerdict | ReleaseVerdict): Finding {
  return finding(ord, { verdict });
}

describe('global-negative rule (contracts section 3)', () => {
  const allowedVerdicts = ['unchanged_confirmed', 'no_evidence_of_change', 'none_found'] as const;

  it.each(allowedVerdicts)('is allowed when every finding is %s', (verdict) => {
    expect(
      globalNegativeAllowed(findingSet(TURN, [withVerdict(1, verdict), withVerdict(2, verdict)])),
    ).toBe(true);
  });

  it('is forbidden when ANY finding is unable_to_verify, however many others are confirmed', () => {
    const set = findingSet(TURN, [
      withVerdict(1, 'unchanged_confirmed'),
      withVerdict(2, 'unchanged_confirmed'),
      unableFinding(3),
    ]);
    expect(globalNegativeAllowed(set)).toBe(false);
  });

  it('is forbidden by a coverage failure even if the verdict looks fine', () => {
    const f = finding(1, {
      verdict: 'unchanged_confirmed',
      coverage: coverage({ failure: 'deadline' }),
    });
    expect(globalNegativeAllowed(findingSet(TURN, [f]))).toBe(false);
  });

  it.each(['changed', 'baseline_incorrect', 'differs_timing_unknown', 'contested'] as const)(
    'is forbidden when a finding is %s',
    (verdict) => {
      const set = findingSet(TURN, [
        withVerdict(1, 'unchanged_confirmed'),
        withVerdict(2, verdict),
      ]);
      expect(globalNegativeAllowed(set)).toBe(false);
    },
  );

  it('is forbidden with no findings, and with a finding that has no verdict', () => {
    expect(globalNegativeAllowed(null)).toBe(false);
    expect(globalNegativeAllowed(findingSet(TURN, []))).toBe(false);
    expect(globalNegativeAllowed(findingSet(TURN, [finding(1)]))).toBe(false);
  });

  describe('guardGlobalNegatives (defence in depth, downgrade only)', () => {
    const phrases = [
      'Nothing changed.',
      'There are no changes since Monday.',
      'None of them changed their price.',
      'All the same as before.',
      'Everything is unchanged.',
    ];

    it.each(phrases)('downgrades "%s" when one finding is unable_to_verify', (text) => {
      const set = findingSet(TURN, [withVerdict(1, 'unchanged_confirmed'), unableFinding(2)]);
      const out = guardGlobalNegatives([sentence(0, text)], set);
      expect(out.changed).toEqual([0]);
      expect(out.sentences[0]?.status).toBe('unverified');
      expect(out.sentences[0]?.issues).toContain('unsupported_global_negative');
    });

    it('leaves the sentence alone when every verdict is unchanged_confirmed', () => {
      const set = findingSet(TURN, [withVerdict(1, 'unchanged_confirmed')]);
      const s = sentence(0, 'Nothing changed.');
      expect(guardGlobalNegatives([s], set)).toEqual({ sentences: [s], changed: [] });
    });

    it('with no_evidence_of_change allows only the "no sign / no evidence" phrasing', () => {
      const set = findingSet(TURN, [withVerdict(1, 'no_evidence_of_change')]);
      expect(guardGlobalNegatives([sentence(0, 'Nothing changed.')], set).changed).toEqual([0]);
      expect(
        guardGlobalNegatives([sentence(0, 'I found no sign of a price change.')], set).changed,
      ).toEqual([]);
    });

    it('never upgrades or rewrites: other sentences and an already-unverified sentence are untouched', () => {
      const set = findingSet(TURN, [unableFinding(1)]);
      const other = sentence(0, 'Entity1 could not be checked.');
      const already = sentence(1, 'Nothing changed.', {
        status: 'unverified',
        issues: ['unsupported_global_negative'],
      });
      const out = guardGlobalNegatives([other, already], set);
      expect(out.sentences).toEqual([other, already]);
      expect(out.changed).toEqual([]);
    });

    it('does nothing without findings (chat and recall turns)', () => {
      const s = sentence(0, 'Nothing changed in our chat.');
      expect(guardGlobalNegatives([s], null).sentences).toEqual([s]);
    });
  });

  describe('assertFindingSetConsistent', () => {
    it('accepts consistent sets', () => {
      expect(() =>
        assertFindingSetConsistent(findingSet(TURN, [finding(1), unableFinding(2)]), TURN),
      ).not.toThrow();
    });
    it('rejects a coverage failure presented as a normal status', () => {
      const bad = finding(1, { coverage: coverage({ failure: 'search_timeout' }) });
      expect(() => assertFindingSetConsistent(findingSet(TURN, [bad]), TURN)).toThrow(
        /coverage failure/,
      );
    });
    it('rejects unable_to_verify next to a real verdict, and a set of another turn', () => {
      const bad = finding(1, { currentStatus: 'unable_to_verify', verdict: 'unchanged_confirmed' });
      expect(() => assertFindingSetConsistent(findingSet(TURN, [bad]), TURN)).toThrow(
        /unable_to_verify/,
      );
      expect(() => assertFindingSetConsistent(findingSet(newId('trn'), []), TURN)).toThrow(
        /belongs to turn/,
      );
    });
  });
});

describe('error classification', () => {
  it('maps LLM and search failures by retryability', () => {
    for (const code of ['rate_limited', 'unavailable', 'timeout'] as const) {
      expect(classifyError(new LlmError(code, 'x'))).toBe('external_retryable');
      expect(classifyError(new SearchError(code, 'x'))).toBe('external_retryable');
    }
    for (const code of ['refused', 'invalid_output', 'bad_request'] as const) {
      expect(classifyError(new LlmError(code, 'x'))).toBe('external_permanent');
    }
    for (const code of ['quota_exhausted', 'bad_request'] as const) {
      expect(classifyError(new SearchError(code, 'x'))).toBe('external_permanent');
    }
  });

  it('tells a deadline abort from another cancellation', () => {
    const controller = new AbortController();
    controller.abort(new DeadlineExceededError());
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyError(abort, controller.signal)).toBe('deadline');
    expect(classifyError(new LlmError('cancelled', 'x'), controller.signal)).toBe('deadline');
    expect(classifyError(abort, new AbortController().signal)).toBe('cancelled');
    expect(classifyError(new SearchError('cancelled', 'x'))).toBe('cancelled');
    expect(classifyError(new DeadlineExceededError())).toBe('deadline');
  });

  it('classifies database failures as persistence and everything else as programmer error', () => {
    const sqlite = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    expect(classifyError(sqlite)).toBe('persistence');
    expect(classifyError(new InvalidTransitionError('RECEIVED', 'PERSISTING', 'no'))).toBe(
      'persistence',
    );
    expect(classifyError(new TypeError('x is undefined'))).toBe('programmer');
    expect(classifyError(new Error('boom'))).toBe('programmer');
    expect(classifyError('a string')).toBe('programmer');
  });

  it('recognises only SQLITE_BUSY and SQLITE_LOCKED as busy', () => {
    expect(isDatabaseBusy(Object.assign(new Error('b'), { code: 'SQLITE_BUSY' }))).toBe(true);
    expect(isDatabaseBusy(Object.assign(new Error('b'), { code: 'SQLITE_BUSY_SNAPSHOT' }))).toBe(
      true,
    );
    expect(isDatabaseBusy(Object.assign(new Error('l'), { code: 'SQLITE_LOCKED' }))).toBe(true);
    expect(isDatabaseBusy(Object.assign(new Error('c'), { code: 'SQLITE_CONSTRAINT' }))).toBe(
      false,
    );
    expect(isDatabaseBusy(new Error('busy'))).toBe(false);
  });
});

describe('withBoundedRetry: no infinite retry', () => {
  const busy = () => Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });

  it('retries once and succeeds', () => {
    let calls = 0;
    const out = withBoundedRetry(
      () => {
        calls += 1;
        if (calls === 1) throw busy();
        return 'ok';
      },
      { maxAttempts: 2, shouldRetry: isDatabaseBusy },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(2);
  });

  it('gives up after maxAttempts and rethrows the last error', () => {
    let calls = 0;
    expect(() =>
      withBoundedRetry(
        () => {
          calls += 1;
          throw busy();
        },
        { maxAttempts: 2, shouldRetry: isDatabaseBusy },
      ),
    ).toThrow('busy');
    expect(calls).toBe(2);
  });

  it('does not retry an error it was not told to retry, and treats 0 attempts as 1', () => {
    let calls = 0;
    expect(() =>
      withBoundedRetry(
        () => {
          calls += 1;
          throw new Error('permanent');
        },
        { maxAttempts: 0, shouldRetry: () => false },
      ),
    ).toThrow('permanent');
    expect(calls).toBe(1);
  });
});

describe('response preparation', () => {
  it('the turn is partial when a finding is unable_to_verify, otherwise complete', () => {
    expect(statusForFindings(null)).toBe('complete');
    expect(statusForFindings(findingSet(TURN, [finding(1)]))).toBe('complete');
    expect(statusForFindings(findingSet(TURN, [finding(1), unableFinding(2, 'deadline')]))).toBe(
      'partial',
    );
  });

  it('a fixed reply has claim-free sentences that all count as streamed', () => {
    const a = deterministicAnswer(['One.', 'Two.']);
    expect(a.streamedThrough).toBe(1);
    expect(a.rendered).toBe('One. Two.');
    expect(a.sentences.every((s) => s.status === 'no_claims' && s.placeholders.length === 0)).toBe(
      true,
    );
  });

  it('builds one assertion per rendered F placeholder, with the value of that variant', () => {
    const f = finding(1, {
      beliefKey: 'k1',
      current: {
        value: null,
        displayedAt: null,
        verifiedAt: null,
        citations: [],
        pendingSignals: [],
      },
    });
    const s = sentence(0, 'x', {
      placeholders: [
        { token: '[[F1]]', findingId: f.id, rendered: 'US$90' },
        { token: '[[F1:verdict]]', findingId: f.id, rendered: 'unchanged' },
        { token: '[[M:msg_x]]', rendered: 'quote' },
        { token: '[[F1]]', findingId: f.id, rendered: 'US$90' },
      ],
    });
    const out = buildAssertions([s], findingSet(TURN, [f]));
    expect(out.map((a) => a.placeholder)).toEqual(['F1', 'F1:verdict']);
    expect(out[0]).toMatchObject({ beliefKey: 'k1', renderedText: 'US$90', sentenceIndex: 0 });
    expect(buildAssertions([s], null)).toEqual([]);
  });

  it('maps baseline verdicts to assertion events (contracts section 2) and none for no_evidence_of_change', () => {
    const mk = (verdict: PriceVerdict) =>
      finding(1, {
        verdict,
        verdictReason: null,
        baseline: {
          value: { amount: 1 } as never,
          presentedAt: 1,
          citations: [],
          assertionId: newId('asr'),
        },
      });
    const expected: Array<[PriceVerdict, string | null]> = [
      ['unchanged_confirmed', 'reaffirmed'],
      ['changed', 'superseded_world_changed'],
      ['baseline_incorrect', 'retracted_was_wrong'],
      ['contested', 'contested'],
      ['differs_timing_unknown', 'differs_timing_unknown'],
      ['unable_to_verify', 'unverifiable_now'],
      ['no_evidence_of_change', null],
    ];
    for (const [verdict, status] of expected) {
      const events = buildBaselineEvents(findingSet(TURN, [mk(verdict)]));
      expect(events.map((e) => e.status)).toEqual(status === null ? [] : [status]);
    }
    expect(buildBaselineEvents(findingSet(TURN, [finding(1, { verdict: 'changed' })]))).toEqual([]);
  });

  it('collects citations from source placeholders and from rendered findings', () => {
    const a = newId('src') as SnapshotId;
    const b = newId('src') as SnapshotId;
    const f = finding(1, {
      current: {
        value: null,
        displayedAt: null,
        verifiedAt: null,
        citations: [a],
        pendingSignals: [],
      },
    });
    const s = sentence(0, 'x', {
      placeholders: [
        { token: '[[F1]]', findingId: f.id, rendered: 'v' },
        { token: `[[S:${b}]]`, snapshotId: b, rendered: '[1]' },
      ],
    });
    expect(citationsOf([s], findingSet(TURN, [f])).sort()).toEqual([a, b].sort());
  });

  describe('enrichment is untrusted model output', () => {
    const fact = (quote: string) => ({
      kind: 'shortlist' as const,
      quote,
      data: { kind: 'shortlist' as const, entities: ['HubSpot'] },
    });

    it('keeps only decisions quoted verbatim from the user message', () => {
      const a = analysis({ userFacts: [fact('shortlist HubSpot'), fact('invented quote')] });
      const out = buildEnrichment(a, 'Please shortlist HubSpot for me');
      expect(out.decisions.map((d) => d.quote)).toEqual(['shortlist HubSpot']);
    });

    it('drops self-contradicting facts and writes nothing for a degraded analysis', () => {
      const bad = { ...fact('shortlist'), data: { kind: 'choice' as const } };
      expect(buildEnrichment(analysis({ userFacts: [bad] }), 'shortlist').decisions).toEqual([]);
      const degraded = analysis({ degraded: true, userFacts: [fact('shortlist')] });
      expect(buildEnrichment(degraded, 'shortlist')).toEqual({
        tags: [],
        entities: [],
        decisions: [],
      });
      expect(buildEnrichment(null, 'x')).toEqual({ tags: [], entities: [], decisions: [] });
    });
  });
});

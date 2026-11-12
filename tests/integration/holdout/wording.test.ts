import { afterEach, describe, expect, it } from 'vitest';
import {
  DAY,
  expectConsistent,
  expectWording,
  HOUR,
  o,
  oEff,
  Rig,
  TWO_DOMAINS,
  URL_OTHER_DOMAIN,
  type AuditResult,
  type RigOptions,
} from './rig.js';
import type { Verdict } from './cases.js';

/**
 * HO-12: for each verdict, a model that writes change wording the verdict does not allow, next to the verdict
 * placeholder of the right finding (ADR-40 change language). The sentence must be withheld, and the forbidden
 * word must be nowhere in the visible text. The wording the pipeline itself renders for the verdict is allowed.
 */

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

interface Hostile {
  name: string;
  verdict: Verdict | null;
  sentence: string;
  forbidden: RegExp;
  options: Omit<RigOptions, 'auditSynth'>;
  /** Audits to run; the last one is checked. */
  audits: number[];
  ack?: boolean;
}

const TABLE: Hostile[] = [
  {
    name: 'differs_timing_unknown never permits "raised"',
    verdict: 'differs_timing_unknown',
    sentence: 'Acme CRM raised its price: [[F1:verdict]].',
    forbidden: /raised/i,
    options: { steps: [[o(90)], [o(100)]] },
    audits: [8 * DAY],
  },
  {
    name: 'differs_timing_unknown never permits "previously" or "used to"',
    verdict: 'differs_timing_unknown',
    sentence: 'Acme CRM used to cost [[F1:baseline]] and now differs: [[F1:verdict]].',
    forbidden: /used to/i,
    options: { steps: [[o(90)], [o(100)]] },
    audits: [8 * DAY],
  },
  {
    name: 'no_evidence_of_change never permits "unchanged"',
    verdict: 'no_evidence_of_change',
    sentence: 'The price is unchanged: [[F1:verdict]].',
    forbidden: /unchanged/i,
    options: { steps: [[o(90)], [o(90, { marker: 'none' })]] },
    audits: [8 * DAY],
  },
  {
    name: 'unchanged_confirmed never permits "cut"',
    verdict: 'unchanged_confirmed',
    sentence: 'Acme CRM cut its price: [[F1:verdict]].',
    forbidden: /\bcut\b/i,
    options: { steps: [[o(90)], [o(90)]] },
    audits: [8 * DAY],
  },
  {
    name: 'contested never permits "raised"',
    verdict: 'contested',
    sentence: 'Acme CRM raised its price: [[F1:verdict]].',
    forbidden: /raised/i,
    options: {
      steps: [[o(90)], [o(90), o(100, { url: URL_OTHER_DOMAIN })]],
      registry: TWO_DOMAINS(),
    },
    audits: [8 * DAY],
  },
  {
    name: 'unable_to_verify never permits "unchanged"',
    verdict: 'unable_to_verify',
    sentence: 'The price is unchanged since my answer: [[F1:verdict]].',
    forbidden: /unchanged/i,
    options: { steps: [[o(90)], 'unavailable', 'unavailable'], fallback: 'unavailable' },
    audits: [8 * DAY],
  },
  {
    name: 'changed (up) never permits "cut"',
    verdict: 'changed',
    sentence: 'Acme CRM cut its price: [[F1:verdict]].',
    forbidden: /\bcut\b/i,
    options: { steps: [[o(90)], [o(90)], [o(100)]] },
    audits: [9 * DAY, 10 * DAY + 2 * HOUR],
  },
  {
    name: 'changed (up) never permits "unchanged"',
    verdict: 'changed',
    sentence: 'The price is unchanged: [[F1:verdict]].',
    forbidden: /unchanged/i,
    options: { steps: [[o(90)], [o(90)], [o(100)]] },
    audits: [9 * DAY, 10 * DAY + 2 * HOUR],
  },
  {
    name: 'baseline_incorrect never permits "raised"',
    verdict: 'baseline_incorrect',
    sentence: 'The price was raised: [[F1:verdict]].',
    forbidden: /raised/i,
    options: { steps: [[o(90)], [oEff(100, '1 November 2026')]] },
    audits: [8 * DAY],
  },
  {
    name: 'no baseline (unacknowledged answer) never permits "raised"',
    verdict: null,
    sentence: 'Acme CRM raised its price from [[F1:baseline]] to [[F1]].',
    forbidden: /raised/i,
    options: { steps: [[o(90)], [o(100)]] },
    audits: [8 * DAY],
    ack: false,
  },
];

describe('HOLDOUT 12: the answer text never carries a change claim the verdict forbids', () => {
  for (const h of TABLE) {
    it(`HO-12 ${h.name}`, async () => {
      rig = await Rig.start({ ...h.options, auditSynth: [h.sentence] });
      await rig.research(h.ack ?? true);
      let last: AuditResult | undefined;
      for (const gap of h.audits) last = await rig.audit(gap);
      if (!last) throw new Error('no audit ran');
      expect(last.verdict, 'the verdict the case is about').toBe(h.verdict);
      expect(last.warnings).toContain('sentence_withheld');
      expect(h.forbidden.test(last.text), `forbidden wording in: ${last.text}`).toBe(false);
      expectWording(last.verdict, last.text, last.finding?.direction);
      expectConsistent(rig, last);
    });
  }
});

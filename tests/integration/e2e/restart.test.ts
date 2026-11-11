import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../../../src/temporal/clock.js';
import { acknowledge, ask, Client, DAY, eventsOf, startE2e, TUE, type E2eApp } from './harness.js';
import {
  analysis,
  auditOf,
  extractionOf,
  fixture,
  priceSearch,
  researchOf,
  say,
} from './scenarios.js';

const Q = 'What does Acme CRM cost?';
const AUDIT = 'Is the Acme CRM price you gave me still correct?';
const RECALL = 'What did we talk about last Tuesday?';

const recallAnalysis = {
  whenMessageContains: RECALL,
  reply: analysis({
    laneHint: 'recall' as const,
    temporal: [
      {
        text: 'last Tuesday',
        expr: { kind: 'weekday' as const, weekday: 2 as const, modifier: 'last' as const },
        role: 'reference_conversation' as const,
      },
    ],
  }),
};

const apps: E2eApp[] = [];
let dir: string | undefined;
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('T-E2E restart: nothing depends on in-memory state', () => {
  it('recalls and audits an answer after the application was stopped and started again on the same database file', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recalliq-e2e-'));
    const dbPath = path.join(dir, 'demo.db');

    // first instance: answer and acknowledge
    const one = await startE2e({
      dbPath,
      clock: new FixedClock(TUE),
      fixture: fixture({
        analysis: [researchOf(Q, ['Acme CRM'])],
        extraction: [extractionOf('Acme CRM', 90)],
        search: [priceSearch('Acme CRM', 90)],
        synthesis: [say(Q, 'Acme CRM Pro is [[F1]].')],
      }),
    });
    apps.push(one);
    const user = one.client();
    const conv = await user.newConversation();
    const first = await ask(user, conv, Q);
    await acknowledge(user, first);
    const cookie = user.cookie;
    await one.stop();
    apps.pop();

    // second instance: new process state, same file, a later clock, a different (fresh) provider script
    const two = await startE2e({
      dbPath,
      clock: new FixedClock(TUE + 8 * DAY),
      fixture: fixture({
        analysis: [auditOf(AUDIT, 'Acme CRM'), recallAnalysis],
        extraction: [extractionOf('Acme CRM', 100)],
        search: [priceSearch('Acme CRM', 100)],
        synthesis: [
          say(AUDIT, 'I said [[F1:baseline]]. Now [[F1]]. Acme CRM: [[F1:verdict]].'),
          say(RECALL, 'You wrote this: [[M:{{M1}}]].'),
        ],
      }),
    });
    apps.push(two);
    const back = new Client(two.base);
    back.cookie = cookie;

    // the conversation is still there
    const stored = await back.json<{ messages: Array<{ role: string; content: string }> }>(
      'GET',
      `/api/conversations/${conv}/messages`,
    );
    expect(stored.body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    // audit: the baseline comes from the database, and US$100 is checked against it
    const audit = await ask(back, conv, AUDIT);
    const finding = eventsOf(audit, 'finding')[0] as {
      verdict: string;
      baseline: { value: { amount: number } };
    };
    expect(finding.baseline.value.amount).toBe(90);
    expect(finding.verdict).toBe('differs_timing_unknown');

    // recall: the earlier question is found by its day (2026-11-03 is "last Tuesday" on 2026-11-11)
    two.clock.set(TUE + 8 * DAY + 2 * DAY);
    const recall = await ask(back, await back.newConversation(), RECALL);
    expect(recall.sentences.join(' ')).toContain(Q);
  });
});

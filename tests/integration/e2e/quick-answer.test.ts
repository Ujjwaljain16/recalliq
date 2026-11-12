import { afterEach, describe, expect, it } from 'vitest';
import { QUICK_SYSTEM } from '../../../src/llm/prompts/quick.js';
import { SYNTHESIS_SYSTEM } from '../../../src/llm/prompts/synthesis.js';
import {
  LlmError,
  type LlmPort,
  type StreamEvent,
  type StreamRequest,
  type StructuredRequest,
  type StructuredResult,
} from '../../../src/shared/llm.js';
import {
  acknowledge,
  ask,
  dbContains,
  DAY,
  eventsOf,
  scalar,
  startE2e,
  type E2eApp,
  type TurnOutcome,
} from './harness.js';
import {
  analysis,
  auditOf,
  extractionOf,
  fixture,
  priceSearch,
  researchOf,
  say,
} from './scenarios.js';

let t: E2eApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

const Q = 'What does Acme CRM cost?';
const AUDIT = 'Is the Acme CRM price you gave me still correct?';
const PREFACE = 'Here is what the sources say while I check the details.';

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new LlmError('cancelled', 'aborted'));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new LlmError('cancelled', 'aborted'));
      },
      { once: true },
    );
  });

interface QuickScript {
  /** Deltas of the quick call; `{{S:host}}` becomes the id listed for that host in the prompt. */
  deltas: string[];
  /** Waits before delta i (default 0). */
  delaysMs?: number[];
  /** The quick call fails instead of answering. */
  fail?: boolean;
}

/** The replay model with a scripted quick call and a slow extraction. Records every prompt it is given. */
class QuickLlm implements LlmPort {
  readonly quickPrompts: string[] = [];
  readonly fullPrompts: Array<{ system: string; content: string }> = [];
  quickCalls = 0;

  constructor(
    private readonly inner: LlmPort,
    private readonly script: QuickScript,
    private readonly extractionDelayMs: number,
  ) {}

  async structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>> {
    if (r.role === 'extraction' && this.extractionDelayMs > 0)
      await sleep(this.extractionDelayMs, r.signal);
    return this.inner.structured(r);
  }

  async *stream(r: StreamRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const content = r.messages.at(-1)?.content ?? '';
    if (r.system !== QUICK_SYSTEM) {
      this.fullPrompts.push({ system: r.system, content });
      yield* this.inner.stream(r);
      return;
    }
    this.quickCalls++;
    this.quickPrompts.push(content);
    if (this.script.fail) throw new LlmError('unavailable', 'quick failed');
    const listed = new Map<string, string>();
    for (const m of content.matchAll(/\[\[S:(src_[A-Za-z0-9_-]+)\]\] domain: (\S+)/g)) {
      listed.set(m[2] ?? '', m[1] ?? '');
    }
    for (const [i, raw] of this.script.deltas.entries()) {
      await sleep(this.script.delaysMs?.[i] ?? 0, r.signal);
      yield {
        type: 'delta',
        text: raw.replace(
          /\{\{S:([^}]+)\}\}/g,
          (_a, host: string) => `[[S:${listed.get(host) ?? 'src_none'}]]`,
        ),
      };
    }
    yield {
      type: 'done',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'fixture',
      ttftMs: 0,
      latencyMs: 0,
    };
  }
}

const S1 = 'Acme CRM lists Pro at US$90 per user per month {{S:acme.example}}.';
const S2 = ' Acme CRM lists Starter at US$20 per user per month {{S:acme.example}}.';

async function start(
  script: QuickScript,
  extractionDelayMs: number,
  synthesis = [say(Q, 'Acme CRM Pro is [[F1]].')],
  extra: { audit?: boolean; general?: boolean } = {},
): Promise<{ app: E2eApp; llm: () => QuickLlm }> {
  let llm: QuickLlm | undefined;
  const app = await startE2e({
    quick: true,
    wrapLlm: (inner) => (llm = new QuickLlm(inner, script, extractionDelayMs)),
    fixture: fixture({
      analysis: [
        researchOf(Q, ['Acme CRM']),
        ...(extra.audit ? [auditOf(AUDIT, 'Acme CRM')] : []),
        ...(extra.general
          ? [{ whenMessageContains: 'Hello there', reply: analysis({ laneHint: 'chat' }) }]
          : []),
      ],
      extraction: [extractionOf('Acme CRM', 90)],
      search: [priceSearch('Acme CRM', 90, 90)],
      synthesis: [
        ...synthesis,
        ...(extra.audit ? [say(AUDIT, 'Acme CRM: [[F1]].')] : []),
        ...(extra.general ? [say('Hello there', 'Hello, how can I help you today.')] : []),
      ],
    }),
  });
  t = app;
  return {
    app,
    llm: () => {
      if (!llm) throw new Error('the model was not built');
      return llm;
    },
  };
}

const names = (turn: TurnOutcome): string[] => turn.names;
const indexOf = (
  turn: TurnOutcome,
  pred: (e: { event: string; data: unknown }) => boolean,
): number => turn.read.events.findIndex(pred);
const ends = (turn: TurnOutcome): number[] =>
  (eventsOf(turn, 'answer.sentence_end') as Array<{ index: number }>).map((e) => e.index);

describe('T-QUICK a sourced answer streams while extraction runs', () => {
  it('sends sources, then the preface and a quick sentence, then the findings, then the verified sentences', async () => {
    const { app, llm } = await start({ deltas: [S1, S2] }, 300);
    const user = app.client();
    const turn = await ask(user, await user.newConversation(), Q);

    const firstSource = names(turn).indexOf('source');
    const firstDelta = names(turn).indexOf('answer.delta');
    const firstFinding = names(turn).indexOf('finding');
    expect(firstSource).toBeGreaterThanOrEqual(0);
    expect(firstSource).toBeLessThan(firstDelta);
    expect(firstDelta).toBeLessThan(firstFinding);
    const lastQuickDelta = indexOf(
      turn,
      (e) =>
        e.event === 'answer.delta' && (e.data as { sentenceIndex: number }).sentenceIndex === 2,
    );
    expect(lastQuickDelta).toBeLessThan(firstFinding);
    const verified = indexOf(
      turn,
      (e) =>
        e.event === 'answer.delta' && (e.data as { sentenceIndex: number }).sentenceIndex === 3,
    );
    expect(verified).toBeGreaterThan(firstFinding);

    expect(turn.sentences[0]).toBe(PREFACE);
    expect(turn.sentences[1]).toContain('US$90');
    expect(turn.sentences).toHaveLength(4);
    expect(ends(turn)).toEqual([0, 1, 2, 3]);
    expect(turn.completed?.sentences.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(turn.status).toBe('complete');

    // one message, whose text is the sentences in order
    expect(scalar(app.app, "SELECT count(*) FROM messages WHERE role = 'assistant'")).toBe(1);
    const stored = scalar<string>(app.app, "SELECT content FROM messages WHERE role = 'assistant'");
    expect(stored).toBe(turn.sentences.join(''));
    expect(llm().quickCalls).toBe(1);
  });

  it('withholds a quick sentence with a number its source does not contain', async () => {
    const { app } = await start(
      { deltas: ['Acme CRM lists Pro at US$95 per user per month {{S:acme.example}}.', S2] },
      200,
    );
    const user = app.client();
    const turn = await ask(user, await user.newConversation(), Q);
    const warnings = eventsOf(turn, 'warning') as Array<{ code: string; text: string }>;
    expect(warnings.find((w) => w.code === 'sentence_withheld')?.text).toContain(
      'ungrounded_number',
    );
    expect(turn.read.raw).not.toContain('US$95');
    expect(dbContains(app.app, 'US$95')).toBe(false);
    // preface, the grounded sentence, the verified one: numbering has no gap
    expect(ends(turn)).toEqual([0, 1, 2]);
  });

  it('withholds a quick sentence that cites no source, and shows no preface when none was released', async () => {
    const { app } = await start({ deltas: ['Acme CRM is a customer tool for teams.'] }, 200);
    const user = app.client();
    const turn = await ask(user, await user.newConversation(), Q);
    expect(turn.sentences.join('')).not.toContain(PREFACE);
    expect(ends(turn)).toEqual([0]);
  });

  it('never makes an assertion from a quick sentence; the verified section does', async () => {
    const { app } = await start({ deltas: [S1, S2] }, 200);
    const user = app.client();
    await ask(user, await user.newConversation(), Q);
    expect(scalar(app.app, 'SELECT count(*) FROM assertions')).toBe(1);
    expect(scalar(app.app, 'SELECT min(sentence_index) FROM assertions')).toBe(3);
    expect(scalar(app.app, 'SELECT count(*) FROM assertions WHERE sentence_index < 3')).toBe(0);
  });

  it('runs only the normal synthesis when the findings are ready before the quick answer released anything', async () => {
    const { app, llm } = await start({ deltas: [S1, S2], delaysMs: [1500, 0] }, 0);
    const user = app.client();
    const turn = await ask(user, await user.newConversation(), Q);
    expect(turn.sentences).toEqual([
      'Acme CRM Pro is ' + (turn.sentences[0] ?? '').slice('Acme CRM Pro is '.length),
    ]);
    expect(turn.sentences.join('')).not.toContain(PREFACE);
    expect(ends(turn)).toEqual([0]);
    expect(llm().quickCalls).toBe(1);
    expect(llm().fullPrompts).toHaveLength(1);
    expect(llm().fullPrompts[0]?.system).toBe(SYNTHESIS_SYSTEM);
    expect(llm().fullPrompts[0]?.content).not.toContain('already_shown');
  });

  it('keeps what the quick section released when the findings arrive mid-stream, and continues the numbering', async () => {
    const { app, llm } = await start(
      {
        deltas: [S1, ' A', S2.slice(2)],
        delaysMs: [0, 0, 1500],
      },
      250,
    );
    const user = app.client();
    const turn = await ask(user, await user.newConversation(), Q);
    expect(turn.sentences[0]).toBe(PREFACE);
    expect(ends(turn)).toEqual([0, 1, 2]);
    expect(turn.sentences.join('')).not.toContain('Starter');
    expect(llm().fullPrompts[0]?.content).toContain('already_shown');
  });

  it('gives the verified synthesis the quick sentences, fenced, and the instruction to confirm, add or correct', async () => {
    const { app, llm } = await start({ deltas: [S1, S2] }, 250);
    const user = app.client();
    await ask(user, await user.newConversation(), Q);
    const prompt = llm().fullPrompts[0];
    expect(prompt?.system).toContain('already_shown');
    expect(prompt?.system).toContain('correct it explicitly');
    const block = /<data kind="already_shown">\n([\s\S]*?)\n<\/data>/.exec(
      prompt?.content ?? '',
    )?.[1];
    expect(block).toContain(PREFACE);
    expect(block).toContain('Acme CRM lists Pro at US$90 per user per month');
    // the quick call itself saw sources and the message, no findings
    expect(llm().quickPrompts[0]).toContain('<data kind="sources">');
    expect(llm().quickPrompts[0]).not.toContain('kind="findings"');
  });

  it('a verified section with nothing to add leaves the quick answer as a complete answer, not an interrupted one', async () => {
    // The only verified sentence states a number no source holds, so it is withheld and nothing new remains.
    const { app } = await start({ deltas: [S1] }, 250, [say(Q, 'It costs 5 dollars flat.')]);
    const user = app.client();
    const turn = await ask(user, await user.newConversation(), Q);
    expect(turn.sentences.join('')).toContain('US$90');
    expect(turn.sentences.join('')).not.toContain('5 dollars');
    expect(turn.status).toBe('complete');
    expect(eventsOf(turn, 'error')).toEqual([]);
  });

  it('a failed quick call leaves the turn exactly as it is without one', async () => {
    const { app } = await start({ deltas: [], fail: true }, 200);
    const user = app.client();
    const turn = await ask(user, await user.newConversation(), Q);
    expect(turn.sentences).toHaveLength(1);
    expect(turn.status).toBe('complete');
    expect(eventsOf(turn, 'error')).toEqual([]);
  });

  it('an acknowledgement after the quick part only presents nothing, and a later audit finds no baseline', async () => {
    const { app } = await start({ deltas: [S1, S2] }, 200, undefined, { audit: true });
    const user = app.client();
    const conv = await user.newConversation();
    const first = await ask(user, conv, Q);
    // the browser rendered the preface and the two quick sentences (0..2) but not the verified sentence (3)
    const ack = await acknowledge(user, first, 2);
    expect(ack.status).toBe(200);
    expect(scalar(app.app, 'SELECT count(*) FROM assertions WHERE presented_at IS NOT NULL')).toBe(
      0,
    );

    app.clock.advance(8 * DAY);
    const audit = await ask(user, conv, AUDIT);
    const findings = eventsOf(audit, 'finding') as Array<{ baseline?: unknown }>;
    expect(findings).toHaveLength(1);
    expect(findings[0]?.baseline).toBeUndefined();
    expect(audit.sentences.join(' ')).toContain('no earlier answer of my own on record');
  });

  it('an acknowledgement of the whole answer presents the verified claim, which a later audit finds as the baseline', async () => {
    const { app } = await start({ deltas: [S1, S2] }, 200, undefined, { audit: true });
    const user = app.client();
    const conv = await user.newConversation();
    const first = await ask(user, conv, Q);
    expect((await acknowledge(user, first)).status).toBe(200);
    expect(scalar(app.app, 'SELECT count(*) FROM assertions WHERE presented_at IS NOT NULL')).toBe(
      1,
    );
    app.clock.advance(8 * DAY);
    const audit = await ask(user, conv, AUDIT);
    const findings = eventsOf(audit, 'finding') as Array<{
      baseline?: { value: { amount: number } };
    }>;
    expect(findings[0]?.baseline?.value.amount).toBe(90);
  });

  it('does not touch a chat turn', async () => {
    const { app, llm } = await start({ deltas: [S1] }, 0, undefined, { general: true });
    const user = app.client();
    const turn = await ask(user, await user.newConversation(), 'Hello there');
    expect(turn.sentences).toEqual(['Hello, how can I help you today.']);
    expect(llm().quickCalls).toBe(0);
  });
});

import { z } from 'zod';

/**
 * Talks to the running application exactly as the browser client does: a session cookie set by the first
 * POST /api/conversations, one SSE stream per turn, and an acknowledgement of the rendered sentences after
 * the stream ends. Times are measured on the harness side, from sending the request.
 */

export interface TurnSentence {
  index: number;
  text: string;
  /** The last status the stream gave it (`verification` events update `answer.sentence_end`). */
  status: string;
}

export interface TurnOutcome {
  httpStatus: number;
  turnId: string | null;
  lane: string | null;
  status: string | null;
  sentences: TurnSentence[];
  /** Issue lists of sentences withheld by the release gate (they are never streamed). */
  withheld: string[][];
  clarification: { question: string; options: string[] } | null;
  sources: Array<{ url: string; domain: string }>;
  citations: number;
  warnings: Array<{ code: string; text: string }>;
  errors: Array<{ code: string; text: string }>;
  serverMetrics: { ttfpMs: number | null; ttftMs: number | null; ttcMs: number } | null;
  wallMs: number;
  firstEventMs: number | null;
  firstTextMs: number | null;
  /** The JSON error body of a refused request (non-200), if any. */
  refusal: string | null;
}

const started = z.object({ turnId: z.string() });
const context = z.object({ lane: z.string() });
const delta = z.object({ sentenceIndex: z.number().int(), text: z.string() });
const sentenceEnd = z.object({ index: z.number().int(), status: z.string() });
const verification = z.object({ index: z.number().int(), status: z.string() });
const source = z.object({ url: z.string(), domain: z.string() });
const coded = z.object({ code: z.string(), text: z.string() });
const clarification = z.object({
  question: z.string(),
  options: z.array(z.object({ label: z.string() })),
});
const completed = z.object({ citations: z.array(z.string()) });
const turnCompleted = z.object({
  status: z.string(),
  metrics: z.object({
    ttfpMs: z.number().nullable(),
    ttftMs: z.number().nullable(),
    ttcMs: z.number(),
  }),
});

function issuesOf(text: string): string[] {
  const m = /\(([^)]*)\)\.?$/.exec(text);
  return m?.[1] ? m[1].split(',').map((s) => s.trim()) : [];
}

export class BenchClient {
  private cookie: string | null = null;

  constructor(
    private readonly base: string,
    private readonly now: () => number = Date.now,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers['cookie'] = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.base + path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? '';
      this.cookie = pair.endsWith('=') ? null : pair;
    }
    return res;
  }

  /** Creates a conversation (and, on first use, the user and its cookie). */
  async newConversation(): Promise<string> {
    const res = await this.request('POST', '/api/conversations', {});
    const text = await res.text();
    if (res.status !== 201) throw new Error(`creating a conversation failed: HTTP ${res.status}`);
    const parsed = z.object({ conversation: z.object({ id: z.string() }) }).parse(JSON.parse(text));
    return parsed.conversation.id;
  }

  async ack(turnId: string, renderedThrough: number): Promise<number> {
    const res = await this.request('POST', `/api/turns/${turnId}/ack`, {
      renderedThrough,
      complete: true,
    });
    await res.text();
    return res.status;
  }

  async turn(
    conversationId: string,
    text: string,
    idempotencyKey: string,
    tz = 'UTC',
  ): Promise<TurnOutcome> {
    const t0 = this.now();
    const res = await this.request('POST', `/api/conversations/${conversationId}/turns`, {
      text,
      idempotencyKey,
      tz,
    });
    const out: TurnOutcome = {
      httpStatus: res.status,
      turnId: null,
      lane: null,
      status: null,
      sentences: [],
      withheld: [],
      clarification: null,
      sources: [],
      citations: 0,
      warnings: [],
      errors: [],
      serverMetrics: null,
      wallMs: 0,
      firstEventMs: null,
      firstTextMs: null,
      refusal: null,
    };
    if (res.status !== 200 || res.body === null) {
      out.refusal = (await res.text()).slice(0, 500);
      out.wallMs = this.now() - t0;
      return out;
    }
    const sentences = new Map<number, TurnSentence>();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const handle = (event: string, raw: string): void => {
      const at = this.now() - t0;
      if (out.firstEventMs === null && event !== 'turn.started') out.firstEventMs = at;
      const data = JSON.parse(raw) as unknown;
      switch (event) {
        case 'turn.started':
          out.turnId = started.parse(data).turnId;
          break;
        case 'context':
          out.lane = context.parse(data).lane;
          break;
        case 'answer.delta': {
          const d = delta.parse(data);
          if (out.firstTextMs === null) out.firstTextMs = at;
          const s = sentences.get(d.sentenceIndex) ?? {
            index: d.sentenceIndex,
            text: '',
            status: 'pending',
          };
          s.text += d.text;
          sentences.set(d.sentenceIndex, s);
          break;
        }
        case 'answer.sentence_end':
        case 'verification': {
          const e = event === 'verification' ? verification.parse(data) : sentenceEnd.parse(data);
          const s = sentences.get(e.index);
          if (s) s.status = e.status;
          break;
        }
        case 'source':
          out.sources.push(source.parse(data));
          break;
        case 'answer.completed':
          out.citations = completed.parse(data).citations.length;
          break;
        case 'clarification': {
          const c = clarification.parse(data);
          out.clarification = { question: c.question, options: c.options.map((o) => o.label) };
          break;
        }
        case 'warning': {
          const w = coded.parse(data);
          out.warnings.push(w);
          if (w.code === 'sentence_withheld') out.withheld.push(issuesOf(w.text));
          break;
        }
        case 'error':
          out.errors.push(coded.parse(data));
          break;
        case 'turn.completed': {
          const c = turnCompleted.parse(data);
          out.status = c.status;
          out.serverMetrics = c.metrics;
          break;
        }
        default:
          break;
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event && data) handle(event, data);
      }
    }
    out.wallMs = this.now() - t0;
    out.sentences = [...sentences.values()].sort((a, b) => a.index - b.index);
    // Acknowledge what was rendered, as the browser does once the sentences are on screen.
    const last = out.sentences.at(-1);
    if (out.turnId !== null && last !== undefined) await this.ack(out.turnId, last.index);
    return out;
  }
}

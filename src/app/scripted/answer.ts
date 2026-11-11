import type { AnswerPipeline, PersistedSentence, SentenceIssue } from '../../shared/answer.js';
import type { Finding } from '../../shared/findings.js';
import type { MessageId, SnapshotId } from '../../shared/ids.js';
import type { NormalizedValue } from '../../shared/evidence.js';

/**
 * DEVELOPMENT / SCRIPTED. There is no model here. This builds a few canned sentences from the stored data the
 * lanes already resolved (recalled messages, scripted findings) and streams them the way the real answer
 * pipeline does once a sentence is validated: one `answer.delta` carrying the whole rendered sentence, then its
 * `answer.sentence_end` with the final status.
 *
 * It does use the real placeholder grammar and the real rendering rules of docs/contracts.md section 3: the
 * template holds `[[F1]]`, `[[F1:verdict]]` or `[[M:msg_...]]`, and the sentence text is that template with
 * each placeholder replaced by its rendered form. Free text carries no numbers of its own except in the two
 * deliberate demonstration sentences (see below).
 *
 * Two optional demonstration sentences exist so the interface can show them: a message that contains the word
 * "unverified" gets a sentence with status `unverified`, and one that contains "unchecked" gets a sentence
 * released with status `unchecked`.
 */

export interface ScriptedAnswerOptions {
  /** Pause between deltas, so a person can watch the stream. 0 (the default) means none. */
  paceMs?: number;
}

type Placeholder = PersistedSentence['placeholders'][number];

interface Draft {
  template: string;
  text: string;
  placeholders: Placeholder[];
  status: PersistedSentence['status'];
  issues: SentenceIssue[];
  /** The final status of a sentence that could not be checked (it is released with this status). */
  lateStatus?: PersistedSentence['status'];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-11-03 14:05" to "Tue 3 Nov, 14:05" (the form of the message-quote rendering, contracts section 3). */
export function formatLocalTime(localTime: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(localTime);
  if (!m) return localTime;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${DAYS[date.getUTCDay()]} ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}, ${m[4]}`;
}

export function renderMessageQuote(text: string, localTime: string): string {
  return `"${text}" (${formatLocalTime(localTime)})`;
}

function unitPhrase(v: NormalizedValue): string {
  const per = v.unit === 'per_seat' ? 'per user' : v.unit === 'flat' ? 'flat' : '';
  const period =
    v.billingPeriod === 'monthly' ? 'per month' : v.billingPeriod === 'annual' ? 'per year' : '';
  return [per, period].filter((p) => p.length > 0).join(' ');
}

/** `[[F3]]`: "<amount with symbol> <unit/period phrase> [n]" (the plan and arrangement parts do not apply here). */
export function renderCurrent(f: Finding, citationNumber: number): string {
  const v = f.current?.value;
  if (!v) return 'no value';
  const amount = `${v.currencySymbol ?? ''}${v.amount}`;
  return `${amount} ${unitPhrase(v)} [${citationNumber}]`.replace(/\s+/g, ' ');
}

/** `[[F3:verdict]]`: the fixed phrase per (verdict, reason), architecture section 8. */
export function renderVerdict(f: Finding): string {
  if (f.verdict === 'unable_to_verify') {
    const reason = (f.verdictReason ?? f.coverage.failure ?? 'unknown').replace(/_/g, ' ');
    return `couldn't be checked this time (${reason})`;
  }
  return 'has no verdict';
}

function template(parts: Array<string | Placeholder>): Draft['placeholders'] {
  return parts.filter((p): p is Placeholder => typeof p !== 'string');
}

function draftOf(parts: Array<string | Placeholder>, status: Draft['status']): Draft {
  return {
    template: parts.map((p) => (typeof p === 'string' ? p : p.token)).join(''),
    text: parts.map((p) => (typeof p === 'string' ? p : p.rendered)).join(''),
    placeholders: template(parts),
    status,
    issues: [],
  };
}

function plain(text: string): Draft {
  return draftOf([text], 'no_claims');
}

function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function chatDrafts(userMessage: string): Draft[] {
  const msg = userMessage.trim();
  if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/i.test(msg)) {
    return [
      plain("Hello, I'm the RecallIQ demo assistant."),
      plain(
        'This build gives scripted demo responses, so I do not search the web or call a language model.',
      ),
    ];
  }
  if (/\b(thanks|thank you)\b/i.test(msg)) return [plain("You're welcome.")];
  if (/\b(price|prices|pricing|cost|costs|how much|plan|plans)\b/i.test(msg)) {
    return [
      plain(
        'I can look up a price once you name the company or product, for example "What does Acme charge?".',
      ),
    ];
  }
  return [
    plain("I'm running scripted demo responses, so I can only show a few canned behaviours."),
    plain('Try asking what a product costs, or what you asked earlier today.'),
  ];
}

function recallDrafts(
  hits: Array<{ messageId: MessageId; text: string; localTime: string }>,
): Draft[] {
  if (hits.length === 0) return [plain('I only see the question you just asked, nothing earlier.')];
  const out: Draft[] = [];
  for (const h of hits.slice(0, 3)) {
    const token = `[[M:${h.messageId}]]`;
    const draft = draftOf(
      [
        'You asked ',
        { token, messageId: h.messageId, rendered: renderMessageQuote(h.text, h.localTime) },
        '.',
      ],
      'verified',
    );
    out.push(draft);
  }
  if (hits.length > 3) out.push(plain('There are more messages from that day than I list here.'));
  return out;
}

function researchDrafts(findings: Finding[], sources: SnapshotId[], userMessage: string): Draft[] {
  const out: Draft[] = [];
  for (const f of findings) {
    const unable = f.currentStatus === 'unable_to_verify';
    if (unable) {
      const token = `[[F${f.ord}:verdict]]`;
      out.push(
        draftOf(
          [
            `I tried to check ${f.entityName}'s current price, but the price `,
            { token, findingId: f.id, rendered: renderVerdict(f) },
            '.',
          ],
          'verified',
        ),
      );
      continue;
    }
    const cited = f.current?.citations[0];
    const n = cited === undefined ? 0 : sources.indexOf(cited) + 1;
    out.push(
      draftOf(
        [
          `${f.entityName} lists `,
          { token: `[[F${f.ord}]]`, findingId: f.id, rendered: renderCurrent(f, n) },
          '.',
        ],
        'verified',
      ),
    );
  }
  if (/\bunverified\b/i.test(userMessage)) {
    out.push({
      ...plain('My unsourced guess is that it costs about 40 dollars per user.'),
      status: 'unverified',
      issues: ['free_number', 'free_currency'],
    });
  }
  if (/\bunchecked\b/i.test(userMessage)) {
    out.push({
      ...plain('Prices like this usually change at the start of a quarter.'),
      status: 'no_claims',
      lateStatus: 'unchecked',
      issues: ['judge_unavailable'],
    });
  }
  const anyUnable = findings.some((f) => f.currentStatus === 'unable_to_verify');
  out.push(
    plain(
      anyUnable
        ? 'These are scripted demo results, and I will not treat a failed check as evidence either way.'
        : 'These figures are scripted demo data, not real prices.',
    ),
  );
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ScriptedAnswer implements AnswerPipeline {
  constructor(private readonly options: ScriptedAnswerOptions = {}) {}

  async run(
    input: Parameters<AnswerPipeline['run']>[0],
    _budget: Parameters<AnswerPipeline['run']>[1],
    emit: Parameters<AnswerPipeline['run']>[2],
  ): ReturnType<AnswerPipeline['run']> {
    const lane = input.ctx.lane;
    let drafts: Draft[];
    if (lane === 'recall') {
      const current = normalizeSpaces(input.userMessage);
      drafts = recallDrafts(
        input.ctx.memoryHits
          .map((h) => ({
            messageId: h.messageId,
            ...(input.recall.get(h.messageId) ?? { text: h.excerpt, localTime: h.localTime }),
          }))
          // The question being answered is itself a stored message of today: never list it as an answer.
          .filter((h) => normalizeSpaces(h.text) !== current),
      );
    } else if (input.findings !== null) {
      const sources = Object.keys(input.findings.sources) as SnapshotId[];
      drafts = researchDrafts(input.findings.findings, sources, input.userMessage);
    } else {
      drafts = chatDrafts(input.userMessage);
    }

    const sentences: PersistedSentence[] = [];
    for (const [index, draft] of drafts.entries()) {
      // A validated sentence is released whole: one delta with the complete rendered text, immediately
      // followed by its sentence_end with the final status. There is no partial text and no later downgrade.
      emit({ event: 'answer.delta', data: { sentenceIndex: index, text: draft.text } });
      const status = draft.lateStatus ?? draft.status;
      emit({ event: 'answer.sentence_end', data: { index, status, issues: draft.issues } });
      if (this.options.paceMs) await sleep(this.options.paceMs);
      sentences.push({
        index,
        text: draft.text,
        template: draft.template,
        status,
        issues: draft.issues,
        placeholders: draft.placeholders,
      });
    }
    return {
      sentences,
      streamedThrough: sentences.length - 1,
      interrupted: false,
      template: sentences.map((s) => s.template).join(' '),
      rendered: sentences.map((s) => s.text).join(' '),
    };
  }
}

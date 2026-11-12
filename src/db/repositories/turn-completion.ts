import { z } from 'zod';
import type { Clock } from '../../shared/infrastructure.js';
import { newId, parseId, type MessageId, type TurnId, type UserId } from '../../shared/ids.js';
import type { TurnCompletion } from '../../shared/repositories.js';
import type { Db } from '../connection.js';
import { InvalidCompletionError, InvalidTransitionError, NotFoundError } from '../errors.js';
import { turnCompletionSchema } from '../schemas.js';
import { queryOne } from '../sql.js';
import { parseEnrichment, writeEnrichment } from './enrichment.js';
import type { MessageRepository } from './messages.js';

const turnState = z.object({
  conversation_id: z.string(),
  user_message_id: z.string(),
  state: z.string(),
  status: z.string(),
});
const userMessage = z.object({ tz: z.string(), origin: z.enum(['live', 'recorded', 'synthetic']) });
const oneRow = z.object({ one: z.literal(1) });
const lane = z.enum(['chat', 'recall', 'research', 'audit', 'clarify']);

/**
 * Checks a TurnCompletion for internal consistency, before any write. Pure.
 *
 * Throws ZodError for a malformed shape and InvalidCompletionError for a well-formed but inconsistent one,
 * including a request that is not supported yet (belief recomputation needs the belief resolver): that is
 * rejected loudly, never ignored. Enrichment is checked structurally here and against the
 * user message (decision quotes) inside the completion transaction.
 */
export function validateCompletion(turnId: TurnId, completion: TurnCompletion): void {
  parseEnrichment(completion.enrichment); // untrusted LLM output
  const c = turnCompletionSchema.parse(completion);

  if (c.touchedBeliefKeys.length > 0) {
    throw new InvalidCompletionError(
      'touchedBeliefKeys is not supported yet: belief recomputation needs the belief resolver',
    );
  }

  if (c.status === 'interrupted' && c.assistant?.messageStatus !== 'interrupted') {
    throw new InvalidCompletionError(
      'an interrupted turn must store an interrupted assistant message',
    );
  }
  if (c.assistant?.messageStatus === 'interrupted' && c.status !== 'interrupted') {
    throw new InvalidCompletionError(
      'an interrupted assistant message requires status "interrupted"',
    );
  }

  const sentences = c.assistant?.sentences ?? [];
  sentences.forEach((sentence, i) => {
    if (sentence.index !== i) {
      throw new InvalidCompletionError(`sentence at position ${i} has index ${sentence.index}`);
    }
  });
  if (c.assistant && c.assistant.streamedThrough > sentences.length - 1) {
    throw new InvalidCompletionError(
      `streamedThrough ${c.assistant.streamedThrough} is beyond the last sentence (${sentences.length - 1})`,
    );
  }

  const findings = c.findings?.findings ?? [];
  if (c.findings && c.findings.turnId !== turnId) {
    throw new InvalidCompletionError('findings belong to a different turn');
  }
  if (new Set(findings.map((f) => f.id)).size !== findings.length) {
    throw new InvalidCompletionError('duplicate finding id');
  }
  if (new Set(findings.map((f) => f.ord)).size !== findings.length) {
    throw new InvalidCompletionError('duplicate finding ord');
  }

  if (c.assertions.length > 0 && !c.assistant) {
    throw new InvalidCompletionError('assertions need an assistant message to belong to');
  }
  const seen = new Set<string>();
  for (const assertion of c.assertions) {
    const finding = findings.find((f) => f.id === assertion.findingId);
    if (!finding)
      throw new InvalidCompletionError(`assertion cites unknown finding ${assertion.findingId}`);
    const ord = Number(/^F(\d+)/.exec(assertion.placeholder)?.[1]);
    if (ord !== finding.ord) {
      throw new InvalidCompletionError(
        `placeholder ${assertion.placeholder} does not refer to finding ord ${finding.ord}`,
      );
    }
    const sentence = sentences[assertion.sentenceIndex];
    if (!sentence) {
      throw new InvalidCompletionError(
        `assertion sentenceIndex ${assertion.sentenceIndex} is out of range`,
      );
    }
    // An assertion records what was actually rendered, so it must match a rendered placeholder of its sentence.
    const rendered = sentence.placeholders.some(
      (p) =>
        p.token === `[[${assertion.placeholder}]]` &&
        p.findingId === assertion.findingId &&
        p.rendered === assertion.renderedText,
    );
    if (!rendered) {
      throw new InvalidCompletionError(
        `assertion ${assertion.placeholder} in sentence ${assertion.sentenceIndex} matches no rendered placeholder`,
      );
    }
    const key = `${assertion.sentenceIndex}:${assertion.placeholder}`;
    if (seen.has(key)) throw new InvalidCompletionError(`duplicate assertion ${key}`);
    seen.add(key);
  }
}

/**
 * Stores the outcome of a turn atomically: the assistant message, findings, assertions with their evidence
 * links, the `not_presented` events for sentences that were never streamed, the verdict events on baseline
 * assertions, the write-time enrichment (search rows, tags, decisions), and the final turn row. Either all of it is written or none is.
 *
 * Delivery rules applied here (architecture, answer delivery):
 *   - assertions are stored unpresented; only a browser acknowledgement (TurnRepository.ack) presents them;
 *   - an assertion in a sentence beyond `streamedThrough` is born with a `not_presented` event;
 *   - a streamed sentence gets no event yet: streamed-but-unacknowledged is a derived state, not a claim told;
 *   - verdict events may only target assertions that were actually presented, in an earlier turn.
 */
export function completeTurn(
  db: Db,
  clock: Clock,
  messages: MessageRepository,
  userId: UserId,
  turnId: TurnId,
  completion: TurnCompletion,
): void {
  validateCompletion(turnId, completion);
  const c = completion;
  const enrichment = parseEnrichment(c.enrichment);

  db.transaction(() => {
    const turn = queryOne(
      db,
      'SELECT conversation_id, user_message_id, state, status FROM turns WHERE id = ? AND user_id = ?',
      turnState,
      [turnId, userId],
    );
    if (!turn) throw new NotFoundError('turn');
    if (turn.status !== 'running' || turn.state !== 'PERSISTING') {
      throw new InvalidTransitionError(
        turn.state,
        'COMPLETED',
        `complete() needs a running turn in PERSISTING, found ${turn.status}/${turn.state}`,
      );
    }
    const now = clock.now();

    let assistantMessageId: MessageId | null = null;
    if (c.assistant) {
      const user = queryOne(
        db,
        `SELECT m.tz, m.origin FROM turns t JOIN messages m ON m.id = t.user_message_id
         WHERE t.id = ? AND t.user_id = ?`,
        userMessage,
        [turnId, userId],
      );
      if (!user) throw new NotFoundError('user message');
      assistantMessageId = messages.insert({
        userId,
        conversationId: parseId('cnv', turn.conversation_id),
        role: 'assistant',
        content: c.assistant.rendered,
        template: c.assistant.template,
        sentences: c.assistant.sentences,
        status: c.assistant.messageStatus,
        streamedThrough: c.assistant.streamedThrough,
        tz: user.tz,
        origin: user.origin,
        turnId,
      }).id;
    }

    // Enrichment shares this transaction: if anything below fails, the search rows and decisions go too.
    writeEnrichment(
      db,
      {
        userId,
        conversationId: parseId('cnv', turn.conversation_id),
        userMessageId: parseId('msg', turn.user_message_id),
        assistantMessageId,
        now,
      },
      enrichment,
    );

    const isPresentedBaseline = db.prepare(
      'SELECT 1 AS one FROM assertions WHERE id = ? AND user_id = ? AND presented_at IS NOT NULL AND turn_id <> ?',
    );

    const insertFinding = db.prepare(
      `INSERT INTO findings (id, turn_id, ord, entity_id, intent, belief_key, current_status, verdict,
         verdict_reason, baseline_assertion_id, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const finding of c.findings?.findings ?? []) {
      if (finding.baseline) {
        const baseline: unknown = isPresentedBaseline.get(
          finding.baseline.assertionId,
          userId,
          turnId,
        );
        if (!oneRow.safeParse(baseline).success) {
          throw new InvalidCompletionError(
            `finding ${finding.ord} uses baseline ${finding.baseline.assertionId}, which was never presented to this user`,
          );
        }
      }
      insertFinding.run(
        finding.id,
        turnId,
        finding.ord,
        finding.entityId,
        finding.intent,
        finding.beliefKey,
        finding.currentStatus,
        finding.verdict,
        finding.verdictReason,
        finding.baseline?.assertionId ?? null,
        JSON.stringify(finding),
      );
    }

    const insertAssertion = db.prepare(
      `INSERT INTO assertions (id, user_id, message_id, turn_id, finding_id, sentence_index, placeholder,
         belief_key, rendered_text, value_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const linkEvidence = db.prepare(
      'INSERT INTO assertion_evidence (assertion_id, evidence_id) VALUES (?, ?)',
    );
    const insertEvent = db.prepare(
      `INSERT INTO assertion_events (id, assertion_id, status, reason, evidence_ids, turn_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const streamedThrough = c.assistant?.streamedThrough ?? -1;
    for (const assertion of c.assertions) {
      const id = newId('asr');
      insertAssertion.run(
        id,
        userId,
        assistantMessageId,
        turnId,
        assertion.findingId,
        assertion.sentenceIndex,
        assertion.placeholder,
        assertion.beliefKey,
        assertion.renderedText,
        assertion.value === null ? null : JSON.stringify(assertion.value),
        now,
      );
      for (const evidenceId of assertion.evidenceIds) linkEvidence.run(id, evidenceId);
      if (assertion.sentenceIndex > streamedThrough) {
        insertEvent.run(
          newId('aev'),
          id,
          'not_presented',
          'never_streamed',
          JSON.stringify(assertion.evidenceIds),
          turnId,
          now,
        );
      }
    }

    for (const event of c.baselineEvents) {
      const baseline: unknown = isPresentedBaseline.get(event.assertionId, userId, turnId);
      if (!oneRow.safeParse(baseline).success) {
        throw new InvalidCompletionError(
          `baseline event on ${event.assertionId}: only an assertion presented to this user in an earlier turn can be judged`,
        );
      }
      insertEvent.run(
        newId('aev'),
        event.assertionId,
        event.status,
        event.reason,
        JSON.stringify(event.evidenceIds),
        turnId,
        now,
      );
    }

    const contextLane = lane.safeParse(c.context?.['lane']);
    const result = db
      .prepare(
        `UPDATE turns SET state = 'COMPLETED', status = ?, assistant_message_id = ?, lane = ?,
           analysis_json = ?, context_json = ?, events_json = ?, metrics_json = ?, error_code = ?, finished_at = ?
         WHERE id = ? AND user_id = ? AND status = 'running' AND state = 'PERSISTING'`,
      )
      .run(
        c.status,
        assistantMessageId,
        contextLane.success ? contextLane.data : null,
        c.analysis === null ? null : JSON.stringify(c.analysis),
        c.context === null ? null : JSON.stringify(c.context),
        JSON.stringify(c.events),
        JSON.stringify(c.metrics),
        c.errorCode ?? null,
        now,
        turnId,
        userId,
      );
    if (result.changes !== 1) {
      throw new InvalidTransitionError('PERSISTING', 'COMPLETED', 'the turn changed concurrently');
    }
  }).immediate();
}

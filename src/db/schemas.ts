import { z } from 'zod';
import type { PersistedSentence } from '../shared/answer.js';

/**
 * Runtime validation of JSON stored in TEXT columns (contracts: "validated with zod on both
 * read and write"). `satisfies` keeps each schema assignable to the contract type, so a change
 * to the contract that the schema does not follow stops compiling.
 */

const sentenceStatus = z.enum(['verified', 'no_claims', 'unverified', 'unchecked', 'truncated']);

const sentenceIssue = z.enum([
  'malformed_placeholder',
  'unknown_ref',
  'inapplicable_variant',
  'render_mismatch',
  'free_number',
  'free_currency',
  'free_percent',
  'free_date',
  'unsupported_verdict_word',
  'unsupported_global_negative',
  'judge_unsupported',
  'judge_partial',
  'judge_unavailable',
]);

export const persistedSentenceSchema = z.object({
  index: z.number().int().min(0),
  text: z.string(),
  template: z.string(),
  status: sentenceStatus,
  issues: z.array(sentenceIssue),
  placeholders: z.array(
    z.object({
      token: z.string(),
      findingId: z.templateLiteral(['fnd_', z.string()]).optional(),
      messageId: z.templateLiteral(['msg_', z.string()]).optional(),
      snapshotId: z.templateLiteral(['src_', z.string()]).optional(),
      rendered: z.string(),
    }),
  ),
}) satisfies z.ZodType<PersistedSentence>;

export const persistedSentencesSchema = z.array(persistedSentenceSchema);

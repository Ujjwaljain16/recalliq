import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The calibration data set: captured public pages plus hand-reviewed gold claims. See
 * docs/extraction-calibration.md. Every file is validated here because the labels were written by hand.
 */

export const confidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof confidenceSchema>;

export const categorySchema = z.enum([
  'per_seat',
  'usage_based',
  'tiered_billing',
  'conditions',
  'negative_control',
]);
export type Category = z.infer<typeof categorySchema>;

export const pageFileSchema = z.object({
  url: z.string().url(),
  urlNorm: z.string().min(1),
  capturedAt: z.string().datetime(),
  provider: z.string().min(1),
  /** The page title as the provider returned it. */
  title: z.string().nullable().optional(),
  /** Exactly as returned, at most 6000 characters. */
  text: z.string().min(1).max(6000),
  requestId: z.string().optional(),
});
export type PageFile = z.infer<typeof pageFileSchema>;

export const goldValueSchema = z.object({
  amount: z.number().finite().nonnegative(),
  /** As the page states it: `unknown` for a bare symbol unless the page declares a currency. */
  currency: z.string().regex(/^(?:[A-Z]{3}|unknown)$/),
  currencySymbol: z.string().max(8).nullable(),
  unit: z.enum(['per_seat', 'flat', 'usage', 'unspecified']),
  usageUnit: z.string().max(40).nullable(),
  billingPeriod: z.enum([
    'monthly',
    'annual',
    'monthly_billed_annually',
    'one_time',
    'unspecified',
  ]),
  valueKind: z.enum(['exact', 'lower_bound', 'upper_bound']),
});
export type GoldValue = z.infer<typeof goldValueSchema>;

export const expectedOutcomeSchema = z.object({
  /** The outcome under the current deterministic rules when the claim is extracted perfectly. */
  status: z.enum(['pass', 'weak', 'fail']),
  /** Required unless the status is pass. */
  reason: z.string().max(400).optional(),
});

export const goldClaimSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  /** The plan or tier the price belongs to; null when the price is for a resource that is not tied to a plan. */
  plan: z.string().min(1).max(80).nullable(),
  planNorm: z.string().min(1).max(80).nullable(),
  value: goldValueSchema,
  modality: z.enum(['current', 'planned', 'historical', 'conditional', 'promotional']),
  conditions: z.string().max(300).nullable(),
  /** Verbatim from the page text, at most 400 characters. */
  quote: z.string().min(1).max(400),
  /** The nearest heading or table header above the quote, verbatim, at most 200 characters. */
  contextQuote: z.string().max(200).nullable(),
  expected: expectedOutcomeSchema,
  /**
   * The quote and context that give the best verification outcome for the same (true) field values, found by
   * searching the lines around the amount. Present when it differs from the quote and context above.
   */
  bestAchievable: z
    .object({
      quote: z.string().min(1).max(400),
      contextQuote: z.string().max(200).nullable(),
      status: z.enum(['pass', 'weak', 'fail']),
      reason: z.string().max(400).optional(),
    })
    .optional(),
  /** How sure the reviewer is of the whole label (fields, quote and expected outcome). */
  confidence: confidenceSchema,
  note: z.string().max(600).optional(),
});
export type GoldClaim = z.infer<typeof goldClaimSchema>;

export const trapKindSchema = z.enum([
  'competitor',
  'crossed_out',
  'annual_shown_per_month',
  'promotional',
  'usage_without_unit',
  'other_plan',
  'other',
]);

/** A statement that must not be produced. A prediction matches when every given condition holds. */
export const statementMatchSchema = z.object({
  amount: z.number().finite().optional(),
  /** Normalised plan name the statement is attributed to. */
  planNorm: z.string().optional(),
  /** Every string must occur (case-insensitive) in the statement's quote. */
  quoteContains: z.array(z.string().min(1)).optional(),
  /** The statement's value must have one of these (any-of). */
  currency: z.array(z.string()).optional(),
  unit: z.array(z.string()).optional(),
  billingPeriod: z.array(z.string()).optional(),
  modality: z.array(z.string()).optional(),
});
export type StatementMatch = z.infer<typeof statementMatchSchema>;

export const trapSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  kind: trapKindSchema,
  description: z.string().min(1).max(400),
  match: statementMatchSchema,
});
export type Trap = z.infer<typeof trapSchema>;

/**
 * A true statement the gold list deliberately does not enumerate (for example one row of a long size table).
 * A prediction that matches no gold claim but matches an ignorable entry is neither right nor wrong.
 */
export const ignorableSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  description: z.string().min(1).max(400),
  match: statementMatchSchema,
});
export type Ignorable = z.infer<typeof ignorableSchema>;

export const entityContextSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).min(1),
  /** Every plan of the vendor shown on the page (the verifier uses them for the intervening-plan rule). */
  knownPlans: z.array(z.string()),
  officialDomains: z.array(z.string()),
  /** Competitors named on the page. */
  otherEntityAliases: z.array(z.string()),
});
export type GoldEntity = z.infer<typeof entityContextSchema>;

export const goldFileSchema = z.object({
  pageId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  vendor: z.string().min(1),
  categories: z.array(categorySchema).min(1),
  entity: entityContextSchema,
  /** Confidence that the claim list is complete and correct for this page. */
  pageConfidence: confidenceSchema,
  claims: z.array(goldClaimSchema),
  traps: z.array(trapSchema),
  /** True statements that are not enumerated as claims; they count neither for nor against precision. */
  ignorable: z.array(ignorableSchema).default([]),
  /** Why the page is in the set and anything the reviewer wants the owner to look at. */
  notes: z.string().max(1200).optional(),
});
export type GoldFile = z.infer<typeof goldFileSchema>;

export const manifestSchema = z.object({
  version: z.literal(1),
  /** Labels were made by an AI reading the pages: the owner must spot-check them. */
  labelledBy: z.string(),
  capturedOn: z.string(),
  exa: z.object({
    requests: z.number().int().nonnegative(),
    totalCostUsd: z.number().nonnegative(),
    contentMode: z.literal('text'),
    contentChars: z.number().int().positive(),
  }),
  pages: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      vendor: z.string().min(1),
      pageFile: z.string(),
      goldFile: z.string(),
    }),
  ),
});
export type Manifest = z.infer<typeof manifestSchema>;

export interface CalibrationPage {
  id: string;
  page: PageFile;
  gold: GoldFile;
}

export interface CalibrationSet {
  manifest: Manifest;
  pages: CalibrationPage[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** Loads and validates the whole set. Throws with the path of the first file that is wrong. */
export function loadCalibrationSet(dir: string): CalibrationSet {
  const manifest = manifestSchema.parse(readJson(join(dir, 'manifest.json')));
  const pages: CalibrationPage[] = manifest.pages.map((m) => {
    const page = pageFileSchema.parse(readJson(join(dir, m.pageFile)));
    const gold = goldFileSchema.parse(readJson(join(dir, m.goldFile)));
    if (gold.pageId !== m.id)
      throw new Error(`${m.goldFile}: pageId ${gold.pageId} is not ${m.id}`);
    return { id: m.id, page, gold };
  });
  return { manifest, pages };
}

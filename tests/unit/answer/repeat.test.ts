import { describe, expect, it } from 'vitest';
import { claimSignature, repeatsClaim } from '../../../src/answer/duplicate.js';

const sig = claimSignature;

describe('repeated claims', () => {
  it('the quick and the verified section quoting the same source twice is a repeat', () => {
    expect(
      repeatsClaim(
        sig(
          'According to supabase.com, on the Pro plan, one database-only project costs $25 a month before any extra usage [3].',
        ),
        sig(
          'According to supabase.com, one database-only project on the Pro plan costs $25 a month before any extra usage [3].',
        ),
      ),
    ).toBe(true);
    expect(
      repeatsClaim(
        sig(
          'According to supabase.com, a billing example for the Pro Plan shows a cost of $25 [4].',
        ),
        sig('According to supabase.com, a line item for the Pro Plan is listed at $25 [4].'),
      ),
    ).toBe(true);
  });

  it('different numbers or different content are not repeats', () => {
    expect(
      repeatsClaim(
        sig('According to a.com, Pro costs $25 a month [1].'),
        sig('According to a.com, Pro costs $35 a month [1].'),
      ),
    ).toBe(false);
    expect(
      repeatsClaim(
        sig('According to a.com, Zoho CRM Standard is $14 per user [2].'),
        sig('According to a.com, the Salesforce Starter Suite is $25 per user [2].'),
      ),
    ).toBe(false);
  });

  it('two different facts from one source with the same numbers are not repeats', () => {
    expect(
      repeatsClaim(
        sig('According to costofsoftware.com, Pipedrive Lite is $14 on annual billing [8].'),
        sig('According to costofsoftware.com, Zoho CRM Standard is $14 on annual billing [8].'),
      ),
    ).toBe(false);
  });

  it('a sentence without numbers is never treated as a repeat', () => {
    expect(repeatsClaim(sig('Netlify has a free tier.'), sig('Netlify has a free tier.'))).toBe(
      false,
    );
  });
});

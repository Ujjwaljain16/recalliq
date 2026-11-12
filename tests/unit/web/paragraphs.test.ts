import { describe, expect, it } from 'vitest';
import {
  leadingBreak,
  paragraphStarts,
  paragraphTexts,
  sentenceBasis,
  sentenceGap,
  sourceLabel,
  storedParagraphTexts,
} from '../../../web/js/format.js';

describe('answer paragraphs', () => {
  it('starts a paragraph when a streamed sentence follows a line break', () => {
    expect(leadingBreak('\n\nSecond part.')).toEqual({ newParagraph: true, text: 'Second part.' });
    expect(leadingBreak(' Same paragraph.')).toEqual({
      newParagraph: false,
      text: 'Same paragraph.',
    });
    expect(leadingBreak('First.')).toEqual({ newParagraph: false, text: 'First.' });
  });

  it('recovers paragraph starts of stored sentences from the message content', () => {
    const content = 'One. Two.\n\nThree.\n- Four.';
    expect(paragraphStarts(content, ['One.', 'Two.', 'Three.', '- Four.'])).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(paragraphStarts('One. Two.', ['One.', 'Missing.', 'Two.'])).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe('one space between the sentences of a paragraph', () => {
  const zoho = 'Zoho CRM: I could not confirm a price through my checks.';
  const g2 = 'According to g2.com, Zoho CRM pricing starts at $14.00 [4].';

  it('puts one space between streamed sentences of one paragraph and a break between paragraphs', () => {
    expect(paragraphTexts([zoho, ` ${g2}`, `\n\nSalesforce: nothing.`, ' Next.'])).toEqual([
      `${zoho} ${g2}`,
      'Salesforce: nothing. Next.',
    ]);
    expect(sentenceGap(false, true)).toBe(' ');
    expect(sentenceGap(true, true)).toBe('');
    expect(sentenceGap(false, false)).toBe('');
  });

  it('does not depend on the model whitespace: a sentence streamed with no lead still gets the space', () => {
    expect(paragraphTexts([zoho, g2])).toEqual([`${zoho} ${g2}`]);
  });

  it('the reloaded message shows the same text as the stream', () => {
    const content = `${zoho} ${g2}\n\nSalesforce: nothing.`;
    expect(storedParagraphTexts(content, [zoho, g2, 'Salesforce: nothing.'])).toEqual([
      `${zoho} ${g2}`,
      'Salesforce: nothing.',
    ]);
  });
});

describe('the check mark is shown only for a verified finding', () => {
  it('maps a sentence kind to what it rests on', () => {
    expect(sentenceBasis('verified', 'verified', undefined)).toBe('verified');
    expect(sentenceBasis('verified', 'unconfirmed', undefined)).toBe('unconfirmed');
    expect(sentenceBasis('verified', 'sourced', undefined)).toBe('sourced');
    // a late status event carries no kind: the earlier basis stays
    expect(sentenceBasis('verified', undefined, 'unconfirmed')).toBe('unconfirmed');
    // sentences stored before kinds existed fall back to their status
    expect(sentenceBasis('verified', undefined, undefined)).toBe('verified');
    expect(sentenceBasis('no_claims', undefined, undefined)).toBeNull();
  });
});

describe('source labels', () => {
  it('uses the title, else the humanised last path segment, else the domain once', () => {
    expect(sourceLabel({ title: 'Pricing', url: 'https://a.example/x', domain: 'a.example' })).toBe(
      'Pricing',
    );
    expect(
      sourceLabel({
        title: '  ',
        url: 'https://g2.com/products/zoho-crm/pricing',
        domain: 'g2.com',
      }),
    ).toBe('Pricing');
    expect(
      sourceLabel({
        title: null,
        url: 'https://a.example/blog/crm-price_guide.html',
        domain: 'a.example',
      }),
    ).toBe('Crm price guide');
    expect(sourceLabel({ title: '', url: 'https://a.example/', domain: 'a.example' })).toBe(
      'a.example',
    );
    expect(sourceLabel({ title: null, url: 'https://a.example/12345', domain: 'a.example' })).toBe(
      'a.example',
    );
    expect(sourceLabel({ title: null, url: 'not a url', domain: 'a.example' })).toBe('a.example');
  });
});

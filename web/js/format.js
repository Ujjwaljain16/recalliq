// Presentation rules that need no DOM: which sentences get a visible warning, how citations are linked, how a
// turn outcome is described. Kept pure so they can be tested without a browser.

/** Only http and https links are ever made clickable. */
export function safeHref(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Splits sentence text on `[n]` citation markers. A marker becomes a link segment only when source n exists
 * and has a safe URL; otherwise it stays plain text, so nothing is linked that the stored data does not back.
 *
 * @param {string} text
 * @param {Array<{ n: number, url: string, title?: string | null, domain?: string }>} sources
 * @returns {Array<{ type: 'text', text: string } | { type: 'cite', text: string, n: number, href: string, title: string }>}
 */
export function splitCitations(text, sources) {
  const byNumber = new Map(sources.map((s) => [s.n, s]));
  const out = [];
  let last = 0;
  for (const match of text.matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(match[1]);
    const source = byNumber.get(n);
    const href = source ? safeHref(source.url) : null;
    if (!source || href === null) continue;
    if (match.index > last) out.push({ type: 'text', text: text.slice(last, match.index) });
    out.push({
      type: 'cite',
      text: match[0],
      n,
      href,
      title: source.title ?? source.domain ?? href,
    });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

const ISSUE_TEXT = {
  malformed_placeholder: 'a value could not be filled in',
  unknown_ref: 'it referred to something that is not on record',
  inapplicable_variant: 'a value did not apply',
  render_mismatch: 'a value did not match its record',
  free_number: 'it contains a number with no source',
  free_currency: 'it contains an amount with no source',
  free_percent: 'it contains a percentage with no source',
  free_date: 'it contains a date with no source',
  unsupported_verdict_word: 'it says something changed without evidence',
  unsupported_global_negative: 'it claims nothing changed without evidence for every item',
  judge_unsupported: 'the check found it unsupported',
  judge_partial: 'the check found it only partly supported',
  judge_unavailable: 'the check could not run',
  ungrounded_number: 'it states a number its cited source does not contain',
  ungrounded_name: 'it names something its cited source does not mention',
  ungrounded_source: 'it cites a source that was not read in this turn',
  sourced_link: 'it contains a link or an email address',
  sourced_too_long: 'it quotes too much of a source',
};

/** A plain-language reason list for a tooltip or a screen reader. */
export function describeIssues(issues) {
  return issues.map((i) => ISSUE_TEXT[i] ?? i.replace(/_/g, ' ')).join('; ');
}

/**
 * The visible marker for a sentence, or null when it needs none. Colour is never the only signal: every
 * marker carries words.
 *
 * @param {string} status  a sentence status, or 'pending_judge' while a late check is running
 * @param {string[]} issues
 * @returns {{ kind: string, label: string, title: string } | null}
 */
export function sentenceMarker(status, issues = []) {
  const why = describeIssues(issues);
  switch (status) {
    case 'unverified':
      return {
        kind: 'unverified',
        label: 'unverified',
        title: `Not backed by a checked source${why ? `: ${why}` : ''}`,
      };
    case 'unchecked':
      return {
        kind: 'unchecked',
        label: 'not checked',
        title: `This sentence could not be checked${why ? `: ${why}` : ''}`,
      };
    case 'truncated':
      return {
        kind: 'truncated',
        label: 'cut off',
        title: 'The answer ended in the middle of this sentence',
      };
    case 'pending_judge':
      return { kind: 'pending', label: 'checking', title: 'A final check is still running' };
    default:
      return null;
  }
}

/**
 * What to tell the person about how a turn ended, or null when nothing needs saying.
 *
 * @param {string | undefined} status  a terminal turn status
 * @param {{ hasAnswer: boolean }} context
 */
export function outcomeNote(status, context) {
  switch (status) {
    case 'partial':
      return {
        kind: 'warning',
        text: 'Some checks could not be completed, so this answer is partial.',
      };
    case 'failed':
      return {
        kind: 'error',
        text: 'This request failed. What is shown is a fixed message, not research.',
      };
    case 'interrupted':
      return {
        kind: 'error',
        text: context.hasAnswer
          ? 'This answer was interrupted and may be cut off.'
          : 'This request was interrupted before an answer was saved.',
      };
    default:
      return null;
  }
}

/** One short label for a conversation in the list. */
export function conversationLabel(c) {
  return c.title ?? c.preview ?? 'Empty conversation';
}

/**
 * A streamed sentence arrives with the whitespace that separated it from the previous one. A line break there
 * starts a new paragraph; the whitespace itself is not shown.
 *
 * @param {string} text  the first delta of a sentence
 * @returns {{ newParagraph: boolean, text: string }}
 */
export function leadingBreak(text) {
  const m = /^\s*/.exec(text);
  const lead = m ? m[0] : '';
  return { newParagraph: lead.includes('\n'), text: text.slice(lead.length) };
}

/**
 * For stored sentences (whose text has no separators), which ones start a new paragraph in the stored
 * message content. Sentences that cannot be found in the content never start one.
 *
 * @param {string} content  the stored message text
 * @param {string[]} texts  the sentences in order
 * @returns {boolean[]}
 */
export function paragraphStarts(content, texts) {
  let at = 0;
  return texts.map((t, i) => {
    const found = t.length > 0 ? content.indexOf(t, at) : -1;
    if (found === -1) return false;
    const gap = content.slice(at, found);
    at = found + t.length;
    return i > 0 && gap.includes('\n');
  });
}

/**
 * The text between two sentences of one paragraph: a single space. A sentence that opens a paragraph, or the
 * first sentence of the answer, has none. The streamed text and the stored text both rely on this, because the
 * leading whitespace of a sentence is not shown as such (see `leadingBreak`).
 *
 * @param {boolean} newParagraph
 * @param {boolean} paragraphHasText
 */
export function sentenceGap(newParagraph, paragraphHasText) {
  return !newParagraph && paragraphHasText ? ' ' : '';
}

/**
 * The paragraphs the page shows for the streamed sentence chunks (each with its leading whitespace), as plain
 * text: sentences of one paragraph are joined with one space, paragraphs are separate entries.
 *
 * @param {string[]} chunks
 * @returns {string[]}
 */
export function paragraphTexts(chunks) {
  const out = [];
  for (const chunk of chunks) {
    const { newParagraph, text } = leadingBreak(chunk);
    const last = out.length - 1;
    if (last < 0 || newParagraph) out.push(text);
    else out[last] += sentenceGap(false, true) + text;
  }
  return out;
}

/**
 * The paragraphs the page shows for stored sentences, as plain text, in the same shape as `paragraphTexts`.
 *
 * @param {string} content  the stored message text
 * @param {string[]} texts  the sentences in order
 * @returns {string[]}
 */
export function storedParagraphTexts(content, texts) {
  const starts = paragraphStarts(content, texts);
  const out = [];
  texts.forEach((t, i) => {
    const last = out.length - 1;
    if (last < 0 || starts[i]) out.push(t);
    else out[last] += sentenceGap(false, true) + t;
  });
  return out;
}

/**
 * What a settled sentence rests on, which decides its mark: `verified` (a checked finding: the check mark),
 * `sourced` (a cited page: dotted underline), `unconfirmed` (a finding that says there is no verified value or
 * that the check failed: no mark, because nothing was verified) or null. Sentences stored before kinds existed
 * have none and fall back to their status.
 *
 * @param {string} status
 * @param {string | undefined} kind
 * @param {string | undefined} previous  the basis the sentence already had
 * @returns {'verified' | 'sourced' | 'unconfirmed' | null}
 */
export function sentenceBasis(status, kind, previous) {
  const basis = kind ?? previous ?? (status === 'verified' ? 'verified' : null);
  return basis === 'verified' || basis === 'sourced' || basis === 'unconfirmed' ? basis : null;
}

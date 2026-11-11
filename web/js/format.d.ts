export type CitationSegment =
  | { type: 'text'; text: string }
  | { type: 'cite'; text: string; n: number; href: string; title: string };

export function safeHref(url: string): string | null;
export function splitCitations(
  text: string,
  sources: Array<{ n: number; url: string; title?: string | null; domain?: string }>,
): CitationSegment[];
export function describeIssues(issues: string[]): string;
export function sentenceMarker(
  status: string,
  issues?: string[],
): { kind: string; label: string; title: string } | null;
export function outcomeNote(
  status: string | undefined,
  context: { hasAnswer: boolean },
): { kind: 'warning' | 'error'; text: string } | null;
export function conversationLabel(c: { title: string | null; preview: string | null }): string;
export function leadingBreak(text: string): { newParagraph: boolean; text: string };
export function paragraphStarts(content: string, texts: string[]): boolean[];

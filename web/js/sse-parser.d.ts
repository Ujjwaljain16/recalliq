export interface ParsedSseEvent {
  id: string | null;
  event: string;
  data: string;
}

export interface SseParser {
  feed(chunk: string): void;
  end(): void;
}

export function createSseParser(
  onEvent: (event: ParsedSseEvent) => void,
  onComment?: (comment: string) => void,
): SseParser;

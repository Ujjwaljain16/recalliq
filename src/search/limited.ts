import type { ClientLimiter } from '../llm/limiter.js';
import type { SearchPort, SearchRequest, SearchResponse } from '../shared/search.js';
import { abortError } from './exa-adapter.js';

/**
 * A search port under a client-side limiter shared by the whole process, so concurrent turns cannot together
 * open more provider requests than the limiter allows. Waiting for a slot is abortable and reported as the
 * same timeout or cancellation the adapter itself would report.
 */
export class LimitedSearchPort implements SearchPort {
  readonly provider: string;

  constructor(
    private readonly inner: SearchPort,
    private readonly limiter: ClientLimiter,
  ) {
    this.provider = inner.provider;
  }

  async search(req: SearchRequest, signal: AbortSignal): Promise<SearchResponse> {
    let release: () => void;
    try {
      release = await this.limiter.acquire(signal);
    } catch {
      throw abortError(signal);
    }
    try {
      return await this.inner.search(req, signal);
    } finally {
      release();
    }
  }
}

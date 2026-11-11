import {
  ReplayMissError,
  SearchError,
  type SearchPort,
  type SearchRequest,
  type SearchResponse,
} from '../shared/search.js';
import { recordingFileSchema } from './recording.js';
import { requestKey } from './request-key.js';

/**
 * Plays back recorded responses by request hash. Constructed WITHOUT credentials and without any live
 * adapter: a miss throws `ReplayMissError` and never falls back to anything.
 */
export class ReplaySearchAdapter implements SearchPort {
  readonly provider: string;
  private readonly byKey = new Map<string, SearchResponse>();

  constructor(
    provider: string,
    exchanges: ReadonlyArray<{ key: string; response: SearchResponse }>,
  ) {
    this.provider = provider;
    for (const e of exchanges) this.byKey.set(e.key, e.response);
  }

  /** Parses and validates a recording file's JSON text. */
  static fromJson(json: string): ReplaySearchAdapter {
    const file = recordingFileSchema.parse(JSON.parse(json));
    const provider = file.exchanges[0]?.response.provider ?? 'replay';
    return new ReplaySearchAdapter(provider, file.exchanges);
  }

  search(req: SearchRequest, signal: AbortSignal): Promise<SearchResponse> {
    if (signal.aborted) {
      return Promise.reject(new SearchError('cancelled', 'Search call cancelled'));
    }
    const key = requestKey(req);
    const hit = this.byKey.get(key);
    if (!hit) {
      return Promise.reject(
        new ReplayMissError(
          `No recorded response for request ${key.slice(0, 12)} (query "${req.query}")`,
        ),
      );
    }
    // A copy, so a caller cannot mutate the recording.
    return Promise.resolve(structuredClone(hit));
  }
}

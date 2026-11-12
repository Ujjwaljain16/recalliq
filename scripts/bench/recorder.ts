/**
 * A counting fetch for the application's outbound provider calls (Gemini and Exa). It records the host,
 * status and duration of each call and whether a failure looked like a rate limit or a quota. It never
 * records URLs beyond the host, headers or bodies, so no key can end up in a result file.
 */

export type Provider = 'gemini' | 'exa' | 'other';

export interface ProviderCall {
  provider: Provider;
  host: string;
  /** HTTP status, 0 for a network failure or abort. */
  status: number;
  ms: number;
  /** 429, or an error body saying RESOURCE_EXHAUSTED or quota. */
  rateLimited: boolean;
  /** A rate limit whose body names a daily quota: waiting minutes will not help. */
  dailyQuota: boolean;
}

export function providerOf(host: string): Provider {
  if (host.endsWith('googleapis.com')) return 'gemini';
  if (host.endsWith('exa.ai')) return 'exa';
  return 'other';
}

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

export class CallRecorder {
  readonly calls: ProviderCall[] = [];

  constructor(private readonly base: typeof fetch = fetch) {}

  readonly fetch: typeof fetch = async (input, init) => {
    const host = urlOf(input).host;
    const provider = providerOf(host);
    const t0 = Date.now();
    let res: Response;
    try {
      res = await this.base(input, init);
    } catch (error) {
      this.calls.push({
        provider,
        host,
        status: 0,
        ms: Date.now() - t0,
        rateLimited: false,
        dailyQuota: false,
      });
      throw error;
    }
    let rateLimited = res.status === 429;
    let dailyQuota = false;
    if (!res.ok) {
      try {
        const body = (await res.clone().text()).slice(0, 4000);
        if (/RESOURCE_EXHAUSTED|quota/i.test(body)) rateLimited = true;
        if (rateLimited && /per ?day|PerDay|daily/i.test(body)) dailyQuota = true;
      } catch {
        /* an unreadable error body changes nothing */
      }
    }
    this.calls.push({
      provider,
      host,
      status: res.status,
      ms: Date.now() - t0,
      rateLimited,
      dailyQuota,
    });
    return res;
  };

  mark(): number {
    return this.calls.length;
  }

  since(mark: number): ProviderCall[] {
    return this.calls.slice(mark);
  }
}

export interface CallSummary {
  count: number;
  failed: number;
  rateLimited: number;
  statuses: number[];
}

export function summarize(calls: readonly ProviderCall[], provider: Provider): CallSummary {
  const mine = calls.filter((c) => c.provider === provider);
  return {
    count: mine.length,
    failed: mine.filter((c) => c.status < 200 || c.status >= 300).length,
    rateLimited: mine.filter((c) => c.rateLimited).length,
    statuses: mine.map((c) => c.status),
  };
}

// gtm/lib/http.ts - the one place collectors do network IO from.
//
// why one helper: every public API in the crawl set (GitHub, Bluesky
// AppView, HN Algolia) needs the same three behaviors - polite pacing,
// retry-with-backoff on transient failures, and hard respect for rate
// limits. Centralizing them keeps the collectors readable and keeps us a
// good citizen of APIs we don't pay for.

export class HttpRequestError extends Error {
  constructor(public readonly status: number, public readonly url: string, message: string) {
    super(message);
  }
}

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  /** transient statuses to retry (with exponential backoff) */
  retryStatuses?: number[];
  maxAttempts?: number;
  minimumIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nextRequestAt = new Map<string, number>();

export const fetchJson = async <T>(url: string, options: FetchJsonOptions = {}): Promise<T> => {
  const {
    headers = {},
    retryStatuses = [429, 500, 502, 503, 504],
    maxAttempts = 5,
    minimumIntervalMs = 100,
    timeoutMs = 20_000,
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
    nowImpl = Date.now,
  } = options;

  let lastError: Error = new HttpRequestError(0, url, 'unreachable');
  let waitedForRateReset = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0 && !waitedForRateReset) await sleepImpl(1000 * 2 ** (attempt - 1));
    waitedForRateReset = false;
    if (minimumIntervalMs > 0) {
      // why reserve before sleep: concurrent calls cannot burst through the interval.
      const origin = new URL(url).origin;
      const now = nowImpl();
      const requestAt = Math.max(now, nextRequestAt.get(origin) ?? now);
      nextRequestAt.set(origin, requestAt + minimumIntervalMs);
      if (requestAt > now) await sleepImpl(requestAt - now);
    }
    const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, signal });
    } catch (error) {
      lastError = signal?.aborted
        ? new HttpRequestError(0, url, `request timed out after ${timeoutMs}ms`)
        : error instanceof Error ? error : new Error(String(error));
      continue; // network blip - retry
    }

    // GitHub signals an exhausted rate window as 403 with a reset header;
    // sleeping through it beats failing a half-finished crawl.
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    if ((response.status === 403 || response.status === 429) && remaining === '0' && reset) {
      const waitMs = Math.max(0, Number(reset) * 1000 - nowImpl()) + 2000;
      await response.body?.cancel();
      lastError = new HttpRequestError(response.status, url, `rate limit ${response.status}`);
      if (attempt + 1 < maxAttempts) {
        console.error(`  rate limit hit; sleeping ${Math.round(waitMs / 1000)}s until reset…`);
        await sleepImpl(waitMs);
        waitedForRateReset = true;
      }
      continue;
    }

    if (retryStatuses.includes(response.status)) {
      await response.body?.cancel();
      lastError = new HttpRequestError(response.status, url, `transient ${response.status}`);
      continue;
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new HttpRequestError(response.status, url, `${response.status} ${url}: ${body.slice(0, 200)}`);
    }
    return (await response.json()) as T;
  }
  throw lastError;
};

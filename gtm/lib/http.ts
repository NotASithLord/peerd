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
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const fetchJson = async <T>(url: string, options: FetchJsonOptions = {}): Promise<T> => {
  const {
    headers = {},
    retryStatuses = [429, 500, 502, 503, 504],
    maxAttempts = 5,
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
  } = options;

  let lastError: Error = new HttpRequestError(0, url, 'unreachable');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleepImpl(1000 * 2 ** (attempt - 1));
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { accept: 'application/json', ...headers } });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      continue; // network blip - retry
    }

    // GitHub signals an exhausted rate window as 403 with a reset header;
    // sleeping through it beats failing a half-finished crawl.
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    if ((response.status === 403 || response.status === 429) && remaining === '0' && reset) {
      const waitMs = Math.max(0, Number(reset) * 1000 - Date.now()) + 2000;
      await response.body?.cancel();
      console.error(`  rate limit hit; sleeping ${Math.round(waitMs / 1000)}s until reset…`);
      await sleepImpl(waitMs);
      attempt--; // a rate-limit pause is not a failed attempt
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

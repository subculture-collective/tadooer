/**
 * Process-wide Google throttle (ADR 0043). Wraps the fetch the Google
 * connector uses and records a cooldown on HTTP 429 or a rate-limit 403,
 * honouring `Retry-After`. The worker starts no Google job before the
 * cooldown ends. Response bodies are inspected only for the reason code and
 * never stored or logged.
 */
export const defaultThrottleMs = 60_000;
const maxRetryAfterMs = 6 * 60 * 60_000;

/** Parses delta-seconds or an HTTP date; undefined when absent or invalid. */
export const parseRetryAfter = (
  value: string | null,
  nowMs: number,
): number | undefined => {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed))
    return Math.min(Number(trimmed) * 1000, maxRetryAfterMs);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, date - nowMs), maxRetryAfterMs);
};

const rateLimitReasons = ["rateLimitExceeded", "userRateLimitExceeded"];

export class ProviderThrottle {
  #notBefore = 0;
  #events = 0;

  constructor(private readonly clock: { now(): Date }) {}

  /** Epoch milliseconds before which no Google job should start. */
  notBefore(): number {
    return this.#notBefore;
  }

  /** Remaining cooldown in milliseconds at `nowMs`. */
  remainingMs(nowMs: number): number {
    return Math.max(0, this.#notBefore - nowMs);
  }

  /** Count of throttling responses seen by this process. */
  events(): number {
    return this.#events;
  }

  note(retryAfterMs: number | undefined): void {
    const now = this.clock.now().getTime();
    this.#events += 1;
    this.#notBefore = Math.max(
      this.#notBefore,
      now + (retryAfterMs ?? defaultThrottleMs),
    );
  }

  wrap(fetcher: typeof fetch): typeof fetch {
    return async (input, init) => {
      const response = await fetcher(input, init);
      if (response.status === 429) {
        this.note(
          parseRetryAfter(
            response.headers.get("retry-after"),
            this.clock.now().getTime(),
          ),
        );
      } else if (response.status === 403) {
        const text = await response
          .clone()
          .text()
          .catch(() => "");
        if (rateLimitReasons.some((reason) => text.includes(reason)))
          this.note(
            parseRetryAfter(
              response.headers.get("retry-after"),
              this.clock.now().getTime(),
            ),
          );
      }
      return response;
    };
  }
}

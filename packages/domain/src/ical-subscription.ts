// iCal subscriptions (issue #91, ADR 0032): read-only feed policy that does not
// depend on persistence or the network. The server service applies these
// rules before fetching; the browser reuses the filter and interval bounds.

/** Refresh interval bounds in minutes (SP default is two hours). */
export const subscriptionRefreshBounds = {
  minMinutes: 5,
  maxMinutes: 24 * 60,
  defaultMinutes: 120,
} as const;

/** Bound for include/exclude patterns; SP uses the same cap. */
export const subscriptionFilterMaxLength = 256;

/** Longest name a subscription may carry. */
export const subscriptionNameMaxLength = 100;

export type SubscriptionUrlRejection =
  | "invalid_url"
  | "unsupported_scheme"
  | "credentials_in_url"
  | "blocked_address"
  | "url_too_long";

export type SubscriptionUrlCheck =
  | { readonly ok: true; readonly url: URL; readonly host: string }
  | { readonly ok: false; readonly reason: SubscriptionUrlRejection };

export const subscriptionUrlMaxLength = 2048;

const ipv4 = (hostname: string): readonly number[] | undefined => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (match === null) return undefined;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : undefined;
};

const blockedIpv4 = (parts: readonly number[]): boolean => {
  const [a, b] = parts as [number, number];
  return (
    a === 127 || // loopback
    a === 0 || // "this" network
    (a === 169 && b === 254) || // link-local, including cloud metadata
    a >= 224 // multicast and reserved
  );
};

const expandIpv6 = (literal: string): readonly number[] | undefined => {
  const value = literal.replace(/^\[|\]$/g, "").split("%", 1)[0] ?? "";
  if (!/^[0-9a-f:.]+$/i.test(value) || value.split("::").length > 2)
    return undefined;
  const mapped = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  let hexPart = value;
  let tail: number[] = [];
  if (mapped !== null) {
    const parts = ipv4(mapped[2] ?? "");
    if (parts === undefined) return undefined;
    const [p0, p1, p2, p3] = parts as [number, number, number, number];
    tail = [(p0 << 8) | p1, (p2 << 8) | p3];
    hexPart = mapped[1] ?? "";
    if (hexPart.endsWith(":") && !hexPart.endsWith("::"))
      hexPart = hexPart.slice(0, -1);
  }
  const [head, rest] = hexPart.split("::") as [string, string | undefined];
  const parse = (segment: string): number[] =>
    segment === "" ? [] : segment.split(":").map((part) => parseInt(part, 16));
  const left = parse(head);
  const right = rest === undefined ? [] : parse(rest);
  if ([...left, ...right].some((part) => Number.isNaN(part) || part > 0xffff))
    return undefined;
  const missing = 8 - left.length - right.length - tail.length;
  if (rest === undefined) {
    const full = [...left, ...tail];
    return full.length === 8 ? full : undefined;
  }
  if (missing < 0) return undefined;
  return [...left, ...new Array<number>(missing).fill(0), ...right, ...tail];
};

const blockedIpv6 = (words: readonly number[]): boolean => {
  const [w0 = 0] = words;
  const allZero = words.every((word) => word === 0);
  const loopback =
    words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const mapped =
    words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (allZero || loopback) return true;
  if (mapped) {
    const w6 = words[6] ?? 0;
    const w7 = words[7] ?? 0;
    return blockedIpv4([w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff]);
  }
  return (
    (w0 & 0xffc0) === 0xfe80 || // link-local
    (w0 & 0xff00) === 0xff00 || // multicast
    (w0 === 0xfd00 && words[1] === 0x0ec2) // cloud metadata (fd00:ec2::254)
  );
};

/**
 * True for hosts a feed fetch must never reach: loopback, unspecified,
 * link-local (including cloud metadata) and multicast addresses, plus
 * `localhost` names. Private LAN ranges stay allowed: the homelab serves
 * feeds from them. Names are checked literally; the fetch service checks the
 * resolved addresses again.
 */
export const isBlockedSubscriptionHost = (hostname: string): boolean => {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  if (lower === "" || lower === "localhost" || lower.endsWith(".localhost"))
    return true;
  if (lower === "metadata.google.internal" || lower.endsWith(".internal"))
    return true;
  const v4 = ipv4(lower);
  if (v4 !== undefined) return blockedIpv4(v4);
  if (lower.startsWith("[") || lower.includes(":")) {
    const v6 = expandIpv6(lower);
    return v6 === undefined ? true : blockedIpv6(v6);
  }
  return false;
};

/** Validates a feed address without fetching it. */
export const checkSubscriptionUrl = (raw: string): SubscriptionUrlCheck => {
  if (raw.length > subscriptionUrlMaxLength)
    return { ok: false, reason: "url_too_long" };
  let url: URL;
  try {
    // webcal: is the conventional subscription scheme; it means https.
    url = new URL(raw.trim().replace(/^webcal:\/\//i, "https://"));
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { ok: false, reason: "unsupported_scheme" };
  if (url.username !== "" || url.password !== "")
    return { ok: false, reason: "credentials_in_url" };
  if (isBlockedSubscriptionHost(url.hostname))
    return { ok: false, reason: "blocked_address" };
  return { ok: true, url, host: url.host };
};

// ── Safe filter patterns (port of SP's calendar-event-regex-filter) ────────

interface Quantifier {
  readonly endIndex: number;
  readonly isVariable: boolean;
  readonly isRepeating: boolean;
}

interface GroupFrame {
  alternatives: string[];
  current: string;
  hasVariableQuantifier: boolean;
}

const noQuantifier: Quantifier = {
  endIndex: -1,
  isVariable: false,
  isRepeating: false,
};

const readNumber = (
  pattern: string,
  start: number,
): { value: number; endIndex: number } | undefined => {
  let end = start;
  while (end < pattern.length && /[0-9]/.test(pattern[end] ?? "")) end += 1;
  return end === start
    ? undefined
    : { value: Number(pattern.slice(start, end)), endIndex: end };
};

const readBraceQuantifier = (
  pattern: string,
  start: number,
): Quantifier | undefined => {
  const min = readNumber(pattern, start + 1);
  if (min === undefined) return undefined;
  if (pattern[min.endIndex] === "}")
    return {
      endIndex: min.endIndex,
      isVariable: false,
      isRepeating: min.value > 1,
    };
  if (pattern[min.endIndex] !== ",") return undefined;
  const max = readNumber(pattern, min.endIndex + 1);
  if (max === undefined) {
    if (pattern[min.endIndex + 1] !== "}") return undefined;
    return { endIndex: min.endIndex + 1, isVariable: true, isRepeating: true };
  }
  if (pattern[max.endIndex] !== "}") return undefined;
  return {
    endIndex: max.endIndex,
    isVariable: max.value !== min.value,
    isRepeating: max.value > 1,
  };
};

const readQuantifier = (pattern: string, start: number): Quantifier => {
  const char = pattern[start];
  if (char === "+" || char === "*")
    return { endIndex: start, isVariable: true, isRepeating: true };
  if (char === "?")
    return { endIndex: start, isVariable: true, isRepeating: false };
  if (char === "{") return readBraceQuantifier(pattern, start) ?? noQuantifier;
  return noQuantifier;
};

const groupContentStart = (pattern: string, open: number): number => {
  if (pattern[open + 1] !== "?") return open + 1;
  const modifier = pattern[open + 2];
  if (modifier === ":" || modifier === "=" || modifier === "!") return open + 3;
  if (
    modifier === "<" &&
    (pattern[open + 3] === "=" || pattern[open + 3] === "!")
  )
    return open + 4;
  if (modifier === "<") {
    const nameEnd = pattern.indexOf(">", open + 3);
    return nameEnd === -1 ? open + 2 : nameEnd + 1;
  }
  const flagEnd = pattern.indexOf(":", open + 2);
  return flagEnd === -1 ? open + 2 : flagEnd + 1;
};

const ambiguousAlternatives = (frame: GroupFrame): boolean => {
  const alternatives = [...frame.alternatives, frame.current].filter(
    (alternative) => alternative !== "",
  );
  return alternatives.some((alternative, index) =>
    alternatives.some(
      (other, otherIndex) =>
        index !== otherIndex &&
        other.length > alternative.length &&
        other.startsWith(alternative),
    ),
  );
};

/**
 * Rejects back-references and nested variable quantifiers or ambiguous
 * alternations under a repeating quantifier, the constructions behind
 * catastrophic backtracking. Length is bounded separately.
 */
export const isSafeSubscriptionFilter = (pattern: string): boolean => {
  if (pattern.length > subscriptionFilterMaxLength) return false;
  try {
    new RegExp(pattern);
  } catch {
    return false;
  }
  const stack: GroupFrame[] = [];
  const append = (value: string) => {
    const frame = stack.at(-1);
    if (frame !== undefined) frame.current += value;
  };
  const markVariable = () => {
    const frame = stack.at(-1);
    if (frame !== undefined) frame.hasVariableQuantifier = true;
  };
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      const escaped = pattern[index + 1];
      if ((escaped !== undefined && /[1-9]/.test(escaped)) || escaped === "k")
        return false;
      const quantifier = readQuantifier(pattern, index + 2);
      append(pattern.slice(index, index + 2));
      if (quantifier.isVariable) {
        markVariable();
        index = quantifier.endIndex;
      } else index += 1;
      continue;
    }
    if (char === "[") {
      let end = index + 1;
      while (end < pattern.length) {
        if (pattern[end] === "\\") {
          end += 2;
          continue;
        }
        if (pattern[end] === "]") break;
        end += 1;
      }
      const quantifier = readQuantifier(pattern, end + 1);
      append("[]");
      if (quantifier.isVariable) {
        markVariable();
        index = quantifier.endIndex;
      } else index = end;
      continue;
    }
    if (char === "(") {
      stack.push({
        alternatives: [],
        current: "",
        hasVariableQuantifier: false,
      });
      index = groupContentStart(pattern, index) - 1;
      continue;
    }
    const closing = char === ")" ? stack.pop() : undefined;
    if (closing !== undefined) {
      const frame = closing;
      const quantifier = readQuantifier(pattern, index + 1);
      const risky = frame.hasVariableQuantifier || ambiguousAlternatives(frame);
      if (quantifier.isRepeating && risky) return false;
      append("(group)");
      if (risky) markVariable();
      if (quantifier.isVariable) {
        markVariable();
        index = quantifier.endIndex;
      }
      continue;
    }
    const open = char === "|" ? stack.at(-1) : undefined;
    if (open !== undefined) {
      open.alternatives.push(open.current);
      open.current = "";
      continue;
    }
    const quantifier = readQuantifier(pattern, index + 1);
    append(char ?? "");
    if (quantifier.isVariable) {
      markVariable();
      index = quantifier.endIndex;
    }
  }
  return true;
};

const compiled = new Map<string, RegExp | null>();

const compile = (pattern: string): RegExp | null => {
  const cached = compiled.get(pattern);
  if (cached !== undefined) return cached;
  const value = isSafeSubscriptionFilter(pattern)
    ? new RegExp(pattern, "i")
    : null;
  if (compiled.size >= 64) {
    const oldest = compiled.keys().next().value;
    if (oldest !== undefined) compiled.delete(oldest);
  }
  compiled.set(pattern, value);
  return value;
};

/**
 * SP semantics: an unusable include pattern hides every event (fail closed);
 * an unusable exclude pattern excludes nothing (fail open). Matching is
 * case-insensitive against the event title.
 */
export const passesSubscriptionFilter = (
  title: string,
  include: string | null | undefined,
  exclude: string | null | undefined,
): boolean => {
  if (include) {
    const pattern = compile(include);
    if (!pattern?.test(title)) return false;
  }
  if (exclude) {
    const pattern = compile(exclude);
    if (pattern?.test(title)) return false;
  }
  return true;
};

// ── Scheduling and freshness ───────────────────────────────────────────────

/**
 * The next fetch instant: the interval plus a jitter of up to a tenth of it
 * (at most five minutes), so several subscriptions do not fetch in lockstep.
 */
export const nextSubscriptionFetchAt = (
  now: string,
  intervalMinutes: number,
  random: () => number = Math.random,
): string => {
  const intervalMs = intervalMinutes * 60_000;
  const jitterMs = Math.floor(
    Math.min(intervalMs / 10, 5 * 60_000) * Math.max(0, Math.min(1, random())),
  );
  return new Date(Date.parse(now) + intervalMs + jitterMs).toISOString();
};

export type SubscriptionFetchState =
  "never" | "fresh" | "stale" | "unavailable";

export interface SubscriptionFreshnessInput {
  readonly enabled: boolean;
  readonly refreshIntervalMinutes: number;
  readonly lastSuccessAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastErrorClass: string | null;
}

export interface SubscriptionFreshness {
  readonly state: SubscriptionFetchState;
  readonly message: string;
}

/** Human summary of a subscription's fetch history for the UI and assistant. */
export const subscriptionFreshness = (
  input: SubscriptionFreshnessInput,
  now: string,
): SubscriptionFreshness => {
  if (!input.enabled)
    return { state: "never", message: "Subscription is paused" };
  if (input.lastAttemptAt === null)
    return { state: "never", message: "Awaiting the first fetch" };
  if (input.lastSuccessAt === null)
    return {
      state: "unavailable",
      message: `No successful fetch yet (${input.lastErrorClass ?? "unknown error"})`,
    };
  const ageMs = Date.parse(now) - Date.parse(input.lastSuccessAt);
  const allowedMs = 2 * input.refreshIntervalMinutes * 60_000;
  if (input.lastErrorClass === null && ageMs <= allowedMs)
    return { state: "fresh", message: "Feed fetched recently" };
  return {
    state: "stale",
    message:
      input.lastErrorClass === null
        ? "Showing saved events; the next fetch is overdue"
        : `Showing saved events; the last fetch failed (${input.lastErrorClass})`,
  };
};

/** Stable key of one event occurrence inside a subscription. */
export const subscriptionEventKey = (
  uid: string,
  occurrenceStart: string,
): string => `${uid}\u0000${occurrenceStart}`;

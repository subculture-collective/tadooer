import * as chrono from "chrono-node";
import {
  CaptureRecurrenceError,
  parseCaptureRepeat,
  type CaptureRecurrence,
} from "./capture-recurrence.ts";

export interface StructuredCaptureContext {
  readonly at: Date;
  readonly timezoneOffsetMinutes: number;
  readonly timeZone?: string;
}

/** ADR 0031: what happens to an http(s) address found in a captured title. */
export type CaptureUrlBehavior = "keep" | "extract" | "keep_and_attach";
export const captureUrlBehaviors = [
  "keep",
  "extract",
  "keep_and_attach",
] as const;
export const defaultCaptureUrlBehavior: CaptureUrlBehavior = "keep_and_attach";

export interface StructuredCaptureOptions {
  readonly urlBehavior?: CaptureUrlBehavior | undefined;
}

export type CaptureDeadline =
  | { readonly kind: "date"; readonly value: string }
  | { readonly kind: "instant"; readonly value: string };

export interface CaptureLink {
  readonly title: string;
  readonly url: string;
}

export interface StructuredCapture {
  readonly title: string;
  readonly projectName: string | undefined;
  readonly tagNames: readonly string[];
  readonly plannedStart: string | undefined;
  /** ADR 0020: an `@date` without a time of day. */
  readonly plannedDay: string | undefined;
  readonly deadline: CaptureDeadline | undefined;
  /** Whole minutes from an estimate word such as `30m`, `1h` or `1h30m`. */
  readonly estimateMinutes: number | undefined;
  /** ADR 0023: an `@every …` rule; the task becomes the first instance. */
  readonly recurrence: CaptureRecurrence | undefined;
  /** Safe http(s) addresses to attach (ADR 0021), per the URL behavior. */
  readonly links: readonly CaptureLink[];
}

export type { CaptureRecurrence } from "./capture-recurrence.ts";

export class StructuredCaptureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StructuredCaptureError";
  }
}

export const captureEstimateMin = 1;
export const captureEstimateMax = 720;

interface Segment {
  readonly marker: string;
  value: string;
  /** Parallel to `value`: true where the character came from a quote or escape. */
  literal: boolean[];
}

// Quotes protect markers; backslash escapes the next character. Quoted and
// escaped characters are literal: estimate words and addresses inside them
// are never extracted.
const tokenize = (input: string): Segment[] => {
  let current: Segment = { marker: "", value: "", literal: [] };
  const segments = [current];
  let quote: string | undefined;
  const push = (char: string, literal: boolean) => {
    current.value += char;
    current.literal.push(literal);
  };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (char === "\\") {
      const next = input[++index];
      if (next === undefined)
        throw new StructuredCaptureError("Trailing capture escape");
      push(next, true);
    } else if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else push(char, true);
    } else if (
      (char === '"' || char === "'") &&
      (current.value.length === 0 || /\s/.test(input[index - 1] ?? ""))
    ) {
      quote = char;
    } else if (
      "+#@!".includes(char) &&
      (index === 0 || /\s/.test(input[index - 1] ?? ""))
    ) {
      current = { marker: char, value: "", literal: [] };
      segments.push(current);
    } else push(char, false);
  }
  if (quote !== undefined)
    throw new StructuredCaptureError("Unclosed capture quote");
  return segments;
};

interface Word {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly literal: boolean;
}

const words = (segment: Segment): Word[] => {
  const result: Word[] = [];
  const pattern = /\S+/g;
  for (const match of segment.value.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    result.push({
      text: match[0],
      start,
      end,
      literal: segment.literal.slice(start, end).some(Boolean),
    });
  }
  return result;
};

const removeSpans = (
  segment: Segment,
  spans: readonly { readonly start: number; readonly end: number }[],
): void => {
  for (const span of [...spans].toSorted((a, b) => b.start - a.start)) {
    segment.value =
      segment.value.slice(0, span.start) + segment.value.slice(span.end);
    segment.literal.splice(span.start, span.end - span.start);
  }
};

const estimateWord = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m)?$/i;

/** Minutes for `30m`, `1h`, `1h30m`, `90m` or `1.5h`; undefined otherwise. */
export const parseEstimateWord = (word: string): number | undefined => {
  const match = estimateWord.exec(word);
  if (match === null || (match[1] === undefined && match[2] === undefined))
    return undefined;
  const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
  if (!Number.isInteger(minutes))
    throw new StructuredCaptureError(
      `Estimate “${word}” must be a whole number of minutes`,
    );
  if (minutes < captureEstimateMin || minutes > captureEstimateMax)
    throw new StructuredCaptureError(
      `Estimate “${word}” is outside ${String(captureEstimateMin)}–${String(captureEstimateMax)} minutes`,
    );
  return minutes;
};

const extractEstimate = (segments: Segment[]): number | undefined => {
  let estimate: number | undefined;
  for (const segment of segments) {
    if (
      segment.marker !== "" &&
      segment.marker !== "+" &&
      segment.marker !== "#"
    )
      continue;
    const found = words(segment).filter(
      (word) => !word.literal && estimateWord.test(word.text),
    );
    for (const word of found) {
      const minutes = parseEstimateWord(word.text);
      if (minutes === undefined) continue;
      if (estimate !== undefined)
        throw new StructuredCaptureError("Only one estimate is allowed");
      estimate = minutes;
      removeSpans(segment, [word]);
    }
  }
  return estimate;
};

const plainUrl = /^(?:https?:\/\/|www\.)\S+$/i;
const markdownLink = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
const trailingPunctuation = /[.,;:!?)\]]+$/;

/**
 * The normalized address when it is an absolute http(s) URL without user
 * credentials; matches the attachment rule in ADR 0021.
 */
const safeAddress = (raw: string): string => {
  const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new StructuredCaptureError(`“${raw}” is not a valid web address`);
  }
  if (url.username !== "" || url.password !== "")
    throw new StructuredCaptureError(
      "Addresses with a user name or password cannot be attached; remove the credentials or quote the text",
    );
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new StructuredCaptureError(`“${raw}” is not an http(s) address`);
  if (url.href.length > 2048)
    throw new StructuredCaptureError("A captured address is too long");
  return url.href;
};

const titleFromUrl = (href: string): string => {
  const url = new URL(href);
  const last = url.pathname.split("/").filter(Boolean).at(-1);
  return last === undefined ? url.hostname : `${url.hostname} ${last}`;
};

const extractLinks = (
  title: Segment,
  behavior: CaptureUrlBehavior,
): CaptureLink[] => {
  if (behavior === "keep") return [];
  const links = new Map<string, CaptureLink>();
  const spans: { start: number; end: number; replacement: string }[] = [];
  for (const match of title.value.matchAll(markdownLink)) {
    const start = match.index;
    const end = start + match[0].length;
    if (title.literal.slice(start, end).some(Boolean)) continue;
    const url = safeAddress(match[2] ?? "");
    if (!links.has(url))
      links.set(url, { title: (match[1] ?? "").trim(), url });
    spans.push({ start, end, replacement: (match[1] ?? "").trim() });
  }
  for (const word of words(title)) {
    if (word.literal || !plainUrl.test(word.text)) continue;
    if (spans.some((span) => word.start >= span.start && word.end <= span.end))
      continue;
    const raw = word.text.replace(trailingPunctuation, "");
    const url = safeAddress(raw);
    if (!links.has(url)) links.set(url, { title: raw, url });
    spans.push({ start: word.start, end: word.end, replacement: "" });
  }
  if (behavior === "extract" && spans.length > 0) {
    for (const span of spans.toSorted((a, b) => b.start - a.start)) {
      title.value =
        title.value.slice(0, span.start) +
        span.replacement +
        title.value.slice(span.end);
      title.literal.splice(
        span.start,
        span.end - span.start,
        ...span.replacement.split("").map(() => true),
      );
    }
    const collapsed = title.value.replace(/\s+/g, " ").trim();
    title.value = collapsed;
    title.literal = collapsed.split("").map(() => true);
    const first = [...links.values()][0];
    if (title.value.length === 0 && first !== undefined)
      title.value = titleFromUrl(first.url);
  }
  return [...links.values()];
};

const civilTimestamp = (instant: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (key: string) =>
    Number(parts.find(({ type }) => type === key)?.value);
  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
};

const offsetAt = (instant: number, timeZone: string): number =>
  (civilTimestamp(instant, timeZone) - Math.floor(instant / 1000) * 1000) /
  60000;

const zonedInstant = (
  result: chrono.ParsedResult,
  timeZone: string,
): string => {
  const local = Date.UTC(
    result.start.get("year") ?? NaN,
    (result.start.get("month") ?? NaN) - 1,
    result.start.get("day") ?? NaN,
    result.start.get("hour") ?? NaN,
    result.start.get("minute") ?? 0,
    result.start.get("second") ?? 0,
  );
  const offsets = new Set(
    [-86400000, 0, 86400000].map((delta) => offsetAt(local + delta, timeZone)),
  );
  const candidates = [...offsets]
    .map((offset) => local - offset * 60000)
    .filter((instant) => civilTimestamp(instant, timeZone) === local);
  if (candidates.length !== 1)
    throw new StructuredCaptureError(
      "This local time is skipped or repeated by daylight saving. Include an explicit UTC offset.",
    );
  return new Date(candidates[0] ?? NaN).toISOString();
};

const dateValue = (result: chrono.ParsedResult): string => {
  const year = result.start.get("year");
  const month = String(result.start.get("month")).padStart(2, "0");
  const day = String(result.start.get("day")).padStart(2, "0");
  return `${String(year)}-${month}-${day}`;
};

/** The calendar date at the capture instant in the planning zone. */
export const captureContextDate = (
  context: StructuredCaptureContext,
): string => {
  const civil =
    context.timeZone === undefined
      ? context.at.getTime() + context.timezoneOffsetMinutes * 60_000
      : civilTimestamp(context.at.getTime(), context.timeZone);
  return new Date(civil).toISOString().slice(0, 10);
};

const bareWeekday =
  /^(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;

const addDays = (date: string, days: number): string =>
  new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const parseDate = (
  value: string,
  context: StructuredCaptureContext,
): CaptureDeadline => {
  const [result, ...additional] = chrono.parse(
    value,
    {
      instant: context.at,
      timezone:
        context.timeZone === undefined
          ? context.timezoneOffsetMinutes
          : offsetAt(context.at.getTime(), context.timeZone),
    },
    { forwardDate: true },
  );
  if (
    result === undefined ||
    additional.length > 0 ||
    result.index !== 0 ||
    result.text.trim() !== value.trim() ||
    result.end != null
  ) {
    throw new StructuredCaptureError(
      `Could not resolve time expression “${value}”`,
    );
  }
  const parsedDate = dateValue(result);
  const resolvedDate =
    bareWeekday.test(value.trim()) && parsedDate === captureContextDate(context)
      ? addDays(parsedDate, 7)
      : parsedDate;
  const hasExplicitTime =
    result.start.isCertain("hour") || result.start.isCertain("minute");
  return hasExplicitTime
    ? {
        kind: "instant",
        value:
          context.timeZone !== undefined &&
          !result.start.isCertain("timezoneOffset")
            ? zonedInstant(result, context.timeZone)
            : result.start.date().toISOString(),
      }
    : { kind: "date", value: resolvedDate };
};

export const parseStructuredCapture = (
  input: string,
  context: StructuredCaptureContext,
  options: StructuredCaptureOptions = {},
): StructuredCapture => {
  const segments = tokenize(input);
  const estimateMinutes = extractEstimate(segments);
  const [first, ...rest] = segments;
  if (first === undefined) throw new StructuredCaptureError("Empty capture");
  const links = extractLinks(
    first,
    options.urlBehavior ?? defaultCaptureUrlBehavior,
  );
  const title = first.value.trim();
  if (title.length === 0) {
    throw new StructuredCaptureError(
      "A task title is required before capture markers",
    );
  }

  let projectName: string | undefined;
  const tagNames: string[] = [];
  let plannedStart: string | undefined;
  let plannedDay: string | undefined;
  let deadline: CaptureDeadline | undefined;
  let recurrence: CaptureRecurrence | undefined;

  for (const segment of rest) {
    const marker = segment.marker;
    const value = segment.value.trim();
    if (value.length === 0) {
      throw new StructuredCaptureError(
        `Capture marker “${marker}” needs a value`,
      );
    }
    if (marker === "+") {
      if (projectName !== undefined) {
        throw new StructuredCaptureError("Only one project marker is allowed");
      }
      projectName = value;
    } else if (marker === "#") {
      tagNames.push(value);
    } else if (marker === "@") {
      if (
        plannedStart !== undefined ||
        plannedDay !== undefined ||
        recurrence !== undefined
      ) {
        throw new StructuredCaptureError(
          "Only one planned-time marker is allowed",
        );
      }
      let repeat: CaptureRecurrence | undefined;
      try {
        repeat = parseCaptureRepeat(value, captureContextDate(context));
      } catch (error) {
        if (!(error instanceof CaptureRecurrenceError)) throw error;
        throw new StructuredCaptureError(error.message);
      }
      if (repeat !== undefined) {
        recurrence = repeat;
        continue;
      }
      const parsed = parseDate(value, context);
      if (parsed.kind === "instant") plannedStart = parsed.value;
      else plannedDay = parsed.value;
    } else if (deadline !== undefined) {
      throw new StructuredCaptureError("Only one deadline marker is allowed");
    } else {
      deadline = parseDate(value, context);
    }
  }

  return {
    title,
    projectName,
    tagNames,
    plannedStart,
    plannedDay,
    deadline,
    estimateMinutes,
    recurrence,
    links,
  };
};

export interface CaptureReferenceOptions {
  /** Report unknown tag names as `newTags` instead of failing. */
  readonly allowNewTags?: boolean | undefined;
}

export interface CaptureReferences {
  readonly projectId?: string;
  readonly tagIds: string[];
  /** Tag names with no active record, in capture order, case-folded unique. */
  readonly newTags: string[];
}

export const normalizeCaptureName = (value: string): string =>
  value.normalize("NFKC").toLowerCase().trim();

export const resolveCaptureReferences = (
  capture: Pick<StructuredCapture, "projectName" | "tagNames">,
  projects: readonly { id: string; title: string; archivedAt: string | null }[],
  tags: readonly {
    id: string;
    displayName: string;
    archivedAt: string | null;
  }[],
  options: CaptureReferenceOptions = {},
): CaptureReferences => {
  const resolve = (
    name: string,
    records: readonly { id: string; name: string; archivedAt: string | null }[],
    kind: string,
  ): string | undefined => {
    const matches = records.filter(
      (record) =>
        normalizeCaptureName(record.name) === normalizeCaptureName(name),
    );
    if (matches.length === 0 && kind === "Tag" && options.allowNewTags === true)
      return undefined;
    if (matches.length === 0 && kind === "Tag")
      throw new StructuredCaptureError(
        `Tag “${name}” does not exist; confirm tag creation to create it with this task`,
      );
    if (matches.length !== 1 || matches[0]?.archivedAt !== null)
      throw new StructuredCaptureError(
        `${kind} “${name}” is unknown, archived, or ambiguous`,
      );
    return matches[0].id;
  };
  const tagIds = new Set<string>();
  const newTags = new Map<string, string>();
  for (const name of capture.tagNames) {
    const id = resolve(
      name,
      tags.map((tag) => ({ ...tag, name: tag.displayName })),
      "Tag",
    );
    if (id !== undefined) tagIds.add(id);
    else if (!newTags.has(normalizeCaptureName(name)))
      newTags.set(normalizeCaptureName(name), name);
  }
  const projectId =
    capture.projectName === undefined
      ? undefined
      : resolve(
          capture.projectName,
          projects.map((project) => ({ ...project, name: project.title })),
          "Project",
        );
  return {
    ...(projectId === undefined ? {} : { projectId }),
    tagIds: [...tagIds],
    newTags: [...newTags.values()],
  };
};

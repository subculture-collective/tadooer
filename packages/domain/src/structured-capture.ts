import * as chrono from "chrono-node";

export interface StructuredCaptureContext {
  readonly at: Date;
  readonly timezoneOffsetMinutes: number;
  readonly timeZone?: string;
}

export type CaptureDeadline =
  | { readonly kind: "date"; readonly value: string }
  | { readonly kind: "instant"; readonly value: string };

export interface StructuredCapture {
  readonly title: string;
  readonly projectName: string | undefined;
  readonly tagNames: readonly string[];
  readonly plannedStart: string | undefined;
  readonly deadline: CaptureDeadline | undefined;
}

export class StructuredCaptureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StructuredCaptureError";
  }
}

// Quotes protect markers; backslash escapes the next character in titles or values.
const tokenize = (input: string): { marker: string; value: string }[] => {
  let current = { marker: "", value: "" };
  const segments = [current];
  let quote: string | undefined;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (char === "\\") {
      const next = input[++index];
      if (next === undefined)
        throw new StructuredCaptureError("Trailing capture escape");
      current.value += next;
    } else if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current.value += char;
    } else if (
      (char === '"' || char === "'") &&
      (current.value.length === 0 || /\s/.test(input[index - 1] ?? ""))
    ) {
      quote = char;
    } else if (
      "+#@!".includes(char) &&
      (index === 0 || /\s/.test(input[index - 1] ?? ""))
    ) {
      current = { marker: char, value: "" };
      segments.push(current);
    } else current.value += char;
  }
  if (quote !== undefined)
    throw new StructuredCaptureError("Unclosed capture quote");
  return segments.map(({ marker, value }) => ({ marker, value: value.trim() }));
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

const contextDateValue = (context: StructuredCaptureContext): string => {
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
    bareWeekday.test(value.trim()) && parsedDate === contextDateValue(context)
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
): StructuredCapture => {
  const [first, ...segments] = tokenize(input);
  const title = first?.value ?? "";
  if (title.length === 0) {
    throw new StructuredCaptureError(
      "A task title is required before capture markers",
    );
  }

  let projectName: string | undefined;
  const tagNames: string[] = [];
  let plannedStart: string | undefined;
  let deadline: CaptureDeadline | undefined;

  for (const { marker, value } of segments) {
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
      if (plannedStart !== undefined) {
        throw new StructuredCaptureError(
          "Only one planned-time marker is allowed",
        );
      }
      const parsed = parseDate(value, context);
      if (parsed.kind !== "instant") {
        throw new StructuredCaptureError(
          "A planned time must include a time of day",
        );
      }
      plannedStart = parsed.value;
    } else if (deadline !== undefined) {
      throw new StructuredCaptureError("Only one deadline marker is allowed");
    } else {
      deadline = parseDate(value, context);
    }
  }

  return { title, projectName, tagNames, plannedStart, deadline };
};

export const resolveCaptureReferences = (
  capture: StructuredCapture,
  projects: readonly { id: string; title: string; archivedAt: string | null }[],
  tags: readonly {
    id: string;
    displayName: string;
    archivedAt: string | null;
  }[],
): { projectId?: string; tagIds: string[] } => {
  const normalize = (value: string) =>
    value.normalize("NFKC").toLowerCase().trim();
  const resolve = (
    name: string,
    records: readonly { id: string; name: string; archivedAt: string | null }[],
    kind: string,
  ): string => {
    const matches = records.filter(
      (record) => normalize(record.name) === normalize(name),
    );
    if (matches.length !== 1 || matches[0]?.archivedAt !== null)
      throw new StructuredCaptureError(
        `${kind} “${name}” is unknown, archived, or ambiguous`,
      );
    return matches[0].id;
  };
  return {
    ...(capture.projectName === undefined
      ? {}
      : {
          projectId: resolve(
            capture.projectName,
            projects.map((project) => ({ ...project, name: project.title })),
            "Project",
          ),
        }),
    tagIds: [
      ...new Set(
        capture.tagNames.map((name) =>
          resolve(
            name,
            tags.map((tag) => ({ ...tag, name: tag.displayName })),
            "Tag",
          ),
        ),
      ),
    ],
  };
};

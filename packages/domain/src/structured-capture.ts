import * as chrono from "chrono-node";

export interface StructuredCaptureContext {
  readonly at: Date;
  readonly timezoneOffsetMinutes: number;
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

const markerPattern = /(^|\s)([+#@!])/g;

const dateValue = (result: chrono.ParsedResult): string => {
  const year = result.start.get("year");
  const month = String(result.start.get("month")).padStart(2, "0");
  const day = String(result.start.get("day")).padStart(2, "0");
  return `${String(year)}-${month}-${day}`;
};

const parseDate = (
  value: string,
  context: StructuredCaptureContext,
): CaptureDeadline => {
  const [result, ...additional] = chrono.parse(
    value,
    {
      instant: context.at,
      timezone: context.timezoneOffsetMinutes,
    },
    { forwardDate: true },
  );
  if (result === undefined || additional.length > 0) {
    throw new StructuredCaptureError(
      `Could not resolve time expression “${value}”`,
    );
  }
  const hasExplicitTime =
    result.start.isCertain("hour") || result.start.isCertain("minute");
  return hasExplicitTime
    ? { kind: "instant", value: result.start.date().toISOString() }
    : { kind: "date", value: dateValue(result) };
};

export const parseStructuredCapture = (
  input: string,
  context: StructuredCaptureContext,
): StructuredCapture => {
  const matches = [...input.matchAll(markerPattern)];
  const title = input.slice(0, matches[0]?.index ?? input.length).trim();
  if (title.length === 0) {
    throw new StructuredCaptureError(
      "A task title is required before capture markers",
    );
  }

  let projectName: string | undefined;
  const tagNames: string[] = [];
  let plannedStart: string | undefined;
  let deadline: CaptureDeadline | undefined;

  for (const [index, match] of matches.entries()) {
    const marker = match[2] ?? "";
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? input.length;
    const value = input.slice(start, end).trim();
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

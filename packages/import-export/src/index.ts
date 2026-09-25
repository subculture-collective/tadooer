import { createHash } from "node:crypto";
export * from "./super-productivity.ts";
export * from "./super-productivity-apply.ts";
export * from "./super-productivity-links.ts";

export type ImportSourceKind = "ics" | "google_ics";

export interface ImportIssue {
  readonly code:
    | "malformed_component"
    | "missing_uid"
    | "duplicate_uid"
    | "recurrence_preserved"
    | "attendees_preserved"
    | "alarms_preserved"
    | "unknown_properties_preserved";
  readonly detail: string;
}

export interface ImportCandidate {
  readonly externalId: string;
  readonly uid: string;
  readonly summary: string;
  readonly rawIcs: string;
  readonly recurrence: boolean;
  readonly attendeeCount: number;
  readonly alarmCount: number;
  readonly unknownProperties: readonly string[];
  readonly issues: readonly ImportIssue[];
}

export interface ImportReconciliationReport {
  readonly source: ImportSourceKind;
  readonly inputHash: string;
  readonly candidates: readonly ImportCandidate[];
  readonly skipped: readonly ImportIssue[];
  readonly totals: {
    readonly components: number;
    readonly ready: number;
    readonly skipped: number;
    readonly recurring: number;
    readonly attendees: number;
    readonly alarms: number;
    readonly unknownProperties: number;
  };
}

const unfold = (raw: string): readonly string[] | undefined => {
  if (Buffer.byteLength(raw, "utf8") > 4 * 1024 * 1024 || raw.includes("\0"))
    return undefined;
  const normalized = raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const output: string[] = [];
  for (const line of normalized.split("\n")) {
    if (/^[ \t]/.test(line) && output.length > 0)
      output[output.length - 1] = `${output.at(-1) ?? ""}${line.slice(1)}`;
    else output.push(line);
  }
  return output;
};

const text = (value: string): string =>
  value
    .replace(/\\[nN]/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");

const known = new Set([
  "UID",
  "DTSTAMP",
  "DTSTART",
  "DTEND",
  "DURATION",
  "SUMMARY",
  "DESCRIPTION",
  "LOCATION",
  "STATUS",
  "TRANSP",
  "CLASS",
  "SEQUENCE",
  "CREATED",
  "LAST-MODIFIED",
  "ORGANIZER",
  "ATTENDEE",
  "RRULE",
  "RDATE",
  "EXDATE",
  "RECURRENCE-ID",
  "CATEGORIES",
  "URL",
  "GEO",
  "PRIORITY",
  "ACTION",
  "TRIGGER",
  "REPEAT",
  "ATTACH",
  "BEGIN",
  "END",
]);

const calendarFor = (eventLines: readonly string[]): string =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Suite//Import v1//EN",
    ...eventLines,
    "END:VCALENDAR",
    "",
  ].join("\r\n");

export const parseIcsImport = (
  source: ImportSourceKind,
  raw: string,
): ImportReconciliationReport => {
  const inputHash = createHash("sha256").update(raw).digest("hex");
  const lines = unfold(raw);
  const skipped: ImportIssue[] = [];
  const components: string[][] = [];
  if (!lines?.includes("BEGIN:VCALENDAR"))
    skipped.push({
      code: "malformed_component",
      detail: "Input is not a bounded VCALENDAR",
    });
  else {
    let current: string[] | undefined;
    let depth = 0;
    for (const line of lines) {
      if (line === "BEGIN:VEVENT" && current === undefined) {
        current = [line];
        depth = 1;
      } else if (current !== undefined) {
        current.push(line);
        if (line.startsWith("BEGIN:")) depth += 1;
        if (line.startsWith("END:")) depth -= 1;
        if (line === "END:VEVENT" && depth === 0) {
          components.push(current);
          current = undefined;
        }
      }
    }
    if (current !== undefined)
      skipped.push({
        code: "malformed_component",
        detail: "VEVENT is not closed",
      });
  }
  const seen = new Set<string>();
  const candidates: ImportCandidate[] = [];
  for (const [index, eventLines] of components.entries()) {
    const properties = eventLines
      .map((line) => {
        const separator = line.indexOf(":");
        if (separator < 1) return undefined;
        return {
          name: (line.slice(0, separator).split(";", 1)[0] ?? "").toUpperCase(),
          value: line.slice(separator + 1),
        };
      })
      .filter(
        (property): property is { name: string; value: string } =>
          property !== undefined,
      );
    const uid =
      properties.find(({ name }) => name === "UID")?.value.trim() ?? "";
    if (uid === "") {
      skipped.push({
        code: "missing_uid",
        detail: `VEVENT ${String(index + 1)} has no UID`,
      });
      continue;
    }
    if (seen.has(uid)) {
      skipped.push({
        code: "duplicate_uid",
        detail: `UID ${uid} occurs more than once in the source`,
      });
      continue;
    }
    seen.add(uid);
    const recurrence = properties.some(({ name }) =>
      ["RRULE", "RDATE", "EXDATE", "RECURRENCE-ID"].includes(name),
    );
    const attendeeCount = properties.filter(
      ({ name }) => name === "ATTENDEE",
    ).length;
    const alarmCount = eventLines.filter(
      (line) => line === "BEGIN:VALARM",
    ).length;
    const unknownProperties = [
      ...new Set(
        properties.map(({ name }) => name).filter((name) => !known.has(name)),
      ),
    ].sort();
    const issues: ImportIssue[] = [];
    if (recurrence)
      issues.push({
        code: "recurrence_preserved",
        detail: "Recurrence fields are preserved as raw iCalendar",
      });
    if (attendeeCount > 0)
      issues.push({
        code: "attendees_preserved",
        detail: `${String(attendeeCount)} attendee properties are preserved`,
      });
    if (alarmCount > 0)
      issues.push({
        code: "alarms_preserved",
        detail: `${String(alarmCount)} alarms are preserved`,
      });
    if (unknownProperties.length > 0)
      issues.push({
        code: "unknown_properties_preserved",
        detail: unknownProperties.join(", "),
      });
    const rawIcs = calendarFor(eventLines);
    candidates.push({
      externalId: createHash("sha256")
        .update(`${uid}\0${rawIcs}`)
        .digest("base64url"),
      uid,
      summary: text(
        properties.find(({ name }) => name === "SUMMARY")?.value ?? "",
      ),
      rawIcs,
      recurrence,
      attendeeCount,
      alarmCount,
      unknownProperties,
      issues,
    });
  }
  return {
    source,
    inputHash,
    candidates,
    skipped,
    totals: {
      components: components.length,
      ready: candidates.length,
      skipped: skipped.length,
      recurring: candidates.filter(({ recurrence }) => recurrence).length,
      attendees: candidates.reduce((sum, item) => sum + item.attendeeCount, 0),
      alarms: candidates.reduce((sum, item) => sum + item.alarmCount, 0),
      unknownProperties: candidates.reduce(
        (sum, item) => sum + item.unknownProperties.length,
        0,
      ),
    },
  };
};

export const sourceAdapters: Readonly<
  Record<ImportSourceKind, (raw: string) => ImportReconciliationReport>
> = {
  ics: (raw) => parseIcsImport("ics", raw),
  google_ics: (raw) => parseIcsImport("google_ics", raw),
};

export const serializeCalendarFeed = (rawEvents: readonly string[]): string => {
  const bodies = rawEvents.flatMap((raw) => {
    const lines = unfold(raw) ?? [];
    const start = lines.indexOf("BEGIN:VEVENT");
    const end = lines.lastIndexOf("END:VEVENT");
    return start >= 0 && end >= start ? [lines.slice(start, end + 1)] : [];
  });
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Suite//Read-only publication v1//EN",
    "X-WR-CALNAME:Suite read-only feed",
    ...bodies.flat(),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
};
export * from "./super-productivity-recurrence.ts";

import { createHash } from "node:crypto";

/**
 * Normalized event envelope, version 1 (ADR 0041). Only these fields are
 * propagated. Everything else meaningful is listed in `unsupported` with a
 * canonical value, so it contributes to the digest (a change is visible) and
 * blocks propagation (it is never silently dropped). #45 extends this.
 */
export interface BridgeEnvelope {
  readonly v: 1;
  /** null means absent; "" is an explicit empty value. */
  readonly summary: string | null;
  readonly description: string | null;
  readonly location: string | null;
  readonly allDay: boolean;
  /** UTC instant (`toISOString`) or, for all-day events, `YYYY-MM-DD`. */
  readonly start: string;
  readonly end: string;
  readonly unsupported: Readonly<Record<string, string>>;
}

export interface NormalizedBridgeEvent {
  readonly uid: string | null;
  readonly envelope: BridgeEnvelope;
  readonly digest: string;
  readonly unsupportedFields: readonly string[];
  /** Attendees or a foreign organizer: writing could send invitations. */
  readonly invitationEffect: boolean;
}

const canonical = (envelope: BridgeEnvelope): string =>
  JSON.stringify([
    envelope.v,
    envelope.summary,
    envelope.description,
    envelope.location,
    envelope.allDay,
    envelope.start,
    envelope.end,
    Object.keys(envelope.unsupported)
      .toSorted()
      .map((key) => [key, envelope.unsupported[key]]),
  ]);

/** SHA-256 over the canonical envelope; excludes ETags and fetch metadata. */
export const envelopeDigest = (envelope: BridgeEnvelope): string =>
  createHash("sha256").update(canonical(envelope)).digest("base64url");

export const serializeEnvelope = (envelope: BridgeEnvelope): string =>
  JSON.stringify(envelope);

export const parseEnvelope = (value: string): BridgeEnvelope | undefined => {
  try {
    const parsed = JSON.parse(value) as Partial<BridgeEnvelope> | null;
    if (
      parsed?.v !== 1 ||
      typeof parsed.start !== "string" ||
      typeof parsed.end !== "string" ||
      typeof parsed.allDay !== "boolean" ||
      typeof parsed.unsupported !== "object"
    )
      return undefined;
    return {
      v: 1,
      summary: parsed.summary ?? null,
      description: parsed.description ?? null,
      location: parsed.location ?? null,
      allDay: parsed.allDay,
      start: parsed.start,
      end: parsed.end,
      unsupported: parsed.unsupported,
    };
  } catch {
    return undefined;
  }
};

const finish = (
  uid: string | null,
  envelope: BridgeEnvelope,
  invitationEffect: boolean,
): NormalizedBridgeEvent => ({
  uid,
  envelope,
  digest: envelopeDigest(envelope),
  unsupportedFields: Object.keys(envelope.unsupported).toSorted(),
  invitationEffect,
});

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .toSorted()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return value === undefined ? "null" : JSON.stringify(value);
};

const text = (value: unknown): string | null | undefined =>
  value === undefined ? null : typeof value === "string" ? value : undefined;

// ---- Google ---------------------------------------------------------------

/** Provider metadata that carries no event meaning for the bridge. */
const googleIgnored = new Set([
  "kind",
  "etag",
  "id",
  "iCalUID",
  "htmlLink",
  "created",
  "updated",
  "creator",
  "sequence",
  "guestsCanInviteOthers",
  "guestsCanModify",
  "guestsCanSeeOtherGuests",
  "privateCopy",
  "locked",
]);

const googleTime = (
  value: unknown,
): { readonly value: string; readonly allDay: boolean } | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.dateTime === "string") {
    const parsed = Date.parse(item.dateTime);
    return Number.isFinite(parsed)
      ? { value: new Date(parsed).toISOString(), allDay: false }
      : undefined;
  }
  if (typeof item.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.date))
    return { value: item.date, allDay: true };
  return undefined;
};

/** Normalizes one non-cancelled Google event resource. */
export const normalizeGoogleEvent = (
  raw: Readonly<Record<string, unknown>>,
): NormalizedBridgeEvent => {
  const unsupported: Record<string, string> = {};
  let invitationEffect = false;
  const summary = text(raw.summary);
  const description = text(raw.description);
  const location = text(raw.location);
  const start = googleTime(raw.start);
  const end = googleTime(raw.end);
  for (const [key, value] of Object.entries(raw)) {
    if (googleIgnored.has(key) || value === undefined || value === null)
      continue;
    switch (key) {
      case "summary":
      case "description":
      case "location":
      case "start":
      case "end":
        continue;
      case "status":
        if (value !== "confirmed") unsupported.status = stable(value);
        continue;
      case "organizer":
        if (
          typeof value !== "object" ||
          (value as Record<string, unknown>).self !== true
        ) {
          unsupported.organizer = stable(value);
          invitationEffect = true;
        }
        continue;
      case "attendees":
        if (Array.isArray(value) && value.length === 0) continue;
        unsupported.attendees = stable(value);
        invitationEffect = true;
        continue;
      case "reminders":
        if (
          stable(value) !== stable({ useDefault: true }) &&
          stable(value) !== stable({ useDefault: true, overrides: [] })
        )
          unsupported.reminders = stable(value);
        continue;
      case "eventType":
        if (value !== "default") unsupported.eventType = stable(value);
        continue;
      case "transparency":
        if (value !== "opaque") unsupported.transparency = stable(value);
        continue;
      case "visibility":
        if (value !== "default") unsupported.visibility = stable(value);
        continue;
      case "recurrence":
      case "recurringEventId":
      case "originalStartTime":
        unsupported.recurrence = stable([
          raw.recurrence,
          raw.recurringEventId,
          raw.originalStartTime,
        ]);
        continue;
      default:
        unsupported[key] = stable(value);
    }
  }
  if (summary === undefined) unsupported.summary = stable(raw.summary);
  if (description === undefined)
    unsupported.description = stable(raw.description);
  if (location === undefined) unsupported.location = stable(raw.location);
  // Time zone labels are not part of envelope v1 (#45); the instant is.
  const valid =
    start !== undefined &&
    end?.allDay === start.allDay &&
    end.value > start.value;
  if (!valid) unsupported.schedule = stable([raw.start, raw.end]);
  return finish(
    typeof raw.iCalUID === "string" ? raw.iCalUID : null,
    {
      v: 1,
      summary: summary ?? null,
      description: description ?? null,
      location: location ?? null,
      allDay: valid ? start.allDay : false,
      start: valid ? start.value : "",
      end: valid ? end.value : "",
      unsupported,
    },
    invitationEffect,
  );
};

/** Google request body for an envelope with no unsupported fields. */
export const googleEventBody = (
  envelope: BridgeEnvelope,
): Record<string, unknown> => {
  const time = (value: string) =>
    envelope.allDay ? { date: value } : { dateTime: value, timeZone: "UTC" };
  return {
    status: "confirmed",
    ...(envelope.summary === null ? {} : { summary: envelope.summary }),
    ...(envelope.description === null
      ? {}
      : { description: envelope.description }),
    ...(envelope.location === null ? {} : { location: envelope.location }),
    start: time(envelope.start),
    end: time(envelope.end),
  };
};

// ---- iCalendar (Baikal) ---------------------------------------------------

interface IcsProperty {
  readonly name: string;
  readonly params: readonly string[];
  readonly value: string;
  readonly line: string;
}

const unfold = (rawIcs: string): readonly string[] => {
  const lines: string[] = [];
  for (const line of rawIcs.replace(/\r\n/g, "\n").split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0)
      lines[lines.length - 1] = `${lines.at(-1) ?? ""}${line.slice(1)}`;
    else if (line !== "") lines.push(line);
  }
  return lines;
};

const property = (line: string): IcsProperty | undefined => {
  // Parameter values may be quoted and contain ':'.
  let quoted = false;
  let separator = -1;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === ":" && !quoted) {
      separator = index;
      break;
    }
  }
  if (separator < 1) return undefined;
  const [name, ...params] = line.slice(0, separator).split(";");
  if (name === undefined || name === "") return undefined;
  return {
    name: name.toUpperCase(),
    params: params.map((param) => param.toUpperCase()),
    value: line.slice(separator + 1),
    line,
  };
};

const unescapeText = (value: string): string =>
  value.replace(/\\([\\;,nN])/g, (_match, char: string) =>
    char === "n" || char === "N" ? "\n" : char,
  );

const escapeText = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");

const icsIgnored = new Set([
  "UID",
  "DTSTAMP",
  "CREATED",
  "LAST-MODIFIED",
  "SEQUENCE",
]);

const icsTime = (
  prop: IcsProperty,
):
  | { readonly value: string; readonly allDay: boolean }
  | "timezone"
  | undefined => {
  if (prop.params.some((param) => param.startsWith("TZID="))) return "timezone";
  const dateOnly =
    prop.params.length === 0 || prop.params.every((p) => p === "VALUE=DATE");
  if (dateOnly && /^\d{8}$/.test(prop.value)) {
    const value = `${prop.value.slice(0, 4)}-${prop.value.slice(4, 6)}-${prop.value.slice(6)}`;
    return Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      ? { value, allDay: true }
      : undefined;
  }
  if (
    (prop.params.length === 0 ||
      prop.params.every((p) => p === "VALUE=DATE-TIME")) &&
    /^\d{8}T\d{6}Z$/.test(prop.value)
  ) {
    const v = prop.value;
    const parsed = Date.parse(
      `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}Z`,
    );
    return Number.isFinite(parsed)
      ? { value: new Date(parsed).toISOString(), allDay: false }
      : undefined;
  }
  return undefined;
};

/** Normalizes a single-VEVENT iCalendar resource. */
export const normalizeCalDavEvent = (rawIcs: string): NormalizedBridgeEvent => {
  const unsupported: Record<string, string> = {};
  let invitationEffect = false;
  const lines = unfold(rawIcs);
  const events: IcsProperty[][] = [];
  const stack: string[] = [];
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      const component = upper.slice(6);
      stack.push(component);
      if (component === "VEVENT" && stack.length === 2) events.push([]);
      else if (component === "VALARM")
        unsupported.alarms = `${unsupported.alarms ?? ""}${line}`;
      else if (component !== "VCALENDAR" && component !== "VTIMEZONE")
        unsupported.component = `${unsupported.component ?? ""}${component};`;
      continue;
    }
    if (upper.startsWith("END:")) {
      stack.pop();
      continue;
    }
    const parsed = property(line);
    if (parsed === undefined) {
      unsupported.structure = `${unsupported.structure ?? ""}${line}\n`;
      continue;
    }
    if (stack.at(-1) === "VEVENT" && stack.length === 2)
      events.at(-1)?.push(parsed);
    else if (stack.at(-1) === "VALARM")
      unsupported.alarms = `${unsupported.alarms ?? ""}\n${line}`;
  }
  if (events.length !== 1)
    unsupported.component = `${unsupported.component ?? ""}VEVENT*${String(events.length)}`;
  const seen = new Map<string, IcsProperty>();
  let uid: string | null = null;
  for (const prop of events[0] ?? []) {
    if (seen.has(prop.name)) {
      unsupported[`duplicate:${prop.name}`] =
        `${unsupported[`duplicate:${prop.name}`] ?? ""}${prop.line}\n`;
      continue;
    }
    seen.set(prop.name, prop);
    if (prop.name === "UID") uid = prop.value;
    if (icsIgnored.has(prop.name)) continue;
    switch (prop.name) {
      case "SUMMARY":
      case "DESCRIPTION":
      case "LOCATION":
        if (prop.params.length > 0) unsupported[prop.name] = prop.line;
        continue;
      case "DTSTART":
      case "DTEND":
        continue;
      case "TRANSP":
        if (prop.value.toUpperCase() !== "OPAQUE")
          unsupported.TRANSP = prop.line;
        continue;
      case "STATUS":
        if (prop.value.toUpperCase() !== "CONFIRMED")
          unsupported.STATUS = prop.line;
        continue;
      case "CLASS":
        if (prop.value.toUpperCase() !== "PUBLIC")
          unsupported.CLASS = prop.line;
        continue;
      case "ATTENDEE":
      case "ORGANIZER":
        invitationEffect = true;
        unsupported[prop.name] = prop.line;
        continue;
      case "RRULE":
      case "RDATE":
      case "EXDATE":
      case "RECURRENCE-ID":
        unsupported.recurrence = `${unsupported.recurrence ?? ""}${prop.line}\n`;
        continue;
      default:
        unsupported[prop.name] = prop.line;
    }
  }
  const textValue = (name: string): string | null => {
    const prop = seen.get(name);
    return prop === undefined ? null : unescapeText(prop.value);
  };
  const dtstart = seen.get("DTSTART");
  const dtend = seen.get("DTEND");
  const start = dtstart === undefined ? undefined : icsTime(dtstart);
  const end = dtend === undefined ? undefined : icsTime(dtend);
  if (start === "timezone" || end === "timezone")
    unsupported.timezone = `${dtstart?.line ?? ""}\n${dtend?.line ?? ""}`;
  const valid =
    typeof start === "object" &&
    typeof end === "object" &&
    start.allDay === end.allDay &&
    end.value > start.value;
  if (!valid && start !== "timezone" && end !== "timezone")
    unsupported.schedule = `${dtstart?.line ?? ""}\n${dtend?.line ?? ""}`;
  return finish(
    uid,
    {
      v: 1,
      summary: textValue("SUMMARY"),
      description: textValue("DESCRIPTION"),
      location: textValue("LOCATION"),
      allDay: valid ? start.allDay : false,
      start: valid ? start.value : "",
      end: valid ? end.value : "",
      unsupported,
    },
    invitationEffect,
  );
};

const fold = (line: string): string => {
  const chunks: string[] = [];
  let rest = line;
  while (rest.length > 73) {
    chunks.push(rest.slice(0, 73));
    rest = rest.slice(73);
  }
  chunks.push(rest);
  return chunks.join("\r\n ");
};

const icsDate = (envelope: BridgeEnvelope, value: string): string =>
  envelope.allDay
    ? `;VALUE=DATE:${value.replaceAll("-", "")}`
    : `:${value.replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "")}`;

/** iCalendar body for an envelope with no unsupported fields. */
export const calDavEventIcs = (
  envelope: BridgeEnvelope,
  uid: string,
  now: string,
): string =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Tadooer//Calendar bridge v1//EN",
    "BEGIN:VEVENT",
    fold(`UID:${uid}`),
    `DTSTAMP${icsDate({ ...envelope, allDay: false }, now)}`,
    `DTSTART${icsDate(envelope, envelope.start)}`,
    `DTEND${icsDate(envelope, envelope.end)}`,
    ...(envelope.summary === null
      ? []
      : [fold(`SUMMARY:${escapeText(envelope.summary)}`)]),
    ...(envelope.description === null
      ? []
      : [fold(`DESCRIPTION:${escapeText(envelope.description)}`)]),
    ...(envelope.location === null
      ? []
      : [fold(`LOCATION:${escapeText(envelope.location)}`)]),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

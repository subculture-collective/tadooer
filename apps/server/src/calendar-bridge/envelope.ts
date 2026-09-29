import { createHash } from "node:crypto";

/**
 * Normalized event envelope, version 2 (ADR 0041, ADR 0042). Only the
 * content, schedule and recurrence fields are propagated. Organizer and
 * attendees are retained in `invitation` and never written. Everything else
 * meaningful is listed in `unsupported` with a canonical value, so it
 * contributes to the digest (a change is visible) and blocks propagation (it
 * is never silently dropped).
 */
export interface BridgeSchedule {
  readonly allDay: boolean;
  /**
   * All-day: `YYYY-MM-DD`. UTC: an instant (`toISOString`). Zoned: the local
   * wall time `YYYY-MM-DDTHH:MM:SS` in `startZone`/`endZone`.
   */
  readonly start: string;
  readonly end: string;
  /** IANA zone of a zoned time; null for UTC instants and all-day dates. */
  readonly startZone: string | null;
  readonly endZone: string | null;
}

export interface BridgeInstance extends BridgeSchedule {
  /** null means absent; "" is an explicit empty value. */
  readonly summary: string | null;
  readonly description: string | null;
  readonly location: string | null;
}

export interface BridgeRecurrence {
  /** RRULE values, FREQ first and the other parts sorted. */
  readonly rules: readonly string[];
  /** Instance keys (see `instanceKey`), sorted and unique. */
  readonly rdates: readonly string[];
  /** EXDATEs and cancelled instances, sorted and unique. */
  readonly exdates: readonly string[];
  /** Modified instances by instance key. */
  readonly overrides: Readonly<Record<string, BridgeInstance>>;
}

export interface BridgeEnvelope extends BridgeInstance {
  readonly v: 2;
  readonly recurrence: BridgeRecurrence | null;
  /**
   * Organizer and attendees by instance key ("" is the master), in the
   * provider's canonical form. Retained for review; never written.
   */
  readonly invitation: Readonly<Record<string, string>> | null;
  readonly unsupported: Readonly<Record<string, string>>;
}

export interface NormalizedBridgeEvent {
  readonly uid: string | null;
  readonly envelope: BridgeEnvelope;
  /** Bridge digest: the envelope without `invitation` (ADR 0042). */
  readonly digest: string;
  readonly unsupportedFields: readonly string[];
  /** Attendees or a foreign organizer: the event is never written. */
  readonly invitationEffect: boolean;
}

const sortedEntries = <T>(value: Readonly<Record<string, T>>) =>
  Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const instanceArray = (value: BridgeInstance) => [
  value.summary,
  value.description,
  value.location,
  value.allDay,
  value.start,
  value.end,
  value.startZone,
  value.endZone,
];

const canonical = (envelope: BridgeEnvelope): string => {
  const unsupported = sortedEntries(envelope.unsupported);
  // Envelopes without v2 content hash exactly as version 1 (ADR 0041), so
  // accepted digests stored before ADR 0042 remain valid.
  if (
    envelope.startZone === null &&
    envelope.endZone === null &&
    envelope.recurrence === null &&
    envelope.invitation === null
  )
    return JSON.stringify([
      1,
      envelope.summary,
      envelope.description,
      envelope.location,
      envelope.allDay,
      envelope.start,
      envelope.end,
      unsupported,
    ]);
  const recurrence = envelope.recurrence;
  return JSON.stringify([
    2,
    instanceArray(envelope),
    recurrence === null
      ? null
      : [
          recurrence.rules,
          recurrence.rdates,
          recurrence.exdates,
          sortedEntries(recurrence.overrides).map(([key, value]) => [
            key,
            instanceArray(value),
          ]),
        ],
    envelope.invitation === null ? null : sortedEntries(envelope.invitation),
    unsupported,
  ]);
};

/** SHA-256 over the canonical envelope; excludes ETags and fetch metadata. */
export const envelopeDigest = (envelope: BridgeEnvelope): string =>
  createHash("sha256").update(canonical(envelope)).digest("base64url");

/** The part of an envelope the bridge compares and writes. */
export const projectEnvelope = (envelope: BridgeEnvelope): BridgeEnvelope =>
  envelope.invitation === null ? envelope : { ...envelope, invitation: null };

export const bridgeDigest = (envelope: BridgeEnvelope): string =>
  envelopeDigest(projectEnvelope(envelope));

export const serializeEnvelope = (envelope: BridgeEnvelope): string =>
  JSON.stringify(envelope);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses a stored snapshot; version 1 snapshots are upgraded in place. */
export const parseEnvelope = (value: string): BridgeEnvelope | undefined => {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown> | null;
    if (
      (parsed?.v !== 1 && parsed?.v !== 2) ||
      typeof parsed.start !== "string" ||
      typeof parsed.end !== "string" ||
      typeof parsed.allDay !== "boolean" ||
      !isRecord(parsed.unsupported)
    )
      return undefined;
    const optional = (item: unknown): string | null =>
      typeof item === "string" ? item : null;
    return {
      v: 2,
      summary: optional(parsed.summary),
      description: optional(parsed.description),
      location: optional(parsed.location),
      allDay: parsed.allDay,
      start: parsed.start,
      end: parsed.end,
      startZone: optional(parsed.startZone),
      endZone: optional(parsed.endZone),
      recurrence: isRecord(parsed.recurrence)
        ? (parsed.recurrence as unknown as BridgeRecurrence)
        : null,
      invitation: isRecord(parsed.invitation)
        ? (parsed.invitation as Record<string, string>)
        : null,
      unsupported: parsed.unsupported as Record<string, string>,
    };
  } catch {
    return undefined;
  }
};

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

// ---- Time --------------------------------------------------------------

type BridgeTime =
  | { readonly kind: "date"; readonly value: string }
  | { readonly kind: "utc"; readonly value: string }
  | { readonly kind: "zoned"; readonly value: string; readonly zone: string };

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (zone: string): Intl.DateTimeFormat => {
  let result = formatters.get(zone);
  if (result === undefined) {
    result = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, result);
  }
  return result;
};

/** True when the runtime's IANA database knows the zone name. */
export const knownTimeZone = (zone: string): boolean => {
  if (!/^[A-Za-z0-9_+\-/]+$/.test(zone)) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
};

const utcZones = new Set(["UTC", "ETC/UTC", "GMT", "ETC/GMT", "Z", "UCT"]);
const isUtcZone = (zone: string): boolean => utcZones.has(zone.toUpperCase());

/** Local wall time `YYYY-MM-DDTHH:MM:SS` of an instant in a zone. */
export const wallTime = (instant: number, zone: string): string => {
  const parts: Record<string, string> = {};
  for (const part of formatter(zone).formatToParts(instant))
    parts[part.type] = part.value;
  return `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}T${parts.hour ?? ""}:${parts.minute ?? ""}:${parts.second ?? ""}`;
};

const wallMs = (wall: string): number => Date.parse(`${wall}Z`);

/** Instant of a wall time in a zone (a skipped DST time moves forward). */
export const zonedInstant = (wall: string, zone: string): number => {
  const guess = wallMs(wall);
  const offset = (instant: number) => wallMs(wallTime(instant, zone)) - instant;
  const first = guess - offset(guess);
  return guess - offset(first);
};

const instantOf = (time: BridgeTime): number =>
  time.kind === "date"
    ? Date.parse(`${time.value}T00:00:00Z`)
    : time.kind === "utc"
      ? Date.parse(time.value)
      : zonedInstant(time.value, time.zone);

const validDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const timeOf = (
  value: string,
  zone: string | null,
  allDay: boolean,
): BridgeTime =>
  allDay
    ? { kind: "date", value }
    : zone === null
      ? { kind: "utc", value }
      : { kind: "zoned", value, zone };

const startOf = (schedule: BridgeSchedule): BridgeTime =>
  timeOf(schedule.start, schedule.startZone, schedule.allDay);
const endOf = (schedule: BridgeSchedule): BridgeTime =>
  timeOf(schedule.end, schedule.endZone, schedule.allDay);

/** Schedule from two parsed times, or undefined when it is not usable. */
const scheduleOf = (
  start: BridgeTime,
  end: BridgeTime,
): BridgeSchedule | undefined => {
  if ((start.kind === "date") !== (end.kind === "date")) return undefined;
  if (start.kind === "date" ? end.value <= start.value : false)
    return undefined;
  if (start.kind !== "date" && instantOf(end) <= instantOf(start))
    return undefined;
  return {
    allDay: start.kind === "date",
    start: start.value,
    end: end.value,
    startZone: start.kind === "zoned" ? start.zone : null,
    endZone: end.kind === "zoned" ? end.zone : null,
  };
};

/**
 * Instance key: an original start in the master's form (ADR 0042). A date
 * for all-day series, a UTC instant for UTC series, and the wall time in the
 * master's zone for zoned series, so keys survive DST changes.
 */
const instanceKey = (
  master: BridgeTime,
  time: BridgeTime,
): string | undefined => {
  if (master.kind === "date")
    return time.kind === "date" ? time.value : undefined;
  if (time.kind === "date") return undefined;
  if (master.kind === "zoned" && time.kind === "zoned")
    if (time.zone === master.zone) return time.value;
  const instant = instantOf(time);
  if (!Number.isFinite(instant)) return undefined;
  return master.kind === "utc"
    ? new Date(instant).toISOString()
    : wallTime(instant, master.zone);
};

const keyTime = (master: BridgeSchedule, key: string): BridgeTime =>
  timeOf(key, master.startZone, master.allDay);

/** Instance with the master's content, start at the key and its duration. */
const generatedInstance = (
  master: BridgeInstance,
  key: string,
): BridgeInstance => {
  if (master.allDay) {
    const days = Math.round(
      (Date.parse(`${master.end}T00:00:00Z`) -
        Date.parse(`${master.start}T00:00:00Z`)) /
        86_400_000,
    );
    return { ...master, start: key, end: addDays(key, days) };
  }
  const duration = instantOf(endOf(master)) - instantOf(startOf(master));
  const endInstant = instantOf(keyTime(master, key)) + duration;
  return {
    ...master,
    start: key,
    end:
      master.endZone === null
        ? new Date(endInstant).toISOString()
        : wallTime(endInstant, master.endZone),
  };
};

const sameInstance = (a: BridgeInstance, b: BridgeInstance): boolean =>
  stable(instanceArray(a)) === stable(instanceArray(b));

// ---- Shared assembly ---------------------------------------------------

interface Parts {
  readonly unsupported: Record<string, string>;
  readonly invitation: Record<string, string>;
}

const add = (parts: Parts, key: string, value: string): void => {
  parts.unsupported[key] =
    parts.unsupported[key] === undefined
      ? value
      : `${parts.unsupported[key]}\n${value}`;
};

const canonicalRule = (value: string): string => {
  const pieces = value
    .split(";")
    .filter((piece) => piece !== "")
    .map((piece) => piece.toUpperCase());
  const freq = pieces.filter((piece) => piece.startsWith("FREQ="));
  return [
    ...freq,
    ...pieces.filter((piece) => !piece.startsWith("FREQ=")).toSorted(),
  ].join(";");
};

interface RecurrenceDraft {
  readonly rules: string[];
  readonly rdates: Set<string>;
  readonly exdates: Set<string>;
  readonly overrides: Map<string, BridgeInstance>;
}

const draft = (): RecurrenceDraft => ({
  rules: [],
  rdates: new Set(),
  exdates: new Set(),
  overrides: new Map(),
});

const finish = (
  uid: string | null,
  master: BridgeInstance | undefined,
  recurrence: RecurrenceDraft | undefined,
  parts: Parts,
): NormalizedBridgeEvent => {
  const unsupported = parts.unsupported;
  // Instance invitations are kept only where they differ from the master's.
  const masterInvitation = parts.invitation[""];
  const ownInvitation = (key: string): string | undefined =>
    parts.invitation[key] === masterInvitation
      ? undefined
      : parts.invitation[key];
  const invitation: Record<string, string> =
    masterInvitation === undefined ? {} : { "": masterInvitation };
  let envelopeRecurrence: BridgeRecurrence | null = null;
  if (master !== undefined && recurrence !== undefined) {
    if (recurrence.rules.length > 1)
      add(parts, "recurrence", recurrence.rules.join("\n"));
    if (recurrence.rules.length === 0 && recurrence.rdates.size === 0)
      add(parts, "recurrence", "no-rule");
    const overrides: Record<string, BridgeInstance> = {};
    for (const key of [...recurrence.overrides.keys()].toSorted()) {
      const override = recurrence.overrides.get(key);
      if (override === undefined || recurrence.exdates.has(key)) continue;
      const hasUnsupported = Object.keys(unsupported).some((name) =>
        name.startsWith(`override:${key}:`),
      );
      const own = ownInvitation(key);
      // A materialized but unchanged instance is not a modification.
      if (
        !hasUnsupported &&
        own === undefined &&
        sameInstance(override, generatedInstance(master, key))
      )
        continue;
      overrides[key] = override;
      if (own !== undefined) invitation[key] = own;
    }
    envelopeRecurrence = {
      rules: recurrence.rules,
      rdates: [...recurrence.rdates].toSorted(),
      exdates: [...recurrence.exdates].toSorted(),
      overrides,
    };
  }
  if (
    master === undefined &&
    unsupported.schedule === undefined &&
    unsupported.timezone === undefined
  )
    add(parts, "schedule", "invalid");
  const base = master ?? {
    summary: null,
    description: null,
    location: null,
    allDay: false,
    start: "",
    end: "",
    startZone: null,
    endZone: null,
  };
  const envelope: BridgeEnvelope = {
    v: 2,
    ...base,
    recurrence: envelopeRecurrence,
    invitation: Object.keys(invitation).length === 0 ? null : invitation,
    unsupported,
  };
  return {
    uid,
    envelope,
    digest: bridgeDigest(envelope),
    unsupportedFields: Object.keys(unsupported).toSorted(),
    invitationEffect: envelope.invitation !== null,
  };
};

// ---- iCalendar lines -----------------------------------------------------

interface IcsProperty {
  readonly name: string;
  /** Raw parameters (`NAME=value`); names compare case-insensitively. */
  readonly params: readonly string[];
  readonly value: string;
  readonly line: string;
}

const property = (line: string): IcsProperty | undefined => {
  // Parameter values may be quoted and contain ':' or ';'.
  let quoted = false;
  let separator = -1;
  const cuts: number[] = [];
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === ";" && !quoted) cuts.push(index);
    else if (char === ":" && !quoted) {
      separator = index;
      break;
    }
  }
  if (separator < 1) return undefined;
  const head = line.slice(0, separator);
  const bounds = [-1, ...cuts, separator];
  const pieces = bounds
    .slice(0, -1)
    .map((start, index) => head.slice(start + 1, bounds[index + 1]));
  const [name, ...params] = pieces;
  if (name === undefined || name === "") return undefined;
  return {
    name: name.toUpperCase(),
    params,
    value: line.slice(separator + 1),
    line,
  };
};

const param = (prop: IcsProperty, name: string): string | undefined => {
  const prefix = `${name}=`;
  const found = prop.params.find((item) =>
    item.toUpperCase().startsWith(prefix),
  );
  if (found === undefined) return undefined;
  const value = found.slice(prefix.length);
  return value.startsWith('"') && value.endsWith('"') && value.length > 1
    ? value.slice(1, -1)
    : value;
};

/** Parses one iCalendar date or date-time value. */
const icsTime = (
  value: string,
  tzid: string | undefined,
  valueType: string | undefined,
): BridgeTime | "timezone" | undefined => {
  const type = valueType?.toUpperCase();
  if (type === "DATE" || (type === undefined && /^\d{8}$/.test(value))) {
    if (!/^\d{8}$/.test(value)) return undefined;
    const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
    return validDate(date) ? { kind: "date", value: date } : undefined;
  }
  if (type !== undefined && type !== "DATE-TIME") return undefined;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (match === null) return undefined;
  const wall = `${match[1] ?? ""}-${match[2] ?? ""}-${match[3] ?? ""}T${match[4] ?? ""}:${match[5] ?? ""}:${match[6] ?? ""}`;
  if (!Number.isFinite(wallMs(wall))) return undefined;
  if (match[7] === "Z" || (tzid !== undefined && isUtcZone(tzid)))
    return { kind: "utc", value: new Date(wallMs(wall)).toISOString() };
  // Floating times and zones the IANA database does not know stay blocked.
  if (tzid === undefined || !knownTimeZone(tzid)) return "timezone";
  return { kind: "zoned", value: wall, zone: tzid };
};

const icsPropTime = (prop: IcsProperty): BridgeTime | "timezone" | undefined =>
  prop.params.some((item) => !/^(TZID|VALUE)=/i.test(item))
    ? undefined
    : icsTime(prop.value, param(prop, "TZID"), param(prop, "VALUE"));

/** Adds one RRULE/RDATE/EXDATE line (from iCalendar or Google). */
const recurrenceLine = (
  prop: IcsProperty,
  master: BridgeTime | undefined,
  recurrence: RecurrenceDraft,
  parts: Parts,
): void => {
  if (prop.name === "RRULE" && prop.params.length === 0) {
    recurrence.rules.push(canonicalRule(prop.value));
    return;
  }
  if (
    (prop.name === "RDATE" || prop.name === "EXDATE") &&
    master !== undefined
  ) {
    const keys: string[] = [];
    for (const value of prop.value.split(",")) {
      const time = icsPropTime({ ...prop, value });
      const key =
        typeof time === "object" ? instanceKey(master, time) : undefined;
      if (key === undefined) {
        add(parts, "recurrence", prop.line);
        return;
      }
      keys.push(key);
    }
    const target =
      prop.name === "RDATE" ? recurrence.rdates : recurrence.exdates;
    for (const key of keys) target.add(key);
    return;
  }
  add(parts, "recurrence", prop.line);
};

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

const googleTime = (value: unknown): BridgeTime | "timezone" | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.date === "string")
    return validDate(value.date)
      ? { kind: "date", value: value.date }
      : undefined;
  if (typeof value.dateTime !== "string") return undefined;
  const label = typeof value.timeZone === "string" ? value.timeZone : null;
  const zone = label === null || isUtcZone(label) ? null : label;
  if (zone !== null && !knownTimeZone(zone)) return "timezone";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value.dateTime)) {
    // No offset: the wall time is in the named zone.
    if (!Number.isFinite(wallMs(value.dateTime))) return undefined;
    if (zone !== null) return { kind: "zoned", value: value.dateTime, zone };
    return label === null
      ? "timezone"
      : { kind: "utc", value: new Date(wallMs(value.dateTime)).toISOString() };
  }
  const parsed = Date.parse(value.dateTime);
  if (!Number.isFinite(parsed)) return undefined;
  return zone === null
    ? { kind: "utc", value: new Date(parsed).toISOString() }
    : { kind: "zoned", value: wallTime(parsed, zone), zone };
};

const text = (value: unknown): string | null | undefined =>
  value === undefined || value === null
    ? null
    : typeof value === "string"
      ? value
      : undefined;

const googleInvitation = (
  raw: Readonly<Record<string, unknown>>,
): string | undefined => {
  const attendees = Array.isArray(raw.attendees) ? raw.attendees : [];
  const foreign =
    raw.organizer !== undefined &&
    raw.organizer !== null &&
    !(isRecord(raw.organizer) && raw.organizer.self === true);
  if (!foreign && attendees.length === 0) return undefined;
  return stable({ organizer: raw.organizer ?? null, attendees });
};

/** One Google event resource as an instance; records unsupported fields. */
const googleInstance = (
  raw: Readonly<Record<string, unknown>>,
  parts: Parts,
  prefix: string,
  handled: ReadonlySet<string>,
): BridgeInstance | undefined => {
  const note = (key: string, value: unknown) => {
    add(parts, `${prefix}${key}`, stable(value));
  };
  for (const [key, value] of Object.entries(raw)) {
    if (
      googleIgnored.has(key) ||
      handled.has(key) ||
      value === undefined ||
      value === null
    )
      continue;
    switch (key) {
      case "summary":
      case "description":
      case "location":
      case "start":
      case "end":
      case "organizer":
        continue;
      case "attendees":
        if (!Array.isArray(value)) note(key, value);
        continue;
      case "status":
        if (value !== "confirmed") note(key, value);
        continue;
      case "reminders":
        if (
          stable(value) !== stable({ useDefault: true }) &&
          stable(value) !== stable({ useDefault: true, overrides: [] })
        )
          note(key, value);
        continue;
      case "eventType":
        if (value !== "default") note(key, value);
        continue;
      case "transparency":
        if (value !== "opaque") note(key, value);
        continue;
      case "visibility":
        if (value !== "default") note(key, value);
        continue;
      case "recurringEventId":
      case "originalStartTime":
        // An instance whose master is not part of this read.
        note("recurring-instance", [
          raw.recurringEventId,
          raw.originalStartTime,
        ]);
        continue;
      default:
        note(key, value);
    }
  }
  const invitation = googleInvitation(raw);
  if (invitation !== undefined)
    parts.invitation[prefix === "" ? "" : prefix.slice(9, -1)] = invitation;
  const summary = text(raw.summary);
  const description = text(raw.description);
  const location = text(raw.location);
  if (summary === undefined) note("summary", raw.summary);
  if (description === undefined) note("description", raw.description);
  if (location === undefined) note("location", raw.location);
  const start = googleTime(raw.start);
  const end = googleTime(raw.end);
  if (start === "timezone" || end === "timezone")
    note("timezone", [raw.start, raw.end]);
  const schedule =
    typeof start === "object" && typeof end === "object"
      ? scheduleOf(start, end)
      : undefined;
  if (schedule === undefined) {
    if (start !== "timezone" && end !== "timezone")
      note("schedule", [raw.start, raw.end]);
    return undefined;
  }
  return {
    summary: summary ?? null,
    description: description ?? null,
    location: location ?? null,
    ...schedule,
  };
};

/**
 * Normalizes a Google series: the master resource and every exception event
 * (`recurringEventId` = master ID), cancelled ones included (ADR 0042).
 */
export const normalizeGoogleSeries = (
  master: Readonly<Record<string, unknown>>,
  exceptions: readonly Readonly<Record<string, unknown>>[],
): NormalizedBridgeEvent => {
  const parts: Parts = { unsupported: {}, invitation: {} };
  const main = googleInstance(master, parts, "", new Set(["recurrence"]));
  const masterStart = main === undefined ? undefined : startOf(main);
  let recurrence: RecurrenceDraft | undefined;
  if (master.recurrence !== undefined && master.recurrence !== null) {
    recurrence = draft();
    if (!Array.isArray(master.recurrence))
      add(parts, "recurrence", stable(master.recurrence));
    else
      for (const line of master.recurrence as unknown[]) {
        const prop = typeof line === "string" ? property(line) : undefined;
        if (prop === undefined) add(parts, "recurrence", stable(line));
        else recurrenceLine(prop, masterStart, recurrence, parts);
      }
  }
  for (const exception of exceptions) {
    const original = googleTime(exception.originalStartTime);
    const key =
      masterStart !== undefined && typeof original === "object"
        ? instanceKey(masterStart, original)
        : undefined;
    if (recurrence === undefined || main === undefined || !key) {
      add(parts, "recurring-instance", stable(exception));
      continue;
    }
    if (exception.status === "cancelled") {
      recurrence.exdates.add(key);
      continue;
    }
    const instance = googleInstance(
      exception,
      parts,
      `override:${key}:`,
      new Set(["recurringEventId", "originalStartTime"]),
    );
    if (instance !== undefined) recurrence.overrides.set(key, instance);
  }
  return finish(
    typeof master.iCalUID === "string" ? master.iCalUID : null,
    main,
    recurrence,
    parts,
  );
};

/** Normalizes one non-cancelled Google event resource without exceptions. */
export const normalizeGoogleEvent = (
  raw: Readonly<Record<string, unknown>>,
): NormalizedBridgeEvent => normalizeGoogleSeries(raw, []);

const basicDate = (date: string): string => date.replaceAll("-", "");
const basicUtc = (instant: string): string =>
  instant.replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
const basicWall = (wall: string): string => wall.replace(/[-:]/g, "");

const googleTimeBody = (time: BridgeTime): Record<string, string> =>
  time.kind === "date"
    ? { date: time.value }
    : time.kind === "utc"
      ? { dateTime: time.value, timeZone: "UTC" }
      : { dateTime: time.value, timeZone: time.zone };

/** RDATE/EXDATE line for instance keys in the master's form. */
const valueListLine = (
  name: string,
  keys: readonly string[],
  master: BridgeSchedule,
): string[] =>
  keys.length === 0
    ? []
    : master.allDay
      ? [`${name};VALUE=DATE:${keys.map(basicDate).join(",")}`]
      : master.startZone === null
        ? [`${name}:${keys.map(basicUtc).join(",")}`]
        : [`${name};TZID=${master.startZone}:${keys.map(basicWall).join(",")}`];

const recurrenceLines = (envelope: BridgeEnvelope): string[] =>
  envelope.recurrence === null
    ? []
    : [
        ...envelope.recurrence.rules.map((rule) => `RRULE:${rule}`),
        ...valueListLine("RDATE", envelope.recurrence.rdates, envelope),
        ...valueListLine("EXDATE", envelope.recurrence.exdates, envelope),
      ];

const googleContent = (instance: BridgeInstance): Record<string, unknown> => ({
  status: "confirmed",
  ...(instance.summary === null ? {} : { summary: instance.summary }),
  ...(instance.description === null
    ? {}
    : { description: instance.description }),
  ...(instance.location === null ? {} : { location: instance.location }),
  start: googleTimeBody(startOf(instance)),
  end: googleTimeBody(endOf(instance)),
});

/**
 * Google request body for the master of an envelope with no unsupported
 * fields. Organizer and attendees are never written.
 */
export const googleEventBody = (
  envelope: BridgeEnvelope,
): Record<string, unknown> => ({
  ...googleContent(envelope),
  ...(envelope.recurrence === null
    ? {}
    : { recurrence: recurrenceLines(envelope) }),
});

/** Google instance ID of an instance key (`<master>_<basic start>`). */
export const googleInstanceId = (
  masterId: string,
  envelope: BridgeSchedule,
  key: string,
): string =>
  `${masterId}_${
    envelope.allDay
      ? basicDate(key)
      : basicUtc(new Date(instantOf(keyTime(envelope, key))).toISOString())
  }`;

/**
 * Body for one instance of a Google series: the envelope's override for the
 * key, or the generated instance when the key is not modified.
 */
export const googleInstanceBody = (
  masterId: string,
  envelope: BridgeEnvelope,
  key: string,
): Record<string, unknown> => ({
  ...googleContent(
    envelope.recurrence?.overrides[key] ?? generatedInstance(envelope, key),
  ),
  recurringEventId: masterId,
  originalStartTime: googleTimeBody(keyTime(envelope, key)),
});

/**
 * Digest of the master resource alone as written by `googleEventBody`: the
 * envelope without overrides.
 */
export const masterDigest = (envelope: BridgeEnvelope): string =>
  bridgeDigest({
    ...envelope,
    recurrence:
      envelope.recurrence === null
        ? null
        : { ...envelope.recurrence, overrides: {} },
    unsupported: Object.fromEntries(
      Object.entries(envelope.unsupported).filter(
        ([key]) => !key.startsWith("override:"),
      ),
    ),
    invitation: null,
  });

// ---- iCalendar (Baikal) ---------------------------------------------------

const unfold = (rawIcs: string): readonly string[] => {
  const lines: string[] = [];
  for (const line of rawIcs.replace(/\r\n/g, "\n").split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0)
      lines[lines.length - 1] = `${lines.at(-1) ?? ""}${line.slice(1)}`;
    else if (line !== "") lines.push(line);
  }
  return lines;
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

/** Properties that may repeat within one VEVENT. */
const icsRepeatable = new Set(["ATTENDEE", "RDATE", "EXDATE"]);

/** One VEVENT as an instance; records unsupported fields. */
const icsInstance = (
  props: readonly IcsProperty[],
  parts: Parts,
  prefix: string,
  isMaster: boolean,
): {
  readonly instance: BridgeInstance | undefined;
  readonly cancelled: boolean;
  readonly recurrenceProps: readonly IcsProperty[];
} => {
  const note = (key: string, value: string) => {
    add(parts, `${prefix}${key}`, value);
  };
  const seen = new Map<string, IcsProperty>();
  const recurrenceProps: IcsProperty[] = [];
  const invitation: string[] = [];
  let cancelled = false;
  for (const prop of props) {
    if (seen.has(prop.name) && !icsRepeatable.has(prop.name)) {
      note(`duplicate:${prop.name}`, prop.line);
      continue;
    }
    seen.set(prop.name, prop);
    if (icsIgnored.has(prop.name)) continue;
    switch (prop.name) {
      case "SUMMARY":
      case "DESCRIPTION":
      case "LOCATION":
        if (prop.params.length > 0) note(prop.name, prop.line);
        continue;
      case "DTSTART":
      case "DTEND":
        continue;
      case "RECURRENCE-ID":
        if (isMaster) note(prop.name, prop.line);
        continue;
      case "TRANSP":
        if (prop.value.toUpperCase() !== "OPAQUE") note(prop.name, prop.line);
        continue;
      case "STATUS":
        if (!isMaster && prop.value.toUpperCase() === "CANCELLED")
          cancelled = true;
        else if (prop.value.toUpperCase() !== "CONFIRMED")
          note(prop.name, prop.line);
        continue;
      case "CLASS":
        if (prop.value.toUpperCase() !== "PUBLIC") note(prop.name, prop.line);
        continue;
      case "ATTENDEE":
      case "ORGANIZER":
        invitation.push(prop.line);
        continue;
      case "RRULE":
      case "RDATE":
      case "EXDATE":
        if (isMaster) recurrenceProps.push(prop);
        else note(prop.name, prop.line);
        continue;
      default:
        note(prop.name, prop.line);
    }
  }
  if (invitation.length > 0)
    parts.invitation[prefix === "" ? "" : prefix.slice(9, -1)] = invitation
      .toSorted()
      .join("\n");
  const textValue = (name: string): string | null => {
    const prop = seen.get(name);
    return prop === undefined ? null : unescapeText(prop.value);
  };
  const dtstart = seen.get("DTSTART");
  const dtend = seen.get("DTEND");
  const start = dtstart === undefined ? undefined : icsPropTime(dtstart);
  let end = dtend === undefined ? undefined : icsPropTime(dtend);
  // An all-day event without DTEND lasts one day (RFC 5545 3.6.1).
  if (
    dtend === undefined &&
    !seen.has("DURATION") &&
    typeof start === "object" &&
    start.kind === "date"
  )
    end = { kind: "date", value: addDays(start.value, 1) };
  const schedule =
    typeof start === "object" && typeof end === "object"
      ? scheduleOf(start, end)
      : undefined;
  if (start === "timezone" || end === "timezone")
    note("timezone", `${dtstart?.line ?? ""}\n${dtend?.line ?? ""}`);
  else if (schedule === undefined && !cancelled)
    note("schedule", `${dtstart?.line ?? ""}\n${dtend?.line ?? ""}`);
  return {
    instance:
      schedule === undefined
        ? undefined
        : {
            summary: textValue("SUMMARY"),
            description: textValue("DESCRIPTION"),
            location: textValue("LOCATION"),
            ...schedule,
          },
    cancelled,
    recurrenceProps,
  };
};

/**
 * Normalizes one calendar object resource: a single VEVENT, or a recurring
 * master with its RECURRENCE-ID overrides (ADR 0042).
 */
export const normalizeCalDavEvent = (rawIcs: string): NormalizedBridgeEvent => {
  const parts: Parts = { unsupported: {}, invitation: {} };
  const events: IcsProperty[][] = [];
  const stack: string[] = [];
  for (const line of unfold(rawIcs)) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      const component = upper.slice(6);
      stack.push(component);
      if (component === "VEVENT" && stack.length === 2) events.push([]);
      else if (component === "VALARM") add(parts, "alarms", line);
      else if (component !== "VCALENDAR" && component !== "VTIMEZONE")
        add(parts, "component", component);
      continue;
    }
    if (upper.startsWith("END:")) {
      stack.pop();
      continue;
    }
    const parsed = property(line);
    if (parsed === undefined) {
      add(parts, "structure", line);
      continue;
    }
    if (stack.at(-1) === "VEVENT" && stack.length === 2)
      events.at(-1)?.push(parsed);
    else if (stack.at(-1) === "VALARM") add(parts, "alarms", line);
  }
  const uidOf = (props: readonly IcsProperty[]) =>
    props.find((prop) => prop.name === "UID")?.value ?? null;
  const masters = events.filter(
    (props) => !props.some((prop) => prop.name === "RECURRENCE-ID"),
  );
  const overrides = events.filter((props) =>
    props.some((prop) => prop.name === "RECURRENCE-ID"),
  );
  const uids = new Set(events.map(uidOf));
  if (masters.length !== 1 || uids.size !== 1)
    add(parts, "component", `VEVENT*${String(events.length)}`);
  const masterProps = masters[0] ?? [];
  const master = icsInstance(masterProps, parts, "", true);
  const main = master.instance;
  const masterStart = main === undefined ? undefined : startOf(main);
  let recurrence: RecurrenceDraft | undefined;
  if (master.recurrenceProps.length > 0 || overrides.length > 0) {
    recurrence = draft();
    for (const prop of master.recurrenceProps)
      recurrenceLine(prop, masterStart, recurrence, parts);
  }
  for (const props of overrides) {
    const ridProp = props.find((prop) => prop.name === "RECURRENCE-ID");
    const rid =
      ridProp === undefined || param(ridProp, "RANGE") !== undefined
        ? undefined
        : icsPropTime(ridProp);
    const key =
      masterStart !== undefined && typeof rid === "object"
        ? instanceKey(masterStart, rid)
        : undefined;
    if (recurrence === undefined || !key) {
      add(parts, "recurrence", ridProp?.line ?? "RECURRENCE-ID");
      continue;
    }
    const override = icsInstance(props, parts, `override:${key}:`, false);
    if (override.cancelled) recurrence.exdates.add(key);
    else if (override.instance !== undefined)
      recurrence.overrides.set(key, override.instance);
  }
  return finish(uidOf(masterProps), main, recurrence, parts);
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

const icsTimeLine = (name: string, time: BridgeTime): string =>
  time.kind === "date"
    ? `${name};VALUE=DATE:${basicDate(time.value)}`
    : time.kind === "utc"
      ? `${name}:${basicUtc(time.value)}`
      : `${name};TZID=${time.zone}:${basicWall(time.value)}`;

const icsContent = (instance: BridgeInstance): string[] => [
  icsTimeLine("DTSTART", startOf(instance)),
  icsTimeLine("DTEND", endOf(instance)),
  ...(instance.summary === null
    ? []
    : [fold(`SUMMARY:${escapeText(instance.summary)}`)]),
  ...(instance.description === null
    ? []
    : [fold(`DESCRIPTION:${escapeText(instance.description)}`)]),
  ...(instance.location === null
    ? []
    : [fold(`LOCATION:${escapeText(instance.location)}`)]),
];

/**
 * iCalendar body for an envelope with no unsupported fields: the master and
 * one VEVENT per override. Organizer and attendees are never written. Zoned
 * values use `TZID=<IANA name>` without a generated VTIMEZONE (ADR 0042).
 */
export const calDavEventIcs = (
  envelope: BridgeEnvelope,
  uid: string,
  now: string,
): string => {
  const stamp = `DTSTAMP:${basicUtc(now)}`;
  const overrides = envelope.recurrence?.overrides ?? {};
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Tadooer//Calendar bridge v2//EN",
    "BEGIN:VEVENT",
    fold(`UID:${uid}`),
    stamp,
    ...icsContent(envelope),
    ...recurrenceLines(envelope).map(fold),
    "END:VEVENT",
    ...Object.keys(overrides)
      .toSorted()
      .flatMap((key) => {
        const override = overrides[key];
        return override === undefined
          ? []
          : [
              "BEGIN:VEVENT",
              fold(`UID:${uid}`),
              stamp,
              icsTimeLine("RECURRENCE-ID", keyTime(envelope, key)),
              ...icsContent(override),
              "END:VEVENT",
            ];
      }),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
};

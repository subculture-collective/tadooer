import { splitVEventComponents, unfoldIcsLines } from "./ics-lines.ts";

/**
 * Subscription feed parser (issue #91, ADR 0032). Turns a fetched iCalendar
 * document into bounded event occurrences inside a window, reusing the
 * import parser's unfolding and VEVENT splitting.
 *
 * Supported: DATE and DATE-TIME values (UTC, TZID, floating), DTEND or
 * DURATION, STATUS:CANCELLED, EXDATE, RECURRENCE-ID overrides, and RRULE
 * with FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY
 * (weekly lists and monthly ordinals), BYMONTHDAY and BYMONTH. Other BY*
 * parts and sub-daily frequencies are unsupported: the series contributes
 * its first occurrence only and is counted. Unknown TZIDs fall back to the
 * owner's zone. Zero-length timed events are shown as one minute long.
 */

export interface IcalFeedOccurrence {
  readonly uid: string;
  /** Original occurrence key: an ISO instant, or a date for all-day events. */
  readonly occurrenceStart: string;
  readonly summary: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly recurring: boolean;
  readonly url: string | null;
}

export interface IcalFeedParseOptions {
  /** Inclusive window start (ISO instant). */
  readonly from: string;
  /** Exclusive window end (ISO instant). */
  readonly to: string;
  /** Zone for floating times and unknown TZIDs. */
  readonly timeZone: string;
  readonly maxOccurrences?: number;
  readonly maxPerSeries?: number;
}

export interface IcalFeedCounts {
  readonly components: number;
  readonly series: number;
  readonly unsupportedRecurrence: number;
  readonly unknownTimeZones: number;
  readonly invalid: number;
  readonly cancelled: number;
  readonly truncated: number;
}

export type IcalFeedParseResult =
  | {
      readonly ok: true;
      readonly events: readonly IcalFeedOccurrence[];
      readonly counts: IcalFeedCounts;
    }
  | { readonly ok: false; readonly reason: "not_calendar" | "too_large" };

export const icalFeedDefaults = {
  maxOccurrences: 2_000,
  maxPerSeries: 500,
  maxSteps: 5_000,
  summaryMaxLength: 1_024,
  uidMaxLength: 512,
} as const;

interface Property {
  readonly name: string;
  readonly params: ReadonlyMap<string, string>;
  readonly value: string;
}

interface Civil {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  readonly h: number;
  readonly mi: number;
  readonly s: number;
}

type Moment =
  | { readonly kind: "date"; readonly date: string }
  | {
      readonly kind: "instant";
      readonly instant: number;
      readonly local: Civil;
      readonly zone: string;
    };

const dayMs = 24 * 60 * 60 * 1000;

const parseProperty = (line: string): Property | undefined => {
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
  const [name, ...parameterParts] = line.slice(0, separator).split(";");
  const params = new Map<string, string>();
  for (const part of parameterParts) {
    const equals = part.indexOf("=");
    if (equals < 1) continue;
    params.set(
      part.slice(0, equals).toUpperCase(),
      part.slice(equals + 1).replace(/^"|"$/g, ""),
    );
  }
  return {
    name: (name ?? "").toUpperCase(),
    params,
    value: line.slice(separator + 1),
  };
};

const unescapeText = (value: string): string =>
  value
    .replace(/\\[nN]/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");

const formatters = new Map<string, Intl.DateTimeFormat | null>();

const formatterFor = (zone: string): Intl.DateTimeFormat | null => {
  const cached = formatters.get(zone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    formatter = null;
  }
  formatters.set(zone, formatter);
  return formatter;
};

const civilIn = (instant: number, zone: string): Civil => {
  const formatter = formatterFor(zone);
  if (formatter === null) throw new RangeError("Unknown time zone");
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(instant))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  ) as Record<string, number>;
  return {
    y: parts.year ?? 1970,
    m: parts.month ?? 1,
    d: parts.day ?? 1,
    h: (parts.hour ?? 0) % 24,
    mi: parts.minute ?? 0,
    s: parts.second ?? 0,
  };
};

const civilUtc = (civil: Civil): number =>
  Date.UTC(civil.y, civil.m - 1, civil.d, civil.h, civil.mi, civil.s);

/** Resolves a wall-clock time in a zone to an instant (first match in a fold). */
const localToInstant = (civil: Civil, zone: string): number => {
  if (zone === "UTC") return civilUtc(civil);
  const wanted = civilUtc(civil);
  const offsetAt = (instant: number): number =>
    civilUtc(civilIn(instant, zone)) - instant;
  const candidates = [
    ...new Set(
      [-dayMs, 0, dayMs].map((delta) => wanted - offsetAt(wanted + delta)),
    ),
  ]
    .filter((instant) => civilUtc(civilIn(instant, zone)) === wanted)
    .toSorted((left, right) => left - right);
  return candidates[0] ?? wanted - offsetAt(wanted - dayMs / 2);
};

const isoDate = (y: number, m: number, d: number): string =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

const dateFromString = (
  value: string,
): [number, number, number] | undefined => {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const [y, m, d] = match.slice(1).map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
    ? [y, m, d]
    : undefined;
};

const parseMoment = (
  property: Property,
  defaultZone: string,
  unknownZone: () => void,
): Moment | undefined => {
  const value = property.value.trim();
  if (property.params.get("VALUE") === "DATE" || /^\d{8}$/.test(value)) {
    const date = dateFromString(value);
    return date === undefined
      ? undefined
      : { kind: "date", date: isoDate(...date) };
  }
  const match = /^(\d{8})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (match === null) return undefined;
  const date = dateFromString(match[1] ?? "");
  if (date === undefined) return undefined;
  const [h, mi, s] = [match[2], match[3], match[4]].map(Number) as [
    number,
    number,
    number,
  ];
  if (h > 23 || mi > 59 || s > 60) return undefined;
  const [y, m, d] = date;
  const local: Civil = { y, m, d, h, mi, s: Math.min(s, 59) };
  if (match[5] === "Z")
    return { kind: "instant", instant: civilUtc(local), local, zone: "UTC" };
  const tzid = property.params.get("TZID");
  let zone = defaultZone;
  if (tzid !== undefined) {
    if (formatterFor(tzid) === null) unknownZone();
    else zone = tzid;
  }
  if (formatterFor(zone) === null) zone = "UTC";
  return { kind: "instant", instant: localToInstant(local, zone), local, zone };
};

const parseDuration = (value: string): number | undefined => {
  const match =
    /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
      value.trim(),
    );
  if (match === null) return undefined;
  const [sign, w, d, h, mi, s] = match.slice(1);
  const total =
    Number(w ?? 0) * 7 * dayMs +
    Number(d ?? 0) * dayMs +
    Number(h ?? 0) * 3_600_000 +
    Number(mi ?? 0) * 60_000 +
    Number(s ?? 0) * 1_000;
  return sign === "-" ? -total : total;
};

const momentKey = (moment: Moment): string =>
  moment.kind === "date" ? moment.date : new Date(moment.instant).toISOString();

const safeUrl = (value: string): string | null => {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.href.length <= 1024
      ? url.href
      : null;
  } catch {
    return null;
  }
};

// ── Recurrence ─────────────────────────────────────────────────────────────

const weekdays = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
type Weekday = (typeof weekdays)[number];

interface Rule {
  readonly freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  readonly interval: number;
  readonly count: number | undefined;
  readonly until: Moment | undefined;
  readonly byDay: readonly { ordinal: number; day: Weekday }[];
  readonly byMonthDay: readonly number[];
  readonly byMonth: readonly number[];
}

const supportedParts = new Set([
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "BYDAY",
  "BYMONTHDAY",
  "BYMONTH",
  "WKST",
]);

const parseRule = (
  property: Property,
  defaultZone: string,
): Rule | undefined => {
  const parts = new Map<string, string>();
  for (const part of property.value.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 1) return undefined;
    parts.set(part.slice(0, equals).toUpperCase(), part.slice(equals + 1));
  }
  for (const key of parts.keys())
    if (!supportedParts.has(key)) return undefined;
  const freq = parts.get("FREQ");
  if (
    freq !== "DAILY" &&
    freq !== "WEEKLY" &&
    freq !== "MONTHLY" &&
    freq !== "YEARLY"
  )
    return undefined;
  const interval = Number(parts.get("INTERVAL") ?? "1");
  if (!Number.isInteger(interval) || interval < 1 || interval > 366)
    return undefined;
  const countRaw = parts.get("COUNT");
  const count = countRaw === undefined ? undefined : Number(countRaw);
  if (count !== undefined && (!Number.isInteger(count) || count < 1))
    return undefined;
  const untilRaw = parts.get("UNTIL");
  const until =
    untilRaw === undefined
      ? undefined
      : parseMoment(
          { name: "UNTIL", params: new Map(), value: untilRaw },
          defaultZone,
          () => undefined,
        );
  if (untilRaw !== undefined && until === undefined) return undefined;
  const byDay: { ordinal: number; day: Weekday }[] = [];
  for (const item of (parts.get("BYDAY") ?? "").split(",").filter(Boolean)) {
    const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item);
    if (match === null) return undefined;
    const ordinal = Number(match[1] ?? "0");
    if (Math.abs(ordinal) > 5) return undefined;
    byDay.push({ ordinal, day: match[2] as Weekday });
  }
  const byMonthDay = (parts.get("BYMONTHDAY") ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number);
  if (
    byMonthDay.some(
      (day) => !Number.isInteger(day) || day === 0 || Math.abs(day) > 31,
    )
  )
    return undefined;
  const byMonth = (parts.get("BYMONTH") ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number);
  if (
    byMonth.some((month) => !Number.isInteger(month) || month < 1 || month > 12)
  )
    return undefined;
  if (freq === "DAILY" && (byDay.length > 0 || byMonthDay.length > 0))
    return undefined;
  if (
    freq === "WEEKLY" &&
    (byMonthDay.length > 0 || byDay.some(({ ordinal }) => ordinal !== 0))
  )
    return undefined;
  if (freq === "MONTHLY" && byDay.length > 0 && byMonthDay.length > 0)
    return undefined;
  if (freq === "YEARLY" && byDay.length > 0) return undefined;
  return { freq, interval, count, until, byDay, byMonthDay, byMonth };
};

const daysInMonth = (y: number, m: number): number =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();

const weekdayOf = (y: number, m: number, d: number): Weekday =>
  weekdays[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "SU";

/** Dates of one month matched by the rule's BYDAY/BYMONTHDAY, in order. */
const monthDates = (
  rule: Rule,
  y: number,
  m: number,
  startDay: number,
): number[] => {
  const total = daysInMonth(y, m);
  const days = new Set<number>();
  if (rule.byMonthDay.length > 0) {
    for (const day of rule.byMonthDay) {
      const resolved = day > 0 ? day : total + day + 1;
      if (resolved >= 1 && resolved <= total) days.add(resolved);
    }
  } else if (rule.byDay.length > 0) {
    for (const { ordinal, day } of rule.byDay) {
      const matching: number[] = [];
      for (let d = 1; d <= total; d += 1)
        if (weekdayOf(y, m, d) === day) matching.push(d);
      if (ordinal === 0) matching.forEach((d) => days.add(d));
      else {
        const picked =
          ordinal > 0
            ? matching[ordinal - 1]
            : matching[matching.length + ordinal];
        if (picked !== undefined) days.add(picked);
      }
    }
  } else if (startDay <= total) days.add(startDay);
  return [...days].toSorted((left, right) => left - right);
};

/** Civil dates (y, m, d) of a series, in order, bounded by steps and count. */
function* seriesDates(
  rule: Rule,
  start: Civil,
  maxSteps: number,
): Generator<[number, number, number]> {
  let steps = 0;
  const startKey = isoDate(start.y, start.m, start.d);
  const notBeforeStart = (y: number, m: number, d: number): boolean =>
    isoDate(y, m, d) >= startKey;
  if (rule.freq === "DAILY") {
    for (
      let offset = 0;
      steps < maxSteps;
      offset += rule.interval, steps += 1
    ) {
      const date = new Date(Date.UTC(start.y, start.m - 1, start.d + offset));
      yield [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    }
    return;
  }
  if (rule.freq === "WEEKLY") {
    const days = new Set(
      rule.byDay.length > 0
        ? rule.byDay.map(({ day }) => day)
        : [weekdayOf(start.y, start.m, start.d)],
    );
    const startIndex = new Date(
      Date.UTC(start.y, start.m - 1, start.d),
    ).getUTCDay();
    // Weeks start on Monday; offset to the Monday of the start week.
    const mondayOffset = (startIndex + 6) % 7;
    for (let week = 0; steps < maxSteps; week += rule.interval, steps += 1) {
      for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
        const date = new Date(
          Date.UTC(
            start.y,
            start.m - 1,
            start.d - mondayOffset + week * 7 + dayOffset,
          ),
        );
        const [y, m, d] = [
          date.getUTCFullYear(),
          date.getUTCMonth() + 1,
          date.getUTCDate(),
        ];
        if (days.has(weekdayOf(y, m, d)) && notBeforeStart(y, m, d))
          yield [y, m, d];
      }
    }
    return;
  }
  if (rule.freq === "MONTHLY") {
    for (
      let offset = 0;
      steps < maxSteps;
      offset += rule.interval, steps += 1
    ) {
      const y = start.y + Math.floor((start.m - 1 + offset) / 12);
      const m = ((start.m - 1 + offset) % 12) + 1;
      for (const d of monthDates(rule, y, m, start.d))
        if (notBeforeStart(y, m, d)) yield [y, m, d];
    }
    return;
  }
  for (let offset = 0; steps < maxSteps; offset += rule.interval, steps += 1) {
    const y = start.y + offset;
    const months = rule.byMonth.length > 0 ? rule.byMonth : [start.m];
    for (const m of months)
      for (const d of monthDates(rule, y, m, start.d))
        if (notBeforeStart(y, m, d)) yield [y, m, d];
  }
}

// ── Components ─────────────────────────────────────────────────────────────

interface Component {
  readonly uid: string;
  readonly summary: string;
  readonly url: string | null;
  readonly start: Moment;
  readonly durationMs: number;
  readonly cancelled: boolean;
  readonly rule: Rule | undefined;
  readonly ruleUnsupported: boolean;
  readonly exdates: ReadonlySet<string>;
  readonly recurrenceId: Moment | undefined;
}

const readComponent = (
  lines: readonly string[],
  zone: string,
  unknownZone: () => void,
): Component | undefined => {
  const properties: Property[] = [];
  let depth = 0;
  for (const line of lines.slice(1, -1)) {
    if (line.startsWith("BEGIN:")) depth += 1;
    else if (line.startsWith("END:")) depth -= 1;
    else if (depth === 0) {
      const property = parseProperty(line);
      if (property !== undefined) properties.push(property);
    }
  }
  const first = (name: string) => properties.find((p) => p.name === name);
  const uid = first("UID")?.value.trim() ?? "";
  if (uid === "" || uid.length > icalFeedDefaults.uidMaxLength)
    return undefined;
  const dtstart = first("DTSTART");
  if (dtstart === undefined) return undefined;
  const start = parseMoment(dtstart, zone, unknownZone);
  if (start === undefined) return undefined;
  const dtend = first("DTEND");
  const duration = first("DURATION");
  let durationMs: number;
  if (dtend !== undefined) {
    const end = parseMoment(dtend, zone, unknownZone);
    if (end?.kind !== start.kind) return undefined;
    durationMs =
      end.kind === "date" && start.kind === "date"
        ? Date.parse(`${end.date}T00:00:00Z`) -
          Date.parse(`${start.date}T00:00:00Z`)
        : end.kind === "instant" && start.kind === "instant"
          ? end.instant - start.instant
          : 0;
  } else if (duration !== undefined) {
    const parsed = parseDuration(duration.value);
    if (parsed === undefined) return undefined;
    durationMs = parsed;
  } else durationMs = start.kind === "date" ? dayMs : 0;
  if (start.kind === "date") {
    durationMs = Math.max(dayMs, Math.floor(durationMs / dayMs) * dayMs);
  } else if (durationMs < 60_000) durationMs = 60_000;
  const rruleProperty = first("RRULE");
  const rule =
    rruleProperty === undefined ? undefined : parseRule(rruleProperty, zone);
  const exdates = new Set<string>();
  for (const property of properties.filter((p) => p.name === "EXDATE"))
    for (const value of property.value.split(","))
      if (value.trim() !== "") {
        const moment = parseMoment({ ...property, value }, zone, unknownZone);
        if (moment !== undefined) exdates.add(momentKey(moment));
      }
  const recurrenceIdProperty = first("RECURRENCE-ID");
  const recurrenceId =
    recurrenceIdProperty === undefined
      ? undefined
      : parseMoment(recurrenceIdProperty, zone, unknownZone);
  if (recurrenceIdProperty !== undefined && recurrenceId === undefined)
    return undefined;
  return {
    uid,
    summary: unescapeText(first("SUMMARY")?.value ?? "").slice(
      0,
      icalFeedDefaults.summaryMaxLength,
    ),
    url: safeUrl(first("URL")?.value ?? ""),
    start,
    durationMs,
    cancelled:
      (first("STATUS")?.value.trim().toUpperCase() ?? "") === "CANCELLED",
    rule,
    ruleUnsupported: rruleProperty !== undefined && rule === undefined,
    exdates,
    recurrenceId,
  };
};

const occurrenceFrom = (
  component: Component,
  start: Moment,
  occurrenceStart: string,
  recurring: boolean,
): IcalFeedOccurrence => {
  const startsAtMs =
    start.kind === "date"
      ? Date.parse(`${start.date}T00:00:00Z`)
      : start.instant;
  return {
    uid: component.uid,
    occurrenceStart,
    summary: component.summary,
    startsAt: new Date(startsAtMs).toISOString(),
    endsAt: new Date(startsAtMs + component.durationMs).toISOString(),
    allDay: start.kind === "date",
    recurring,
    url: component.url,
  };
};

/** Shifts a series start to another civil date, keeping its wall-clock time. */
const momentAt = (start: Moment, y: number, m: number, d: number): Moment =>
  start.kind === "date"
    ? { kind: "date", date: isoDate(y, m, d) }
    : {
        kind: "instant",
        instant: localToInstant({ ...start.local, y, m, d }, start.zone),
        local: { ...start.local, y, m, d },
        zone: start.zone,
      };

export const parseIcalFeed = (
  raw: string,
  options: IcalFeedParseOptions,
): IcalFeedParseResult => {
  const lines = unfoldIcsLines(raw);
  if (lines === undefined) return { ok: false, reason: "too_large" };
  if (!lines.includes("BEGIN:VCALENDAR"))
    return { ok: false, reason: "not_calendar" };
  const zone =
    formatterFor(options.timeZone) === null ? "UTC" : options.timeZone;
  const from = Date.parse(options.from);
  const to = Date.parse(options.to);
  const maxOccurrences =
    options.maxOccurrences ?? icalFeedDefaults.maxOccurrences;
  const maxPerSeries = options.maxPerSeries ?? icalFeedDefaults.maxPerSeries;
  const counts = {
    components: 0,
    series: 0,
    unsupportedRecurrence: 0,
    unknownTimeZones: 0,
    invalid: 0,
    cancelled: 0,
    truncated: 0,
  };
  const { components } = splitVEventComponents(lines);
  const masters: Component[] = [];
  const overrides = new Map<string, Map<string, Component>>();
  for (const componentLines of components) {
    counts.components += 1;
    const component = readComponent(componentLines, zone, () => {
      counts.unknownTimeZones += 1;
    });
    if (component === undefined) {
      counts.invalid += 1;
      continue;
    }
    if (component.recurrenceId !== undefined) {
      const byUid =
        overrides.get(component.uid) ?? new Map<string, Component>();
      byUid.set(momentKey(component.recurrenceId), component);
      overrides.set(component.uid, byUid);
    } else masters.push(component);
  }
  const events: IcalFeedOccurrence[] = [];
  const inWindow = (occurrence: IcalFeedOccurrence): boolean =>
    Date.parse(occurrence.endsAt) > from &&
    Date.parse(occurrence.startsAt) < to;
  const push = (occurrence: IcalFeedOccurrence): void => {
    if (!inWindow(occurrence)) return;
    if (events.length >= maxOccurrences) {
      counts.truncated += 1;
      return;
    }
    events.push(occurrence);
  };
  const emitted = new Set<string>();
  const mark = (uid: string, key: string): string => {
    const identity = `${uid}\u0000${key}`;
    emitted.add(identity);
    return identity;
  };
  for (const component of masters) {
    const uidOverrides = overrides.get(component.uid);
    const emit = (start: Moment, recurring: boolean): void => {
      const key = momentKey(start);
      const override = uidOverrides?.get(key);
      mark(component.uid, key);
      if (override !== undefined) {
        if (override.cancelled) counts.cancelled += 1;
        else push(occurrenceFrom(override, override.start, key, true));
        return;
      }
      if (component.exdates.has(key)) return;
      if (component.cancelled) {
        counts.cancelled += 1;
        return;
      }
      push(occurrenceFrom(component, start, key, recurring));
    };
    if (component.ruleUnsupported) counts.unsupportedRecurrence += 1;
    const rule = component.rule;
    if (rule === undefined) {
      emit(component.start, false);
      continue;
    }
    counts.series += 1;
    const startCivil: Civil =
      component.start.kind === "date"
        ? {
            ...(() => {
              const [y, m, d] = component.start.date.split("-").map(Number) as [
                number,
                number,
                number,
              ];
              return { y, m, d };
            })(),
            h: 0,
            mi: 0,
            s: 0,
          }
        : component.start.local;
    let produced = 0;
    let inWindowCount = 0;
    for (const [y, m, d] of seriesDates(
      rule,
      startCivil,
      icalFeedDefaults.maxSteps,
    )) {
      const start = momentAt(component.start, y, m, d);
      const startMs =
        start.kind === "date"
          ? Date.parse(`${start.date}T00:00:00Z`)
          : start.instant;
      if (rule.until !== undefined) {
        const untilMs =
          rule.until.kind === "date"
            ? Date.parse(`${rule.until.date}T00:00:00Z`) + dayMs - 1
            : rule.until.instant;
        if (startMs > untilMs) break;
      }
      produced += 1;
      if (rule.count !== undefined && produced > rule.count) break;
      if (startMs >= to) break;
      if (startMs + component.durationMs > from) {
        inWindowCount += 1;
        if (inWindowCount > maxPerSeries) {
          counts.truncated += 1;
          break;
        }
      }
      emit(start, true);
    }
  }
  // Overrides whose series never produced their occurrence (or has no master)
  // still describe a real event.
  for (const [uid, byUid] of overrides)
    for (const [key, override] of byUid) {
      if (emitted.has(`${uid}\u0000${key}`)) continue;
      mark(uid, key);
      if (override.cancelled) counts.cancelled += 1;
      else push(occurrenceFrom(override, override.start, key, true));
    }
  events.sort(
    (left, right) =>
      left.startsAt.localeCompare(right.startsAt) ||
      left.uid.localeCompare(right.uid) ||
      left.occurrenceStart.localeCompare(right.occurrenceStart),
  );
  return { ok: true, events, counts };
};

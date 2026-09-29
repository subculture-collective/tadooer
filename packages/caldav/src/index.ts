import {
  DOMParser,
  type Document as XmlDocument,
  type Element as XmlElement,
} from "@xmldom/xmldom";

export interface CalendarCollectionIdentity {
  readonly href: string;
}

export interface CalendarCollectionSummary extends CalendarCollectionIdentity {
  readonly displayName: string;
  readonly color: string | null;
  readonly supportsEvents: boolean;
  readonly supportsTodos: boolean;
}

export interface CalendarDiscoveryPort {
  discoverCollections(): Promise<readonly CalendarCollectionSummary[]>;
}

const davNamespace = "DAV:";
const caldavNamespace = "urn:ietf:params:xml:ns:caldav";
const maxXmlBytes = 2 * 1024 * 1024;

const principalRequest = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>`;

const calendarHomeRequest = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-home-set/></D:prop></D:propfind>`;

const collectionRequest = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:resourcetype/><D:displayname/><C:supported-calendar-component-set/></D:prop></D:propfind>`;

export type CalDavDiscoveryFailure =
  | "authentication-required"
  | "authorization-denied"
  | "not-found"
  | "remote-unavailable"
  | "invalid-protocol"
  | "unsafe-remote-url"
  | "redirected"
  | "caldav-unsupported"
  | "transport-failed";

export type CalDavDiscoveryResult =
  | {
      readonly ok: true;
      readonly principalUrl: URL;
      readonly calendarHomeUrl: URL;
      readonly collections: readonly CalendarCollectionSummary[];
    }
  | { readonly ok: false; readonly reason: CalDavDiscoveryFailure };

export interface CalDavDiscoveryOptions {
  readonly endpoint: URL;
  readonly username: string;
  readonly password: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

const safeUrl = (url: URL, origin: string): boolean =>
  (url.protocol === "http:" || url.protocol === "https:") &&
  url.origin === origin &&
  url.username === "" &&
  url.password === "" &&
  url.search === "" &&
  url.hash === "";

const resolveSafeUrl = (href: string, base: URL): URL | undefined => {
  try {
    const resolved = new URL(href, base);
    return safeUrl(resolved, base.origin) ? resolved : undefined;
  } catch {
    return undefined;
  }
};

const readBoundedText = async (
  response: Response,
): Promise<string | undefined> => {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxXmlBytes) return undefined;
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > maxXmlBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
};

const parseMultiStatus = (body: string): XmlDocument | undefined => {
  if (/<!DOCTYPE|<!ENTITY/i.test(body)) return undefined;
  const errors: string[] = [];
  let document: XmlDocument;
  try {
    document = new DOMParser({
      onError: (_level, message) => errors.push(message),
    }).parseFromString(body, "application/xml");
  } catch {
    return undefined;
  }
  const root = document.documentElement;
  return errors.length === 0 &&
    root?.namespaceURI === davNamespace &&
    root.localName === "multistatus"
    ? document
    : undefined;
};

const propfind = async (
  fetcher: typeof fetch,
  url: URL,
  authorization: string,
  depth: "0" | "1",
  body: string,
  signal: AbortSignal | undefined,
): Promise<XmlDocument | CalDavDiscoveryFailure> => {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "PROPFIND",
      redirect: "manual",
      headers: {
        Authorization: authorization,
        Depth: depth,
        "Content-Type": "application/xml; charset=utf-8",
      },
      body,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return "transport-failed";
  }
  if (response.url !== "" && response.url !== url.href)
    return "unsafe-remote-url";
  if (response.status >= 300 && response.status <= 399) return "redirected";
  if (response.status === 401) return "authentication-required";
  if (response.status === 403) return "authorization-denied";
  if (response.status === 404) return "not-found";
  if (response.status >= 500) return "remote-unavailable";
  if (response.status !== 207) return "invalid-protocol";
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("xml")) return "invalid-protocol";
  try {
    const text = await readBoundedText(response);
    return text === undefined
      ? "invalid-protocol"
      : (parseMultiStatus(text) ?? "invalid-protocol");
  } catch {
    return "invalid-protocol";
  }
};

const successfulProps = (
  parent: XmlDocument | XmlElement,
): readonly XmlElement[] => {
  const props: XmlElement[] = [];
  const propstats = parent.getElementsByTagNameNS(davNamespace, "propstat");
  for (let index = 0; index < propstats.length; index += 1) {
    const propstat = propstats.item(index);
    const status = propstat
      ?.getElementsByTagNameNS(davNamespace, "status")
      .item(0);
    const prop = propstat?.getElementsByTagNameNS(davNamespace, "prop").item(0);
    if (
      status?.textContent?.includes(" 200 ") === true &&
      prop !== null &&
      prop !== undefined
    ) {
      props.push(prop);
    }
  }
  return props;
};

const propertyHrefs = (
  document: XmlDocument,
  namespace: string,
  propertyName: string,
): readonly string[] => {
  const hrefs: string[] = [];
  for (const prop of successfulProps(document)) {
    const properties = prop.getElementsByTagNameNS(namespace, propertyName);
    for (let index = 0; index < properties.length; index += 1) {
      const href = properties
        .item(index)
        ?.getElementsByTagNameNS(davNamespace, "href")
        .item(0)?.textContent;
      if (href !== null && href !== undefined && href.trim() !== "")
        hrefs.push(href.trim());
    }
  }
  return hrefs;
};

const collections = (
  document: XmlDocument,
  homeUrl: URL,
): readonly CalendarCollectionSummary[] | undefined => {
  const result: CalendarCollectionSummary[] = [];
  const responses = document.getElementsByTagNameNS(davNamespace, "response");
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses.item(index);
    const href = response
      ?.getElementsByTagNameNS(davNamespace, "href")
      .item(0)
      ?.textContent?.trim();
    if (response === null || href === undefined || href === "") continue;
    const url = resolveSafeUrl(href, homeUrl);
    if (url === undefined) return undefined;
    for (const prop of successfulProps(response)) {
      const resourceType = prop
        .getElementsByTagNameNS(davNamespace, "resourcetype")
        .item(0);
      if (
        resourceType?.getElementsByTagNameNS(caldavNamespace, "calendar")
          .length !== 1
      )
        continue;
      const reportedName = prop
        .getElementsByTagNameNS(davNamespace, "displayname")
        .item(0)
        ?.textContent?.trim();
      const pathName = href.replace(/\/$/, "").split("/").at(-1);
      const displayName =
        reportedName !== undefined && reportedName !== ""
          ? reportedName
          : (pathName ?? "Calendar");
      const componentSet = prop
        .getElementsByTagNameNS(
          caldavNamespace,
          "supported-calendar-component-set",
        )
        .item(0);
      const components = new Set<string>();
      if (componentSet !== null) {
        const nodes = componentSet.getElementsByTagNameNS(
          caldavNamespace,
          "comp",
        );
        for (
          let componentIndex = 0;
          componentIndex < nodes.length;
          componentIndex += 1
        ) {
          const name = nodes
            .item(componentIndex)
            ?.getAttribute("name")
            ?.toUpperCase();
          if (name !== undefined) components.add(name);
        }
      }
      result.push({
        href,
        displayName,
        color: null,
        supportsEvents: components.has("VEVENT"),
        supportsTodos: components.has("VTODO"),
      });
    }
  }
  return result;
};

export const discoverCalDavCalendars = async (
  options: CalDavDiscoveryOptions,
): Promise<CalDavDiscoveryResult> => {
  if (!safeUrl(options.endpoint, options.endpoint.origin)) {
    return { ok: false, reason: "unsafe-remote-url" };
  }
  const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`, "utf8").toString("base64")}`;
  const fetcher = options.fetch ?? fetch;
  const principalDocument = await propfind(
    fetcher,
    options.endpoint,
    authorization,
    "0",
    principalRequest,
    options.signal,
  );
  if (typeof principalDocument === "string")
    return { ok: false, reason: principalDocument };
  const principalHrefs = propertyHrefs(
    principalDocument,
    davNamespace,
    "current-user-principal",
  );
  if (principalHrefs.length !== 1)
    return { ok: false, reason: "invalid-protocol" };
  const principalUrl = resolveSafeUrl(
    principalHrefs[0] ?? "",
    options.endpoint,
  );
  if (principalUrl === undefined)
    return { ok: false, reason: "unsafe-remote-url" };

  const homeDocument = await propfind(
    fetcher,
    principalUrl,
    authorization,
    "0",
    calendarHomeRequest,
    options.signal,
  );
  if (typeof homeDocument === "string")
    return { ok: false, reason: homeDocument };
  const homeHrefs = propertyHrefs(
    homeDocument,
    caldavNamespace,
    "calendar-home-set",
  );
  if (homeHrefs.length !== 1) return { ok: false, reason: "invalid-protocol" };
  const calendarHomeUrl = resolveSafeUrl(homeHrefs[0] ?? "", principalUrl);
  if (calendarHomeUrl === undefined)
    return { ok: false, reason: "unsafe-remote-url" };

  const collectionDocument = await propfind(
    fetcher,
    calendarHomeUrl,
    authorization,
    "1",
    collectionRequest,
    options.signal,
  );
  if (typeof collectionDocument === "string")
    return { ok: false, reason: collectionDocument };
  const discovered = collections(collectionDocument, calendarHomeUrl);
  return discovered === undefined
    ? { ok: false, reason: "unsafe-remote-url" }
    : { ok: true, principalUrl, calendarHomeUrl, collections: discovered };
};

const privilegeRequest = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-privilege-set/></D:prop></D:propfind>`;

const maxProbedCalendars = 50;

export interface CalDavCalendarPermissions extends CalendarCollectionSummary {
  /** Privilege local names from RFC 3744 current-user-privilege-set, or null when not reported. */
  readonly privileges: readonly string[] | null;
  readonly canRead: boolean | null;
  readonly canWrite: boolean | null;
}

export type CalDavProbeResult =
  | {
      readonly ok: true;
      readonly davClasses: readonly string[];
      readonly principalUrl: URL;
      readonly calendarHomeUrl: URL;
      readonly calendars: readonly CalDavCalendarPermissions[];
    }
  | { readonly ok: false; readonly reason: CalDavDiscoveryFailure };

/**
 * Reduces RFC 3744 privileges to the access the Suite needs. Writing task
 * blocks creates, replaces and deletes resources, so it needs bind,
 * write-content and unbind (each implied by write or all).
 */
export const summarizeCalDavPrivileges = (
  privileges: readonly string[],
): { readonly canRead: boolean; readonly canWrite: boolean } => {
  const granted = new Set(privileges);
  const all = granted.has("all");
  const write = all || granted.has("write");
  return {
    canRead: all || granted.has("read"),
    canWrite:
      write ||
      (granted.has("write-content") &&
        granted.has("bind") &&
        granted.has("unbind")),
  };
};

const davClasses = (header: string | null): readonly string[] =>
  (header ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

const optionsCapabilities = async (
  fetcher: typeof fetch,
  url: URL,
  authorization: string,
  signal: AbortSignal | undefined,
): Promise<readonly string[] | CalDavDiscoveryFailure> => {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "OPTIONS",
      redirect: "manual",
      headers: { Authorization: authorization },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return "transport-failed";
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.url !== "" && response.url !== url.href)
    return "unsafe-remote-url";
  if (response.status >= 300 && response.status <= 399) return "redirected";
  if (response.status === 401) return "authentication-required";
  if (response.status === 403) return "authorization-denied";
  if (response.status === 404) return "not-found";
  if (response.status >= 500) return "remote-unavailable";
  if (response.status < 200 || response.status > 299) return "invalid-protocol";
  const classes = davClasses(response.headers.get("dav"));
  return classes.some((item) => item.toLowerCase() === "calendar-access")
    ? classes
    : "caldav-unsupported";
};

const calendarPrivileges = async (
  fetcher: typeof fetch,
  url: URL,
  authorization: string,
  signal: AbortSignal | undefined,
): Promise<readonly string[] | null | CalDavDiscoveryFailure> => {
  const document = await propfind(
    fetcher,
    url,
    authorization,
    "0",
    privilegeRequest,
    signal,
  );
  if (typeof document === "string") return document;
  let reported = false;
  const privileges = new Set<string>();
  for (const prop of successfulProps(document)) {
    const sets = prop.getElementsByTagNameNS(
      davNamespace,
      "current-user-privilege-set",
    );
    for (let index = 0; index < sets.length; index += 1) {
      reported = true;
      const nodes = sets
        .item(index)
        ?.getElementsByTagNameNS(davNamespace, "privilege");
      for (let item = 0; item < (nodes?.length ?? 0); item += 1) {
        const children = nodes?.item(item)?.childNodes;
        for (let child = 0; child < (children?.length ?? 0); child += 1) {
          const node = children?.item(child);
          if (node?.nodeType !== 1) continue;
          const name = (node as XmlElement).localName;
          if (name !== null && name !== "") privileges.add(name);
        }
      }
    }
  }
  return reported ? [...privileges].sort() : null;
};

/**
 * Read-only setup probe for a configured CalDAV endpoint: capability
 * advertisement, calendar discovery and per-calendar privileges. It writes
 * nothing and follows no redirect or cross-origin href.
 */
export const probeCalDavEndpoint = async (
  options: CalDavDiscoveryOptions,
): Promise<CalDavProbeResult> => {
  if (!safeUrl(options.endpoint, options.endpoint.origin)) {
    return { ok: false, reason: "unsafe-remote-url" };
  }
  const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`, "utf8").toString("base64")}`;
  const fetcher = options.fetch ?? fetch;
  const classes = await optionsCapabilities(
    fetcher,
    options.endpoint,
    authorization,
    options.signal,
  );
  if (typeof classes === "string") return { ok: false, reason: classes };
  const discovery = await discoverCalDavCalendars(options);
  if (!discovery.ok) return discovery;
  const calendars: CalDavCalendarPermissions[] = [];
  for (const collection of discovery.collections.slice(0, maxProbedCalendars)) {
    const url = resolveSafeUrl(collection.href, discovery.calendarHomeUrl);
    if (url === undefined) return { ok: false, reason: "unsafe-remote-url" };
    const privileges = await calendarPrivileges(
      fetcher,
      url,
      authorization,
      options.signal,
    );
    if (privileges === "authorization-denied" || privileges === "not-found") {
      calendars.push({
        ...collection,
        privileges: [],
        canRead: false,
        canWrite: false,
      });
      continue;
    }
    if (typeof privileges === "string")
      return { ok: false, reason: privileges };
    calendars.push({
      ...collection,
      privileges,
      ...(privileges === null
        ? { canRead: null, canWrite: null }
        : summarizeCalDavPrivileges(privileges)),
    });
  }
  return {
    ok: true,
    davClasses: classes,
    principalUrl: discovery.principalUrl,
    calendarHomeUrl: discovery.calendarHomeUrl,
    calendars,
  };
};

/** A deliberately small, lossless Phase 1 VEVENT projection. */
export interface ProjectedCalendarEvent {
  readonly uid: string;
  readonly summary: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
}

export interface CalendarEventResource {
  readonly href: string;
  readonly etag: string;
  readonly rawIcs: string;
  readonly event: ProjectedCalendarEvent;
}

export type CalDavEventFailure =
  CalDavDiscoveryFailure | "precondition-failed" | "outcome-unknown";

export type CalDavEventResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: CalDavEventFailure };

export interface CalDavEventReadOptions {
  readonly collectionUrl: URL;
  readonly username: string;
  readonly password: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

export interface CalDavEventWriteOptions {
  readonly collectionUrl: URL;
  readonly username: string;
  readonly password: string;
  readonly href: string;
  readonly rawIcs: string;
  readonly expectedEtag?: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

export type CalDavEventDeleteOptions = Omit<CalDavEventWriteOptions, "rawIcs">;

const maxEventMembers = 1_000;
const maxIcsBytes = 2 * 1024 * 1024;
const strongEtag = /^"[^"\r\n]+"$/;

const authorizationFor = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;

const directMemberUrl = (href: string, collectionUrl: URL): URL | undefined => {
  const url = resolveSafeUrl(href, collectionUrl);
  if (url === undefined) return undefined;
  const root = collectionUrl.pathname.endsWith("/")
    ? collectionUrl.pathname
    : `${collectionUrl.pathname}/`;
  const child = url.pathname.slice(root.length);
  if (
    !url.pathname.startsWith(root) ||
    child === "" ||
    child.includes("/") ||
    !child.endsWith(".ics")
  )
    return undefined;
  try {
    const decoded = decodeURIComponent(child);
    return decoded.includes("/") || decoded.includes("\\") || decoded === ".ics"
      ? undefined
      : url;
  } catch {
    return undefined;
  }
};

const validInstant = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

const calendarQuery = (startsAt: string, endsAt: string): string => {
  const compact = (value: string): string =>
    value.replace(".000Z", "Z").replace(/[-:]/g, "");
  return `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="${compact(startsAt)}" end="${compact(endsAt)}"/></C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`;
};

const responseFailure = (
  response: Response,
): CalDavEventFailure | undefined => {
  if (response.status === 401) return "authentication-required";
  if (response.status === 403) return "authorization-denied";
  if (response.status === 404) return "not-found";
  if (response.status === 412) return "precondition-failed";
  if (response.status >= 500) return "remote-unavailable";
  return undefined;
};

const eventMembers = (
  document: XmlDocument,
  collectionUrl: URL,
): readonly { href: string; etag: string }[] | undefined => {
  const result: { href: string; etag: string }[] = [];
  const responses = document.getElementsByTagNameNS(davNamespace, "response");
  if (responses.length > maxEventMembers) return undefined;
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses.item(index);
    const href = response
      ?.getElementsByTagNameNS(davNamespace, "href")
      .item(0)
      ?.textContent?.trim();
    if (
      response === null ||
      href === undefined ||
      directMemberUrl(href, collectionUrl) === undefined
    )
      return undefined;
    let etag: string | undefined;
    for (const prop of successfulProps(response)) {
      const candidate = prop
        .getElementsByTagNameNS(davNamespace, "getetag")
        .item(0)
        ?.textContent?.trim();
      if (candidate !== undefined && strongEtag.test(candidate))
        etag = candidate;
    }
    if (etag === undefined || result.some((member) => member.href === href))
      return undefined;
    result.push({ href, etag });
  }
  return result;
};

const unfoldedLines = (rawIcs: string): readonly string[] | undefined => {
  if (rawIcs.includes("\0") || rawIcs.length === 0) return undefined;
  const lines = rawIcs.replace(/\r\n/g, "\n").split("\n");
  const unfolded: string[] = [];
  for (const line of lines) {
    if (
      (line.startsWith(" ") || line.startsWith("\t")) &&
      unfolded.length > 0
    ) {
      const index = unfolded.length - 1;
      unfolded[index] = `${unfolded[index] ?? ""}${line.slice(1)}`;
    } else if (line !== "") unfolded.push(line);
  }
  return unfolded;
};

const unescapeIcsText = (value: string): string =>
  value
    .replace(/\\[nN]/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");

const parseUtc = (value: string): string | undefined => {
  if (!/^\d{8}T\d{6}Z$/.test(value)) return undefined;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : undefined;
};

const parseDate = (value: string): string | undefined =>
  /^\d{8}$/.test(value) &&
  Number.isFinite(
    Date.parse(
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}T00:00:00Z`,
    ),
  )
    ? value
    : undefined;

/** Rejects recurrence, floating/local time, and multi-VEVENT resources. */
export const parseBoundedVEvent = (
  rawIcs: string,
): ProjectedCalendarEvent | undefined => {
  const lines = unfoldedLines(rawIcs);
  if (lines?.[0] !== "BEGIN:VCALENDAR" || !lines.includes("END:VCALENDAR"))
    return undefined;
  const begins = lines.filter((line) => line === "BEGIN:VEVENT").length;
  if (
    begins !== 1 ||
    lines.filter((line) => line === "END:VEVENT").length !== 1
  )
    return undefined;
  const start = lines.indexOf("BEGIN:VEVENT");
  const end = lines.indexOf("END:VEVENT");
  if (start < 0 || end <= start) return undefined;
  const fields = new Map<string, { params: string; value: string }>();
  for (const line of lines.slice(start + 1, end)) {
    const separator = line.indexOf(":");
    if (separator < 1) return undefined;
    const [name, ...parameterParts] = line.slice(0, separator).split(";");
    const upper = name?.toUpperCase();
    if (upper === undefined || fields.has(upper)) return undefined;
    fields.set(upper, {
      params: parameterParts.join(";").toUpperCase(),
      value: line.slice(separator + 1),
    });
  }
  if (
    ["RRULE", "RDATE", "EXDATE", "RECURRENCE-ID"].some((name) =>
      fields.has(name),
    )
  )
    return undefined;
  const uid = fields.get("UID")?.value;
  const summary = fields.get("SUMMARY")?.value ?? "";
  const dtstart = fields.get("DTSTART");
  const dtend = fields.get("DTEND");
  if (!uid || !dtstart || !dtend || uid.length > 1024 || summary.length > 4_096)
    return undefined;
  const allDay =
    (dtstart.params === "VALUE=DATE" || dtstart.params === "") &&
    (dtend.params === "VALUE=DATE" || dtend.params === "") &&
    /^\d{8}$/.test(dtstart.value) &&
    /^\d{8}$/.test(dtend.value);
  if (allDay) {
    const startsAt = parseDate(dtstart.value);
    const endsAt = parseDate(dtend.value);
    return startsAt && endsAt && endsAt > startsAt
      ? {
          uid,
          summary: unescapeIcsText(summary),
          startsAt,
          endsAt,
          allDay: true,
        }
      : undefined;
  }
  if (dtstart.params !== "" || dtend.params !== "") return undefined;
  const startsAt = parseUtc(dtstart.value);
  const endsAt = parseUtc(dtend.value);
  return startsAt && endsAt && Date.parse(endsAt) > Date.parse(startsAt)
    ? {
        uid,
        summary: unescapeIcsText(summary),
        startsAt,
        endsAt,
        allDay: false,
      }
    : undefined;
};

export const serializeBoundedVEvent = (
  input: ProjectedCalendarEvent,
): string | undefined => {
  if (!input.uid || input.uid.length > 1024 || input.summary.length > 4_096)
    return undefined;
  const escape = (value: string): string =>
    value
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,");
  if (input.allDay) {
    if (
      !/^\d{8}$/.test(input.startsAt) ||
      !/^\d{8}$/.test(input.endsAt) ||
      input.endsAt <= input.startsAt
    )
      return undefined;
    return [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `UID:${input.uid}`,
      `DTSTART;VALUE=DATE:${input.startsAt}`,
      `DTEND;VALUE=DATE:${input.endsAt}`,
      `SUMMARY:${escape(input.summary)}`,
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
  }
  if (
    !validInstant(input.startsAt) ||
    !validInstant(input.endsAt) ||
    Date.parse(input.endsAt) <= Date.parse(input.startsAt)
  )
    return undefined;
  const compact = (value: string): string =>
    value.replace(".000Z", "Z").replace(/[-:]/g, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `DTSTART:${compact(input.startsAt)}`,
    `DTEND:${compact(input.endsAt)}`,
    `SUMMARY:${escape(input.summary)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
};

const getCalendarResource = async (
  fetcher: typeof fetch,
  url: URL,
  authorization: string,
  expectedEtag: string,
  signal: AbortSignal | undefined,
): Promise<CalDavEventResult<CalendarEventResource>> => {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      redirect: "manual",
      headers: { Authorization: authorization, Accept: "text/calendar" },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return { ok: false, reason: "outcome-unknown" };
  }
  if (response.url !== "" && response.url !== url.href)
    return { ok: false, reason: "unsafe-remote-url" };
  const failure = responseFailure(response);
  if (failure !== undefined) return { ok: false, reason: failure };
  if (
    response.status !== 200 ||
    response.headers.get("etag") !== expectedEtag ||
    !strongEtag.test(expectedEtag)
  )
    return { ok: false, reason: "invalid-protocol" };
  try {
    const rawIcs = await readBoundedText(response);
    const event = rawIcs === undefined ? undefined : parseBoundedVEvent(rawIcs);
    return rawIcs !== undefined && event !== undefined
      ? {
          ok: true,
          value: { href: url.pathname, etag: expectedEtag, rawIcs, event },
        }
      : { ok: false, reason: "invalid-protocol" };
  } catch {
    return { ok: false, reason: "invalid-protocol" };
  }
};

export const readBoundedCalDavEvents = async (
  options: CalDavEventReadOptions,
): Promise<CalDavEventResult<readonly CalendarEventResource[]>> => {
  if (
    !safeUrl(options.collectionUrl, options.collectionUrl.origin) ||
    !validInstant(options.startsAt) ||
    !validInstant(options.endsAt) ||
    Date.parse(options.endsAt) <= Date.parse(options.startsAt) ||
    Date.parse(options.endsAt) - Date.parse(options.startsAt) > 366 * 86_400_000
  )
    return { ok: false, reason: "invalid-protocol" };
  const fetcher = options.fetch ?? fetch;
  const authorization = authorizationFor(options.username, options.password);
  let response: Response;
  try {
    response = await fetcher(options.collectionUrl, {
      method: "REPORT",
      redirect: "manual",
      headers: {
        Authorization: authorization,
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: calendarQuery(options.startsAt, options.endsAt),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return { ok: false, reason: "transport-failed" };
  }
  if (response.url !== "" && response.url !== options.collectionUrl.href)
    return { ok: false, reason: "unsafe-remote-url" };
  const failure = responseFailure(response);
  if (failure !== undefined) return { ok: false, reason: failure };
  if (
    response.status !== 207 ||
    !response.headers.get("content-type")?.toLowerCase().includes("xml")
  )
    return { ok: false, reason: "invalid-protocol" };
  let document: XmlDocument | undefined;
  try {
    const text = await readBoundedText(response);
    document = text === undefined ? undefined : parseMultiStatus(text);
  } catch {
    document = undefined;
  }
  const members =
    document === undefined
      ? undefined
      : eventMembers(document, options.collectionUrl);
  if (members === undefined) return { ok: false, reason: "invalid-protocol" };
  const resources: CalendarEventResource[] = [];
  for (const member of members) {
    const url = directMemberUrl(member.href, options.collectionUrl);
    if (url === undefined) return { ok: false, reason: "unsafe-remote-url" };
    const resource = await getCalendarResource(
      fetcher,
      url,
      authorization,
      member.etag,
      options.signal,
    );
    if (!resource.ok) return resource;
    resources.push({ ...resource.value, href: member.href });
  }
  return { ok: true, value: resources };
};

const writeCalendarResource = async (
  method: "PUT" | "DELETE",
  options: CalDavEventWriteOptions | CalDavEventDeleteOptions,
): Promise<CalDavEventResult<void>> => {
  const url = directMemberUrl(options.href, options.collectionUrl);
  if (
    url === undefined ||
    !safeUrl(options.collectionUrl, options.collectionUrl.origin)
  )
    return { ok: false, reason: "unsafe-remote-url" };
  if (
    "rawIcs" in options &&
    Buffer.byteLength(options.rawIcs, "utf8") > maxIcsBytes
  )
    return { ok: false, reason: "invalid-protocol" };
  const headers = new Headers({
    Authorization: authorizationFor(options.username, options.password),
  });
  if (method === "PUT")
    headers.set("Content-Type", "text/calendar; charset=utf-8");
  if (options.expectedEtag === undefined) headers.set("If-None-Match", "*");
  else if (strongEtag.test(options.expectedEtag))
    headers.set("If-Match", options.expectedEtag);
  else return { ok: false, reason: "invalid-protocol" };
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method,
      redirect: "manual",
      headers,
      ...("rawIcs" in options ? { body: options.rawIcs } : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return { ok: false, reason: "outcome-unknown" };
  }
  if (response.url !== "" && response.url !== url.href)
    return { ok: false, reason: "unsafe-remote-url" };
  const failure = responseFailure(response);
  if (failure !== undefined) return { ok: false, reason: failure };
  return response.status === 200 ||
    response.status === 201 ||
    response.status === 204
    ? { ok: true, value: undefined }
    : { ok: false, reason: "invalid-protocol" };
};

export const createCalDavEvent = (
  options: CalDavEventWriteOptions,
): Promise<CalDavEventResult<void>> => writeCalendarResource("PUT", options);
export const replaceCalDavEvent = (
  options: CalDavEventWriteOptions,
): Promise<CalDavEventResult<void>> =>
  options.expectedEtag === undefined
    ? Promise.resolve({ ok: false, reason: "invalid-protocol" })
    : writeCalendarResource("PUT", options);
export const deleteCalDavEvent = (
  options: CalDavEventDeleteOptions,
): Promise<CalDavEventResult<void>> =>
  options.expectedEtag === undefined
    ? Promise.resolve({ ok: false, reason: "invalid-protocol" })
    : writeCalendarResource("DELETE", options);

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

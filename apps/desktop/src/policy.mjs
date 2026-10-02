import { URL } from "node:url";

/**
 * Authority rules of the desktop shell (ADR 0015, ADR 0047). Every function
 * here is pure: no Electron, no I/O. The main process and the tests use the
 * same code.
 */

export const suiteServiceName = "productivity-suite";
export const deepLinkScheme = "tadooer";

const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];

/**
 * True for an IP literal in a private range. Host names are never treated as
 * private: the shell cannot tell where a name resolves, so plaintext HTTP to
 * a name stays refused.
 *
 * IPv4: 10/8, 172.16/12, 192.168/16 and 100.64/10 (carrier-grade NAT space,
 * which is where Tailscale addresses live). IPv6: unique local fc00::/7.
 * `URL.hostname` is already canonical, so `0x0a.1` arrives here as 10.0.0.1.
 */
export const privateLanHost = (hostname) => {
  if (typeof hostname !== "string") return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (v4 !== null) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((part) => part > 255)) return false;
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return /^\[f[cd][0-9a-f]{2}:[0-9a-f:]*\]$/i.test(hostname);
};

/**
 * Turns what the owner typed into something `URL` can parse. A bare host
 * (`suite.example.org`) means HTTPS; nothing is ever upgraded to HTTP.
 */
export const normalizeServerInput = (raw) => {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
};

/**
 * Classifies a server address.
 *
 * Returns `{ ok: true, origin, transport }` where transport is `https`,
 * `loopback-http` or `private-lan-http`, or `{ ok: false, reason }` where
 * reason is one of `invalid`, `credentials`, `path`, `scheme`,
 * `insecure-http` and `private-lan-consent`. The last one means the address
 * would be accepted if the owner explicitly allowed plaintext HTTP on a
 * private network.
 */
export const classifyServerAddress = (raw, options = {}) => {
  const allowPrivateLanHttp = options.allowPrivateLanHttp === true;
  if (typeof raw !== "string" || raw.length > 2048)
    return { ok: false, reason: "invalid" };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.username !== "" || url.password !== "")
    return { ok: false, reason: "credentials" };
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "")
    return { ok: false, reason: "path" };
  if (url.hostname === "") return { ok: false, reason: "invalid" };
  if (url.protocol === "https:")
    return { ok: true, origin: url.origin, transport: "https" };
  if (url.protocol !== "http:") return { ok: false, reason: "scheme" };
  if (loopbackHosts.includes(url.hostname))
    return { ok: true, origin: url.origin, transport: "loopback-http" };
  if (!privateLanHost(url.hostname))
    return { ok: false, reason: "insecure-http" };
  return allowPrivateLanHttp
    ? { ok: true, origin: url.origin, transport: "private-lan-http" }
    : { ok: false, reason: "private-lan-consent" };
};

/** The accepted origin, or undefined. HTTPS and loopback HTTP by default. */
export const suiteOrigin = (raw, options = {}) => {
  const result = classifyServerAddress(raw, options);
  return result.ok ? result.origin : undefined;
};

export const allowedNavigation = (target, origin) => {
  try {
    return typeof origin === "string" && new URL(target).origin === origin;
  } catch {
    return false;
  }
};

export const allowedExternalOAuth = (target) => {
  try {
    const url = new URL(target);
    return (
      url.origin === "https://accounts.google.com" &&
      url.pathname === "/o/oauth2/v2/auth" &&
      url.username === "" &&
      url.password === "" &&
      url.searchParams.get("response_type") === "code" &&
      (url.searchParams.get("client_id")?.length ?? 0) > 4 &&
      (url.searchParams.get("redirect_uri")?.length ?? 0) > 0 &&
      (url.searchParams.get("state")?.length ?? 0) >= 32
    );
  } catch {
    return false;
  }
};

const hasControlCharacter = (text) => {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * Resolves an application path (`/today`, `/tasks?view=x`) against the
 * configured origin. Returns the absolute URL, or undefined when the path
 * could leave the origin or reach the API instead of an application page.
 */
export const navigationTarget = (path, origin) => {
  if (
    typeof path !== "string" ||
    typeof origin !== "string" ||
    path.length === 0 ||
    path.length > 1024 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    hasControlCharacter(path)
  )
    return undefined;
  let resolved;
  try {
    resolved = new URL(path, origin);
  } catch {
    return undefined;
  }
  if (resolved.origin !== origin) return undefined;
  if (resolved.username !== "" || resolved.password !== "") return undefined;
  const lowered = resolved.pathname.toLowerCase();
  // Deep links and notification clicks open application pages. API routes
  // (OAuth callbacks, exports, capability feeds) are never a link target.
  if (lowered === "/api" || lowered.startsWith("/api/")) return undefined;
  if (lowered.includes("%2f") || lowered.includes("%5c")) return undefined;
  return resolved.href;
};

/**
 * `tadooer://open/<path>` to an absolute URL on the configured origin, or
 * undefined. The link carries a path only; it cannot name a host, a scheme
 * or credentials, so it cannot move the window to another site.
 */
export const deepLinkTarget = (raw, origin) => {
  if (typeof raw !== "string" || raw.length > 2048) return undefined;
  if (raw.includes("\\") || hasControlCharacter(raw)) return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== `${deepLinkScheme}:` ||
    url.hostname !== "open" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  )
    return undefined;
  const path = url.pathname === "" ? "/" : url.pathname;
  return navigationTarget(`${path}${url.search}${url.hash}`, origin);
};

/** The first `tadooer://` argument of a command line, if any. */
export const deepLinkFromArguments = (argv) =>
  Array.isArray(argv)
    ? argv.find(
        (argument) =>
          typeof argument === "string" &&
          argument.toLowerCase().startsWith(`${deepLinkScheme}://`),
      )
    : undefined;

/**
 * Chromium permissions the Suite origin may hold. Everything else is denied:
 * camera, microphone, geolocation, MIDI, USB, screen capture and the rest.
 * `clipboard-sanitized-write` is the gesture-bound "Copy" button the web app
 * already has; without it that button would behave differently in the shell.
 */
export const grantedPermissions = Object.freeze([
  "notifications",
  "clipboard-sanitized-write",
]);

export const allowedPermission = (permission, requestingUrl, origin) =>
  grantedPermissions.includes(permission) &&
  allowedNavigation(requestingUrl, origin);

/**
 * Checks a parsed `/api/build` body. Returns `{ version }` for a Suite
 * server, otherwise undefined.
 */
export const suiteBuildResponse = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  if (value.service !== suiteServiceName) return undefined;
  if (typeof value.version !== "string" || value.version.length > 64)
    return undefined;
  return { version: value.version };
};

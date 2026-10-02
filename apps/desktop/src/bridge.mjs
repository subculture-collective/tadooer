/**
 * The preload bridge contract (ADR 0047). This module is pure and is bundled
 * into the sandboxed preload script and imported by the main process, so both
 * sides validate with the same code.
 *
 * Page to shell, exposed as `window.tadooerDesktop`:
 *   reportStatus(report)  sync and live state for the tray status line
 *   reportFocus(report)   the active focus session for the tray status line
 *   notify(request)       a native notification while the app runs
 *
 * Shell to page: two DOM events on `window` with no payload,
 * `tadooer:quick-capture` and `tadooer:sync-now`. The page may ignore them.
 *
 * There is no generic send, no channel argument, no file, process or shell
 * access, and nothing here reads or changes owner data.
 */

export const bridgeVersion = 1;
export const bridgeGlobal = "tadooerDesktop";

export const channels = Object.freeze({
  status: "tadooer-shell:status",
  focus: "tadooer-shell:focus",
  notify: "tadooer-shell:notify",
  command: "tadooer-shell:command",
});

export const commandEvents = Object.freeze({
  "quick-capture": "tadooer:quick-capture",
  "sync-now": "tadooer:sync-now",
});

const syncStates = ["signed-out", "online", "syncing", "offline"];
const liveStates = ["live", "reconnecting", "offline", "paused"];
const focusStates = ["idle", "running", "paused"];
const focusPhases = ["focus", "break"];

const plainObject = (value, allowedKeys) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.keys(value).every((key) => allowedKeys.includes(key));
};

const cleanText = (value, maximum, { allowEmpty }) => {
  if (typeof value !== "string" || value.length > maximum) return undefined;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    // Line breaks are allowed in a notification body; other control
    // characters never are.
    if ((code < 0x20 && code !== 0x0a) || code === 0x7f) return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "" && !allowEmpty) return undefined;
  return trimmed;
};

/** `{ sync, live, conflicts }` or undefined. */
export const parseStatusReport = (value) => {
  if (!plainObject(value, ["sync", "live", "conflicts"])) return undefined;
  if (!syncStates.includes(value.sync) || !liveStates.includes(value.live))
    return undefined;
  const conflicts = value.conflicts ?? 0;
  if (!Number.isInteger(conflicts) || conflicts < 0 || conflicts > 9999)
    return undefined;
  return { sync: value.sync, live: value.live, conflicts };
};

/** `{ state: "idle" }` or `{ state, phase, label }`, or undefined. */
export const parseFocusReport = (value) => {
  if (!plainObject(value, ["state", "phase", "label"])) return undefined;
  if (!focusStates.includes(value.state)) return undefined;
  if (value.state === "idle") {
    if (value.phase !== undefined || value.label !== undefined)
      return undefined;
    return { state: "idle" };
  }
  if (!focusPhases.includes(value.phase)) return undefined;
  const label = cleanText(value.label ?? "", 120, { allowEmpty: true });
  if (label === undefined || label.includes("\n")) return undefined;
  return { state: value.state, phase: value.phase, label };
};

/**
 * `{ title, body, tag, path }` or undefined. `path` is an application path;
 * the main process resolves it against the configured origin with
 * `navigationTarget` before a click may navigate.
 */
export const parseNotificationRequest = (value) => {
  if (!plainObject(value, ["title", "body", "tag", "path"])) return undefined;
  const title = cleanText(value.title, 120, { allowEmpty: false });
  if (title === undefined || title.includes("\n")) return undefined;
  const body = cleanText(value.body ?? "", 500, { allowEmpty: true });
  if (body === undefined) return undefined;
  const tag = value.tag ?? null;
  if (tag !== null && !(typeof tag === "string" && /^[\w.:-]{1,64}$/.test(tag)))
    return undefined;
  const path = value.path ?? null;
  if (
    path !== null &&
    !(
      typeof path === "string" &&
      path.length <= 1024 &&
      path.startsWith("/") &&
      !path.startsWith("//")
    )
  )
    return undefined;
  return { title, body, tag, path };
};

/** A known shell command name, or undefined. */
export const parseShellCommand = (value) =>
  typeof value === "string" && Object.hasOwn(commandEvents, value)
    ? value
    : undefined;

/**
 * A sliding-window limiter for calls the page can make at will. `now` is
 * injected so the tests do not wait.
 */
export const createRateLimiter = (limit, windowMs, now = () => Date.now()) => {
  let stamps = [];
  return () => {
    const time = now();
    stamps = stamps.filter((stamp) => time - stamp < windowMs);
    if (stamps.length >= limit) return false;
    stamps.push(time);
    return true;
  };
};

const syncText = {
  "signed-out": "Not signed in",
  online: "Synced",
  syncing: "Syncing",
  offline: "Offline",
};
const liveText = {
  live: "live",
  reconnecting: "reconnecting",
  offline: "no network",
  paused: "live updates paused",
};

/** The tray status line. `status` is undefined until the page reports. */
export const statusLine = (status) => {
  if (status === undefined) return "Waiting for the app";
  if (status.sync === "signed-out") return syncText["signed-out"];
  const parts = [syncText[status.sync]];
  if (status.sync !== "offline") parts.push(liveText[status.live]);
  if (status.conflicts > 0)
    parts.push(
      `${String(status.conflicts)} ${status.conflicts === 1 ? "conflict" : "conflicts"}`,
    );
  return parts.join(" · ");
};

/** The tray focus line, or undefined when no session is active. */
export const focusLine = (focus) => {
  if (focus === undefined || focus.state === "idle") return undefined;
  const kind = focus.phase === "break" ? "Break" : "Focus";
  const state = focus.state === "paused" ? "paused" : "running";
  return focus.label === ""
    ? `${kind} ${state}`
    : `${kind} ${state}: ${focus.label}`;
};

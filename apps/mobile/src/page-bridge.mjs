import {
  bridgeVersion,
  commandEvents,
  parseFocusReport,
  parseNotificationRequest,
  parseStatusReport,
  shareCaptureText,
} from "@suite/shell-policy";

/**
 * The bridge the Android shell puts into the Suite page (ADR 0049). It has
 * the shape of the desktop bridge (ADR 0047), so the web app uses one hook
 * for both.
 *
 * Page to shell: one message, the string `ready`, sent when the web app has
 * attached its listeners. There is no other message, no channel argument and
 * no call that returns data.
 *
 * Shell to page: a JSON string `{ "type": "share", "subject", "text" }`,
 * which becomes the `tadooer:quick-capture` DOM event with the capture line
 * in `detail.text`. The line goes into the capture field; nothing submits it.
 *
 * `reportStatus` and `reportFocus` validate and return, because a phone has
 * no tray to show them in. `notify` validates and returns `false`: native
 * notifications are designed in ADR 0049 and not built, and the result says
 * that nothing was shown.
 */

export const mobileBridgeGlobal = "tadooerMobile";
export const nativeChannelName = "tadooerShellNative";
export const readyMessage = "ready";

const maximumMessageLength = 32 * 1024;

/**
 * Reads a message from the native side. Returns `{ type: "share", text }`
 * or undefined. Unknown keys and unknown types are refused.
 */
export const parseNativeMessage = (data) => {
  if (typeof data !== "string" || data.length > maximumMessageLength)
    return undefined;
  let value;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  if (
    !Object.keys(value).every((key) =>
      ["type", "subject", "text"].includes(key),
    )
  )
    return undefined;
  if (value.type !== "share") return undefined;
  const text = shareCaptureText({ subject: value.subject, text: value.text });
  return text === undefined ? undefined : { type: "share", text };
};

/**
 * Builds the bridge object and connects the native channel.
 *
 * `native` is the object the WebView injects for the configured origin
 * (`postMessage` and `onmessage`); `target` receives the DOM events;
 * `createEvent(name, detail)` builds one. All three are injected for tests.
 */
export const createPageBridge = ({ native, target, createEvent }) => {
  native.onmessage = (event) => {
    const message = parseNativeMessage(event?.data);
    if (message === undefined) return;
    target.dispatchEvent(
      createEvent(commandEvents["quick-capture"], { text: message.text }),
    );
  };
  return Object.freeze({
    version: bridgeVersion,
    platform: "android",
    reportStatus: (report) => parseStatusReport(report) !== undefined,
    reportFocus: (report) => parseFocusReport(report) !== undefined,
    notify: (request) => {
      parseNotificationRequest(request);
      return false;
    },
    ready: () => {
      try {
        native.postMessage(readyMessage);
        return true;
      } catch {
        return false;
      }
    },
  });
};

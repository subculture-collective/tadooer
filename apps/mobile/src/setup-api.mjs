/* global URL */
import {
  checkServer,
  classifyServerAddress,
  normalizeServerInput,
  serverCheckMessage,
} from "@suite/shell-policy";

/**
 * The three calls the setup page makes (ADR 0049), with the same names and
 * results as the desktop shell's `window.tadooerSetup`, so the desktop setup
 * script runs here unchanged.
 *
 * `shell` is the native plugin (state, setServer, cancel, cleartextPermitted)
 * and `http` is Capacitor's native HTTP client; both are injected, so this
 * module is pure and the tests use fakes. The address rules and the
 * `/api/build` check are the shared ones. The native side validates the
 * origin again before it stores it.
 */

export const serverCheckTimeoutMs = 8000;

const androidMessages = {
  "localhost-reserved":
    "On Android, use 127.0.0.1 instead of localhost. The app keeps the name localhost for this setup page.",
  "cleartext-build":
    "This build of the app only allows unencrypted connections to addresses it was built for. Use https://, or rebuild the app with this address allowed.",
  "ipv6-literal":
    "Use a host name or an IPv4 address. An IPv6 address in brackets is not supported on Android.",
  "webview-outdated":
    "Android System WebView on this phone is too old for the app to open a server safely. Update it and try again.",
  refused: "The app did not accept this address.",
};

export const setupMessage = (reason) =>
  androidMessages[reason] ?? serverCheckMessage(reason);

const refusal = (reason) => ({
  ok: false,
  reason,
  message: setupMessage(reason),
});

/**
 * A `fetch` stand-in over Capacitor's native HTTP client, shaped for the
 * shared `checkServer`. The WebView cannot make this request itself: the
 * setup page is on another origin than the server and may be on HTTPS while
 * a consented private address is not.
 *
 * Redirects are not followed, and a redirect answer is an error, as it is
 * for the desktop shell: a server that sends `/api/build` elsewhere is not
 * the configured origin.
 */
export const nativeFetch =
  (http, timeoutMs = serverCheckTimeoutMs) =>
  async (url) => {
    const response = await http.get({
      url,
      headers: { accept: "application/json" },
      disableRedirects: true,
      responseType: "text",
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    });
    const status = Number(response?.status);
    if (!Number.isInteger(status) || (status >= 300 && status < 400))
      throw new Error("Redirected or malformed response");
    const data = response.data;
    return {
      status,
      // The native client parses a JSON body before it returns it; the shared
      // check wants the text, so it can bound and parse it itself.
      text: () =>
        Promise.resolve(typeof data === "string" ? data : JSON.stringify(data)),
    };
  };

export const createSetupApi = ({
  shell,
  http,
  timeoutMs = serverCheckTimeoutMs,
}) => {
  const state = async () => {
    const value = await shell.state();
    return {
      currentOrigin:
        typeof value?.currentOrigin === "string" ? value.currentOrigin : null,
      unreachable: value?.unreachable === true,
      webViewSupported: value?.webViewSupported !== false,
    };
  };

  const connect = async (address, allowPrivateLanHttp) => {
    if (typeof address !== "string") return refusal("invalid");
    const allow = allowPrivateLanHttp === true;
    const input = normalizeServerInput(address);
    const classified = classifyServerAddress(input, {
      allowPrivateLanHttp: allow,
    });
    if (!classified.ok) return refusal(classified.reason);
    const url = new URL(classified.origin);
    if (url.hostname === "localhost") return refusal("localhost-reserved");
    if (url.hostname.startsWith("[") && url.hostname !== "[::1]")
      return refusal("ipv6-literal");
    if (classified.transport !== "https") {
      // The platform's network security configuration is fixed when the app
      // is built. Asking first gives a precise message instead of "did not
      // answer".
      const permitted = await shell
        .cleartextPermitted({ host: url.hostname })
        .then((answer) => answer?.permitted === true)
        .catch(() => false);
      if (!permitted) return refusal("cleartext-build");
    }
    const result = await checkServer(input, {
      allowPrivateLanHttp: allow,
      fetchImplementation: nativeFetch(http, timeoutMs),
      signal: undefined,
    });
    if (!result.ok) return refusal(result.reason);
    try {
      await shell.setServer({
        origin: result.origin,
        allowPrivateLanHttp: result.transport === "private-lan-http",
      });
    } catch (error) {
      // The native side names its reason in the error code.
      const code = error?.code;
      return refusal(Object.hasOwn(androidMessages, code) ? code : "refused");
    }
    return { ok: true, origin: result.origin, version: result.version };
  };

  const cancel = async () => {
    await shell.cancel();
    return null;
  };

  return Object.freeze({ state, connect, cancel });
};

/**
 * What the page adds to the desktop markup when it opened for a reason other
 * than first use: the WebView is too old, or the stored server did not load.
 * Returns undefined when there is nothing to add.
 */
export const setupNotice = (state) => {
  if (state?.webViewSupported === false)
    return { message: androidMessages["webview-outdated"] };
  if (state?.unreachable === true && typeof state.currentOrigin === "string")
    return {
      message: `${state.currentOrigin} did not load. Check the connection and try again, or enter another address.`,
      cancelLabel: "Try again",
    };
  return undefined;
};

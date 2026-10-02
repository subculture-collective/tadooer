/**
 * The authority rules every client shell uses (ADR 0015, ADR 0047, ADR 0049).
 *
 * One implementation, two consumers. The functions live in the desktop
 * package because the Electron bundle is packaged from `apps/desktop` alone
 * and cannot import a workspace dependency at run time; this module re-exports
 * them so the mobile shell and any later shell import the same code instead of
 * a copy. `apps/desktop/src/policy.test.mjs` tests them in place, and
 * `index.test.mjs` here checks that what a second shell imports is that code.
 *
 * Everything exported is pure: no Electron, no Capacitor, no I/O. `policy.mjs`
 * imports `URL` from `node:url`; a browser bundle aliases that import to the
 * global `URL` (see `apps/mobile/scripts/build-www.mjs`).
 */

export {
  allowedExternalOAuth,
  allowedNavigation,
  classifyServerAddress,
  deepLinkScheme,
  deepLinkTarget,
  navigationTarget,
  normalizeServerInput,
  privateLanHost,
  suiteBuildResponse,
  suiteOrigin,
  suiteServiceName,
} from "../../../apps/desktop/src/policy.mjs";

export {
  bridgeVersion,
  commandEvents,
  createRateLimiter,
  parseFocusReport,
  parseNotificationRequest,
  parseShellCommand,
  parseStatusReport,
} from "../../../apps/desktop/src/bridge.mjs";

export {
  checkServer,
  serverCheckMessage,
} from "../../../apps/desktop/src/server-check.mjs";

export { captureTextLimit, shareCaptureText } from "./share.mjs";

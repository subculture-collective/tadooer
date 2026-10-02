/* global document, window */
import { CapacitorHttp, registerPlugin } from "@capacitor/core";
import { createSetupApi, setupNotice } from "./setup-api.mjs";

// Entry of the bundled setup page (ADR 0049). It defines the same
// `window.tadooerSetup` the desktop preload defines, then the desktop
// shell's own `setup.js` runs against it.

const shell = registerPlugin("TadooerShell");
const api = createSetupApi({ shell, http: CapacitorHttp });

Object.defineProperty(window, "tadooerSetup", {
  value: api,
  writable: false,
  configurable: false,
});

void api
  .state()
  .then((state) => {
    const notice = setupNotice(state);
    if (notice === undefined) return;
    const message = document.querySelector("#message");
    const cancel = document.querySelector("#cancel");
    if (message !== null) {
      message.textContent = notice.message;
      message.dataset.kind = "error";
    }
    if (cancel !== null && notice.cancelLabel !== undefined)
      cancel.textContent = notice.cancelLabel;
  })
  .catch(() => undefined);

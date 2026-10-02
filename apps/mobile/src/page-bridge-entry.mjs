/* global window, CustomEvent */
import {
  createPageBridge,
  mobileBridgeGlobal,
  nativeChannelName,
} from "./page-bridge.mjs";

// Injected by the Android shell at document start, into the configured
// origin only (ADR 0049). The top frame gets the bridge; a frame inside the
// page gets nothing.

const native = window[nativeChannelName];
if (
  window.top === window &&
  typeof native === "object" &&
  native !== null &&
  window[mobileBridgeGlobal] === undefined
)
  Object.defineProperty(window, mobileBridgeGlobal, {
    value: createPageBridge({
      native,
      target: window,
      createEvent: (name, detail) => new CustomEvent(name, { detail }),
    }),
    writable: false,
    configurable: false,
  });

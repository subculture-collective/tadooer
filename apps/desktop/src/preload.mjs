/* global window, Event */
import { contextBridge, ipcRenderer } from "electron";
import {
  bridgeGlobal,
  bridgeVersion,
  channels,
  commandEvents,
  parseFocusReport,
  parseNotificationRequest,
  parseShellCommand,
  parseStatusReport,
} from "./bridge.mjs";

/**
 * Preload for the Suite window (ADR 0047). It runs sandboxed in an isolated
 * world and is bundled to CommonJS by `pnpm build:preload`, because a
 * sandboxed preload cannot import other files.
 *
 * Each call validates its argument here and sends on one fixed channel; the
 * main process validates again and checks the sender. The page never chooses
 * a channel name and never receives an Electron object.
 */

const forward = (channel, parse) => (value) => {
  const parsed = parse(value);
  if (parsed === undefined) return false;
  ipcRenderer.send(channel, parsed);
  return true;
};

contextBridge.exposeInMainWorld(
  bridgeGlobal,
  Object.freeze({
    version: bridgeVersion,
    reportStatus: forward(channels.status, parseStatusReport),
    reportFocus: forward(channels.focus, parseFocusReport),
    notify: forward(channels.notify, parseNotificationRequest),
  }),
);

ipcRenderer.on(channels.command, (_event, value) => {
  const command = parseShellCommand(value);
  if (command !== undefined)
    window.dispatchEvent(new Event(commandEvents[command]));
});

import { contextBridge, ipcRenderer } from "electron";

/**
 * Preload for the bundled setup page only. Three fixed calls; the main
 * process accepts them from the setup window's own file and nowhere else.
 */
contextBridge.exposeInMainWorld(
  "tadooerSetup",
  Object.freeze({
    state: () => ipcRenderer.invoke("tadooer-setup:state"),
    connect: (address, allowPrivateLanHttp) =>
      ipcRenderer.invoke("tadooer-setup:connect", {
        address: String(address),
        allowPrivateLanHttp: allowPrivateLanHttp === true,
      }),
    cancel: () => ipcRenderer.invoke("tadooer-setup:cancel"),
  }),
);

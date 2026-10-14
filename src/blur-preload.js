const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pixyBlur", {
  frame: (buffer) => ipcRenderer.send("blur:frame", buffer),
  status: (s) => ipcRenderer.send("blur:status", s),
  preview: (buffer) => ipcRenderer.send("blur:preview", buffer),
  getConfig: () => ipcRenderer.invoke("blur:config"),
  onConfig: (cb) => ipcRenderer.on("blur:config", (_e, c) => cb(c)),
});

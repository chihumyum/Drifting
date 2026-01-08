"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("electronAPI", {
  // App info
  getVersion: () => electron.ipcRenderer.invoke("app:getVersion"),
  getPath: (name) => electron.ipcRenderer.invoke("app:getPath", name),
  // Window controls
  window: {
    minimize: () => electron.ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => electron.ipcRenderer.invoke("window:toggleMaximize"),
    close: () => electron.ipcRenderer.invoke("window:close"),
    isMaximized: () => electron.ipcRenderer.invoke("window:isMaximized")
  },
  // Database operations
  db: {
    init: (dbName) => electron.ipcRenderer.invoke("db:init", dbName),
    run: (sql, params) => electron.ipcRenderer.invoke("db:run", sql, params),
    query: (sql, params) => electron.ipcRenderer.invoke("db:query", sql, params),
    get: (sql, params) => electron.ipcRenderer.invoke("db:get", sql, params),
    close: () => electron.ipcRenderer.invoke("db:close")
  }
});

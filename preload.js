'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// A single typed bridge: api.invoke(channel, payload) for request/response,
// api.on(handler) for streamed events (console output, status, progress).
contextBridge.exposeInMainWorld('mcBridge', {
  invoke: (channel, payload) => ipcRenderer.invoke('invoke', { channel, payload }),
  on: (handler) => {
    const listener = (_evt, msg) => handler(msg);
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.removeListener('event', listener);
  },
  // Resolve real filesystem paths from dropped File objects (for drag-and-drop mods).
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  // Copy text to the system clipboard (reliable across file:// where navigator.clipboard may be blocked).
  copyText: (text) => ipcRenderer.invoke('invoke', { channel: 'clipboard:write', payload: text }),
});

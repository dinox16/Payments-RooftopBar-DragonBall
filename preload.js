'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  call: (method, ...args) => ipcRenderer.invoke('call', method, args),
  pickFile: (opts) => ipcRenderer.invoke('pickFile', opts),
  pickFolder: (opts) => ipcRenderer.invoke('pickFolder', opts),
  saveFile: (opts) => ipcRenderer.invoke('saveFile', opts),
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  showInFolder: (p) => ipcRenderer.invoke('showInFolder', p),
  openDataFolder: () => ipcRenderer.invoke('openDataFolder'),
  appInfo: () => ipcRenderer.invoke('appInfo'),
  updateState: () => ipcRenderer.invoke('updateState'),
  checkUpdate: () => ipcRenderer.invoke('checkUpdate'),
  installUpdate: () => ipcRenderer.invoke('installUpdate'),
  onUpdate: (fn) => ipcRenderer.on('update', (_e, s) => fn(s)),
});

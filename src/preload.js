'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  resetHistory: () => ipcRenderer.invoke('config:reset-history'),
  testConnection: () => ipcRenderer.invoke('asr:test'),
  labStart: () => ipcRenderer.invoke('lab:start'),
  labStop: () => ipcRenderer.invoke('lab:stop'),
  hotkeyProbe: () => ipcRenderer.invoke('hotkey:probe'),
  lastAudio: () => ipcRenderer.invoke('audio:last'),
  envCheck: () => ipcRenderer.invoke('env:check'),
  openConfigDir: () => ipcRenderer.invoke('app:open-config-dir'),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  hide: () => ipcRenderer.invoke('win:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  rebuildTray: () => ipcRenderer.send('tray:rebuild'),
  getBounds: () => ipcRenderer.invoke('win:get-bounds'),
  setBounds: (b) => ipcRenderer.send('win:set-bounds', b),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onHotkeyStatus: (cb) => ipcRenderer.on('hotkey-status', (_e, s) => cb(s)),
  onHistory: (cb) => ipcRenderer.on('history', (_e, h) => cb(h)),
  onGoto: (cb) => ipcRenderer.on('goto', (_e, page) => cb(page))
});

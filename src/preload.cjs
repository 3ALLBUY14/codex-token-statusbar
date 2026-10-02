'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexStatusbar', {
  ready: () => ipcRenderer.send('statusbar:ready'),
  onSnapshot: callback => {
    const listener = (_, snapshot) => callback(snapshot);
    ipcRenderer.on('statusbar:snapshot', listener);
    return () => ipcRenderer.removeListener('statusbar:snapshot', listener);
  },
  onCollapse: callback => ipcRenderer.on('statusbar:collapse', () => callback()),
  onCompact: callback => ipcRenderer.on('statusbar:compact', (_, layout) => callback(layout)),
  resize: (width, height) => ipcRenderer.send('statusbar:resize', { width, height }),
  setSettings: async patch => {
    const response = await ipcRenderer.invoke('statusbar:settings', patch);
    if (!response.ok) throw new Error(response.error.message);
    return response.value;
  },
  settings: () => ipcRenderer.send('statusbar:open-settings'),
  restorePosition: () => ipcRenderer.send('statusbar:restore-position'),
  refresh: () => ipcRenderer.send('statusbar:refresh'),
  drag: (action, point) => ipcRenderer.send('statusbar:drag', action, point),
  onDragError: callback => ipcRenderer.on('statusbar:drag-error', (_, message) => callback(message)),
  quit: () => ipcRenderer.send('statusbar:quit'),
});

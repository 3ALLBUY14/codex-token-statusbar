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
  previewOpacity: value => ipcRenderer.send('statusbar:opacity-preview', value),
  onOpacityPreview: callback => ipcRenderer.on('statusbar:opacity-preview', (_, value) => callback(value)),
  resize: (width, height, barHeight) => ipcRenderer.send('statusbar:resize', { width, height, barHeight }),
  setSettings: async patch => {
    const response = await ipcRenderer.invoke('statusbar:settings', patch);
    if (!response.ok) throw new Error(response.error.message);
    return response.value;
  },
  settings: pane => ipcRenderer.send('statusbar:open-settings', pane),
  onRequestFilters: callback => ipcRenderer.on('statusbar:request-filters', () => callback()),
  onShowUpdates: callback => ipcRenderer.on('statusbar:show-updates', () => callback()),
  restorePosition: async () => {
    const response = await ipcRenderer.invoke('statusbar:restore-position');
    if (!response.ok) throw new Error(response.error.message);
  },
  refresh: () => ipcRenderer.send('statusbar:refresh'),
  drag: (action, point) => ipcRenderer.send('statusbar:drag', action, point),
  onDragError: callback => ipcRenderer.on('statusbar:drag-error', (_, message) => callback(message)),
  quit: () => ipcRenderer.send('statusbar:quit'),
  toolInterest: enabled => ipcRenderer.send('statusbar:tool-interest', enabled === true),
  modelRequests: (threadId, filters) => ipcRenderer.invoke('statusbar:model-requests', threadId, filters),
  copyDiagnostics: () => ipcRenderer.invoke('statusbar:copy-diagnostics'),
  checkUpdate: () => ipcRenderer.invoke('statusbar:check-update'),
  openRelease: () => ipcRenderer.invoke('statusbar:open-release'),
  openSettingsLink: url => ipcRenderer.invoke('statusbar:open-settings-link', url),
});

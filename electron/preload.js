const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  browseFile: () => ipcRenderer.invoke('browse-file'),
});
const { contextBridge, ipcRenderer } = require('electron');

function apiPortFromArgs() {
  const arg = process.argv.find((a) => a.startsWith('--api-port='));
  const port = arg ? parseInt(arg.split('=')[1], 10) : NaN;
  return Number.isFinite(port) ? port : 8742;
}

contextBridge.exposeInMainWorld('electronAPI', {
  apiBase: `http://127.0.0.1:${apiPortFromArgs()}`,

  browseFile: () => ipcRenderer.invoke('browse-file'),

  // Boot / loading-screen progress (runtime download + backend startup).
  onBootProgress: (cb) => ipcRenderer.on('boot-progress', (_evt, data) => cb(data)),

  // Backend health.
  onBackendCrashed: (cb) => ipcRenderer.on('backend-crashed', (_evt, data) => cb(data)),
  restartBackend: () => ipcRenderer.invoke('restart-backend'),
  openBackendLog: () => ipcRenderer.invoke('open-backend-log'),

  // Updates.
  onUpdateInfo: (cb) => ipcRenderer.on('update-info', (_evt, data) => cb(data)),
  getUpdateInfo: () => ipcRenderer.invoke('get-update-info'),
  installUpdate: () => ipcRenderer.invoke('install-update'),

  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});

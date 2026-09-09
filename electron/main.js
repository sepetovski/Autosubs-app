const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const runtime = require('./runtime');

let backendProcess  = null;
let mainWindow       = null;
let apiPort           = 8742;
let backendLogStream  = null;
let intentionalKill   = false;
let latestUpdateInfo  = null;

// ── Single instance lock ─────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

const FRONTEND_URL = 'http://localhost:5173';

const USE_BUILT_FILES = app.isPackaged || process.env.ELECTRON_LOAD_DIST === 'true';

const RESOURCES_DIR = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, 'resources');

const DIST_INDEX = app.isPackaged
    ? path.join(process.resourcesPath, 'frontend-dist', 'index.html')
    : path.join(__dirname, '..', 'frontend', 'dist', 'index.html');

const BACKEND_DIR = app.isPackaged
    ? path.join(RESOURCES_DIR, 'backend')
    : path.join(__dirname, '..', 'backend');

function apiBaseUrl() {
  return `http://127.0.0.1:${apiPort}`;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function loadingHtml() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`
  <html>
    <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
                 background:#111010;color:#d6d3cd;font-family:Courier,monospace;">
      <div style="text-align:center;width:340px;">
        <div style="font-size:20px;font-weight:bold;margin-bottom:8px;">AutoSubs</div>
        <div id="txt" style="font-size:12px;color:#8c887d;margin-bottom:10px;">Starting up…</div>
        <div style="height:6px;border-radius:3px;background:#211f1c;overflow:hidden;">
          <div id="bar" style="height:100%;width:0%;background:#d97706;transition:width .2s ease;"></div>
        </div>
      </div>
      <script>
        if (window.electronAPI && window.electronAPI.onBootProgress) {
          window.electronAPI.onBootProgress((evt) => {
            const txt = document.getElementById('txt');
            const bar = document.getElementById('bar');
            if (txt && evt.text) txt.textContent = evt.text;
            if (bar && typeof evt.pct === 'number') bar.style.width = evt.pct + '%';
          });
        }
      </script>
    </body>
  </html>
  `)}`;
}

function errorHtml(message) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`
  <html>
    <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
                 background:#111010;color:#fca5a5;font-family:Courier,monospace;">
      <div style="text-align:center;max-width:480px;padding:0 20px;">
        <div style="font-size:16px;font-weight:bold;">&#9888; Backend failed to start</div>
        <div style="font-size:11px;color:#8c887d;margin-top:8px;">${message || 'Check the logs for details.'}</div>
        <div style="font-size:10px;color:#3d3a34;margin-top:14px;">Logs: ${path.join(app.getPath('userData'), 'logs', 'backend.log')}</div>
      </div>
    </body>
  </html>
  `)}`;
}

function sendBoot(evt) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('boot-progress', evt);
  }
}

function openBackendLog() {
  const logPath = path.join(app.getPath('userData'), 'logs', 'backend.log');
  if (!backendLogStream) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    backendLogStream = fs.createWriteStream(logPath, { flags: 'a' });
  }
  return logPath;
}

function logLine(line) {
  console.log(line);
  try {
    if (!backendLogStream) openBackendLog();
    backendLogStream.write(`[${new Date().toISOString()}] ${line}\n`);
  } catch { /* best effort */ }
}

async function startBackend() {
  const isWin = process.platform === 'win32';
  let pythonExe;
  let env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

  if (USE_BUILT_FILES) {
    sendBoot({ phase: 'runtime', pct: 0, text: 'Checking runtime…' });
    const manifestPath = path.join(RESOURCES_DIR, 'runtime.json');
    const { pythonExe: exe, ffmpegDir } = await runtime.ensureRuntime(
      manifestPath, app.getPath('userData'),
      (evt) => sendBoot({ phase: evt.phase, pct: evt.pct ?? 0, text: evt.text }),
    );
    pythonExe = exe;
    env.AUTOSUBS_FFMPEG_DIR = ffmpegDir;
  } else {
    const venvBin = isWin
        ? path.join(BACKEND_DIR, 'venv', 'Scripts')
        : path.join(BACKEND_DIR, 'venv', 'bin');
    pythonExe = isWin ? path.join(venvBin, 'python.exe') : path.join(venvBin, 'python');
    env.PATH = `${venvBin}${path.delimiter}${process.env.PATH || ''}`;
  }

  env.AUTOSUBS_DATA_DIR   = app.getPath('userData');
  env.AUTOSUBS_MODELS_DIR = path.join(app.getPath('userData'), 'models');

  sendBoot({ phase: 'starting', pct: 95, text: 'Starting AutoSubs engine…' });

  logLine(`Spawning backend: ${pythonExe} server.py --port ${apiPort} (cwd=${BACKEND_DIR})`);
  backendProcess = spawn(pythonExe, ['server.py', '--port', String(apiPort)],
                         { cwd: BACKEND_DIR, env });

  backendProcess.stdout.on('data', (d) => logLine(`[backend] ${d.toString().trimEnd()}`));
  backendProcess.stderr.on('data', (d) => logLine(`[backend] ${d.toString().trimEnd()}`));
  backendProcess.on('error', (err) => logLine(`[main] Failed to spawn backend: ${err}`));
  backendProcess.on('exit', (code, signal) => {
    logLine(`[backend] exited with code ${code} signal ${signal}`);
    if (!intentionalKill && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backend-crashed', { code, signal });
    }
    backendProcess = null;
  });
}

function killBackendTree() {
  intentionalKill = true;
  if (!backendProcess || backendProcess.killed) return;
  const pid = backendProcess.pid;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)]);
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { backendProcess.kill('SIGKILL'); }
    }
  } catch { /* best effort */ }
}

function waitForBackend(retriesLeft = 300) {
  // 300 * 300ms = 90s — generous because a cold-cache torch import (first
  // launch after install/update) can genuinely take a while on slow disks.
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      const req = http.get(`${apiBaseUrl()}/ping`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry(remaining);
      });
      req.on('error', () => retry(remaining));
    };
    const retry = (remaining) => {
      if (remaining <= 0) { reject(new Error('Backend did not start in time')); return; }
      setTimeout(() => attempt(remaining - 1), 300);
    };
    attempt(retriesLeft);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#111010',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--api-port=${apiPort}`],
    },
  });

  mainWindow.loadURL(loadingHtml());

  (async () => {
    try {
      await startBackend();
      await waitForBackend();
      if (USE_BUILT_FILES) {
        logLine(`[main] Loading built files from: ${DIST_INDEX}`);
        mainWindow.loadFile(DIST_INDEX);
      } else {
        logLine(`[main] Loading dev server: ${FRONTEND_URL}`);
        mainWindow.loadURL(FRONTEND_URL);
      }
      if (app.isPackaged) checkForUpdates();
    } catch (err) {
      logLine(`[main] ${err.message || err}`);
      mainWindow.loadURL(errorHtml(err.message));
    }
  })();
}

// ── IPC ───────────────────────────────────────────────────────────────────
ipcMain.handle('browse-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a video file',
    properties: ['openFile'],
    filters: [
      { name: 'Video files', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return '';
  return result.filePaths[0];
});

ipcMain.handle('get-api-port', () => apiPort);

ipcMain.handle('restart-backend', async () => {
  killBackendTree();
  intentionalKill = false;
  await new Promise((r) => setTimeout(r, 400));
  try {
    await startBackend();
    await waitForBackend();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('open-backend-log', () => {
  const logPath = openBackendLog();
  shell.showItemInFolder(logPath);
  return logPath;
});

ipcMain.handle('open-external', (_evt, url) => shell.openExternal(url));

ipcMain.handle('get-update-info', () => latestUpdateInfo);

// ── Auto-update ───────────────────────────────────────────────────────────
// Windows: fully automatic via electron-updater (signed-or-not, Squirrel.Windows
// accepts unsigned installers with just a SmartScreen warning on first run).
// macOS: unsigned builds are refused by Squirrel.Mac's update mechanism, so we
// just check GitHub's latest release and show a "new version available" banner
// that opens the download page — no silent install.
function checkForUpdates() {
  if (process.platform === 'win32') {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = true;
      autoUpdater.on('update-downloaded', (info) => {
        latestUpdateInfo = { available: true, version: info.version, readyToInstall: true };
        if (mainWindow) mainWindow.webContents.send('update-info', latestUpdateInfo);
      });
      autoUpdater.on('error', (err) => logLine(`[updater] ${err}`));
      autoUpdater.checkForUpdates();
    } catch (err) {
      logLine(`[updater] electron-updater unavailable: ${err.message}`);
    }
  } else {
    https.get({
      hostname: 'api.github.com',
      path: '/repos/sepetovski/Autosubs-app/releases/latest',
      headers: { 'User-Agent': 'AutoSubs-App' },
    }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const latest = (json.tag_name || '').replace(/^v/, '');
          const current = app.getVersion();
          if (latest && latest !== current) {
            latestUpdateInfo = { available: true, version: latest, url: json.html_url, readyToInstall: false };
            if (mainWindow) mainWindow.webContents.send('update-info', latestUpdateInfo);
          }
        } catch { /* ignore malformed response */ }
      });
    }).on('error', (err) => logLine(`[updater] check failed: ${err.message}`));
  }
}

ipcMain.handle('install-update', () => {
  if (process.platform === 'win32') {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.quitAndInstall();
    } catch { /* ignore */ }
  } else if (latestUpdateInfo && latestUpdateInfo.url) {
    shell.openExternal(latestUpdateInfo.url);
  }
});

// ── App lifecycle ─────────────────────────────────────────────────────────
if (gotLock) {
  app.whenReady().then(async () => {
    apiPort = await findFreePort().catch(() => 8742);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      // On macOS the app can stay alive with no windows after the last one
      // closes; if the backend died in the meantime, bring it back too.
      else if (!backendProcess) startBackend().catch((err) => logLine(`[main] ${err}`));
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      killBackendTree();
      app.quit();
    }
    // On macOS we deliberately leave the backend running so re-activating
    // via the dock doesn't need a full cold restart.
  });

  app.on('before-quit', () => {
    killBackendTree();
  });
}

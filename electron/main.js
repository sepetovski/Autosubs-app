const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

let backendProcess = null;
let mainWindow = null;

const BACKEND_PORT = 8742;
const BACKEND_URL  = `http://127.0.0.1:${BACKEND_PORT}`;
const FRONTEND_URL = 'http://localhost:5173';

const USE_BUILT_FILES = app.isPackaged || process.env.ELECTRON_LOAD_DIST === 'true';

const RESOURCES_DIR = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, 'resources');

const DIST_INDEX = app.isPackaged
    ? path.join(process.resourcesPath, 'frontend-dist', 'index.html')
    : path.join(__dirname, '..', 'frontend', 'dist', 'index.html');

const LOADING_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`
  <html>
    <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
                 background:#111010;color:#d6d3cd;font-family:Courier,monospace;">
      <div style="text-align:center;">
        <div style="font-size:20px;font-weight:bold;margin-bottom:8px;">AutoSubs</div>
        <div style="font-size:12px;color:#8c887d;">Starting up…</div>
      </div>
    </body>
  </html>
`)}`;

const ERROR_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`
  <html>
    <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
                 background:#111010;color:#fca5a5;font-family:Courier,monospace;">
      <div style="text-align:center;">
        <div style="font-size:16px;font-weight:bold;">⚠ Backend failed to start</div>
        <div style="font-size:11px;color:#8c887d;margin-top:8px;">Check the terminal for errors.</div>
      </div>
    </body>
  </html>
`)}`;

function startBackend() {
  console.log(`[main] app.isPackaged:        ${app.isPackaged}`);
  console.log(`[main] USE_BUILT_FILES:       ${USE_BUILT_FILES}`);
  console.log(`[main] __dirname:             ${__dirname}`);
  console.log(`[main] process.resourcesPath: ${process.resourcesPath}`);
  console.log(`[main] RESOURCES_DIR:         ${RESOURCES_DIR}`);

  if (USE_BUILT_FILES) {
    const isWin     = process.platform === 'win32';
    const serverDir = path.join(RESOURCES_DIR, 'autosubs-server');
    const serverExe = path.join(serverDir, isWin ? 'autosubs-server.exe' : 'autosubs-server');

    console.log(`[main] Bundled server exe: ${serverExe}`);
    console.log(`[main] File exists?        ${fs.existsSync(serverExe)}`);

    backendProcess = spawn(serverExe, [], { cwd: serverDir });
  } else {
    const backendDir = path.join(__dirname, '..', 'backend');
    const isWin       = process.platform === 'win32';
    const venvBin      = isWin
        ? path.join(backendDir, 'venv', 'Scripts')
        : path.join(backendDir, 'venv', 'bin');
    const pythonExe   = isWin
        ? path.join(venvBin, 'python.exe')
        : path.join(venvBin, 'python');

    console.log(`[main] Backend dir: ${backendDir}`);
    console.log(`[main] Python exe:  ${pythonExe}`);

    const childEnv = {
      ...process.env,
      PATH: `${venvBin}${path.delimiter}${process.env.PATH || ''}`,
    };

    backendProcess = spawn(pythonExe, ['server.py'], { cwd: backendDir, env: childEnv });
  }

  backendProcess.stdout.on('data', (data) => console.log(`[backend] ${data}`));
  backendProcess.stderr.on('data', (data) => console.error(`[backend] ${data}`));
  backendProcess.on('error', (err) => console.error(`[main] Failed to spawn backend:`, err));
  backendProcess.on('exit', (code) => console.log(`[backend] exited with code ${code}`));
}

function waitForBackend(retriesLeft = 40) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      const req = http.get(`${BACKEND_URL}/ping`, (res) => {
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
    },
  });

  mainWindow.loadURL(LOADING_HTML);

  waitForBackend()
      .then(() => {
        if (USE_BUILT_FILES) {
          console.log(`[main] Loading built files from: ${DIST_INDEX}`);
          mainWindow.loadFile(DIST_INDEX);
        } else {
          console.log(`[main] Loading dev server: ${FRONTEND_URL}`);
          mainWindow.loadURL(FRONTEND_URL);
        }
      })
      .catch((err) => {
        console.error('[main]', err);
        mainWindow.loadURL(ERROR_HTML);
      });
}

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

app.whenReady().then(() => {
  startBackend();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (backendProcess) backendProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backendProcess) backendProcess.kill();
});
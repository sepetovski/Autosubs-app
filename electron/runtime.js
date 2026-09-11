/**
 * BananaCut — Runtime manager
 *
 * The Electron app installer only ships main.js/preload.js/the frontend
 * bundle/the backend .py source (all small, all auto-updated together).
 * The heavy part — a Python interpreter + torch + openai-whisper + ffmpeg,
 * roughly 300-400MB — lives in a separate GitHub release
 * (sepetovski/Autosubs-runtime) and is downloaded once into the app's
 * userData folder on first launch. It's versioned independently: most app
 * updates don't touch it, so most updates stay a small download.
 *
 * Layout expected inside the downloaded archive:
 *   python/            (a self-contained python-build-standalone tree)
 *   ffmpeg/ffmpeg[.exe], ffmpeg/ffprobe[.exe]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const os = require('os');

let tar = null;
try { tar = require('tar'); } catch { /* validated at call time */ }

const IS_WIN = process.platform === 'win32';

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function loadManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath, 'utf-8');
  return JSON.parse(raw);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function download(url, destPath, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const partPath = `${destPath}.part`;
    const file = fs.createWriteStream(partPath);
    const req = client.get(url, { headers: { 'User-Agent': 'BananaCut-App' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close();
        fs.unlink(partPath, () => {});
        if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return; }
        resolve(download(res.headers.location, destPath, onProgress, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(partPath, () => {});
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress({ received, total });
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.renameSync(partPath, destPath);
          resolve();
        });
      });
    });
    req.on('error', (err) => {
      file.close();
      fs.unlink(partPath, () => {});
      reject(err);
    });
  });
}

async function extractArchive(archivePath, destDir) {
  if (!tar) throw new Error("The 'tar' package is required (npm install tar)");
  fs.mkdirSync(destDir, { recursive: true });
  await tar.x({ file: archivePath, cwd: destDir, preservePaths: false });
}

function removeOldVersions(runtimeRoot, keepVersion) {
  if (!fs.existsSync(runtimeRoot)) return;
  for (const entry of fs.readdirSync(runtimeRoot)) {
    if (entry === keepVersion) continue;
    const p = path.join(runtimeRoot, entry);
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function resolveExecutables(versionDir) {
  const pythonExe = IS_WIN
    ? path.join(versionDir, 'python', 'python.exe')
    : path.join(versionDir, 'python', 'bin', 'python3');
  const ffmpegDir = path.join(versionDir, 'ffmpeg');
  return { pythonExe, ffmpegDir };
}

/**
 * Ensure the runtime for the manifest's declared version is present on
 * disk (downloading + extracting it if needed), and return the paths the
 * caller needs to launch the backend.
 *
 * @param {string} manifestPath  path to the bundled runtime.json
 * @param {string} userDataDir   app.getPath('userData')
 * @param {(evt: {phase:string, pct?:number, text:string}) => void} onProgress
 */
async function ensureRuntime(manifestPath, userDataDir, onProgress = () => {}) {
  const manifest = loadManifest(manifestPath);
  const key = platformKey();
  const asset = manifest.assets && manifest.assets[key];
  if (!asset) {
    throw new Error(`No runtime published for this platform (${key}). ` +
      `Supported: ${Object.keys(manifest.assets || {}).join(', ') || 'none'}`);
  }

  const runtimeRoot = path.join(userDataDir, 'runtime');
  const versionDir = path.join(runtimeRoot, manifest.version);
  const completeMarker = path.join(versionDir, '.complete');

  if (fs.existsSync(completeMarker)) {
    onProgress({ phase: 'ready', text: 'Runtime ready' });
    return resolveExecutables(versionDir);
  }

  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.rmSync(versionDir, { recursive: true, force: true });

  const tmpArchive = path.join(os.tmpdir(), `autosubs-runtime-${manifest.version}-${key}.tar.gz`);
  fs.rmSync(tmpArchive, { force: true });

  onProgress({ phase: 'download', pct: 0, text: 'Downloading BananaCut runtime (one-time, ~300MB)…' });
  await download(asset.url, tmpArchive, ({ received, total }) => {
    const pct = total ? Math.round((received / total) * 100) : 0;
    onProgress({
      phase: 'download', pct,
      text: `Downloading runtime… ${pct}% (${(received / 1e6).toFixed(0)}MB${total ? ` / ${(total / 1e6).toFixed(0)}MB` : ''})`,
    });
  });

  if (asset.sha256) {
    onProgress({ phase: 'verify', text: 'Verifying download…' });
    const actual = await sha256File(tmpArchive);
    if (actual.toLowerCase() !== asset.sha256.toLowerCase()) {
      fs.rmSync(tmpArchive, { force: true });
      throw new Error('Runtime download failed checksum verification. Please retry.');
    }
  }

  onProgress({ phase: 'extract', text: 'Installing runtime…' });
  await extractArchive(tmpArchive, versionDir);
  fs.rmSync(tmpArchive, { force: true });

  fs.writeFileSync(completeMarker, new Date().toISOString());
  removeOldVersions(runtimeRoot, manifest.version);

  onProgress({ phase: 'ready', text: 'Runtime ready' });
  return resolveExecutables(versionDir);
}

module.exports = { ensureRuntime, platformKey, resolveExecutables };

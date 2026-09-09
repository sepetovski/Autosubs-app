# AutoSubs

Desktop app (Electron + React + FastAPI/Whisper) for cutting, reframing,
subtitling and clip-finding video for Shorts/Reels — with an in-app
library, saved projects and local usage stats/badges.

## Download

Grab the latest installer from the [Releases page](https://github.com/sepetovski/Autosubs-app/releases):

- **Windows** — `AutoSubs-Setup-x.y.z.exe`
- **macOS (Apple Silicon)** — `AutoSubs-x.y.z-arm64.dmg`

On first launch the app downloads a one-time ~300MB runtime (Python +
Whisper + ffmpeg) before it's usable — this only happens once per major
runtime version, not on every update.

### Windows: "Windows protected your PC" warning

The installer isn't code-signed yet, so Windows SmartScreen will warn on
first run. Click **More info → Run anyway**. The app still auto-updates
normally afterwards.

### macOS: "AutoSubs is damaged and can't be opened"

The macOS build isn't notarized yet, so Gatekeeper blocks it by default.
Either:
- Right-click (or Control-click) the app in Applications → **Open** → **Open** again, or
- Run in Terminal: `xattr -cr /Applications/AutoSubs.app`

macOS builds don't auto-install updates (Apple requires a paid Developer
ID + notarization for that) — the app instead shows a banner linking to
the latest release when one is available.

Only Apple Silicon (M-series) Macs are supported for now; Intel Macs are
not built.

## Development

```bash
# Backend
cd backend
python -m venv venv
./venv/Scripts/activate    # or source venv/bin/activate on macOS/Linux
pip install -r requirements.txt

# Frontend
cd ../frontend
npm install

# Electron
cd ../electron
npm install
npm start                  # runs the venv backend + `vite` dev server (start `npm run dev` in frontend first)
```

The app expects `ffmpeg`/`ffprobe` on your `PATH` in dev mode (or in one
of the OS-specific fallback locations `engine.find_ffmpeg()` checks).

## Architecture

- `electron/` — Electron main process, the `runtime.js` downloader for the
  Python/ffmpeg runtime bundle, and `electron-builder` packaging config.
- `frontend/` — React (Vite) UI: editor, in-app media library, saved
  projects, and a local profile/stats/badges screen.
- `backend/` — FastAPI server (`server.py`), ffmpeg/Whisper pipeline
  (`engine.py`), rule-based clip finder (`clip_finder.py`), and the
  SQLite-backed library/projects/profile layer (`library.py`).

The app installer only ships the small stuff (Electron, the built
frontend, and the backend's `.py` source) and auto-updates through
GitHub Releases. The heavy dependencies — a standalone Python
interpreter, torch, openai-whisper, ffmpeg — live in a separate,
independently-versioned release (see `.github/workflows/build-runtime.yml`)
and are downloaded once into the OS's app-data folder, so most app
updates stay a small download.

## Releasing a new app version

1. Bump `version` in `electron/package.json`.
2. Commit, then tag and push:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
3. `.github/workflows/release.yml` builds Windows + macOS installers and
   publishes them (plus `latest.yml`/`latest-mac.yml` for the updater) to
   the GitHub Release for that tag automatically.

## Releasing a new runtime version

Only needed when `backend/requirements.txt` or the bundled ffmpeg version
changes — most app releases should *not* need this.

1. Go to **Actions → Build runtime → Run workflow**, enter a version.
2. Once it finishes, copy the printed `sha256` values from the run
   summary into `electron/runtime.json` for each platform.
3. Commit `runtime.json` and cut a normal app release (above) so users
   pick up the pointer to the new runtime.

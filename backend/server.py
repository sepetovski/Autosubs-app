"""
AutoSubs — FastAPI Backend Server
"""
from fastapi import FastAPI, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from concurrent.futures import ThreadPoolExecutor
import asyncio, json, os, io, re, base64, mimetypes, subprocess, threading, queue, sys, argparse
from pathlib import Path
from typing import Optional

sys.path.append(os.path.dirname(__file__))
import engine
import clip_finder
import library

app = FastAPI()
app.add_middleware(
    CORSMiddleware, allow_origins=["*"],
    allow_methods=["*"], allow_headers=["*"],
)

progress_queue = queue.Queue()
cancel_flag    = threading.Event()
current_proc   = None

ASPECT_RATIOS = {
    "9:16": 9/16, "1:1": 1.0, "4:5": 4/5,
    "16:9": 16/9, "4:3": 4/3, "21:9": 21/9,
}
SCALE_MAP = {
    "9:16": "1080:1920", "1:1": "1080:1080", "4:5": "864:1080",
    "16:9": "1920:1080", "4:3": "1440:1080", "21:9": "2560:1080",
}

def _crop_rect(sw, sh, target_ratio):
    source_ratio = sw / sh
    if source_ratio > target_ratio:
        cw, ch = int(sh * target_ratio), sh
    else:
        cw, ch = sw, int(sw / target_ratio)
    cw = max(cw - cw % 2, 2)
    ch = max(ch - ch % 2, 2)
    x = (sw - cw) // 2; x -= x % 2
    y = (sh - ch) // 2; y -= y % 2
    return cw, ch, x, y

# ── Compatibility check / normalize ────────────────────────────────────────────

def _probe_codecs(path):
    try:
        cmd = [engine._ffprobe(), "-v", "quiet", "-print_format", "json",
               "-show_streams", str(path)]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10,
                           encoding="utf-8", errors="replace")
        data = json.loads(r.stdout)
        vcodec = acodec = None
        for s in data.get("streams", []):
            if s.get("codec_type") == "video" and vcodec is None:
                vcodec = s.get("codec_name")
            if s.get("codec_type") == "audio" and acodec is None:
                acodec = s.get("codec_name")
        return vcodec, acodec
    except Exception:
        return None, None

def _find_whisper():
    """Argv prefix to invoke Whisper as a module of the *running*
    interpreter. This backend now always runs from source (dev venv, or
    the runtime's own bundled Python in the packaged app) rather than as
    a frozen PyInstaller binary, so `python -m whisper` always resolves
    to the same install that has torch/whisper available."""
    return [sys.executable, "-m", "whisper"]

def _find_ytdlp():
    """Argv prefix to invoke yt-dlp as a module of the running interpreter."""
    return [sys.executable, "-m", "yt_dlp"]

def _check_disk_space(push, need_bytes):
    """Non-blocking disk-space sanity check. Warns (doesn't stop the job —
    ffmpeg/whisper will fail with a clearer error if it actually runs out)
    when free space looks tight relative to the source file."""
    free = engine.free_bytes(engine.SAVE_DIR)
    if free is not None and need_bytes and free < need_bytes:
        push({"type": "log",
              "text": f"⚠ Low disk space: {free / 1e9:.1f} GB free, "
                      f"this job may need ~{need_bytes / 1e9:.1f} GB"})

def _needs_normalize(vcodec, acodec):
    video_ok = vcodec == "h264"
    audio_ok = (acodec is None) or (acodec == "aac")
    return not (video_ok and audio_ok)

def _normalize_video(path, push, force_remux=False):
    global current_proc

    vcodec, acodec = _probe_codecs(path)
    needs_transcode = _needs_normalize(vcodec, acodec)

    if not needs_transcode and not force_remux:
        return str(path)

    ffmpeg_exe, _ = engine.find_ffmpeg()
    if not ffmpeg_exe:
        push({"type": "log", "text": "⚠ ffmpeg not found, skipping optimization"})
        return str(path)

    src_path   = Path(path)
    is_ours    = src_path.parent.resolve() == engine.SAVE_DIR.resolve()
    temp_path  = engine.SAVE_DIR / f".{src_path.stem}_tmp.mp4"
    final_path = src_path if is_ours else engine.SAVE_DIR / f"{src_path.stem}_compat.mp4"

    info = engine.get_video_info(path)
    dur  = info[0] if info else 0

    if needs_transcode:
        push({"type": "phase", "text": "Converting for browser compatibility…"})
        cmd = [ffmpeg_exe, "-y", "-i", str(path),
               "-c:v", "libx264", "-crf", "18", "-preset", "fast",
               "-c:a", "aac", "-b:a", "192k",
               "-movflags", "+faststart", str(temp_path)]
    else:
        push({"type": "phase", "text": "Optimizing for playback…"})
        cmd = [ffmpeg_exe, "-y", "-i", str(path),
               "-c", "copy", "-movflags", "+faststart", str(temp_path)]

    try:
        current_proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT,
                                         text=True, encoding="utf-8", errors="replace")
        for line in current_proc.stdout:
            if cancel_flag.is_set():
                current_proc.terminate()
                push({"type": "log", "text": "⚠ Cancelled"})
                try: temp_path.unlink(missing_ok=True)
                except Exception: pass
                return str(path)
            m = re.search(r"time=(\d+):(\d+):([\d.]+)", line)
            if m and dur:
                e = int(m.group(1))*3600 + int(m.group(2))*60 + float(m.group(3))
                pct = min(99, int(e / dur * 100))
                push({"type": "progress", "pct": pct,
                      "text": f"{'Converting' if needs_transcode else 'Optimizing'}… {pct}%"})
            push({"type": "log", "text": line.rstrip()})
        current_proc.wait()
        rc = current_proc.returncode
    except Exception as e:
        push({"type": "log", "text": f"⚠ Optimization error: {e}"})
        try: temp_path.unlink(missing_ok=True)
        except Exception: pass
        return str(path)

    if rc != 0 or not temp_path.exists():
        push({"type": "log", "text": "⚠ Optimization failed, using original file"})
        try: temp_path.unlink(missing_ok=True)
        except Exception: pass
        return str(path)

    try:
        os.replace(str(temp_path), str(final_path))
    except Exception as e:
        push({"type": "log", "text": f"⚠ Could not finalize file: {e}"})
        return str(temp_path)

    return str(final_path)

# ── Request models ────────────────────────────────────────────────────────────
class LoadVideoRequest(BaseModel):
    path: str

class PrepareRequest(BaseModel):
    path: str

class TextOverlay(BaseModel):
    text:  str   = ""
    y:     float = 0.15
    size:  int   = 40
    color: str   = "#ffffff"

class RenderRequest(BaseModel):
    video_path:     str
    output_name:    str   = ""
    add_subtitles:  bool  = True
    text_overlays:  list[TextOverlay] = []
    aspect:         str   = "9:16"
    bg_color:       str   = "#000000"
    video_y_offset: float = 0.5
    do_trim:        bool  = False
    trim_start:     Optional[float] = None
    trim_end:       Optional[float] = None
    model:          str   = "medium"
    language:       str   = "English"
    font_path:      str   = ""
    base_size:      int   = 55
    active_size:    int   = 80
    color_base:     str   = "#ffffff"
    color_active:   str   = "#ffd200"
    subtitle_y:     float = 0.82
    # Path to a full-video Whisper transcript (produced by /analyze) to
    # reuse instead of re-running Whisper on this render's own clip. The
    # transcript is sliced down to [trim_start, trim_end] and re-timed to
    # the clip's own t=0. None/missing → falls back to transcribing fresh.
    transcript_json: Optional[str] = None

class DownloadRequest(BaseModel):
    url:     str
    quality: str = "1080p"

class AnalyzeRequest(BaseModel):
    path:     str
    model:    str   = "tiny"
    language: str   = "English"
    min_len:  float = 20.0
    max_len:  float = 60.0
    want:     int   = 6

class ClipSpec(BaseModel):
    start: float
    end:   float
    title: str = ""

class BatchRenderRequest(RenderRequest):
    clips: list[ClipSpec] = []

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/ping")
def ping():
    return {"status": "ok"}


@app.get("/browse")
def browse_file():
    if engine.IS_MAC:
        script = (
            'tell application "System Events"\nactivate\n'
            'set f to choose file with prompt "Select a video file" '
            'of type {"mp4","mov","avi","mkv","webm","MP4","MOV","AVI","MKV"}\n'
            'return POSIX path of f\nend tell'
        )
        try:
            r = subprocess.run(["osascript", "-e", script],
                               capture_output=True, text=True, timeout=120)
            return {"path": r.stdout.strip()}
        except Exception as e:
            return {"path": "", "error": str(e)}
    elif engine.IS_WIN:
        result = {"path": ""}
        def _pick():
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk(); root.withdraw()
            root.wm_attributes("-topmost", 1)
            result["path"] = filedialog.askopenfilename(
                title="Select a video file",
                filetypes=[("Video files","*.mp4 *.mov *.avi *.mkv *.webm"),
                           ("All files","*.*")])
            root.destroy()
        t = threading.Thread(target=_pick); t.start(); t.join(timeout=120)
        return {"path": result["path"] or ""}
    return {"path": ""}


@app.get("/video")
async def serve_video(path: str, request: Request):
    if not os.path.exists(path):
        from fastapi.responses import JSONResponse
        return JSONResponse({"error": "not found"}, status_code=404)

    mime, _ = mimetypes.guess_type(path)
    if not mime or not mime.startswith("video"):
        mime = "video/mp4"

    file_size = os.path.getsize(path)
    range_hdr = request.headers.get("range", "")
    m = re.match(r"bytes=(\d+)-(\d*)", range_hdr)

    if m:
        start  = int(m.group(1))
        end    = int(m.group(2)) if m.group(2) else file_size - 1
        end    = min(end, file_size - 1)
        length = end - start + 1

        def stream_range():
            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk: break
                    remaining -= len(chunk)
                    yield chunk

        return StreamingResponse(stream_range(), status_code=206, media_type=mime,
            headers={"Content-Range":  f"bytes {start}-{end}/{file_size}",
                     "Accept-Ranges":  "bytes",
                     "Content-Length": str(length)})

    def stream_all():
        with open(path, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk: break
                yield chunk

    return StreamingResponse(stream_all(), media_type=mime,
        headers={"Accept-Ranges": "bytes", "Content-Length": str(file_size)})


@app.get("/thumbnails")
async def get_thumbnails(path: str, count: int = 24):
    if not os.path.exists(path):
        return {"thumbnails": []}
    info = engine.get_video_info(path)
    if not info or not info[0]:
        return {"thumbnails": []}
    dur = info[0]

    def _one(i):
        t = (i / count) * dur
        img = engine.extract_thumb(path, t=t)
        if not img:
            return None
        buf = io.BytesIO()
        img.thumbnail((120, 68))
        img.save(buf, format="JPEG", quality=55)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

    with ThreadPoolExecutor(max_workers=6) as ex:
        thumbs = list(ex.map(_one, range(count)))

    return {"thumbnails": thumbs, "duration": dur}


@app.post("/load-video")
def load_video(req: LoadVideoRequest):
    result = engine.get_video_info(req.path)
    if not result: return {"error": "Could not read video info"}
    dur, fps, (w, h) = result
    try:
        library.register_source(req.path, source="import")
    except Exception:
        pass
    return {"duration": dur, "fps": fps, "width": w, "height": h,
            "filename": Path(req.path).name}


@app.post("/prepare")
def prepare(req: PrepareRequest, background_tasks: BackgroundTasks):
    cancel_flag.clear()
    while not progress_queue.empty(): progress_queue.get_nowait()
    background_tasks.add_task(_run_prepare, req.path)
    return {"status": "started"}


@app.post("/cancel")
def cancel():
    global current_proc
    cancel_flag.set()
    if current_proc:
        engine.kill_proc_tree(current_proc)
    # Push the cancellation ourselves, immediately — don't wait for the
    # background worker thread to notice the flag on its own. That thread
    # may be blocked reading a subprocess pipe for a while yet, and the
    # user should see an instant, clean "Cancelled" instead of a hang
    # followed eventually by an unrelated-looking error.
    progress_queue.put({"type": "cancelled", "text": "Cancelled"})
    return {"status": "cancelled"}


@app.get("/progress")
async def progress():
    async def stream():
        while True:
            try:
                msg = progress_queue.get(timeout=0.2)
                yield f"data: {json.dumps(msg)}\n\n"
                if msg.get("type") in ("done", "error", "cancelled"): break
            except queue.Empty:
                yield ": heartbeat\n\n"
                await asyncio.sleep(0.1)
    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/render")
def render(req: RenderRequest, background_tasks: BackgroundTasks):
    cancel_flag.clear()
    while not progress_queue.empty(): progress_queue.get_nowait()
    background_tasks.add_task(_run_render_pipeline, req)
    return {"status": "started"}


@app.post("/analyze")
def analyze(req: AnalyzeRequest, background_tasks: BackgroundTasks):
    cancel_flag.clear()
    while not progress_queue.empty():
        try: progress_queue.get_nowait()
        except queue.Empty: break
    background_tasks.add_task(_run_analyze, req)
    return {"status": "started"}

@app.post("/render-batch")
def render_batch(req: BatchRenderRequest, background_tasks: BackgroundTasks):
    cancel_flag.clear()
    while not progress_queue.empty():
        try: progress_queue.get_nowait()
        except queue.Empty: break
    background_tasks.add_task(_run_render_batch, req)
    return {"status": "started"}

@app.post("/download")
def download(req: DownloadRequest, background_tasks: BackgroundTasks):
    cancel_flag.clear()
    while not progress_queue.empty(): progress_queue.get_nowait()
    background_tasks.add_task(_run_download, req)
    return {"status": "started"}


# ── Library ───────────────────────────────────────────────────────────────

class MediaPatch(BaseModel):
    title: Optional[str] = None
    tags:  Optional[str] = None

class RevealRequest(BaseModel):
    path: str

@app.get("/thumb")
def get_thumb(path: str):
    from fastapi.responses import FileResponse, JSONResponse
    # Only ever serve files from our own thumbnail cache — never an
    # arbitrary path — since this is reachable with just a query string.
    try:
        resolved = Path(path).resolve()
        resolved.relative_to(engine.THUMB_DIR.resolve())
    except Exception:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    if not resolved.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(str(resolved), media_type="image/jpeg")


@app.get("/library")
def library_list(kind: Optional[str] = None, search: Optional[str] = None, sort: str = "date"):
    return {"items": library.list_media(kind=kind, search=search, sort=sort)}

@app.get("/library/{media_id}")
def library_get(media_id: str):
    item = library.get_media(media_id)
    if not item: return {"error": "not found"}
    return item

@app.patch("/library/{media_id}")
def library_patch(media_id: str, req: MediaPatch):
    patch = {k: v for k, v in req.dict().items() if v is not None}
    item = library.update_media(media_id, patch)
    if not item: return {"error": "not found"}
    return item

@app.delete("/library/{media_id}")
def library_delete(media_id: str, delete_file: bool = False):
    ok = library.delete_media(media_id, delete_file=delete_file)
    return {"status": "ok" if ok else "not found"}

@app.post("/library/reveal")
def library_reveal(req: RevealRequest):
    ok = library.reveal_in_folder(req.path)
    return {"status": "ok" if ok else "failed"}

@app.post("/library/scan")
def library_scan():
    added = library.scan_save_dir()
    return {"added": added}


# ── Projects ──────────────────────────────────────────────────────────────

class ProjectSave(BaseModel):
    id:               Optional[str] = None
    name:             str = "Untitled project"
    source_media_id:  Optional[str] = None
    settings:         dict = {}
    clips:            list = []
    transcript_path:  Optional[str] = None

@app.get("/projects")
def projects_list():
    return {"items": library.list_projects()}

@app.get("/projects/{project_id}")
def projects_get(project_id: str):
    p = library.get_project(project_id)
    if not p: return {"error": "not found"}
    return p

@app.post("/projects")
def projects_save(req: ProjectSave):
    return library.upsert_project(
        req.id, name=req.name, source_media_id=req.source_media_id,
        settings=req.settings, clips=req.clips, transcript_path=req.transcript_path,
    )

@app.delete("/projects/{project_id}")
def projects_delete(project_id: str):
    library.delete_project(project_id)
    return {"status": "ok"}


# ── Profile & stats ───────────────────────────────────────────────────────

class ProfilePatch(BaseModel):
    name:   Optional[str] = None
    avatar: Optional[str] = None

@app.get("/profile")
def profile_get():
    return library.get_profile()

@app.patch("/profile")
def profile_patch(req: ProfilePatch):
    patch = {k: v for k, v in req.dict().items() if v is not None}
    return library.update_profile(patch)

@app.get("/stats")
def stats_get():
    return library.compute_stats()


# ── Workers ───────────────────────────────────────────────────────────────────

def _run_prepare(path: str):
    def push(msg):
        msg["op"] = "prepare"
        progress_queue.put(msg)

    if not os.path.exists(path):
        push({"type": "error", "text": "File not found"})
        return

    push({"type": "phase", "text": "Checking video…"})
    push({"type": "progress", "pct": 10, "text": "Probing format…"})

    final_path = _normalize_video(path, push, force_remux=False)

    push({"type": "progress", "pct": 100, "text": "Ready"})
    push({"type": "done", "output_path": final_path})


def _transcribe(video_path, model, language, push, pct_from=33, pct_to=67,
                json_out=None, cancelled=None, duration=None):
    """Run Whisper CLI on video_path with word timestamps. Returns the path
    to the produced JSON, or None on failure/cancel. Progress is mapped
    into [pct_from, pct_to]."""
    global current_proc
    save_dir = engine.SAVE_DIR
    if json_out is None:
        json_out = save_dir / f"{Path(video_path).stem}.json"
    json_out = Path(json_out)
    if cancelled is None:
        cancelled = cancel_flag.is_set

    cmd_w = _find_whisper() + [os.path.abspath(video_path),
             "--model", model, "--model_dir", str(engine.models_dir()),
             "--word_timestamps", "True",
             "--output_format", "json", "--output_dir", str(json_out.parent)]
    if language != "Auto-detect": cmd_w += ["--language", language]

    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    # Whisper's own internal audio decoder shells out to a bare
    # "ffmpeg" with no way to point it elsewhere. Invisible in dev
    # (Homebrew's ffmpeg is already on PATH) — but a Finder-launched
    # real app gets a minimal PATH with no Homebrew on it at all, so
    # we hand it our bundled ffmpeg's folder directly.
    _, ffmpeg_dir = engine.find_ffmpeg()
    if ffmpeg_dir:
        env["PATH"] = f"{ffmpeg_dir}{os.pathsep}{env.get('PATH', '')}"

    # Whisper can fail on a file internally, print "Skipping ... due
    # to ...", and still exit 0 — so a clean exit code alone doesn't
    # prove a transcript actually got made. Clearing out any old file
    # first means "it exists afterward" is trustworthy.
    # Whisper always names the output <input stem>.json inside output_dir.
    whisper_out = json_out.parent / f"{Path(video_path).stem}.json"
    for p in {json_out, whisper_out}:
        try: p.unlink(missing_ok=True)
        except Exception: pass

    current_proc = subprocess.Popen(
        cmd_w, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", env=env)

    span = pct_to - pct_from
    for line in current_proc.stdout:
        if cancelled(): current_proc.terminate(); break
        line = line.rstrip()
        if not line: continue
        push({"type": "log", "text": line})
        m = re.search(r"(\d+)%\|", line)
        if m:
            pct = pct_from + int(int(m.group(1)) * span / 100)
            push({"type": "progress", "pct": pct, "text": f"Transcribing… {m.group(1)}%"})
        elif duration:
            # Whisper prints "[MM:SS.mmm --> MM:SS.mmm] text" per segment.
            ts = re.search(r"-->\s*(\d+):(\d+)(?::(\d+))?\.(\d+)\]", line)
            if ts:
                h, mnt, sec, ms = ts.groups()
                if sec is None:
                    t = int(h) * 60 + int(mnt) + int(ms) / 1000
                else:
                    t = int(h) * 3600 + int(mnt) * 60 + int(sec) + int(ms) / 1000
                frac = max(0.0, min(1.0, t / duration))
                push({"type": "progress", "pct": pct_from + int(frac * span),
                      "text": f"Transcribing… {int(frac * 100)}%"})

    current_proc.wait()
    if cancelled(): return None
    if current_proc.returncode != 0 or not whisper_out.exists():
        return None
    if whisper_out != json_out:
        try: os.replace(str(whisper_out), str(json_out))
        except Exception:
            _record_transcribed(duration, language)
            return whisper_out
    _record_transcribed(duration, language)
    return json_out


def _record_transcribed(duration, language):
    try:
        library.record_event("transcribed", {
            "minutes": (duration or 0) / 60.0,
            "language": language,
        })
    except Exception:
        pass


def _run_render_pipeline(req: RenderRequest, push=None, media_kind="output"):
    global current_proc
    if push is None:
        def push(msg):
            msg["op"] = "render"
            progress_queue.put(msg)

    save_dir = engine.SAVE_DIR
    stem     = Path(req.video_path).stem
    src      = os.path.abspath(req.video_path)

    try:
        _check_disk_space(push, os.path.getsize(src) * 2)
    except OSError:
        pass

    out_stem = req.output_name.strip() if req.output_name.strip() else f"{stem}_subtitled"
    out_stem = re.sub(r'[<>:"/\\|?*]', '_', out_stem)
    output   = save_dir / f"{out_stem}.mp4"

    def cancelled(): return cancel_flag.is_set()

    want_subs       = req.add_subtitles
    active_overlays = [ov.dict() for ov in req.text_overlays if ov.text.strip()]
    need_burn       = want_subs or len(active_overlays) > 0
    need_ffmpeg     = req.do_trim or (req.aspect != "Original")

    # ── Phase 1: Cut & Reframe ────────────────────────────────────────────────
    # If nothing needs burning (no subtitles, no text overlays), this writes
    # DIRECTLY to the final output name — no intermediate file ever exists.
    work_video = src

    if need_ffmpeg:
        cut_target = (save_dir / f"{stem}_work.mp4") if need_burn else output
        push({"type": "phase", "text": "Cutting & Reframing"})
        ffmpeg_exe, _ = engine.find_ffmpeg()
        if not ffmpeg_exe:
            push({"type": "error", "text": "ffmpeg not found"}); return

        if req.aspect == "9:16F":
            bg  = (req.bg_color or "#000000").lstrip("#")
            pos = req.video_y_offset if req.video_y_offset is not None else 0.5
            filt = (f"[0:v]scale=1080:-2[vid];"
                    f"color=c=0x{bg}:s=1080x1920[bg];"
                    f"[bg][vid]overlay=(W-w)/2:'(H-h)*{pos}':shortest=1[out]")
            cmd = [ffmpeg_exe, "-y"]
            if req.do_trim and req.trim_start is not None:
                cmd += ["-ss", str(req.trim_start)]
            cmd += ["-i", src]
            if req.do_trim and req.trim_end is not None:
                cmd += ["-t", str(req.trim_end - (req.trim_start or 0))]
            cmd += ["-filter_complex", filt, "-map", "[out]", "-map", "0:a?",
                    "-c:v", "libx264", "-crf", "18", "-preset", "fast",
                    "-c:a", "aac", "-b:a", "192k"]
            if not need_burn:
                cmd += ["-movflags", "+faststart"]
            cmd += [str(cut_target)]
        else:
            vf = []
            if req.aspect in ASPECT_RATIOS:
                info = engine.get_video_info(src)
                if not info:
                    push({"type": "error", "text": "Could not read video dimensions"}); return
                _, _, (sw, sh) = info
                cw, ch, x, y = _crop_rect(sw, sh, ASPECT_RATIOS[req.aspect])
                vf.append(f"crop={cw}:{ch}:{x}:{y}")
            if req.aspect in SCALE_MAP:
                vf.append(f"scale={SCALE_MAP[req.aspect]}")

            cmd = [ffmpeg_exe, "-y"]
            if req.do_trim and req.trim_start is not None:
                cmd += ["-ss", str(req.trim_start)]
            cmd += ["-i", src]
            if req.do_trim and req.trim_end is not None:
                cmd += ["-t", str(req.trim_end - (req.trim_start or 0))]
            if vf: cmd += ["-vf", ",".join(vf)]
            cmd += ["-c:v", "libx264", "-crf", "18", "-preset", "fast",
                    "-c:a", "aac", "-b:a", "192k"]
            if not need_burn:
                cmd += ["-movflags", "+faststart"]
            cmd += [str(cut_target)]

        current_proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace")

        cap = 33 if need_burn else 99
        for line in current_proc.stdout:
            if cancelled(): current_proc.terminate(); break
            m = re.search(r"time=(\d+):(\d+):([\d.]+)", line)
            if m:
                e = int(m.group(1))*3600 + int(m.group(2))*60 + float(m.group(3))
                push({"type": "progress", "pct": min(cap, int(e * 2)), "text": "Cutting…"})
            push({"type": "log", "text": line.rstrip()})

        current_proc.wait()
        if cancelled() or current_proc.returncode != 0:
            push({"type": "error", "text": "Cut failed"}); return

        work_video = str(cut_target)
        if need_burn:
            push({"type": "progress", "pct": 33, "text": "Cut complete"})
        else:
            push({"type": "progress", "pct": 100, "text": "Done!"})
    else:
        if need_burn:
            push({"type": "phase",    "text": "Cut skipped"})
            push({"type": "progress", "pct": 33, "text": "No cut needed"})
        else:
            push({"type": "phase", "text": "Preparing clip"})
            ffmpeg_exe, _ = engine.find_ffmpeg()
            if not ffmpeg_exe:
                push({"type": "error", "text": "ffmpeg not found"}); return
            cmd = [ffmpeg_exe, "-y", "-i", src, "-c", "copy",
                   "-movflags", "+faststart", str(output)]
            current_proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace")
            for line in current_proc.stdout:
                if cancelled(): current_proc.terminate(); break
                push({"type": "log", "text": line.rstrip()})
            current_proc.wait()
            if cancelled() or current_proc.returncode != 0:
                push({"type": "error", "text": "Export failed"}); return
            push({"type": "progress", "pct": 100, "text": "Done!"})

    if cancelled(): return

    if not need_burn:
        try:
            library.register_output(str(output), kind=media_kind)
        except Exception:
            pass
        push({"type": "done", "output_path": str(output)})
        return

    # ── Transcribe (only if karaoke subtitles are wanted) ────────────────────
    json_out          = None
    phase3_start_pct  = 33

    if want_subs:
        reusable = (req.transcript_json
                    and os.path.exists(req.transcript_json))

        if reusable:
            push({"type": "phase", "text": "Reusing cached transcript"})
            push({"type": "progress", "pct": 45, "text": "Slicing transcript…"})
            clip_start = req.trim_start if (req.do_trim and req.trim_start is not None) else 0.0
            if req.do_trim and req.trim_end is not None:
                clip_end = req.trim_end
            else:
                full_info = engine.get_video_info(src)
                clip_end  = full_info[0] if full_info else None
            try:
                sliced = clip_finder.slice_transcript(req.transcript_json, clip_start,
                                                       clip_end if clip_end is not None else 1e12)
            except Exception as e:
                sliced = None
                push({"type": "log", "text": f"⚠ Could not reuse transcript ({e}), re-transcribing"})

            if sliced and sliced.get("segments"):
                json_out = save_dir / f"{Path(work_video).stem}.json"
                with open(json_out, "w", encoding="utf-8") as f:
                    json.dump(sliced, f)
                push({"type": "progress", "pct": 67, "text": "Transcript ready (reused)"})
                phase3_start_pct = 67
                push({"type": "phase", "text": "Phase 3 / 3 — Burning Subtitles"})
            else:
                reusable = False
                push({"type": "log", "text": "⚠ Reused transcript had no words in range, re-transcribing"})

        if not reusable or not json_out:
            push({"type": "phase", "text": "Phase 2 / 3 — Transcribing"})
            _wi = engine.get_video_info(work_video)
            json_out = _transcribe(work_video, req.model, req.language, push,
                                   pct_from=33, pct_to=67, cancelled=cancelled,
                                   duration=_wi[0] if _wi else None)
            if cancelled(): return
            if json_out is None:
                push({"type": "error", "text": "Transcription failed — no transcript was produced"})
                return

            push({"type": "progress", "pct": 67, "text": "Transcript ready"})
            phase3_start_pct = 67
            push({"type": "phase", "text": "Phase 3 / 3 — Burning Subtitles"})
    else:
        push({"type": "phase", "text": "Adding Text Overlay"})

    if cancelled(): return

    # ── Burn ──────────────────────────────────────────────────────────────────
    def log_fn(msg, tag=None): push({"type": "log", "text": msg})
    def prog_cb(pct):
        remaining = 100 - phase3_start_pct
        push({"type": "progress", "pct": phase3_start_pct + int(pct * remaining / 100),
              "text": f"Burning… {pct}%"})

    ok = engine.burn_subtitles(
        work_video, str(json_out) if json_out else None, output, log_fn, prog_cb,
        font_path     = req.font_path or engine.SUBTITLE_FONT,
        base_size     = req.base_size,
        active_size   = req.active_size,
        color_base    = engine.hex_to_rgb(req.color_base),
        color_active  = engine.hex_to_rgb(req.color_active),
        cancel_flag   = cancel_flag,
        subtitle_y    = req.subtitle_y,
        text_overlays = active_overlays,
    )

    if ok:
        if need_ffmpeg:
            try: Path(work_video).unlink(missing_ok=True)
            except Exception: pass
        try:
            library.register_output(str(output), kind=media_kind)
        except Exception:
            pass
        push({"type": "progress", "pct": 100, "text": "Done!"})
        push({"type": "done", "output_path": str(output)})
    else:
        push({"type": "error", "text": "Burn failed"})


def _run_analyze(req: AnalyzeRequest):
    def push(msg):
        msg["op"] = "analyze"
        progress_queue.put(msg)

    src = os.path.abspath(req.path)
    if not os.path.exists(src):
        push({"type": "error", "text": "File not found"}); return

    info = engine.get_video_info(src)
    duration = info[0] if info else 0.0

    json_out = engine.SAVE_DIR / f"{Path(src).stem}_full_{req.model}.json"
    use_cache = (json_out.exists()
                 and json_out.stat().st_mtime >= os.path.getmtime(src)
                 and json_out.stat().st_size > 0)

    if use_cache:
        push({"type": "phase", "text": "Using cached transcript"})
        push({"type": "progress", "pct": 80, "text": "Transcript cached"})
    else:
        push({"type": "phase", "text": f"Transcribing full video ({req.model})"})
        push({"type": "progress", "pct": 2, "text": "Starting Whisper…"})
        result = _transcribe(src, req.model, req.language, push,
                             pct_from=2, pct_to=80, json_out=json_out,
                             duration=duration)
        if cancel_flag.is_set(): return
        if result is None:
            push({"type": "error", "text": "Transcription failed — no transcript was produced"})
            return
        json_out = Path(result)

    push({"type": "phase", "text": "Scoring clips"})
    push({"type": "progress", "pct": 90, "text": "Finding the best moments…"})
    try:
        clips = clip_finder.find_clips(json_out, duration,
                                       min_len=req.min_len, max_len=req.max_len,
                                       want=req.want)
    except Exception as e:
        push({"type": "error", "text": f"Clip scoring failed: {e}"}); return

    if not clips:
        push({"type": "log", "text": "No clips matched the length constraints."})
    push({"type": "progress", "pct": 100, "text": f"{len(clips)} clip(s) found"})
    push({"type": "done", "clips": clips, "transcript_path": str(json_out)})


def _run_render_batch(req: BatchRenderRequest):
    def push(msg):
        msg["op"] = "batch"
        progress_queue.put(msg)

    clips = [c for c in req.clips if c.end > c.start]
    if not clips:
        push({"type": "error", "text": "No clips selected"}); return

    total   = len(clips)
    stem    = Path(req.video_path).stem
    outputs = []
    failed  = []

    for idx, clip in enumerate(clips):
        if cancel_flag.is_set():
            break

        # AI-suggested titles are shown to the user for review only — they
        # are not filesystem-safe/stable enough to bake into saved
        # filenames, so the file itself just gets a plain clip number.
        name = f"{stem}_clip{idx+1}"

        sub_req = RenderRequest(**{
            **req.dict(exclude={"clips"}),
            "output_name": name,
            "do_trim":     True,
            "trim_start":  clip.start,
            "trim_end":    clip.end,
        })

        result = {}
        lo = int(idx * 100 / total)
        hi = int((idx + 1) * 100 / total)

        def sub_push(msg, lo=lo, hi=hi, idx=idx, result=result):
            t = msg.get("type")
            if t == "done":
                result["output_path"] = msg.get("output_path"); return
            if t == "error":
                result["error"] = msg.get("text", "failed"); return
            if t == "phase":
                msg["text"] = f"Clip {idx+1} / {total} — {msg['text']}"
            if t == "progress":
                msg["pct"] = lo + int(msg.get("pct", 0) * (hi - lo) / 100)
            push(msg)

        push({"type": "phase", "text": f"Clip {idx+1} / {total} — Starting"})
        _run_render_pipeline(sub_req, push=sub_push, media_kind="clip")

        if cancel_flag.is_set():
            break
        if result.get("output_path"):
            outputs.append(result["output_path"])
            push({"type": "clip_done", "index": idx, "output_path": result["output_path"]})
        else:
            failed.append({"index": idx, "error": result.get("error", "unknown")})
            push({"type": "log", "text": f"✘ Clip {idx+1} failed: {result.get('error')}"})

    if cancel_flag.is_set():
        push({"type": "cancelled", "text": f"Cancelled after {len(outputs)} clip(s)"}); return

    if not outputs:
        push({"type": "error", "text": "All clips failed"}); return

    push({"type": "progress", "pct": 100, "text": f"{len(outputs)} / {total} clips rendered"})
    push({"type": "done", "outputs": outputs, "failed": failed,
          "output_path": outputs[0]})


def _run_download(req: DownloadRequest):
    global current_proc
    def push(msg):
        msg["op"] = "download"
        progress_queue.put(msg)

    fmt_map  = engine.YT_QUALITY
    fmt      = fmt_map.get(req.quality, fmt_map["1080p"])
    is_audio = req.quality == "Audio (MP3)"

    out_tmpl      = str(engine.SAVE_DIR / "%(title).60s.%(ext)s")
    _, ffmpeg_dir = engine.find_ffmpeg()

    cmd = _find_ytdlp() + ["--newline", "-f", fmt, "-o", out_tmpl]
    if ffmpeg_dir: cmd += ["--ffmpeg-location", ffmpeg_dir]
    if not is_audio: cmd += ["--merge-output-format", "mp4"]
    if is_audio:     cmd += ["-x", "--audio-format", "mp3"]
    cmd.append(req.url)

    current_proc    = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace")
    downloaded_file = None

    for line in current_proc.stdout:
        line = line.rstrip()
        if not line: continue
        push({"type": "log", "text": line})
        m = re.search(r"\[download\]\s+([\d.]+)%", line)
        if m: push({"type": "progress", "pct": float(m.group(1)),
                    "text": f"Downloading… {m.group(1)}%"})
        mm = re.search(r'\[Merger\] Merging formats into ["\']?(.+?)["\']?\s*$', line)
        if mm: downloaded_file = mm.group(1).strip().strip('"\'')
        dm = re.search(r"\[(?:download|ExtractAudio)\].*?Destination:\s+(.+)", line)
        if dm: downloaded_file = dm.group(1).strip()

    current_proc.wait()
    if current_proc.returncode != 0:
        push({"type": "error", "text": "Download failed"})
        return

    final_path = downloaded_file or ""
    if final_path and not is_audio and os.path.exists(final_path):
        push({"type": "progress", "pct": 100, "text": "Download complete — checking compatibility…"})
        final_path = _normalize_video(final_path, push, force_remux=True)

    if final_path and os.path.exists(final_path):
        try:
            library.register_source(final_path, source="download")
        except Exception:
            pass

    push({"type": "progress", "pct": 100, "text": "Ready"})
    push({"type": "done", "output_path": final_path, "auto_load": True})


if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("AUTOSUBS_PORT", 8742)))
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port)
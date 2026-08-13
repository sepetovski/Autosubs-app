"""
AutoSubs — Engine (pure functions, no UI)
"""
import subprocess, json, os, io, sys, shutil
import numpy as np
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"

def find_ffmpeg():
    if getattr(sys, "frozen", False):
        # Packaged app — ffmpeg sits in a sibling "ffmpeg" folder under the
        # same shared resources directory as this executable.
        bundled_dir = Path(sys._MEIPASS).parent.parent / "ffmpeg"
        exe = bundled_dir / ("ffmpeg.exe" if IS_WIN else "ffmpeg")
        if exe.exists():
            return str(exe), str(bundled_dir)
    if IS_WIN:
        win_dirs = [r"C:\ffmpeg\bin", r"C:\ffmpeg", r"C:\Program Files\ffmpeg\bin"]
        for d in win_dirs:
            exe = os.path.join(d, "ffmpeg.exe")
            if os.path.exists(exe):
                return exe, d
        exe = shutil.which("ffmpeg")
        return (exe, None) if exe else (None, None)
    else:
        mac_paths = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
        for p in mac_paths:
            if os.path.exists(p):
                return p, None
        exe = shutil.which("ffmpeg")
        return (exe, None) if exe else (None, None)

def _ffprobe():
    exe, _ = find_ffmpeg()
    if exe:
        candidate = os.path.join(os.path.dirname(exe), "ffprobe" + (".exe" if IS_WIN else ""))
        if os.path.exists(candidate): return candidate
    return shutil.which("ffprobe") or "ffprobe"

def _default_save_dir():
    d = (Path.home() / "Movies" / "AutoSubs") if IS_MAC else (Path.home() / "AutoSubs")
    d.mkdir(parents=True, exist_ok=True)
    return d

SAVE_DIR = _default_save_dir()

def _default_font():
    if IS_WIN:
        for p in [r"C:\Windows\Fonts\arialbd.ttf", r"C:\Windows\Fonts\arial.ttf",
                  r"C:\Windows\Fonts\calibrib.ttf", r"C:\Windows\Fonts\verdanab.ttf"]:
            if os.path.exists(p): return p
        d = r"C:\Windows\Fonts"
        if os.path.isdir(d):
            for f in os.listdir(d):
                if f.lower().endswith(".ttf"): return os.path.join(d, f)
    for p in ["/System/Library/Fonts/Supplemental/Arial Bold.ttf",
              "/System/Library/Fonts/Supplemental/Arial.ttf",
              "/Library/Fonts/Arial Bold.ttf", "/Library/Fonts/Arial.ttf",
              "/System/Library/Fonts/Helvetica.ttc"]:
        if os.path.exists(p): return p
    for d in ["/Library/Fonts", "/System/Library/Fonts/Supplemental"]:
        if os.path.isdir(d):
            for f in os.listdir(d):
                if f.lower().endswith((".ttf", ".otf")): return os.path.join(d, f)
    return ""

SUBTITLE_FONT         = _default_font()
BASE_SIZE             = 55
ACTIVE_SIZE           = 80
CHUNK_SIZE            = 4
SUBTITLE_COLOR_BASE   = (255, 255, 255)
SUBTITLE_COLOR_ACTIVE = (255, 210, 0)

YT_QUALITY = {
    "4K / Best":   "bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
    "1080p":       "bestvideo[height<=1080][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]",
    "720p":        "bestvideo[height<=720][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]",
    "480p":        "bestvideo[height<=480][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]",
    "360p":        "bestvideo[height<=360][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]",
    "240p":        "bestvideo[height<=240][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=240][ext=mp4]+bestaudio[ext=m4a]/best[height<=240]",
    "Audio (MP3)": "bestaudio/best",
}

_font_cache: dict = {}

def _get_font(path: str, size: int):
    key = (path, size)
    if key not in _font_cache:
        loaded = False
        if path:
            try: _font_cache[key] = ImageFont.truetype(path, size); loaded = True
            except Exception: pass
        if not loaded:
            try: _font_cache[key] = ImageFont.load_default(size=size)
            except TypeError: _font_cache[key] = ImageFont.load_default()
    return _font_cache[key]

def _build_chunk_index(segments):
    words = []
    for seg in segments:
        for w in seg.get("words", []):
            word = w["word"].strip()
            if word: words.append({"word": word, "start": w["start"], "end": w["end"]})
    words.sort(key=lambda w: w["start"])
    chunks     = [words[i:i+CHUNK_SIZE] for i in range(0, len(words), CHUNK_SIZE)]
    chunk_ends = [c[-1]["end"] for c in chunks]
    return chunks, chunk_ends

def _get_active_chunk(t, chunks, chunk_ends):
    import bisect
    idx = bisect.bisect_left(chunk_ends, t)
    for i in range(max(0, idx - 1), min(len(chunks), idx + 2)):
        chunk = chunks[i]
        if chunk[0]["start"] <= t <= chunk[-1]["end"]:
            for j, w in enumerate(chunk):
                if w["start"] <= t <= w["end"]: return chunk, j
            return chunk, None
    return None, None

def burn_subtitles(video_path, json_path, output_path, log_fn, prog_cb,
                   font_path=None, base_size=None, active_size=None,
                   color_base=None, color_active=None, cancel_flag=None,
                   subtitle_y=0.82, text_overlays=None):
    """Draws karaoke-style word subtitles (if json_path is given) and/or
    static text overlays (if text_overlays is given) onto every frame.
    json_path may be None — pass None to skip word subtitles entirely and
    only burn static text."""
    try:
        from moviepy import VideoFileClip, VideoClip
    except ImportError as e:
        log_fn(f"ERROR: moviepy import failed — {e}", "error");
        return False
    
    _fp  = font_path    or SUBTITLE_FONT
    _bs  = base_size    or BASE_SIZE
    _as_ = active_size  or ACTIVE_SIZE
    _cb  = color_base   or SUBTITLE_COLOR_BASE
    _ca  = color_active or SUBTITLE_COLOR_ACTIVE
    text_overlays = text_overlays or []

    log_fn("Loading film reel…")
    video = VideoFileClip(str(video_path))
    W, H  = int(video.w), int(video.h)

    chunks, chunk_ends = [], []
    if json_path:
        with open(json_path) as f:
            data = json.load(f)
        chunks, chunk_ends = _build_chunk_index(data.get("segments", []))
        if not chunks:
            log_fn("ERROR: No word-level timestamps found.", "error"); return False

    fnt_base   = _get_font(_fp, _bs)
    fnt_active = _get_font(_fp, _as_)

    # Pre-resolve static overlays once — text, font, color, position — so
    # nothing gets recomputed on every single video frame.
    overlay_items = []
    for ov in text_overlays:
        txt = (ov.get("text") or "").strip()
        if not txt:
            continue
        size  = max(8, int(ov.get("size", 40)))
        color = ov.get("color") or (255, 255, 255)
        if isinstance(color, str):
            color = hex_to_rgb(color)
        overlay_items.append({
            "text":  txt,
            "y":     float(ov.get("y", 0.15)),
            "font":  _get_font(_fp, size),
            "color": color,
        })

    dur = video.duration

    def draw_frame(img, t):
        draw = ImageDraw.Draw(img)

        for ov in overlay_items:
            bbox = ov["font"].getbbox(ov["text"])
            tw   = bbox[2] - bbox[0]
            x    = max(0, (W - tw) // 2)
            y    = int(H * ov["y"])
            for dx, dy in [(-3,0),(3,0),(0,-3),(0,3),(-2,-2),(2,-2),(-2,2),(2,2)]:
                draw.text((x+dx, y+dy), ov["text"], font=ov["font"], fill=(0,0,0), anchor="lm")
            draw.text((x, y), ov["text"], font=ov["font"], fill=ov["color"], anchor="lm")

        if chunks:
            chunk, aidx = _get_active_chunk(t, chunks, chunk_ends)
            if chunk is not None:
                items = []
                for i, w in enumerate(chunk):
                    active = (i == aidx)
                    fnt    = fnt_active if active else fnt_base
                    txt    = w["word"] + " "
                    bbox   = fnt.getbbox(txt)
                    items.append({"text": txt, "font": fnt,
                                  "width": bbox[2] - bbox[0], "active": active})
                total = sum(it["width"] for it in items)
                x = max(0, (W - total) // 2)
                y = int(H * subtitle_y)
                for it in items:
                    color = _ca if it["active"] else _cb
                    for dx, dy in [(-3,0),(3,0),(0,-3),(0,3),(-2,-2),(2,-2),(-2,2),(2,2)]:
                        draw.text((x+dx, y+dy), it["text"], font=it["font"], fill=(0,0,0), anchor="lm")
                    draw.text((x, y), it["text"], font=it["font"], fill=color, anchor="lm")
                    x += it["width"]
        return img

    def make_frame(t):
        if cancel_flag and cancel_flag.is_set():
            return np.zeros((H, W, 3), dtype="uint8")
        frame = video.get_frame(t)
        img   = Image.fromarray(frame.astype("uint8"))
        img   = draw_frame(img, t)
        prog_cb(int((t / dur) * 100) if dur else 0)
        return np.array(img)

    log_fn("Burning overlays onto frames… (this takes time)")
    final = VideoClip(make_frame, duration=dur)
    final = final.with_audio(video.audio)
    final.write_videofile(str(output_path), codec="libx264",
                          audio_codec="aac", fps=video.fps, logger=None,
                          ffmpeg_params=["-movflags", "+faststart"])

    if cancel_flag and cancel_flag.is_set():
        log_fn("⚠ Burn cancelled.", "error")
        try: Path(output_path).unlink(missing_ok=True)
        except Exception: pass
        return False

    log_fn(f"✔ Saved: {output_path}", "success")
    return True

def get_video_info(video_path):
    try:
        cmd  = [_ffprobe(), "-v", "quiet", "-print_format", "json",
                "-show_streams", "-show_format", str(video_path)]
        r    = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
        data = json.loads(r.stdout)
        dur  = float(data.get("format", {}).get("duration", 0))
        fps  = w = h = None
        for s in data.get("streams", []):
            if s.get("codec_type") == "video":
                parts = s.get("r_frame_rate", "0/1").split("/")
                if len(parts) == 2 and int(parts[1]):
                    fps = round(int(parts[0]) / int(parts[1]), 2)
                w, h = s.get("width"), s.get("height")
                break
        return dur, fps, (w, h)
    except Exception:
        return None

THUMB_W, THUMB_H = 200, 113

def extract_thumb(video_path, t=0):
    ffmpeg_exe, _ = find_ffmpeg()
    if not ffmpeg_exe: ffmpeg_exe = "ffmpeg"
    try:
        cmd = [
            ffmpeg_exe, "-y", "-ss", str(t), "-i", str(video_path),
            "-vframes", "1", "-an",
            "-vf", (f"scale={THUMB_W}:{THUMB_H}:force_original_aspect_ratio=decrease,"
                    f"pad={THUMB_W}:{THUMB_H}:(ow-iw)/2:(oh-ih)/2:color=161513"),
            "-f", "image2", "pipe:1",
        ]
        r = subprocess.run(cmd, capture_output=True, timeout=12)
        if r.returncode == 0 and r.stdout:
            return Image.open(io.BytesIO(r.stdout)).convert("RGB")
    except Exception:
        pass
    return None

def fmt_dur(sec):
    sec = int(sec or 0)
    m, s = divmod(sec, 60)
    hh, m = divmod(m, 60)
    return f"{hh}:{m:02d}:{s:02d}" if hh else f"{m}:{s:02d}"

def parse_time(t: str):
    parts = t.strip().split(":")
    try:
        if len(parts) == 2:  return int(parts[0]) * 60 + float(parts[1])
        if len(parts) == 3:  return int(parts[0])*3600 + int(parts[1])*60 + float(parts[2])
    except Exception: pass
    return None

def hex_to_rgb(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
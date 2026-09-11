"""
AutoSubs — Engine (pure functions, no UI)
"""
import subprocess, json, os, io, re, sys, shutil, uuid
from pathlib import Path
from PIL import Image, ImageFont

IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"

def kill_proc_tree(proc):
    """Terminate a subprocess AND any children it spawned. A plain
    .terminate() on the parent can leave grandchildren (e.g. Whisper/torch
    helper processes) alive and holding the stdout pipe open, which makes
    a caller's read loop hang instead of exiting promptly."""
    if proc is None:
        return
    try:
        if IS_WIN:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           capture_output=True, timeout=5)
        else:
            import signal
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                proc.terminate()
    except Exception:
        try: proc.terminate()
        except Exception: pass

def find_ffmpeg():
    # Packaged app: Electron downloads the runtime bundle (see electron/runtime.js)
    # and points us at its ffmpeg folder via this env var.
    env_dir = os.environ.get("AUTOSUBS_FFMPEG_DIR")
    if env_dir:
        bundled_dir = Path(env_dir)
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

def _default_data_dir():
    """Where the app database, thumbnails and whisper models live. In the
    packaged app, Electron passes AUTOSUBS_DATA_DIR pointing at userData
    so this survives app updates; in dev it falls back next to SAVE_DIR."""
    env_dir = os.environ.get("AUTOSUBS_DATA_DIR")
    d = Path(env_dir) if env_dir else (Path.home() / "AutoSubs" / ".data")
    d.mkdir(parents=True, exist_ok=True)
    return d

DATA_DIR   = _default_data_dir()
THUMB_DIR  = DATA_DIR / "thumbs"
THUMB_DIR.mkdir(parents=True, exist_ok=True)

def models_dir():
    """Directory whisper should cache/read its .pt model files from.
    Keeps models out of ~/.cache so they survive between runtime versions
    and are easy to find/clear."""
    env_dir = os.environ.get("AUTOSUBS_MODELS_DIR")
    d = Path(env_dir) if env_dir else (DATA_DIR / "models")
    d.mkdir(parents=True, exist_ok=True)
    return d

def free_bytes(path):
    """Free disk space (bytes) on the volume containing `path`."""
    try:
        return shutil.disk_usage(str(path)).free
    except Exception:
        return None

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
    # Nothing found on the system — fall back to a font we ship ourselves,
    # so subtitle burning never hard-fails on a machine with no
    # Arial/Helvetica installed (e.g. a minimal Windows or Linux box).
    bundled = Path(__file__).parent / "assets" / "DejaVuSans-Bold.ttf"
    if bundled.exists():
        return str(bundled)
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

_font_family_cache: dict = {}

def _font_family(font_path):
    """Resolve a TTF/OTF file path to the font *family name* libass needs
    (it matches fonts by name, not by path). Falls back to 'Arial' —
    present on effectively every machine this app runs on — if the file
    can't be read."""
    if not font_path:
        return "Arial"
    if font_path in _font_family_cache:
        return _font_family_cache[font_path]
    family = "Arial"
    try:
        f = ImageFont.truetype(font_path, 10)
        fam, style = f.getname()
        if style and style.strip().lower() not in ("regular", "normal", ""):
            family = f"{fam} {style}".strip()
        else:
            family = fam
    except Exception:
        pass
    _font_family_cache[font_path] = family
    return family

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

def _ass_time(t):
    """Seconds (float) -> ASS timestamp 'H:MM:SS.cc' (centiseconds)."""
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    cs = int(round((t - int(t)) * 100))
    if cs == 100:
        cs = 0; s += 1
        if s == 60: s = 0; m += 1
        if m == 60: m = 0; h += 1
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

def _ass_color(rgb):
    """(r,g,b) -> ASS/SSA '&HAABBGGRR' (alpha 00 = fully opaque)."""
    r, g, b = rgb
    return f"&H00{b:02X}{g:02X}{r:02X}"

def _ass_escape(text):
    return (text or "").replace("\\", "/").replace("{", "(") \
                       .replace("}", ")").replace("\n", " ").strip()

def _ffmpeg_escape_path(p):
    """Make a filesystem path safe to embed as an ffmpeg filter option
    value. Colons are the filtergraph's own option separator, and the
    ass/subtitles filter unescapes its value once more internally — so a
    literal ':' (as in a Windows drive letter) needs a *double* backslash
    to survive both passes intact. Verified empirically: a single
    backslash reliably fails to parse on Windows ffmpeg builds."""
    return str(p).replace("\\", "/").replace(":", "\\\\:")

def write_karaoke_ass(path, chunks, W, H, subtitle_y, font_family,
                      base_size, active_size, color_base, color_active,
                      overlay_items, duration):
    """Write an .ass subtitle file reproducing the karaoke look (current
    word bigger + highlighted, rest of its ~4-word chunk in base color)
    plus any static text overlays, for libass to burn in via ffmpeg."""
    base_col   = _ass_color(color_base)
    active_col = _ass_color(color_active)
    cx = W // 2
    cy = int(H * subtitle_y)

    lines = [
        "[Script Info]", "ScriptType: v4.00+",
        f"PlayResX: {W}", f"PlayResY: {H}",
        "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Default,{font_family},{base_size},{base_col},{base_col},"
        f"&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,5,10,10,10,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    for chunk in chunks:
        chunk_start = chunk[0]["start"]
        chunk_end   = chunk[-1]["end"]
        if chunk_end <= chunk_start:
            continue

        # Break the chunk's time span at every word boundary so the
        # highlighted word tracks speech exactly, and gaps between words
        # (inside the same chunk) fall back to plain, unhighlighted text —
        # matching the old frame-by-frame renderer's behaviour.
        pts = {chunk_start, chunk_end}
        for w in chunk:
            pts.add(w["start"]); pts.add(w["end"])
        pts = sorted(p for p in pts if chunk_start <= p <= chunk_end)

        for i in range(len(pts) - 1):
            seg_start, seg_end = pts[i], pts[i + 1]
            if seg_end - seg_start < 0.01:
                continue
            mid = (seg_start + seg_end) / 2
            active_idx = next((j for j, w in enumerate(chunk)
                               if w["start"] <= mid <= w["end"]), None)

            parts = []
            for j, w in enumerate(chunk):
                text = _ass_escape(w["word"])
                if not text:
                    continue
                if j == active_idx:
                    parts.append(f"{{\\fs{active_size}\\c{active_col}}}{text}")
                else:
                    parts.append(f"{{\\fs{base_size}\\c{base_col}}}{text}")
            if not parts:
                continue

            text_line = f"{{\\an5\\pos({cx},{cy})}}" + " ".join(parts)
            lines.append(f"Dialogue: 0,{_ass_time(seg_start)},{_ass_time(seg_end)},"
                        f"Default,,0,0,0,,{text_line}")

    for ov in overlay_items:
        ov_cy = int(H * ov["y"])
        color = _ass_color(ov["color"])
        text  = _ass_escape(ov["text"])
        if not text:
            continue
        text_line = (f"{{\\an5\\pos({cx},{ov_cy})\\fs{ov['size']}\\c{color}}}{text}")
        lines.append(f"Dialogue: 0,{_ass_time(0)},{_ass_time(duration)},"
                    f"Default,,0,0,0,,{text_line}")

    with open(path, "w", encoding="utf-8-sig") as f:
        f.write("\n".join(lines))

_encoder_cache: dict = {}

def pick_video_encoder():
    """Prefer NVIDIA hardware encoding when it's actually usable (encoder
    present in this ffmpeg build AND a working GPU/driver behind it), else
    fall back to libx264. Cached for the process lifetime — availability
    doesn't change mid-session."""
    if "enc" in _encoder_cache:
        return _encoder_cache["enc"]

    enc = "libx264"
    ffmpeg_exe, _ = find_ffmpeg()
    ffmpeg_exe = ffmpeg_exe or "ffmpeg"
    try:
        r = subprocess.run([ffmpeg_exe, "-hide_banner", "-encoders"],
                           capture_output=True, text=True, timeout=8,
                           encoding="utf-8", errors="replace")
        if "h264_nvenc" in r.stdout:
            test = subprocess.run(
                [ffmpeg_exe, "-hide_banner", "-loglevel", "error",
                 "-f", "lavfi", "-i", "color=size=64x64:rate=1:duration=0.1",
                 "-c:v", "h264_nvenc", "-frames:v", "1", "-f", "null", "-"],
                capture_output=True, timeout=10)
            if test.returncode == 0:
                enc = "h264_nvenc"
    except Exception:
        pass

    _encoder_cache["enc"] = enc
    return enc

def burn_subtitles(video_path, json_path, output_path, log_fn, prog_cb,
                   font_path=None, base_size=None, active_size=None,
                   color_base=None, color_active=None, cancel_flag=None,
                   subtitle_y=0.82, text_overlays=None):
    """Burns karaoke-style word subtitles (if json_path is given) and/or
    static text overlays (if text_overlays is given) via ffmpeg's ass/
    libass filter — one hardware/CPU-accelerated encode pass instead of
    drawing every frame in Python. json_path may be None to skip word
    subtitles and only burn static text."""
    _fp  = font_path    or SUBTITLE_FONT
    _bs  = base_size    or BASE_SIZE
    _as_ = active_size  or ACTIVE_SIZE
    _cb  = color_base   or SUBTITLE_COLOR_BASE
    _ca  = color_active or SUBTITLE_COLOR_ACTIVE
    text_overlays = text_overlays or []

    info = get_video_info(video_path)
    if not info or not info[2][0] or not info[2][1]:
        log_fn("ERROR: Could not read video dimensions.", "error")
        return False
    dur, _fps, (W, H) = info

    chunks = []
    if json_path:
        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)
        chunks, _ = _build_chunk_index(data.get("segments", []))
        if not chunks:
            log_fn("ERROR: No word-level timestamps found.", "error")
            return False

    overlay_items = []
    for ov in text_overlays:
        txt = (ov.get("text") or "").strip()
        if not txt:
            continue
        color = ov.get("color") or (255, 255, 255)
        if isinstance(color, str):
            color = hex_to_rgb(color)
        overlay_items.append({
            "text":  txt,
            "y":     float(ov.get("y", 0.15)),
            "size":  max(8, int(ov.get("size", 40))),
            "color": color,
        })

    if not chunks and not overlay_items:
        log_fn("ERROR: Nothing to burn.", "error")
        return False

    ffmpeg_exe, _ = find_ffmpeg()
    if not ffmpeg_exe:
        log_fn("ERROR: ffmpeg not found.", "error")
        return False

    font_family = _font_family(_fp)
    fontsdir    = os.path.dirname(_fp) if _fp and os.path.exists(_fp) else None

    ass_path = Path(output_path).with_name(f".burn_{uuid.uuid4().hex}.ass")
    write_karaoke_ass(ass_path, chunks, W, H, subtitle_y, font_family,
                      _bs, _as_, _cb, _ca, overlay_items, dur or 0)

    encoder = pick_video_encoder()
    log_fn(f"Burning captions with ffmpeg ({encoder})…")

    vf = f"ass={_ffmpeg_escape_path(ass_path)}"
    if fontsdir:
        vf += f":fontsdir={_ffmpeg_escape_path(fontsdir)}"

    if encoder == "h264_nvenc":
        venc = ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr",
                "-cq", "19", "-b:v", "0"]
    else:
        venc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]

    cmd = [ffmpeg_exe, "-y", "-i", str(video_path), "-vf", vf,
           *venc, "-c:a", "aac", "-b:a", "192k",
           "-movflags", "+faststart", str(output_path)]

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace")

    time_re   = re.compile(r"time=(\d+):(\d+):([\d.]+)")
    cancelled = False
    for line in proc.stdout:
        if cancel_flag and cancel_flag.is_set():
            kill_proc_tree(proc)
            cancelled = True
            break
        m = time_re.search(line)
        if m and dur:
            e = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
            prog_cb(max(0, min(99, int(e / dur * 100))))
        log_fn(line.rstrip())

    proc.wait()
    try: ass_path.unlink(missing_ok=True)
    except Exception: pass

    if cancelled or (cancel_flag and cancel_flag.is_set()):
        log_fn("⚠ Burn cancelled.", "error")
        try: Path(output_path).unlink(missing_ok=True)
        except Exception: pass
        return False

    if proc.returncode != 0 or not Path(output_path).exists():
        log_fn(f"ERROR: ffmpeg burn failed (exit {proc.returncode})", "error")
        try: Path(output_path).unlink(missing_ok=True)
        except Exception: pass
        return False

    prog_cb(100)
    log_fn(f"✔ Saved: {output_path}", "success")
    return True

def get_video_info(video_path):
    try:
        cmd  = [_ffprobe(), "-v", "quiet", "-print_format", "json",
                "-show_streams", "-show_format", str(video_path)]
        r    = subprocess.run(cmd, capture_output=True, text=True, timeout=8,
                              encoding="utf-8", errors="replace")
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

THUMB_W, THUMB_H = 200, 112

def _ffmpeg_kwargs():
    kw = dict(capture_output=True, timeout=15, stdin=subprocess.DEVNULL)
    if IS_WIN:
        kw["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return kw

def extract_thumb(video_path, t=0):
    """Grab one JPEG frame. Resize/pad in Pillow — newer ffmpeg builds
    (the ones we ship in the runtime) reject the old pad=…:color=hex
    filtergraph, which made every thumbnail come back empty."""
    ffmpeg_exe, _ = find_ffmpeg()
    if not ffmpeg_exe:
        ffmpeg_exe = "ffmpeg"
    try:
        cmd = [
            ffmpeg_exe, "-hide_banner", "-nostdin", "-y",
            "-ss", str(max(0, t)), "-i", str(video_path),
            "-frames:v", "1", "-an", "-f", "mjpeg", "pipe:1",
        ]
        r = subprocess.run(cmd, **_ffmpeg_kwargs())
        if r.returncode != 0 or not r.stdout:
            return None
        img = Image.open(io.BytesIO(r.stdout)).convert("RGB")
        img.thumbnail((THUMB_W, THUMB_H))
        canvas = Image.new("RGB", (THUMB_W, THUMB_H), (22, 21, 19))
        canvas.paste(img, ((THUMB_W - img.width) // 2, (THUMB_H - img.height) // 2))
        return canvas
    except Exception:
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
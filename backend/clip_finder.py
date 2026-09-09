"""
AutoSubs — Clip Finder (rule-based, no LLM)

Takes a Whisper JSON transcript (with segments) and proposes short,
self-contained clips suitable for Shorts / Reels. Pure functions only.
Swap `find_clips` for an LLM-backed version later; same input/output shape.
"""
import json
import re
from pathlib import Path

# ── Tunable weights ───────────────────────────────────────────────────────────
W_HOOK        = 30    # max points for a strong hook in the first sentence
W_DENSITY     = 20    # speech density (words / sec)
W_CLEAN_START = 10    # starts after a pause / sentence boundary
W_CLEAN_END   = 15    # ends on . ? !
W_LENGTH      = 10    # closeness to the ideal length
P_FILLER      = 15    # max penalty for filler words
P_SILENCE     = 10    # max penalty for long internal silences
P_EDGE        = 12    # penalty for intro / outro zones

PAUSE_GAP      = 0.6   # seconds between segments counted as a pause
EDGE_ZONE      = 30.0  # first/last N seconds are intro/outro
IDEAL_LEN      = 38.0  # seconds
PAD            = 0.3   # seconds of padding around clip edges
MAX_OVERLAP    = 0.20  # fraction of a chosen clip another may overlap

HOOK_PATTERNS = [
    (r"\?", 10, "question hook"),
    (r"\b(secret|truth|nobody|no one|never|always|mistake|wrong|biggest|worst|best)\b", 10, "strong word"),
    (r"\b(how to|why|what if|here'?s|the reason|the problem|the thing)\b", 8, "curiosity opener"),
    (r"\b\d+\b", 5, "number"),
    (r"\b(you|your)\b", 4, "talks to viewer"),
    (r"\b(i realized|i learned|i found|let me|listen|imagine|honestly)\b", 6, "personal / direct"),
]
FILLERS = re.compile(r"\b(um+|uh+|erm|like|you know|i mean|sort of|kind of|basically|actually)\b", re.I)
SENT_END = re.compile(r"[.!?…][\"')\]]*\s*$")


def _load_segments(transcript):
    if isinstance(transcript, (str, Path)):
        with open(transcript, encoding="utf-8") as f:
            transcript = json.load(f)
    segs = []
    for s in transcript.get("segments", []):
        text = (s.get("text") or "").strip()
        if not text:
            continue
        words = s.get("words") or []
        segs.append({
            "start": float(s["start"]),
            "end":   float(s["end"]),
            "text":  text,
            "nwords": len(words) if words else len(text.split()),
        })
    segs.sort(key=lambda s: s["start"])
    return segs


def _hook_score(text):
    score, reasons = 0, []
    low = text.lower()
    for pat, pts, label in HOOK_PATTERNS:
        if re.search(pat, low):
            score += pts
            reasons.append(label)
    return min(W_HOOK, score), reasons


def _score_window(segs, i, j, duration):
    """Score segments segs[i..j] inclusive as a clip. Returns (score, reasons)."""
    start, end = segs[i]["start"], segs[j]["end"]
    length = end - start
    if length <= 0:
        return 0, []
    text = " ".join(s["text"] for s in segs[i:j + 1])
    nwords = sum(s["nwords"] for s in segs[i:j + 1])
    reasons = []
    score = 0.0

    hook, hook_reasons = _hook_score(segs[i]["text"])
    score += hook
    reasons += hook_reasons

    wps = nwords / length
    density = max(0.0, min(1.0, (wps - 1.0) / 2.0))  # 1 wps → 0, 3 wps → 1
    score += W_DENSITY * density
    if density > 0.6:
        reasons.append("dense speech")

    prev_gap = segs[i]["start"] - segs[i - 1]["end"] if i > 0 else PAUSE_GAP + 1
    if prev_gap >= PAUSE_GAP or SENT_END.search(segs[i - 1]["text"] if i > 0 else "."):
        score += W_CLEAN_START
        reasons.append("clean start")

    if SENT_END.search(segs[j]["text"]):
        score += W_CLEAN_END
        reasons.append("clean ending")

    score += W_LENGTH * max(0.0, 1.0 - abs(length - IDEAL_LEN) / IDEAL_LEN)

    fillers = len(FILLERS.findall(text))
    filler_ratio = fillers / max(1, nwords)
    score -= min(P_FILLER, P_FILLER * filler_ratio * 8)
    if filler_ratio > 0.08:
        reasons.append("some filler")

    silence = 0.0
    for k in range(i, j):
        gap = segs[k + 1]["start"] - segs[k]["end"]
        if gap > PAUSE_GAP:
            silence += gap
    score -= min(P_SILENCE, P_SILENCE * (silence / length) * 4)

    if start < EDGE_ZONE or (duration and end > duration - EDGE_ZONE):
        score -= P_EDGE

    return max(0.0, min(100.0, score)), reasons


def _title_from(text, max_words=8):
    words = text.strip().split()
    t = " ".join(words[:max_words])
    t = re.sub(r"[,;:\-–—]+$", "", t).strip()
    if len(words) > max_words:
        t += "…"
    return t


def find_clips(transcript, video_duration=0.0, min_len=20.0, max_len=60.0, want=6):
    """Return up to `want` non-overlapping clip proposals sorted by start.

    Each: {start, end, title, score, reason, preview_text}
    """
    segs = _load_segments(transcript)
    if not segs:
        return []
    if not video_duration:
        video_duration = segs[-1]["end"]

    candidates = []
    n = len(segs)
    for i in range(n):
        for j in range(i, n):
            length = segs[j]["end"] - segs[i]["start"]
            if length < min_len:
                continue
            if length > max_len:
                break
            score, reasons = _score_window(segs, i, j, video_duration)
            # Prefer cutting on a pause after the last segment.
            if j + 1 < n and segs[j + 1]["start"] - segs[j]["end"] >= PAUSE_GAP:
                score += 3
            candidates.append((score, i, j, reasons))

    candidates.sort(key=lambda c: -c[0])

    chosen = []
    for score, i, j, reasons in candidates:
        if len(chosen) >= want:
            break
        s, e = segs[i]["start"], segs[j]["end"]
        ok = True
        for c in chosen:
            ov = max(0.0, min(e, c["end"]) - max(s, c["start"]))
            if ov > MAX_OVERLAP * min(e - s, c["end"] - c["start"]):
                ok = False
                break
        if not ok:
            continue
        text = " ".join(x["text"] for x in segs[i:j + 1])
        chosen.append({
            "start": round(max(0.0, s - PAD), 2),
            "end":   round(min(video_duration, e + PAD), 2),
            "title": _title_from(segs[i]["text"]),
            "score": int(round(score)),
            "reason": ", ".join(dict.fromkeys(reasons)) or "solid segment",
            "preview_text": text[:220] + ("…" if len(text) > 220 else ""),
        })

    chosen.sort(key=lambda c: c["start"])
    return chosen


def slice_transcript(transcript, start, end):
    """Slice a full-video Whisper transcript down to [start, end] and
    shift every timestamp so the clip's own t=0 lines up with `start`.
    Lets a clip reuse the one full-video transcription instead of
    re-running Whisper on every trimmed-out piece. Returns a dict in the
    same {"segments": [...]} shape burn_subtitles()/_build_chunk_index()
    already expect."""
    if isinstance(transcript, (str, Path)):
        with open(transcript, encoding="utf-8") as f:
            transcript = json.load(f)

    out_segments = []
    for seg in transcript.get("segments", []):
        words = seg.get("words") or []
        kept = []
        for w in words:
            ws, we = w.get("start"), w.get("end")
            if ws is None or we is None:
                continue
            if we <= start or ws >= end:
                continue
            kept.append({
                **w,
                "start": max(0.0, ws - start),
                "end":   max(0.0, we - start),
            })
        if not kept:
            continue
        out_segments.append({
            "start": kept[0]["start"],
            "end":   kept[-1]["end"],
            "text":  seg.get("text", ""),
            "words": kept,
        })

    return {"segments": out_segments}

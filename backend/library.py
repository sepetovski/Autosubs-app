"""
AutoSubs — Library, Projects, Profile & Gamification

A small local SQLite layer so the app can show an in-app library of
source/output/clip videos and saved editor "projects" instead of making
the user browse the filesystem, plus a local (no-login) profile with
XP/levels/badges/streaks computed from usage events.

Everything here is pure/local — no network calls, no accounts.
"""
import json
import math
import os
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import engine

_DB_PATH = engine.DATA_DIR / "autosubs.db"
_lock = threading.Lock()


def _conn():
    c = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init_db():
    with _lock, _conn() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS media (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL,           -- source | output | clip
            path        TEXT NOT NULL,
            title       TEXT,
            duration    REAL,
            width       INTEGER,
            height      INTEGER,
            size_bytes  INTEGER,
            thumb_path  TEXT,
            source_id   TEXT,
            project_id  TEXT,
            tags        TEXT DEFAULT '',
            created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind);

        CREATE TABLE IF NOT EXISTS projects (
            id                TEXT PRIMARY KEY,
            name              TEXT NOT NULL,
            source_media_id   TEXT,
            settings_json     TEXT,
            clips_json        TEXT,
            transcript_path   TEXT,
            updated_at        TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS profile (
            key   TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS events (
            id         TEXT PRIMARY KEY,
            type       TEXT NOT NULL,
            meta_json  TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
        """)


init_db()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _new_id():
    return uuid.uuid4().hex[:16]


# ── Thumbnails ─────────────────────────────────────────────────────────────

def _make_thumbnail(path, duration=None):
    try:
        t = (duration or 1.0) * 0.15
        img = engine.extract_thumb(path, t=t)
        if img is None:
            return None
        out = engine.THUMB_DIR / f"{uuid.uuid4().hex}.jpg"
        img.thumbnail((320, 320))
        img.save(out, format="JPEG", quality=70)
        return str(out)
    except Exception:
        return None


# ── Media (library) ──────────────────────────────────────────────────────────

def _media_row_to_dict(row):
    d = dict(row)
    d["tags"] = d.get("tags") or ""
    return d


def register_media(path, kind, source_id=None, project_id=None, title=None):
    """Insert (or return the existing) media row for `path`. Safe to call
    more than once for the same file — dedupes on path+kind."""
    path = str(Path(path).resolve()) if os.path.exists(path) else str(path)
    with _lock, _conn() as c:
        existing = c.execute(
            "SELECT * FROM media WHERE path = ? AND kind = ?", (path, kind)
        ).fetchone()
        if existing:
            return _media_row_to_dict(existing)

        info = engine.get_video_info(path) if os.path.exists(path) else None
        duration, _fps, (w, h) = info if info else (None, None, (None, None))
        size_bytes = os.path.getsize(path) if os.path.exists(path) else None
        thumb = _make_thumbnail(path, duration) if os.path.exists(path) else None

        row = {
            "id": _new_id(),
            "kind": kind,
            "path": path,
            "title": title or Path(path).stem,
            "duration": duration,
            "width": w,
            "height": h,
            "size_bytes": size_bytes,
            "thumb_path": thumb,
            "source_id": source_id,
            "project_id": project_id,
            "tags": "",
            "created_at": _now(),
        }
        c.execute(
            """INSERT INTO media (id, kind, path, title, duration, width, height,
                                  size_bytes, thumb_path, source_id, project_id,
                                  tags, created_at)
               VALUES (:id,:kind,:path,:title,:duration,:width,:height,
                       :size_bytes,:thumb_path,:source_id,:project_id,:tags,:created_at)""",
            row,
        )
        return row


def register_source(path, source="import", project_id=None):
    row = register_media(path, "source", project_id=project_id)
    record_event("video_downloaded" if source == "download" else "video_imported",
                 {"path": path})
    return row


def register_output(path, source_id=None, project_id=None, kind="output"):
    row = register_media(path, kind, source_id=source_id, project_id=project_id)
    record_event("clip_rendered" if kind == "clip" else "rendered", {"path": path})
    return row


def list_media(kind=None, search=None, sort="date"):
    q = "SELECT * FROM media WHERE 1=1"
    params = []
    if kind:
        q += " AND kind = ?"
        params.append(kind)
    if search:
        q += " AND (title LIKE ? OR path LIKE ?)"
        like = f"%{search}%"
        params += [like, like]
    order = {
        "date": "created_at DESC",
        "name": "title COLLATE NOCASE ASC",
        "duration": "duration DESC",
    }.get(sort, "created_at DESC")
    q += f" ORDER BY {order}"
    with _lock, _conn() as c:
        rows = c.execute(q, params).fetchall()
    # Filter out entries whose file has been deleted outside the app.
    out = []
    for r in rows:
        d = _media_row_to_dict(r)
        d["file_exists"] = os.path.exists(d["path"])
        out.append(d)
    return out


def get_media(media_id):
    with _lock, _conn() as c:
        row = c.execute("SELECT * FROM media WHERE id = ?", (media_id,)).fetchone()
    return _media_row_to_dict(row) if row else None


def backfill_thumbs():
    """Generate missing library thumbnails (e.g. items created when the
    old ffmpeg pad filtergraph was broken)."""
    updated = 0
    items = list_media()
    for item in items:
        existing = item.get("thumb_path")
        if existing and os.path.exists(existing):
            continue
        path = item.get("path")
        if not path or not os.path.exists(path):
            continue
        thumb = _make_thumbnail(path, item.get("duration"))
        if not thumb:
            continue
        with _lock, _conn() as c:
            c.execute("UPDATE media SET thumb_path = ? WHERE id = ?", (thumb, item["id"]))
        updated += 1
    return updated


def update_media(media_id, patch):
    allowed = {"title", "tags"}
    fields = {k: v for k, v in patch.items() if k in allowed}
    if not fields:
        return get_media(media_id)
    with _lock, _conn() as c:
        sets = ", ".join(f"{k} = ?" for k in fields)
        c.execute(f"UPDATE media SET {sets} WHERE id = ?", (*fields.values(), media_id))
    return get_media(media_id)


def delete_media(media_id, delete_file=False):
    row = get_media(media_id)
    if not row:
        return False
    if delete_file:
        try:
            os.remove(row["path"])
        except Exception:
            pass
    if row.get("thumb_path"):
        try:
            os.remove(row["thumb_path"])
        except Exception:
            pass
    with _lock, _conn() as c:
        c.execute("DELETE FROM media WHERE id = ?", (media_id,))
    return True


def reveal_in_folder(path):
    try:
        if engine.IS_MAC:
            subprocess.run(["open", "-R", path], check=False)
        elif engine.IS_WIN:
            subprocess.run(["explorer", "/select,", path], check=False)
        else:
            subprocess.run(["xdg-open", str(Path(path).parent)], check=False)
        return True
    except Exception:
        return False


def scan_save_dir():
    """One-time / repeatable import of files already sitting in SAVE_DIR
    (e.g. outputs made before the library existed) so users don't lose
    track of them."""
    added = 0
    for f in engine.SAVE_DIR.glob("*.mp4"):
        if f.name.startswith("."):
            continue
        existing = get_media_by_path(str(f.resolve()))
        if existing:
            continue
        kind = "clip" if "_clip" in f.stem else "output"
        register_media(str(f), kind)
        added += 1
    return added


def get_media_by_path(path):
    with _lock, _conn() as c:
        row = c.execute("SELECT * FROM media WHERE path = ?", (path,)).fetchone()
    return _media_row_to_dict(row) if row else None


# ── Projects ──────────────────────────────────────────────────────────────

def create_project(name, source_media_id=None, settings=None, clips=None, transcript_path=None):
    row = {
        "id": _new_id(),
        "name": name,
        "source_media_id": source_media_id,
        "settings_json": json.dumps(settings or {}),
        "clips_json": json.dumps(clips or []),
        "transcript_path": transcript_path,
        "updated_at": _now(),
    }
    with _lock, _conn() as c:
        c.execute(
            """INSERT INTO projects (id, name, source_media_id, settings_json,
                                     clips_json, transcript_path, updated_at)
               VALUES (:id,:name,:source_media_id,:settings_json,:clips_json,
                       :transcript_path,:updated_at)""",
            row,
        )
    return _project_out(row)


def _project_out(row):
    d = dict(row)
    d["settings"] = json.loads(d.pop("settings_json") or "{}")
    d["clips"] = json.loads(d.pop("clips_json") or "[]")
    return d


def list_projects():
    with _lock, _conn() as c:
        rows = c.execute("SELECT * FROM projects ORDER BY updated_at DESC").fetchall()
    return [_project_out(dict(r)) for r in rows]


def get_project(project_id):
    with _lock, _conn() as c:
        row = c.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return _project_out(dict(row)) if row else None


def upsert_project(project_id, name=None, source_media_id=None, settings=None,
                    clips=None, transcript_path=None):
    existing = get_project(project_id) if project_id else None
    if not existing:
        return create_project(name or "Untitled project", source_media_id, settings, clips, transcript_path)
    fields = {"updated_at": _now()}
    if name is not None: fields["name"] = name
    if source_media_id is not None: fields["source_media_id"] = source_media_id
    if settings is not None: fields["settings_json"] = json.dumps(settings)
    if clips is not None: fields["clips_json"] = json.dumps(clips)
    if transcript_path is not None: fields["transcript_path"] = transcript_path
    with _lock, _conn() as c:
        sets = ", ".join(f"{k} = ?" for k in fields)
        c.execute(f"UPDATE projects SET {sets} WHERE id = ?", (*fields.values(), project_id))
    return get_project(project_id)


def delete_project(project_id):
    with _lock, _conn() as c:
        c.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    return True


# ── Profile ───────────────────────────────────────────────────────────────

DEFAULT_AVATARS = ["🎬", "🎞️", "🎙️", "✂️", "⚡", "🌙", "🔥", "🎯"]


def get_profile():
    with _lock, _conn() as c:
        rows = c.execute("SELECT * FROM profile").fetchall()
    d = {r["key"]: r["value"] for r in rows}
    return {
        "name": d.get("name", "Editor"),
        "avatar": d.get("avatar", DEFAULT_AVATARS[0]),
    }


def update_profile(patch):
    fields = {k: v for k, v in patch.items() if k in ("name", "avatar")}
    with _lock, _conn() as c:
        for k, v in fields.items():
            c.execute(
                "INSERT INTO profile (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (k, str(v)),
            )
    return get_profile()


# ── Events ────────────────────────────────────────────────────────────────

def record_event(event_type, meta=None):
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO events (id, type, meta_json, created_at) VALUES (?, ?, ?, ?)",
            (_new_id(), event_type, json.dumps(meta or {}), _now()),
        )


def _all_events():
    with _lock, _conn() as c:
        rows = c.execute("SELECT * FROM events ORDER BY created_at ASC").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["meta"] = json.loads(d.pop("meta_json") or "{}")
        except Exception:
            d["meta"] = {}
        out.append(d)
    return out


# ── Gamification: XP, levels, streaks, badges ───────────────────────────────

BADGES = [
    {"id": "first_render",    "name": "First Cut",        "emoji": "🎬",
     "desc": "Render your first video",
     "check": lambda s: s["renders"] + s["clips_made"] >= 1},
    {"id": "ten_clips",       "name": "Clip Machine",      "emoji": "✂️",
     "desc": "Render 10 clips",
     "check": lambda s: s["clips_made"] >= 10},
    {"id": "hundred_clips",   "name": "Clip Factory",      "emoji": "🏭",
     "desc": "Render 100 clips",
     "check": lambda s: s["clips_made"] >= 100},
    {"id": "sixty_minutes",   "name": "Hour of Power",     "emoji": "⏱️",
     "desc": "Transcribe 60 minutes of video",
     "check": lambda s: s["minutes_transcribed"] >= 60},
    {"id": "thousand_minutes","name": "Marathon Editor",   "emoji": "🏃",
     "desc": "Transcribe 1000 minutes of video",
     "check": lambda s: s["minutes_transcribed"] >= 1000},
    {"id": "seven_day_streak","name": "On a Roll",         "emoji": "🔥",
     "desc": "Use AutoSubs 7 days in a row",
     "check": lambda s: s["best_streak"] >= 7},
    {"id": "night_owl",       "name": "Night Owl",         "emoji": "🌙",
     "desc": "Render something after midnight",
     "check": lambda s: s["night_owl"]},
    {"id": "multi_lingual",   "name": "Polyglot",          "emoji": "🌍",
     "desc": "Transcribe in 3+ different languages",
     "check": lambda s: len(s["languages"]) >= 3},
]

XP_PER_IMPORT   = 10
XP_PER_RENDER   = 25
XP_PER_CLIP     = 15
XP_PER_MINUTE   = 1


def _level_from_xp(xp):
    level = int(math.floor(math.sqrt(max(0, xp) / 100.0))) + 1
    this_level_xp = ((level - 1) ** 2) * 100
    next_level_xp = (level ** 2) * 100
    span = max(1, next_level_xp - this_level_xp)
    progress = (xp - this_level_xp) / span
    return level, max(0.0, min(1.0, progress)), next_level_xp


def _compute_streaks(dates_set):
    if not dates_set:
        return 0, 0
    days = sorted(dates_set)
    best = cur = 1
    for i in range(1, len(days)):
        if (days[i] - days[i - 1]).days == 1:
            cur += 1
            best = max(best, cur)
        else:
            cur = 1
    today = datetime.now(timezone.utc).date()
    last = days[-1]
    current_streak = cur if (today - last).days <= 1 else 0
    return current_streak, best


def compute_stats():
    events = _all_events()

    videos_imported = sum(1 for e in events if e["type"] in ("video_imported", "video_downloaded"))
    renders = sum(1 for e in events if e["type"] == "rendered")
    clips_made = sum(1 for e in events if e["type"] == "clip_rendered")
    minutes_transcribed = sum(
        float(e["meta"].get("minutes", 0)) for e in events if e["type"] == "transcribed"
    )
    languages = {
        e["meta"].get("language") for e in events
        if e["type"] == "transcribed" and e["meta"].get("language")
    }
    night_owl = any(
        e["type"] == "rendered" and 0 <= datetime.fromisoformat(e["created_at"]).hour < 5
        for e in events
    )
    dates = {datetime.fromisoformat(e["created_at"]).date() for e in events}
    current_streak, best_streak = _compute_streaks(dates)

    xp = (videos_imported * XP_PER_IMPORT + renders * XP_PER_RENDER +
          clips_made * XP_PER_CLIP + int(minutes_transcribed) * XP_PER_MINUTE)
    level, progress, next_level_xp = _level_from_xp(xp)

    stats = {
        "videos_imported": videos_imported,
        "renders": renders,
        "clips_made": clips_made,
        "minutes_transcribed": round(minutes_transcribed, 1),
        "languages": sorted(languages),
        "night_owl": night_owl,
        "current_streak": current_streak,
        "best_streak": best_streak,
        "xp": xp,
        "level": level,
        "level_progress": round(progress, 3),
        "next_level_xp": next_level_xp,
    }

    badges = []
    for b in BADGES:
        unlocked = bool(b["check"](stats))
        badges.append({"id": b["id"], "name": b["name"], "emoji": b["emoji"],
                       "desc": b["desc"], "unlocked": unlocked})
    stats["badges"] = badges
    return stats

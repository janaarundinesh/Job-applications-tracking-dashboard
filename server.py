#!/usr/bin/env python3
"""Local job application tracker.

Serves a small JSON API backed by SQLite plus the static frontend in ./public.

  python3 server.py                # http://127.0.0.1:8787
  python3 server.py --port 9000 --open
"""

import argparse
import base64
import binascii
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

from extract import ExtractionError, extract_job

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(ROOT, "public")
DEFAULT_DB = os.path.join(ROOT, "data", "tracker.db")

STATUSES = ["applied", "screening", "interview", "offer", "rejected", "withdrawn"]
WORK_MODES = ["remote", "hybrid", "onsite"]
PHASES = ["to_apply", "applied"]
DOC_KINDS = ["resume", "cover_letter", "other"]
MAX_BODY = 20 * 1024 * 1024
UPLOAD_LIMIT = 10 * 1024 * 1024

TEXT_LIMITS = {
    "company": 160,
    "role": 200,
    "location": 160,
    "source": 100,
    "job_url": 1000,
    "salary": 100,
    "contact_name": 160,
    "contact_email": 200,
    "next_step": 300,
    "notes": 20000,
    "description": 20000,
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL DEFAULT '',
    phone      TEXT NOT NULL DEFAULT '',
    location   TEXT NOT NULL DEFAULT '',
    headline   TEXT NOT NULL DEFAULT '',
    links      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id    INTEGER NOT NULL DEFAULT 1,
    company       TEXT NOT NULL,
    role          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'applied',
    work_mode     TEXT NOT NULL DEFAULT 'onsite',
    location      TEXT NOT NULL DEFAULT '',
    source        TEXT NOT NULL DEFAULT '',
    job_url       TEXT NOT NULL DEFAULT '',
    salary        TEXT NOT NULL DEFAULT '',
    contact_name  TEXT NOT NULL DEFAULT '',
    contact_email TEXT NOT NULL DEFAULT '',
    phase         TEXT NOT NULL DEFAULT 'applied',
    description   TEXT NOT NULL DEFAULT '',
    applied_on    TEXT NOT NULL DEFAULT '',
    next_step     TEXT NOT NULL DEFAULT '',
    next_step_on  TEXT,
    notes         TEXT NOT NULL DEFAULT '',
    reviewed_at   TEXT,
    deleted_at    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS status_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    from_status    TEXT,
    to_status      TEXT NOT NULL,
    created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL DEFAULT 'other',
    filename       TEXT NOT NULL,
    stored_name    TEXT NOT NULL,
    content_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
    size           INTEGER NOT NULL DEFAULT 0,
    uploaded_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    profile_id INTEGER NOT NULL DEFAULT 1,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    PRIMARY KEY (profile_id, key)
);

CREATE INDEX IF NOT EXISTS idx_events_app ON status_events(application_id);
CREATE INDEX IF NOT EXISTS idx_apps_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_apps_phase ON applications(phase);
CREATE INDEX IF NOT EXISTS idx_docs_app ON documents(application_id);
"""

DEFAULT_PROFILE_NAME = "Personal"
DEFAULT_SETTINGS = {"daily_goal": 3, "weekly_goal": 10}
PROFILE_LIMITS = {
    "name": 80,
    "email": 200,
    "phone": 40,
    "location": 120,
    "headline": 160,
    "links": 400,
}
SETTING_LIMITS = {"daily_goal": (1, 100), "weekly_goal": (1, 100)}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
    ".woff2": "font/woff2",
}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def today_iso():
    return datetime.now().strftime("%Y-%m-%d")


def connect(db_path):
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def uploads_root(db_path):
    if db_path == ":memory:":
        base = os.path.join(ROOT, "data")
    else:
        base = os.path.dirname(os.path.abspath(db_path))
    return os.path.join(base, "uploads")


def ensure_default_profile(conn):
    """Every database has at least one profile; older data belongs to it."""
    row = conn.execute("SELECT id FROM profiles ORDER BY id LIMIT 1").fetchone()
    if row is None:
        stamp = now_iso()
        conn.execute(
            "INSERT INTO profiles (name, created_at, updated_at) VALUES (?, ?, ?)",
            (DEFAULT_PROFILE_NAME, stamp, stamp),
        )


def migrate(conn):
    """Add columns and tables introduced after the first release."""
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(applications)")}
    if "phase" not in columns:
        conn.execute(
            "ALTER TABLE applications ADD COLUMN phase TEXT NOT NULL DEFAULT 'applied'"
        )
    if "description" not in columns:
        conn.execute(
            "ALTER TABLE applications ADD COLUMN description TEXT NOT NULL DEFAULT ''"
        )
    if "deleted_at" not in columns:
        conn.execute("ALTER TABLE applications ADD COLUMN deleted_at TEXT")
    if "reviewed_at" not in columns:
        conn.execute("ALTER TABLE applications ADD COLUMN reviewed_at TEXT")
    if "profile_id" not in columns:
        conn.execute(
            "ALTER TABLE applications ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1"
        )
    # Created here rather than in SCHEMA: older databases only gain the column above.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_apps_profile ON applications(profile_id)"
    )

    ensure_default_profile(conn)

    # Settings became per-profile; rebuild the old key/value table with the
    # existing goals copied onto the first profile.
    setting_columns = {row["name"] for row in conn.execute("PRAGMA table_info(settings)")}
    if setting_columns and "profile_id" not in setting_columns:
        conn.execute(
            "CREATE TABLE settings_new ("
            " profile_id INTEGER NOT NULL DEFAULT 1,"
            " key TEXT NOT NULL,"
            " value TEXT NOT NULL,"
            " PRIMARY KEY (profile_id, key))"
        )
        conn.execute(
            "INSERT INTO settings_new (profile_id, key, value) SELECT 1, key, value FROM settings"
        )
        conn.execute("DROP TABLE settings")
        conn.execute("ALTER TABLE settings_new RENAME TO settings")


def init_db(db_path):
    if db_path != ":memory:":
        parent = os.path.dirname(os.path.abspath(db_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
    conn = connect(db_path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        migrate(conn)
        conn.commit()
    finally:
        conn.close()


def app_dict(row):
    return {key: row[key] for key in row.keys()}


def event_dict(row):
    return {key: row[key] for key in row.keys()}


# --------------------------------------------------------------------------
# Profiles
# --------------------------------------------------------------------------

def clean_profile(payload, partial=False):
    if not isinstance(payload, dict):
        raise ApiError(400, "Expected a JSON object")
    data = {}
    for key, limit in PROFILE_LIMITS.items():
        if partial and key not in payload:
            continue
        data[key] = _str(payload, key, limit)
    if (not partial or "name" in data) and not data.get("name"):
        raise ApiError(400, "A profile name is required")
    return data


def list_profiles(db_path):
    conn = connect(db_path)
    try:
        rows = conn.execute(
            "SELECT p.*,"
            " (SELECT COUNT(*) FROM applications a"
            "   WHERE a.profile_id = p.id AND a.deleted_at IS NULL) AS jobs,"
            " (SELECT COUNT(*) FROM applications a WHERE a.profile_id = p.id) AS total_jobs"
            " FROM profiles p ORDER BY p.id ASC"
        ).fetchall()
        return [{key: row[key] for key in row.keys()} for row in rows]
    finally:
        conn.close()


def default_profile_id(db_path):
    conn = connect(db_path)
    try:
        row = conn.execute("SELECT id FROM profiles ORDER BY id LIMIT 1").fetchone()
        return row["id"] if row else 1
    finally:
        conn.close()


def get_profile(db_path, profile_id):
    conn = connect(db_path)
    try:
        row = conn.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone()
        if row is None:
            raise ApiError(404, "Profile not found")
        return app_dict(row)
    finally:
        conn.close()


def create_profile(db_path, payload):
    data = clean_profile(payload)
    stamp = now_iso()
    conn = connect(db_path)
    try:
        cursor = conn.execute(
            "INSERT INTO profiles"
            " (name, email, phone, location, headline, links, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                data["name"],
                data["email"],
                data["phone"],
                data["location"],
                data["headline"],
                data["links"],
                stamp,
                stamp,
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM profiles WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
        return app_dict(row)
    finally:
        conn.close()


def update_profile(db_path, profile_id, payload):
    data = clean_profile(payload, partial=True)
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM profiles WHERE id = ?", (profile_id,)
        ).fetchone()
        if row is None:
            raise ApiError(404, "Profile not found")
        if not data:
            return app_dict(row)
        assignments = ", ".join("%s = ?" % key for key in data.keys())
        conn.execute(
            "UPDATE profiles SET %s, updated_at = ? WHERE id = ?" % assignments,
            list(data.values()) + [now_iso(), profile_id],
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM profiles WHERE id = ?", (profile_id,)
        ).fetchone()
        return app_dict(row)
    finally:
        conn.close()


def delete_profile(db_path, profile_id):
    """Remove a profile with every job, document and goal that belongs to it."""
    conn = connect(db_path)
    ids = []
    files = 0
    try:
        total = conn.execute("SELECT COUNT(*) AS count FROM profiles").fetchone()["count"]
        if total <= 1:
            raise ApiError(400, "Keep at least one profile")
        row = conn.execute(
            "SELECT * FROM profiles WHERE id = ?", (profile_id,)
        ).fetchone()
        if row is None:
            raise ApiError(404, "Profile not found")
        ids = [
            item["id"]
            for item in conn.execute(
                "SELECT id FROM applications WHERE profile_id = ?", (profile_id,)
            ).fetchall()
        ]
        if ids:
            placeholders = ",".join("?" for _ in ids)
            files = conn.execute(
                "SELECT COUNT(*) AS count FROM documents WHERE application_id IN (%s)"
                % placeholders,
                ids,
            ).fetchone()["count"]
        conn.execute("DELETE FROM applications WHERE profile_id = ?", (profile_id,))
        conn.execute("DELETE FROM settings WHERE profile_id = ?", (profile_id,))
        conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
        conn.commit()
    finally:
        conn.close()
    for app_id in ids:
        shutil.rmtree(os.path.join(uploads_root(db_path), str(app_id)), ignore_errors=True)
    return {"deleted": profile_id, "jobs": len(ids), "files": files}


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------

def _str(payload, key, limit):
    raw = payload.get(key, "")
    if raw is None:
        raw = ""
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        raw = str(raw)
    if not isinstance(raw, str):
        raise ApiError(400, "%s must be text" % key)
    value = raw.strip()
    if len(value) > limit:
        raise ApiError(400, "%s is too long (max %d characters)" % (key, limit))
    return value


def _date(payload, key, required=False):
    raw = payload.get(key)
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ApiError(400, "%s must be a date (YYYY-MM-DD)" % key)
    value = raw.strip()
    if not value:
        return None
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise ApiError(400, "%s must be a date (YYYY-MM-DD)" % key)
    return value


def _status(payload, default=None):
    raw = payload.get("status")
    if raw is None:
        return default
    if not isinstance(raw, str) or raw.strip() not in STATUSES:
        raise ApiError(400, "status must be one of: %s" % ", ".join(STATUSES))
    return raw.strip()


def _work_mode(payload, default=None):
    raw = payload.get("work_mode")
    if raw is None:
        return default
    if not isinstance(raw, str) or raw.strip() not in WORK_MODES:
        raise ApiError(400, "work_mode must be one of: %s" % ", ".join(WORK_MODES))
    return raw.strip()


def _phase(payload, default=None):
    raw = payload.get("phase")
    if raw is None:
        return default
    if not isinstance(raw, str) or raw.strip() not in PHASES:
        raise ApiError(400, "phase must be one of: %s" % ", ".join(PHASES))
    return raw.strip()


def clean_create(payload):
    if not isinstance(payload, dict):
        raise ApiError(400, "Expected a JSON object")
    company = _str(payload, "company", TEXT_LIMITS["company"])
    role = _str(payload, "role", TEXT_LIMITS["role"])
    if not company:
        raise ApiError(400, "Company is required")
    if not role:
        raise ApiError(400, "Role is required")
    phase = _phase(payload, "applied")
    applied_on = _date(payload, "applied_on") or ""
    if phase == "to_apply":
        status = "applied"
        applied_on = ""
    else:
        status = _status(payload, "applied")
        applied_on = applied_on or today_iso()
    data = {
        "company": company,
        "role": role,
        "status": status,
        "phase": phase,
        "work_mode": _work_mode(payload, "onsite"),
        "applied_on": applied_on,
        "next_step_on": _date(payload, "next_step_on"),
    }
    for key, limit in TEXT_LIMITS.items():
        if key in ("company", "role"):
            continue
        data[key] = _str(payload, key, limit)
    return data


def clean_patch(payload):
    if not isinstance(payload, dict):
        raise ApiError(400, "Expected a JSON object")
    data = {}
    for key, limit in TEXT_LIMITS.items():
        if key in payload:
            data[key] = _str(payload, key, limit)
    if "company" in data and not data["company"]:
        raise ApiError(400, "Company cannot be empty")
    if "role" in data and not data["role"]:
        raise ApiError(400, "Role cannot be empty")
    if "status" in payload:
        data["status"] = _status(payload)
    if "work_mode" in payload:
        data["work_mode"] = _work_mode(payload)
    if "phase" in payload:
        data["phase"] = _phase(payload)
    if "applied_on" in payload:
        data["applied_on"] = _date(payload, "applied_on") or ""
    if "next_step_on" in payload:
        data["next_step_on"] = _date(payload, "next_step_on")
    if payload.get("mark_reviewed") is True:
        data["reviewed_at"] = now_iso()
    return data


# --------------------------------------------------------------------------
# Data access
# --------------------------------------------------------------------------

def get_settings(db_path, profile_id):
    conn = connect(db_path)
    try:
        rows = conn.execute(
            "SELECT key, value FROM settings WHERE profile_id = ?", (profile_id,)
        ).fetchall()
    finally:
        conn.close()
    stored = {row["key"]: row["value"] for row in rows}
    settings = dict(DEFAULT_SETTINGS)
    for key in DEFAULT_SETTINGS:
        try:
            value = int(stored.get(key, DEFAULT_SETTINGS[key]))
        except (TypeError, ValueError):
            continue
        low, high = SETTING_LIMITS[key]
        settings[key] = max(low, min(high, value))
    return settings


def save_settings(db_path, profile_id, payload):
    if not isinstance(payload, dict):
        raise ApiError(400, "Expected a JSON object")
    updates = {}
    for key, (low, high) in SETTING_LIMITS.items():
        if key not in payload:
            continue
        raw = payload[key]
        if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
            raise ApiError(400, "%s must be a whole number" % key)
        try:
            value = int(str(raw).strip())
        except ValueError:
            raise ApiError(400, "%s must be a whole number" % key)
        if value < low or value > high:
            raise ApiError(400, "%s must be between %d and %d" % (key, low, high))
        updates[key] = value
    if not updates:
        raise ApiError(400, "No goal values provided")
    conn = connect(db_path)
    try:
        conn.executemany(
            "INSERT INTO settings (profile_id, key, value) VALUES (?, ?, ?)"
            " ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value",
            [(profile_id, key, str(value)) for key, value in updates.items()],
        )
        conn.commit()
    finally:
        conn.close()
    return get_settings(db_path, profile_id)


def list_applications(db_path, profile_id, trashed=False):
    conn = connect(db_path)
    try:
        if trashed:
            rows = conn.execute(
                "SELECT * FROM applications"
                " WHERE profile_id = ? AND deleted_at IS NOT NULL"
                " ORDER BY deleted_at DESC, id DESC",
                (profile_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM applications"
                " WHERE profile_id = ? AND deleted_at IS NULL"
                " ORDER BY applied_on DESC, id DESC",
                (profile_id,),
            ).fetchall()
        return [app_dict(row) for row in rows]
    finally:
        conn.close()


def get_application(db_path, profile_id, app_id):
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM applications WHERE id = ? AND profile_id = ?",
            (app_id, profile_id),
        ).fetchone()
        if row is None:
            raise ApiError(404, "Application not found")
        events = conn.execute(
            "SELECT * FROM status_events WHERE application_id = ? ORDER BY id ASC",
            (app_id,),
        ).fetchall()
        return (
            app_dict(row),
            [event_dict(event) for event in events],
            list_documents(conn, app_id),
        )
    finally:
        conn.close()


def create_application(db_path, profile_id, data):
    stamp = now_iso()
    conn = connect(db_path)
    try:
        columns = list(data.keys()) + ["profile_id", "created_at", "updated_at"]
        values = list(data.values()) + [profile_id, stamp, stamp]
        placeholders = ", ".join("?" for _ in columns)
        cursor = conn.execute(
            "INSERT INTO applications (%s) VALUES (%s)"
            % (", ".join(columns), placeholders),
            values,
        )
        app_id = cursor.lastrowid
        conn.execute(
            "INSERT INTO status_events (application_id, from_status, to_status, created_at)"
            " VALUES (?, ?, ?, ?)",
            (app_id, None, data["status"], stamp),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
        return app_dict(row)
    finally:
        conn.close()


def update_application(db_path, profile_id, app_id, data):
    stamp = now_iso()
    conn = connect(db_path)
    try:
        current = conn.execute(
            "SELECT * FROM applications WHERE id = ? AND profile_id = ?",
            (app_id, profile_id),
        ).fetchone()
        if current is None:
            raise ApiError(404, "Application not found")
        if not data:
            return app_dict(current)
        target_phase = data.get("phase", current["phase"])
        if target_phase == "to_apply":
            data["phase"] = "to_apply"
            data["applied_on"] = ""
            data["status"] = "applied"
        elif "phase" in data or "applied_on" in data:
            if not data.get("applied_on"):
                data["applied_on"] = current["applied_on"] or today_iso()
        assignments = ", ".join("%s = ?" % key for key in data.keys())
        conn.execute(
            "UPDATE applications SET %s, updated_at = ? WHERE id = ?" % assignments,
            list(data.values()) + [stamp, app_id],
        )
        new_status = data.get("status")
        if new_status and new_status != current["status"]:
            conn.execute(
                "INSERT INTO status_events (application_id, from_status, to_status, created_at)"
                " VALUES (?, ?, ?, ?)",
                (app_id, current["status"], new_status, stamp),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
        return app_dict(row)
    finally:
        conn.close()


def soft_delete_application(db_path, profile_id, app_id):
    """Move a job to the trash. Its documents stay on disk until it is purged."""
    stamp = now_iso()
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM applications WHERE id = ? AND profile_id = ?",
            (app_id, profile_id),
        ).fetchone()
        if row is None:
            raise ApiError(404, "Application not found")
        if not row["deleted_at"]:
            conn.execute(
                "UPDATE applications SET deleted_at = ?, updated_at = ? WHERE id = ?",
                (stamp, stamp, app_id),
            )
            conn.commit()
        updated = conn.execute(
            "SELECT * FROM applications WHERE id = ?", (app_id,)
        ).fetchone()
        return app_dict(updated)
    finally:
        conn.close()


def restore_application(db_path, profile_id, app_id):
    stamp = now_iso()
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM applications WHERE id = ? AND profile_id = ?",
            (app_id, profile_id),
        ).fetchone()
        if row is None:
            raise ApiError(404, "Application not found")
        if not row["deleted_at"]:
            raise ApiError(400, "That job is not in the trash")
        conn.execute(
            "UPDATE applications SET deleted_at = NULL, updated_at = ? WHERE id = ?",
            (stamp, app_id),
        )
        conn.commit()
        updated = conn.execute(
            "SELECT * FROM applications WHERE id = ?", (app_id,)
        ).fetchone()
        return app_dict(updated)
    finally:
        conn.close()


def purge_trash(db_path, profile_id):
    """Permanently remove every trashed job, its rows and its uploaded files."""
    conn = connect(db_path)
    try:
        ids = [
            row["id"]
            for row in conn.execute(
                "SELECT id FROM applications WHERE deleted_at IS NOT NULL AND profile_id = ?",
                (profile_id,),
            ).fetchall()
        ]
        if not ids:
            return {"deleted": 0, "files": 0}
        placeholders = ",".join("?" for _ in ids)
        files = conn.execute(
            "SELECT COUNT(*) AS count FROM documents WHERE application_id IN (%s)" % placeholders,
            ids,
        ).fetchone()["count"]
        conn.execute(
            "DELETE FROM applications WHERE deleted_at IS NOT NULL AND profile_id = ?",
            (profile_id,),
        )
        conn.commit()
    finally:
        conn.close()
    for app_id in ids:
        shutil.rmtree(os.path.join(uploads_root(db_path), str(app_id)), ignore_errors=True)
    return {"deleted": len(ids), "files": files}


def purge_application(db_path, profile_id, app_id):
    """Permanently remove a trashed job, its rows and its uploaded files."""
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM applications WHERE id = ? AND profile_id = ?",
            (app_id, profile_id),
        ).fetchone()
        if row is None:
            raise ApiError(404, "Application not found")
        if not row["deleted_at"]:
            raise ApiError(400, "Move the job to the trash before deleting it permanently")
        conn.execute("DELETE FROM applications WHERE id = ?", (app_id,))
        conn.commit()
    finally:
        conn.close()
    shutil.rmtree(os.path.join(uploads_root(db_path), str(app_id)), ignore_errors=True)


# --------------------------------------------------------------------------
# Documents
# --------------------------------------------------------------------------

DOCUMENT_COLUMNS = (
    "application_id", "kind", "filename", "stored_name", "content_type", "size", "uploaded_at"
)


PREVIEW_TYPES = {
    "application/pdf": "pdf",
    "image/png": "image",
    "image/jpeg": "image",
    "image/gif": "image",
    "image/webp": "image",
    "text/plain": "text",
    "text/csv": "text",
    "text/markdown": "text",
}


def preview_format(content_type, filename):
    """Return (preview_kind, safe_content_type) for a stored document.

    Only formats that a browser renders inertly are previewable. HTML and SVG are
    deliberately excluded so an uploaded file can never run script in the app's
    origin; they are served as downloads instead.
    """
    ctype = (content_type or "").split(";")[0].strip().lower()
    if ctype in ("", "application/octet-stream", "binary/octet-stream"):
        guessed, _ = mimetypes.guess_type(filename or "")
        ctype = (guessed or "").lower()
    return PREVIEW_TYPES.get(ctype), ctype


def document_dict(row):
    preview, _ = preview_format(row["content_type"], row["filename"])
    return {
        "id": row["id"],
        "application_id": row["application_id"],
        "kind": row["kind"],
        "filename": row["filename"],
        "content_type": row["content_type"],
        "size": row["size"],
        "uploaded_at": row["uploaded_at"],
        "preview": preview,
        "url": "/api/applications/%d/documents/%d" % (row["application_id"], row["id"]),
    }


def list_documents(conn, app_id):
    rows = conn.execute(
        "SELECT * FROM documents WHERE application_id = ? ORDER BY id ASC", (app_id,)
    ).fetchall()
    return [document_dict(row) for row in rows]


def _document_filename(payload):
    raw = payload.get("filename")
    if not isinstance(raw, str) or not raw.strip():
        raise ApiError(400, "A file name is required")
    name = os.path.basename(raw.replace("\\", "/")).strip()
    name = "".join(char for char in name if char.isprintable())[:160]
    if not name:
        raise ApiError(400, "A valid file name is required")
    return name


def save_document(db_path, profile_id, app_id, payload):
    if not isinstance(payload, dict):
        raise ApiError(400, "Expected a JSON object")
    kind = payload.get("kind") or "other"
    if kind not in DOC_KINDS:
        raise ApiError(400, "kind must be one of: %s" % ", ".join(DOC_KINDS))
    filename = _document_filename(payload)
    content_type = _str(payload, "content_type", 120) or "application/octet-stream"
    encoded = payload.get("data")
    if not isinstance(encoded, str) or not encoded.strip():
        raise ApiError(400, "File data is required")
    if encoded.startswith("data:") and "," in encoded:
        encoded = encoded.split(",", 1)[1]
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise ApiError(400, "File data is not valid base64")
    if not raw:
        raise ApiError(400, "That file is empty")
    if len(raw) > UPLOAD_LIMIT:
        raise ApiError(413, "Files must be 10 MB or smaller")

    conn = connect(db_path)
    try:
        exists = conn.execute(
            "SELECT id FROM applications WHERE id = ? AND profile_id = ?",
            (app_id, profile_id),
        ).fetchone()
        if exists is None:
            raise ApiError(404, "Application not found")
        extension = os.path.splitext(filename)[1].lower().lstrip(".")
        extension = "".join(char for char in extension if char.isalnum())[:10]
        stored_name = uuid.uuid4().hex + (("." + extension) if extension else "")
        folder = os.path.join(uploads_root(db_path), str(app_id))
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, stored_name)
        with open(path, "wb") as handle:
            handle.write(raw)
        stamp = now_iso()
        cursor = conn.execute(
            "INSERT INTO documents (%s) VALUES (%s)"
            % (", ".join(DOCUMENT_COLUMNS), ", ".join("?" for _ in DOCUMENT_COLUMNS)),
            (app_id, kind, filename, stored_name, content_type, len(raw), stamp),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM documents WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
        return document_dict(row)
    finally:
        conn.close()


def find_document(db_path, profile_id, app_id, doc_id):
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT d.* FROM documents d JOIN applications a"
            " ON a.id = d.application_id"
            " WHERE d.id = ? AND d.application_id = ? AND a.profile_id = ?",
            (doc_id, app_id, profile_id),
        ).fetchone()
        if row is None:
            raise ApiError(404, "Document not found")
        path = os.path.join(uploads_root(db_path), str(app_id), row["stored_name"])
        if not os.path.isfile(path):
            raise ApiError(404, "That file is missing on disk")
        return row, path
    finally:
        conn.close()


def delete_document(db_path, profile_id, app_id, doc_id):
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT d.stored_name FROM documents d JOIN applications a"
            " ON a.id = d.application_id"
            " WHERE d.id = ? AND d.application_id = ? AND a.profile_id = ?",
            (doc_id, app_id, profile_id),
        ).fetchone()
        if row is None:
            raise ApiError(404, "Document not found")
        conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        conn.commit()
    finally:
        conn.close()
    path = os.path.join(uploads_root(db_path), str(app_id), row["stored_name"])
    try:
        os.remove(path)
    except OSError:
        pass


def import_applications(db_path, profile_id, items):
    if not isinstance(items, list):
        raise ApiError(400, "Import expects a JSON array of applications")
    stamp = now_iso()
    imported = 0
    skipped = 0
    conn = connect(db_path)
    try:
        for item in items:
            try:
                data = clean_create(item)
            except ApiError:
                skipped += 1
                continue
            columns = list(data.keys()) + ["profile_id", "created_at", "updated_at"]
            values = list(data.values()) + [profile_id, stamp, stamp]
            cursor = conn.execute(
                "INSERT INTO applications (%s) VALUES (%s)"
                % (", ".join(columns), ", ".join("?" for _ in columns)),
                values,
            )
            conn.execute(
                "INSERT INTO status_events (application_id, from_status, to_status, created_at)"
                " VALUES (?, ?, ?, ?)",
                (cursor.lastrowid, None, data["status"], stamp),
            )
            imported += 1
        conn.commit()
    finally:
        conn.close()
    return imported, skipped


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "JobTracker/1.0"
    protocol_version = "HTTP/1.1"

    # Set by main()
    db_path = DEFAULT_DB

    def log_message(self, fmt, *args):
        sys.stderr.write(
            "%s  %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args)
        )

    def handle_one_request(self):
        # Browsers routinely drop keep-alive sockets; that is not an error worth a
        # traceback in the terminal.
        try:
            BaseHTTPRequestHandler.handle_one_request(self)
        except (ConnectionResetError, BrokenPipeError):
            self.close_connection = True

    # -- helpers ---------------------------------------------------------
    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def send_document(self, path, content_type, filename, inline=False):
        try:
            with open(path, "rb") as handle:
                body = handle.read()
        except OSError:
            return self.send_error_json(404, "That file is missing on disk")
        preview, safe_type = preview_format(content_type, filename)
        can_preview = bool(inline and preview)
        total = len(body)

        # Browsers render PDFs with a viewer that asks for byte ranges. Answering
        # every request with the whole file makes it retry forever, so honour
        # Range here (a single range is all the viewer needs).
        start, end, partial = 0, total - 1, False
        range_header = (self.headers.get("Range") or "").strip()
        match = re.match(r"^bytes=(\d*)-(\d*)$", range_header)
        if match and total:
            raw_start, raw_end = match.groups()
            if not raw_start and not raw_end:
                match = None
            elif raw_start:
                start = int(raw_start)
                end = int(raw_end) if raw_end else total - 1
            else:
                start = max(0, total - int(raw_end))
            if match:
                if start >= total or start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % total)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                end = min(end, total - 1)
                partial = True

        chunk = body[start : end + 1]
        self.send_response(206 if partial else 200)
        self.send_header(
            "Content-Type", safe_type if can_preview else (content_type or "application/octet-stream")
        )
        self.send_header("Content-Length", str(len(chunk)))
        self.send_header("Accept-Ranges", "bytes")
        if partial:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, total))
        self.send_header(
            "Content-Disposition", "%s; filename*=UTF-8''%s" % ("inline" if can_preview else "attachment", quote(filename))
        )
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "private, max-age=0, must-revalidate")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(chunk)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "Invalid Content-Length")
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ApiError(413, "Request body is too large")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "Invalid JSON body")

    # -- static files ----------------------------------------------------
    def serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        relative = unquote(path.lstrip("/"))
        target = os.path.normpath(os.path.join(PUBLIC_DIR, relative))
        if not target.startswith(PUBLIC_DIR + os.sep) and target != PUBLIC_DIR:
            self.send_error_json(403, "Forbidden")
            return
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            self.send_error_json(404, "Not found")
            return
        extension = os.path.splitext(target)[1].lower()
        content_type = CONTENT_TYPES.get(extension, "application/octet-stream")
        with open(target, "rb") as handle:
            body = handle.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # -- routing ---------------------------------------------------------
    def route(self):
        parsed = urlparse(self.path)
        path = parsed.path
        self.query = parse_qs(parsed.query)
        parts = [unquote(part) for part in path.split("/") if part]

        if parts and parts[0] == "api":
            return self.api(parts[1:])

        if self.command in ("GET", "HEAD"):
            return self.serve_static(path)
        return self.send_error_json(405, "Method not allowed")

    def profile_id(self):
        """The profile a request works on: X-Profile-Id, else the first profile."""
        raw = (self.headers.get("X-Profile-Id") or "").strip()
        if not raw:
            return default_profile_id(self.db_path)
        try:
            value = int(raw)
        except ValueError:
            raise ApiError(400, "Invalid profile id")
        conn = connect(self.db_path)
        try:
            row = conn.execute("SELECT id FROM profiles WHERE id = ?", (value,)).fetchone()
        finally:
            conn.close()
        if row is None:
            raise ApiError(404, "Profile not found")
        return value

    def profiles(self, parts):
        if not parts:
            if self.command == "GET":
                return self.send_json(list_profiles(self.db_path))
            if self.command == "POST":
                return self.send_json(create_profile(self.db_path, self.read_json()), 201)
            raise ApiError(405, "Method not allowed")
        if len(parts) != 1:
            raise ApiError(404, "Unknown endpoint")
        try:
            profile_id = int(parts[0])
        except ValueError:
            raise ApiError(404, "Unknown endpoint")
        if self.command in ("GET", "HEAD"):
            return self.send_json(get_profile(self.db_path, profile_id))
        if self.command in ("PATCH", "PUT"):
            return self.send_json(update_profile(self.db_path, profile_id, self.read_json()))
        if self.command == "DELETE":
            return self.send_json(delete_profile(self.db_path, profile_id))
        raise ApiError(405, "Method not allowed")

    def api(self, parts):
        try:
            if not parts:
                raise ApiError(404, "Unknown endpoint")

            if parts[0] == "health" and self.command == "GET":
                return self.send_json({"ok": True})

            if parts[0] == "profiles":
                return self.profiles(parts[1:])

            profile_id = self.profile_id()

            if parts[0] == "extract":
                if self.command != "POST":
                    raise ApiError(405, "Method not allowed")
                payload = self.read_json()
                target = payload.get("url") if isinstance(payload, dict) else None
                if not isinstance(target, str) or not target.strip():
                    raise ApiError(400, "A job posting URL is required")
                try:
                    return self.send_json(extract_job(target.strip()))
                except ExtractionError as error:
                    raise ApiError(422, str(error))

            if parts[0] == "trash":
                if len(parts) != 1:
                    raise ApiError(404, "Unknown endpoint")
                if self.command != "DELETE":
                    raise ApiError(405, "Method not allowed")
                return self.send_json(purge_trash(self.db_path, profile_id))

            if parts[0] == "settings":
                if len(parts) != 1:
                    raise ApiError(404, "Unknown endpoint")
                if self.command == "GET":
                    return self.send_json(get_settings(self.db_path, profile_id))
                if self.command in ("PATCH", "PUT"):
                    return self.send_json(
                        save_settings(self.db_path, profile_id, self.read_json())
                    )
                raise ApiError(405, "Method not allowed")

            if parts[0] != "applications" and parts[0] != "import":
                raise ApiError(404, "Unknown endpoint")

            if parts[0] == "import":
                if self.command != "POST":
                    raise ApiError(405, "Method not allowed")
                payload = self.read_json()
                items = payload.get("applications") if isinstance(payload, dict) else payload
                imported, skipped = import_applications(self.db_path, profile_id, items)
                return self.send_json({"imported": imported, "skipped": skipped})

            if parts[0] == "applications" and len(parts) == 3 and parts[2] == "restore":
                if self.command != "POST":
                    raise ApiError(405, "Method not allowed")
                try:
                    app_id = int(parts[1])
                except ValueError:
                    raise ApiError(404, "Unknown endpoint")
                return self.send_json(restore_application(self.db_path, profile_id, app_id))

            if parts[0] == "applications" and len(parts) >= 3 and parts[2] == "documents":
                try:
                    app_id = int(parts[1])
                except ValueError:
                    raise ApiError(404, "Unknown endpoint")
                if len(parts) == 3:
                    if self.command != "POST":
                        raise ApiError(405, "Method not allowed")
                    document = save_document(
                        self.db_path, profile_id, app_id, self.read_json()
                    )
                    return self.send_json(document, 201)
                if len(parts) == 4:
                    try:
                        doc_id = int(parts[3])
                    except ValueError:
                        raise ApiError(404, "Unknown endpoint")
                    if self.command in ("GET", "HEAD"):
                        row, path = find_document(self.db_path, profile_id, app_id, doc_id)
                        inline = (self.query.get("inline") or ["0"])[0].lower() in (
                            "1", "true", "yes"
                        )
                        return self.send_document(
                            path, row["content_type"], row["filename"], inline=inline
                        )
                    if self.command == "DELETE":
                        delete_document(self.db_path, profile_id, app_id, doc_id)
                        return self.send_json({"deleted": doc_id})
                    raise ApiError(405, "Method not allowed")
                raise ApiError(404, "Unknown endpoint")

            if len(parts) == 1:
                if self.command == "GET":
                    trashed = (self.query.get("trash") or ["0"])[0].lower() in ("1", "true", "yes")
                    return self.send_json(
                        list_applications(self.db_path, profile_id, trashed=trashed)
                    )
                if self.command == "POST":
                    data = clean_create(self.read_json())
                    return self.send_json(
                        create_application(self.db_path, profile_id, data), 201
                    )
                raise ApiError(405, "Method not allowed")

            if len(parts) == 2:
                try:
                    app_id = int(parts[1])
                except ValueError:
                    raise ApiError(404, "Unknown endpoint")

                if self.command in ("GET", "HEAD"):
                    application, events, documents = get_application(
                        self.db_path, profile_id, app_id
                    )
                    return self.send_json(
                        {
                            "application": application,
                            "events": events,
                            "documents": documents,
                        }
                    )
                if self.command in ("PATCH", "PUT"):
                    data = clean_patch(self.read_json())
                    return self.send_json(
                        update_application(self.db_path, profile_id, app_id, data)
                    )
                if self.command == "DELETE":
                    permanent = (self.query.get("permanent") or ["0"])[0].lower() in (
                        "1", "true", "yes"
                    )
                    if permanent:
                        purge_application(self.db_path, profile_id, app_id)
                        return self.send_json({"permanent": True, "deleted": app_id})
                    application = soft_delete_application(
                        self.db_path, profile_id, app_id
                    )
                    return self.send_json({"trashed": app_id, "application": application})
                raise ApiError(405, "Method not allowed")

            raise ApiError(404, "Unknown endpoint")
        except ApiError as error:
            return self.send_error_json(error.status, error.message)
        except (BrokenPipeError, ConnectionResetError):
            # The browser closed the socket (a preview iframe or tab being closed).
            self.close_connection = True
        except Exception as error:  # keep the API JSON-only on unexpected failures
            sys.stderr.write("Unhandled error: %r\n" % (error,))
            return self.send_error_json(500, "Server error")

    def do_GET(self):
        self.route()

    def do_HEAD(self):
        self.route()

    def do_POST(self):
        self.route()

    def do_PATCH(self):
        self.route()

    def do_PUT(self):
        self.route()

    def do_DELETE(self):
        self.route()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Local job application tracker")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--db", default=DEFAULT_DB, help="Path to the SQLite database")
    parser.add_argument("--open", action="store_true", help="Open the dashboard in a browser")
    args = parser.parse_args(argv)

    init_db(args.db)
    Handler.db_path = args.db
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = "http://%s:%d" % (args.host, args.port)
    print("Job application tracker running at %s" % url)
    print("Database: %s" % os.path.abspath(args.db))
    print("Press Ctrl+C to stop")
    if args.open:
        import webbrowser

        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

"""End-to-end tests for the job tracker JSON API."""

import base64
import datetime


def test_health(api):
    response = api.get("/api/health")
    assert response.status == 200
    assert response.data == {"ok": True}


def test_create_defaults_and_list(api):
    created = api.create(company="Acme", role="Engineer")
    assert created["phase"] == "applied"
    assert created["status"] == "applied"
    assert created["applied_on"] == datetime.date.today().isoformat()
    assert created["company"] == "Acme"

    listed = api.get("/api/applications")
    assert listed.status == 200
    assert [app["id"] for app in listed.data] == [created["id"]]


def test_to_apply_clears_applied_date(api):
    saved = api.create(company="Globex", role="Designer", phase="to_apply", applied_on="2020-01-01")
    assert saved["phase"] == "to_apply"
    assert saved["applied_on"] == ""


def test_required_fields(api):
    assert api.post("/api/applications", {"role": "Engineer"}).status == 400
    assert api.post("/api/applications", {"company": "Acme"}).status == 400
    assert api.post("/api/applications", {"company": "  ", "role": "Engineer"}).status == 400


def test_invalid_enum_values(api):
    assert api.post("/api/applications", {"company": "Acme", "role": "Eng", "status": "nope"}).status == 400
    assert api.post("/api/applications", {"company": "Acme", "role": "Eng", "phase": "later"}).status == 400
    assert api.post("/api/applications", {"company": "Acme", "role": "Eng", "work_mode": "moon"}).status == 400
    assert api.post("/api/applications", {"company": "Acme", "role": "Eng", "applied_on": "31/02/2026"}).status == 400


def test_unknown_routes_and_methods(api):
    assert api.get("/api/nope").status == 404
    assert api.get("/api/applications/abc").status == 404
    assert api.get("/api/applications/9999").status == 404
    assert api.patch("/api/trash", {}).status == 405
    assert api.post("/api/applications/1", {}).status == 405


def test_detail_includes_creation_event(api):
    created = api.create()
    response = api.get("/api/applications/%d" % created["id"])
    assert response.status == 200
    assert response.data["application"]["id"] == created["id"]
    assert response.data["documents"] == []
    assert len(response.data["events"]) == 1
    assert response.data["events"][0]["to_status"] == "applied"


def test_patch_status_logs_event(api):
    created = api.create()
    patched = api.patch("/api/applications/%d" % created["id"], {"status": "screening"})
    assert patched.status == 200
    assert patched.data["status"] == "screening"

    detail = api.get("/api/applications/%d" % created["id"]).data
    assert [event["to_status"] for event in detail["events"]] == ["applied", "screening"]
    assert detail["events"][-1]["from_status"] == "applied"


def test_patch_review_and_reset_applied_date(api):
    created = api.create(applied_on="2026-01-05")
    reviewed = api.patch("/api/applications/%d" % created["id"], {"mark_reviewed": True})
    assert reviewed.status == 200
    assert reviewed.data["reviewed_at"]

    cleared = api.patch("/api/applications/%d" % created["id"], {"next_step_on": None})
    assert cleared.status == 200
    assert cleared.data["next_step_on"] is None


def test_soft_delete_restore_and_purge(api):
    created = api.create()
    app_id = created["id"]

    trashed = api.delete("/api/applications/%d" % app_id)
    assert trashed.status == 200
    assert api.get("/api/applications").data == []
    assert [app["id"] for app in api.get("/api/applications?trash=1").data] == [app_id]

    restored = api.post("/api/applications/%d/restore" % app_id)
    assert restored.status == 200
    assert restored.data["deleted_at"] is None
    assert api.get("/api/applications?trash=1").data == []

    # An active job cannot be purged before it is trashed.
    assert api.delete("/api/applications/%d?permanent=1" % app_id).status == 400

    api.delete("/api/applications/%d" % app_id)
    purged = api.delete("/api/applications/%d?permanent=1" % app_id)
    assert purged.status == 200
    assert purged.data["permanent"] is True
    assert api.get("/api/applications/%d" % app_id).status == 404


def test_purge_removes_documents_and_files(api):
    created = api.create()
    app_id = created["id"]
    assert api.upload(app_id, b"my resume").status == 201
    assert api.uploads_dir(app_id).is_dir()

    api.delete("/api/applications/%d" % app_id)
    api.delete("/api/applications/%d?permanent=1" % app_id)

    assert not api.uploads_dir(app_id).exists()
    assert api.get("/api/applications/%d" % app_id).status == 404


def test_empty_trash_endpoint(api):
    keep = api.create(company="Keep")
    one = api.create(company="One")
    two = api.create(company="Two")
    api.upload(one["id"], b"one")
    api.delete("/api/applications/%d" % one["id"])
    api.delete("/api/applications/%d" % two["id"])

    emptied = api.delete("/api/trash")
    assert emptied.status == 200
    assert emptied.data["deleted"] == 2
    assert emptied.data["files"] == 1
    assert api.get("/api/applications?trash=1").data == []
    assert [app["id"] for app in api.get("/api/applications").data] == [keep["id"]]
    assert not api.uploads_dir(one["id"]).exists()
    assert not api.uploads_dir(two["id"]).exists()

    # Idempotent when the bin is already empty.
    again = api.delete("/api/trash")
    assert again.data == {"deleted": 0, "files": 0}


def test_document_upload_listing_and_delete(api):
    created = api.create()
    app_id = created["id"]
    uploaded = api.upload(app_id, b"hello", filename="cover.txt", kind="cover_letter")
    assert uploaded.status == 201
    doc = uploaded.data
    assert doc["kind"] == "cover_letter"
    assert doc["preview"] == "text"
    assert doc["url"] == "/api/applications/%d/documents/%d" % (app_id, doc["id"])

    detail = api.get("/api/applications/%d" % app_id).data
    assert [item["filename"] for item in detail["documents"]] == ["cover.txt"]

    removed = api.delete("/api/applications/%d/documents/%d" % (app_id, doc["id"]))
    assert removed.status == 200
    assert api.get("/api/applications/%d" % app_id).data["documents"] == []
    assert not any(api.uploads_dir(app_id).iterdir())


def test_document_download_inline_and_range(api):
    created = api.create()
    app_id = created["id"]
    payload = b"%PDF-1.4 fake pdf body for range tests"
    doc = api.upload(app_id, payload, filename="resume.pdf", content_type="application/pdf").data

    download = api.get("/api/applications/%d/documents/%d" % (app_id, doc["id"]))
    assert download.status == 200
    assert download.headers["Content-Disposition"].startswith("attachment")
    assert download.body == payload

    preview = api.get("/api/applications/%d/documents/%d?inline=1" % (app_id, doc["id"]))
    assert preview.status == 200
    assert preview.headers["Content-Type"] == "application/pdf"
    assert preview.headers["Content-Disposition"].startswith("inline")

    partial = api.get(
        "/api/applications/%d/documents/%d?inline=1" % (app_id, doc["id"]),
        headers={"Range": "bytes=0-9"},
    )
    assert partial.status == 206
    assert partial.body == payload[:10]
    assert partial.headers["Content-Range"] == "bytes 0-9/%d" % len(payload)
    assert partial.headers["Accept-Ranges"] == "bytes"

    out_of_range = api.get(
        "/api/applications/%d/documents/%d" % (app_id, doc["id"]),
        headers={"Range": "bytes=99999-"},
    )
    assert out_of_range.status == 416


def test_html_upload_is_never_served_inline(api):
    created = api.create()
    app_id = created["id"]
    doc = api.upload(
        app_id,
        b"<script>alert(1)</script>",
        filename="evil.html",
        kind="other",
        content_type="text/html",
    ).data
    assert doc["preview"] is None

    response = api.get("/api/applications/%d/documents/%d?inline=1" % (app_id, doc["id"]))
    assert response.headers["Content-Disposition"].startswith("attachment")
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_document_validation(api):
    created = api.create()
    app_id = created["id"]

    missing = api.post("/api/applications/%d/documents" % app_id, {"filename": "x.txt"})
    assert missing.status == 400

    bad_base64 = api.post(
        "/api/applications/%d/documents" % app_id,
        {"filename": "x.txt", "data": "not base64!!"},
    )
    assert bad_base64.status == 400

    empty = api.post(
        "/api/applications/%d/documents" % app_id,
        {"filename": "x.txt", "data": ""},
    )
    assert empty.status == 400

    bad_kind = api.post(
        "/api/applications/%d/documents" % app_id,
        {"filename": "x.txt", "kind": "passport", "data": base64.b64encode(b"x").decode()},
    )
    assert bad_kind.status == 400

    oversized = api.post(
        "/api/applications/%d/documents" % app_id,
        {
            "filename": "big.bin",
            "data": base64.b64encode(b"x" * (10 * 1024 * 1024 + 1)).decode(),
        },
    )
    assert oversized.status == 413


def test_settings_defaults_and_updates(api):
    defaults = api.get("/api/settings")
    assert defaults.status == 200
    assert defaults.data == {"daily_goal": 3, "weekly_goal": 10}

    updated = api.patch("/api/settings", {"daily_goal": 5})
    assert updated.status == 200
    assert updated.data == {"daily_goal": 5, "weekly_goal": 10}

    both = api.patch("/api/settings", {"daily_goal": 2, "weekly_goal": 4})
    assert both.data == {"daily_goal": 2, "weekly_goal": 4}
    assert api.get("/api/settings").data == {"daily_goal": 2, "weekly_goal": 4}


def test_settings_validation(api):
    assert api.patch("/api/settings", {"daily_goal": 0}).status == 400
    assert api.patch("/api/settings", {"daily_goal": 101}).status == 400
    assert api.patch("/api/settings", {"weekly_goal": "many"}).status == 400
    assert api.patch("/api/settings", {}).status == 400
    # Rejected values leave the stored goals untouched.
    assert api.get("/api/settings").data == {"daily_goal": 3, "weekly_goal": 10}


def test_import_json(api):
    response = api.post(
        "/api/import",
        {"applications": [{"company": "Imported", "role": "Engineer", "phase": "to_apply"}]},
    )
    assert response.status == 200
    assert response.data["imported"] == 1
    assert response.data["skipped"] == 0

    listed = api.get("/api/applications").data
    assert [app["company"] for app in listed] == ["Imported"]
    assert listed[0]["phase"] == "to_apply"


def test_extract_requires_url(api):
    assert api.post("/api/extract", {}).status == 400
    assert api.post("/api/extract", {"url": "   "}).status == 400

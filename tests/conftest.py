"""Fixtures for the API tests.

Each test gets the real HTTP server on a random loopback port, backed by a
throwaway SQLite database, so requests exercise routing, validation and storage
exactly as the app does.
"""

import base64
import json
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path
from http.server import ThreadingHTTPServer

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server  # noqa: E402  (needs the path tweak above)


class Response:
    def __init__(self, status, data, headers, body):
        self.status = status
        self.data = data
        self.headers = headers
        self.body = body


class ApiClient:
    """A browser-shaped client: same-origin writes plus the session token."""

    def __init__(self, base_url, tmp_path):
        self.base_url = base_url
        self.tmp_path = tmp_path
        self.token = ""
        self.token = self.session_token()

    def session_token(self):
        with urllib.request.urlopen(self.base_url + "/api/session") as response:
            return json.loads(response.read())["token"]

    def request(self, method, path, payload=None, headers=None, origin=None, token=None):
        body = None
        request_headers = {"Content-Type": "application/json"}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
        if method.upper() not in ("GET", "HEAD"):
            # Browsers send Origin on writes; the server only accepts its own.
            request_headers["Origin"] = self.base_url if origin is None else origin
        effective_token = self.token if token is None else token
        if effective_token:
            request_headers["X-Api-Token"] = effective_token
        if headers:
            request_headers.update(headers)
        request = urllib.request.Request(
            self.base_url + path, data=body, headers=request_headers, method=method
        )
        try:
            with urllib.request.urlopen(request) as response:
                raw = response.read()
                return Response(
                    response.status,
                    _parse(raw),
                    dict(response.headers),
                    raw,
                )
        except urllib.error.HTTPError as error:
            raw = error.read()
            return Response(error.code, _parse(raw), dict(error.headers), raw)

    def get(self, path, **kwargs):
        return self.request("GET", path, **kwargs)

    def post(self, path, payload=None, **kwargs):
        return self.request("POST", path, payload, **kwargs)

    def patch(self, path, payload=None, **kwargs):
        return self.request("PATCH", path, payload, **kwargs)

    def delete(self, path, **kwargs):
        return self.request("DELETE", path, **kwargs)

    def create(self, **fields):
        fields.setdefault("company", "Acme")
        fields.setdefault("role", "Engineer")
        response = self.post("/api/applications", fields)
        assert response.status == 201, response.data
        return response.data

    def upload(
        self,
        app_id,
        raw,
        filename="resume.txt",
        kind="resume",
        content_type="text/plain",
        headers=None,
        replace=None,
    ):
        payload = {
            "filename": filename,
            "kind": kind,
            "content_type": content_type,
            "data": base64.b64encode(raw).decode("ascii"),
        }
        if replace is not None:
            payload["replace"] = replace
        response = self.post(
            "/api/applications/%s/documents" % app_id, payload, headers=headers
        )
        return response

    def uploads_dir(self, app_id):
        return self.tmp_path / "uploads" / str(app_id)


def _parse(raw):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return raw


@pytest.fixture()
def api(tmp_path, monkeypatch):
    db_path = tmp_path / "tracker.db"
    server.init_db(str(db_path))
    monkeypatch.setattr(server.Handler, "db_path", str(db_path))
    # Keep pytest output free of one log line per request.
    monkeypatch.setattr(server.Handler, "log_message", lambda *args, **kwargs: None)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    client = ApiClient("http://127.0.0.1:%d" % httpd.server_address[1], tmp_path)
    try:
        yield client
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)

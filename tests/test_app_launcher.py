"""The app bundle starts the tracker by itself.

Opening Jobby.app must never need a terminal, a command to copy or a
second click: it starts the server, waits until it answers and opens the
dashboard. These tests drive the bundle's own launch script with stand-ins for
python3, curl, open and osascript, so the whole sequence is exercised without a
real port, a real browser or a real dialog.
"""

import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "Jobby.app"
SCRIPT = APP / "Contents" / "MacOS" / "Jobby"

STUBS = {
    # Stands in for python3: records the call and claims to have started.
    "python3": """#!/bin/sh
echo "$@" >> "$STUB_DIR/python.log"
exit 0
""",
    "open": """#!/bin/sh
echo "$@" >> "$STUB_DIR/open.log"
exit 0
""",
    "osascript": """#!/bin/sh
echo "$@" >> "$STUB_DIR/alert.log"
exit 0
""",
    # The wait loop would otherwise take fifteen seconds to give up.
    "sleep": """#!/bin/sh
exit 0
""",
    # curl answers for /api/health. STUB_CURL says what the server is doing:
    # "up" (running), "down" (never answers) or the default, where the first
    # probe finds nothing and a server started by the app answers after that.
    "curl": """#!/bin/sh
n=0
[ -f "$STUB_DIR/curl.count" ] && n=$(cat "$STUB_DIR/curl.count")
n=$((n + 1))
echo "$n" > "$STUB_DIR/curl.count"
case "${STUB_CURL:-down-then-up}" in
  up) exit 0 ;;
  down) exit 1 ;;
  *) [ "$n" -ge 2 ] && exit 0; exit 1 ;;
esac
""",
}


@pytest.fixture()
def project(tmp_path):
    """A throwaway project folder holding the app and stand-in tools."""
    folder = tmp_path / "project"
    folder.mkdir()
    shutil.copytree(APP, folder / APP.name)
    (folder / "server.py").write_text("# stand-in for the real server\n", encoding="utf-8")
    stubs = folder / "stubs"
    stubs.mkdir()
    for name, body in STUBS.items():
        tool = stubs / name
        tool.write_text(body, encoding="utf-8")
        tool.chmod(0o755)
    return folder


def run_app(project, mode="down-then-up"):
    env = dict(os.environ)
    env["PATH"] = str(project / "stubs") + ":/usr/bin:/bin:/usr/sbin:/sbin"
    env["STUB_DIR"] = str(project / "stubs")
    env["STUB_CURL"] = mode
    result = subprocess.run(
        ["/bin/sh", str(project / APP.name / "Contents" / "MacOS" / "Jobby")],
        env=env,
        cwd=str(project),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=120,
    )
    return result, project / "stubs"


def read(path):
    return path.read_text(encoding="utf-8") if path.exists() else ""


def wait_for(path, needle, timeout=10):
    """The server is started in the background, so its call lands later."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if needle in read(path):
            return True
        time.sleep(0.05)
    return False


@pytest.mark.skipif(os.name == "nt", reason="the app bundle is macOS only")
def test_opening_the_app_starts_the_server_and_opens_the_dashboard(project):
    result, stubs = run_app(project)

    assert result.returncode == 0, result.stdout
    started = read(stubs / "python.log")
    assert wait_for(stubs / "python.log", "server.py")
    # The optional engine install runs first, as it does in the launchers.
    assert started.index("install_tectonic.py") < started.index("server.py")
    assert wait_for(stubs / "open.log", "http://127.0.0.1:8787")
    # Nothing to report when the start goes to plan.
    assert read(stubs / "alert.log") == ""


@pytest.mark.skipif(os.name == "nt", reason="the app bundle is macOS only")
def test_a_server_that_is_already_running_is_only_opened(project):
    result, stubs = run_app(project, mode="up")

    assert result.returncode == 0, result.stdout
    assert "http://127.0.0.1:8787" in read(stubs / "open.log")
    # A second server would collide on the port, so none is started.
    assert read(stubs / "python.log") == ""


@pytest.mark.skipif(os.name == "nt", reason="the app bundle is macOS only")
def test_a_server_that_never_answers_is_reported_to_the_user(project):
    result, stubs = run_app(project, mode="down")

    assert result.returncode == 1
    assert wait_for(stubs / "python.log", "server.py")
    # The user gets a dialog naming the log, not a silent nothing.
    assert wait_for(stubs / "alert.log", "did not start")
    assert read(stubs / "open.log") == ""

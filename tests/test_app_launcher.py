"""The app bundle starts the tracker by itself.

Opening Jobby.app must never need a terminal, a command to copy or a
second click: it starts the server, waits until it answers and opens the
dashboard. These tests drive the bundle's own launch script with stand-ins for
python3, curl, open and osascript, so the whole sequence is exercised without a
real port, a real browser or a real dialog.

The server is started by the small helper app inside Resources, not by Jobby.app
itself: macOS tears an app's processes down when the app quits, and this app
quits as soon as the dashboard is open. That is why the helper is tested too.
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
    # Stands in for python3: records the working directory and the call, and
    # claims to have started.
    "python3": """#!/bin/sh
echo "$PWD $@" >> "$STUB_DIR/python.log"
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
    # The window is compiled from Resources on first use. xcrun reports where
    # swiftc is, and swiftc writes the stand-in "window" it was asked for, so no
    # real compiler runs in the test suite.
    "xcrun": """#!/bin/sh
if [ "${1:-}" = "--find" ]; then
  echo "$STUB_DIR/swiftc"
  exit 0
fi
# "xcrun swiftc ..." — hand the rest to the compiler stand-in.
shift
exec "$STUB_DIR/swiftc" "$@"
""",
    "swiftc": """#!/bin/sh
if [ "${STUB_COMPILER:-build}" = "fail" ]; then
  echo "swiftc: simulated failure" >&2
  exit 1
fi
out=""
previous=""
for argument in "$@"; do
  [ "$previous" = "-o" ] && out="$argument"
  previous="$argument"
done
echo "$*" >> "$STUB_DIR/swiftc.log"
{
  echo '#!/bin/sh'
  echo 'echo "$@" >> "$STUB_DIR/window.log"'
  echo 'exit 0'
} > "$out"
chmod +x "$out"
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
    # As a fresh clone would be: the window is built from its source, not the
    # copy this machine may already have compiled into the real bundle.
    for leftover in ("JobbyWindow", "JobbyWindow.building"):
        (folder / APP.name / "Contents" / "MacOS" / leftover).unlink(missing_ok=True)
    (folder / "server.py").write_text("# stand-in for the real server\n", encoding="utf-8")
    stubs = folder / "stubs"
    stubs.mkdir()
    for name, body in STUBS.items():
        tool = stubs / name
        tool.write_text(body, encoding="utf-8")
        tool.chmod(0o755)
    return folder


def launcher_env(project, mode="down-then-up", compiler="build"):
    env = dict(os.environ)
    env["PATH"] = str(project / "stubs") + ":/usr/bin:/bin:/usr/sbin:/sbin"
    env["STUB_DIR"] = str(project / "stubs")
    env["STUB_CURL"] = mode
    env["STUB_COMPILER"] = compiler
    return env


def run_app(project, mode="down-then-up", compiler="build"):
    env = launcher_env(project, mode, compiler)
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
def test_opening_the_app_starts_the_helper_then_the_dashboard(project):
    result, stubs = run_app(project)

    assert result.returncode == 0, result.stdout
    # The server is asked for through the helper app, before the dashboard is
    # opened — the app itself never turns into the server's parent.
    opened = read(stubs / "open.log")
    assert wait_for(stubs / "open.log", "JobbyServer.app")
    # The app itself only installs the optional engine and leaves the server to
    # the helper, which is the one process that has to outlive the bundle.
    installs = read(stubs / "python.log")
    assert "install_tectonic.py" in installs
    assert "server.py" not in installs
    # The dashboard is shown in its own window, not in a browser tab.
    assert "JobbyWindow" in read(stubs / "swiftc.log")
    assert wait_for(stubs / "window.log", "http://127.0.0.1:8787")
    assert "http://127.0.0.1:8787" not in opened
    # Nothing to report when the start goes to plan.
    assert read(stubs / "alert.log") == ""


@pytest.mark.skipif(os.name == "nt", reason="the app bundle is macOS only")
def test_without_a_swift_compiler_the_dashboard_opens_in_the_browser(project):
    result, stubs = run_app(project, compiler="fail")

    assert result.returncode == 0, result.stdout
    # The window could not be built, so a browser tab is the fallback rather than
    # opening nothing at all.
    assert wait_for(stubs / "open.log", "http://127.0.0.1:8787")
    assert read(stubs / "window.log") == ""


@pytest.mark.skipif(os.name == "nt", reason="the app bundle is macOS only")
def test_the_helper_app_runs_the_server_from_inside_the_bundle(project):
    helper = (
        project / APP.name / "Contents" / "Resources" / "JobbyServer.app"
        / "Contents" / "MacOS" / "JobbyServer"
    )
    result = subprocess.run(
        ["/bin/sh", str(helper)],
        env=launcher_env(project),
        cwd="/",
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=30,
    )

    assert result.returncode == 0, result.stdout
    lines = read(project / "stubs" / "python.log").strip().splitlines()
    assert lines, "the helper did not start the server"
    where, arguments = lines[-1].split(" ", 1)
    # Adjacent folders inside the bundle, so the path up to the project has to be
    # exactly right: one level too few and there is no server.py to run.
    assert where == str(project)
    assert "server.py" in arguments
    # Started this way, the server stops once the dashboard is gone.
    assert "--exit-when-idle" in arguments


@pytest.mark.skipif(os.name == "nt", reason="the app bundle is macOS only")
def test_a_server_that_is_already_running_is_only_opened(project):
    result, stubs = run_app(project, mode="up")

    assert result.returncode == 0, result.stdout
    # A second server would collide on the port, so none is started — not even
    # the helper is asked to open.
    assert read(stubs / "python.log") == ""
    assert "JobbyServer" not in read(stubs / "open.log")
    # The dashboard still gets its window.
    assert wait_for(stubs / "window.log", "http://127.0.0.1:8787")


@pytest.mark.skipif(os.name == "nt", reason="the app bundle is macOS only")
def test_a_server_that_never_answers_is_reported_to_the_user(project):
    result, stubs = run_app(project, mode="down")

    assert result.returncode == 1
    # It did try: the helper was opened, but nothing answered behind it.
    assert "JobbyServer.app" in read(stubs / "open.log")
    # The user gets a dialog naming the log, not a silent nothing.
    assert wait_for(stubs / "alert.log", "did not start")
    assert "http://127.0.0.1:8787" not in read(stubs / "open.log")

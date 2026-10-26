"""The launchers keep the server running.

A dashboard in a browser cannot start a process on this machine — it can only
report that the server stopped answering — so the double-click launchers are
what brings the server back after it dies. This drives the Unix one with a
stand-in python3 that exits at once, and checks the restart loop without a real
server, a real port or a real browser.
"""

import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "Start Job Pipeline.command"

# Stands in for python3: the health probe fails, and the server dies the moment
# it starts. Every call is written down so the test can count the restarts.
FAKE_PYTHON = """#!/bin/sh
echo "$@" >> "$LAUNCHER_LOG"
case "$1" in
  -) exit 1 ;;
  server.py) exit 1 ;;
  *) exit 0 ;;
esac
"""


@pytest.fixture()
def launcher(tmp_path):
    """The launcher in a throwaway folder, with a python3 that always fails."""
    workdir = tmp_path / "app"
    workdir.mkdir()
    shutil.copyfile(LAUNCHER, workdir / LAUNCHER.name)
    binary = workdir / "bin"
    binary.mkdir()
    fake = binary / "python3"
    fake.write_text(FAKE_PYTHON, encoding="utf-8")
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    return workdir, workdir / "calls.log", binary


@pytest.mark.skipif(os.name == "nt", reason="the .command launcher is Unix only")
def test_the_launcher_restarts_a_server_that_dies_and_then_gives_up(launcher):
    workdir, log, binary = launcher
    env = dict(os.environ)
    env["PATH"] = str(binary) + os.pathsep + env.get("PATH", "")
    env["LAUNCHER_LOG"] = str(log)

    result = subprocess.run(
        ["/bin/sh", LAUNCHER.name],
        cwd=str(workdir),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=90,
    )

    calls = log.read_text(encoding="utf-8").splitlines()
    runs = [call for call in calls if call.startswith("server.py")]
    output = result.stdout

    # The first run opens the browser; a restart must not open a second tab.
    assert runs.count("server.py --open") == 1
    # Two restarts, and the third quick failure stops the loop instead of
    # spinning this window forever.
    assert len(runs) == 3
    assert output.count("Restarting it") == 2
    assert "three times within seconds" in output
    assert "exit code 1" in output

"""The server can stop itself when nothing is using it.

Jobby.app starts the server with no window behind it, so closing the dashboard
cannot be noticed by a terminal being closed: `--exit-when-idle` is how the
server goes away once the app is gone. Started any other way it keeps running
until Ctrl+C, which the launcher's restart loop depends on.
"""

import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

import server

ROOT = Path(__file__).resolve().parents[1]


class FakeServer:
    def __init__(self):
        self.stopped = False

    def shutdown(self):
        self.stopped = True


def test_the_watch_stops_a_server_nobody_has_asked_anything():
    server.Handler.last_seen = 0.0
    fake = FakeServer()
    readings = iter([10.0, 100.0])  # the second check finds it long past idle
    said = []
    server.watch_idle(
        fake,
        idle_seconds=30,
        interval=1,
        clock=lambda: next(readings),
        sleep=lambda seconds: None,
        report=said.append,
    )
    assert fake.stopped is True
    assert "30" in said[0]


def test_a_request_inside_the_window_keeps_the_server_up():
    fake = FakeServer()
    readings = iter([100.0, 110.0])

    def clock():
        value = next(readings)
        # Every tick finds a request that arrived 5 seconds ago.
        server.Handler.last_seen = value - 5
        return value

    with pytest.raises(StopIteration):
        server.watch_idle(
            fake,
            idle_seconds=30,
            interval=1,
            clock=clock,
            sleep=lambda seconds: None,
            report=lambda message: None,
        )
    assert fake.stopped is False


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def healthy(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/health" % port, timeout=1) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError):
        return False


def wait_until_healthy(port, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if healthy(port):
            return True
        time.sleep(0.1)
    return False


def test_a_quiet_server_stops_itself_and_a_busy_one_does_not(tmp_path):
    port = free_port()
    process = subprocess.Popen(
        [
            sys.executable,
            str(ROOT / "server.py"),
            "--port",
            str(port),
            "--db",
            str(tmp_path / "tracker.db"),
            "--exit-when-idle",
            "1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        assert wait_until_healthy(port)

        # An open dashboard keeps asking, so the server stays.
        for _ in range(6):
            time.sleep(0.4)
            assert healthy(port)
        assert process.poll() is None

        # Nothing asks any more: it goes away on its own.
        deadline = time.time() + 20
        while time.time() < deadline and process.poll() is None:
            time.sleep(0.2)
        assert process.poll() is not None, "the idle server kept running"
        assert process.returncode == 0
        assert "stopping" in process.stdout.read().lower()
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)


@pytest.mark.skipif(os.name == "nt", reason="the launcher and app bundles here are Unix only")
def test_started_without_the_flag_the_server_stays(tmp_path):
    port = free_port()
    process = subprocess.Popen(
        [
            sys.executable,
            str(ROOT / "server.py"),
            "--port",
            str(port),
            "--db",
            str(tmp_path / "tracker.db"),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        assert wait_until_healthy(port)
        time.sleep(1.5)
        assert process.poll() is None, "a terminal server must not stop by itself"
        assert healthy(port)
    finally:
        process.terminate()
        process.wait(timeout=10)

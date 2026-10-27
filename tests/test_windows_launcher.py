"""The Windows app: Jobby.vbs, and the launcher that reuses it.

Double-clicking Jobby.vbs has to do what opening Jobby.app does on macOS: start
the server out of sight, wait until it answers, and open the dashboard in a
window of its own - and the server it started has to stop when that window goes
away, rather than living on behind the desktop.

Neither file can be run from here: VBScript and cmd.exe are Windows. So these
tests read them the way Windows would - byte for byte, in the project folder -
and pin the things that would otherwise only show up the day someone
double-clicks: the CRLF line endings and single-byte text cmd and wscript can
read, the endpoints and flags the scripts have to agree on with each other and
with server.py, and a script that at least parses (no block left open).
"""

import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
VBS = ROOT / "Jobby.vbs"
BAT = ROOT / "Start Jobby.bat"
SERVER = ROOT / "server.py"

# Port and endpoint the three have to agree on, or the wait before the window
# opens would never see the server come up.
PORT = "8787"
HEALTH = "/api/health"


def raw(name):
    return name.read_bytes()


def text(name):
    """The file as wscript and cmd read it: one byte, one character."""
    return raw(name).decode("ascii")


def test_windows_reads_them_as_windows_files():
    for name in (VBS, BAT):
        data = raw(name)
        # Not one drop of non-ASCII: cmd decodes the batch file in an OEM code
        # page and wscript an ANSI one, so a UTF-8 em dash arrives as mojibake.
        data.decode("ascii")
        assert not data.startswith(b"\xef\xbb\xbf"), "%s has a UTF-8 BOM" % name.name
        # Every line ending is CRLF, and no line is left with a bare LF, which
        # cmd would read as part of the command.
        assert b"\r\n" in data
        assert re.search(rb"(?<!\r)\n", data) is None, "%s has a bare LF" % name.name


def test_the_script_starts_the_server_hidden_and_logged():
    script = text(VBS)

    # Hidden - window style 0 - and not waited for: the script goes on to open
    # the dashboard while the server keeps running after it has quit.
    assert 'shell.Run "cmd /c " & Quote(command), 0, False' in script
    # On the same port the other launchers use, from the project folder, with
    # paths quoted because "Job Applications Tracking Dashboard" has spaces.
    assert 'command = Quote(python) & extraArgs & " " & Quote(fso.BuildPath(root, SERVER))' in script
    assert '" --port " & PORT' in script
    # Python 3 even where the py launcher would otherwise pick Python 2.
    assert "python = FindPython(pythonArgs)" in script
    assert 'extraArgs = " -3"' in script
    # Where the Mac app writes: data\server.log, and the folder is made first so
    # the redirection has somewhere to go on a first run.
    assert 'fso.BuildPath(fso.BuildPath(root, "data"), "server.log")' in script
    assert ">> " in script and "2>&1" in script
    assert "fso.CreateFolder" in script
    # The optional engine first, exactly as the other launchers do.
    assert "install_tectonic.py --quiet" in script


def test_closing_the_window_is_what_stops_the_server():
    script = text(VBS)
    server = SERVER.read_text(encoding="utf-8")

    # --exit-when-idle is what installs the dashboard tracking that turns a
    # closed window into a stopped server; without it the goodbye is ignored
    # and a hidden server would be left behind.
    assert '" --exit-when-idle 120' in script
    marker = server.index("if args.exit_when_idle > 0:")
    assert server.index("Handler.auto_stop = clients") > marker
    # ...and the request the page sends when it closes is the one that ends it.
    assert 'parts[0] == "bye"' in server
    assert "/api/bye" in (ROOT / "public" / "js" / "status.js").read_text(encoding="utf-8")


def test_the_dashboard_gets_a_window_of_its_own():
    script = text(VBS)

    # App mode: a window with no tab strip and no address bar. Edge ships with
    # Windows; Chrome is the fallback, and both are found by full path.
    assert "msedge.exe" in script
    assert "chrome.exe" in script
    assert '--app=" & url' in script
    # No Chromium browser at all still gets the dashboard, in a normal window.
    assert "shell.Run url, 1, False" in script


def test_the_double_click_waits_but_never_hangs():
    script = text(VBS)

    # The health endpoint needs no token, so it answers while the dashboard is
    # still starting up; the wait is bounded, so a server that never comes up
    # ends in a dialog instead of a process that waits for ever.
    assert 'url & "/api/health"' in script
    assert "For attempt = 1 To 80" in script
    assert "WScript.Sleep 250" in script
    assert "The tracker did not start." in script
    # "wait" is a plain argument, not /wait: only /name:value is a named
    # argument, so a slash and a name would be read as something else entirely.
    assert 'LCase(WScript.Arguments(0)) = "wait"' in script
    assert "Named.Exists" not in script


def test_the_batch_launcher_keeps_the_server_in_its_console():
    batch = text(BAT)

    # The visible-console path: the server runs in this window, in the
    # foreground, so Ctrl+C and the log both work.
    assert "%PY% server.py" in batch
    # No --open: the window is opened by the script, so a restart must not drop
    # a second tab on top of it.
    assert "--open" not in batch
    assert 'wscript //nologo "%~dp0Jobby.vbs" wait' in batch
    # A server that is already up is only shown, never started twice.
    assert "Jobby is already running" in batch
    assert "'/api/health', timeout=1.5" in batch
    # Three quick deaths stop the loop instead of spinning this window for ever.
    assert "if %QUICK% geq 3 goto :givingup" in batch
    assert "timeout /t 1 /nobreak" in batch


def test_the_three_files_agree_on_port_and_endpoint():
    vbs = text(VBS)
    batch = text(BAT)
    server = SERVER.read_text(encoding="utf-8")

    assert "Const PORT = 8787" in vbs
    assert "http://127.0.0.1:8787" in batch
    assert HEALTH in vbs and HEALTH in batch
    assert "default=8787" in server
    # The path those two ask about is the one the server answers.
    assert 'parts[0] == "health"' in server


def test_the_script_parses():
    lines = text(VBS).splitlines()

    blocks = [
        (r"^\s*(Function|Sub)\s+\w+\s*\(", r"^\s*End (Function|Sub)\s*$"),
        (r"^\s*If\b.*\bThen\s*$", r"^\s*End If\s*$"),
        (r"^\s*For\b.*$", r"^\s*Next\s*$"),
    ]
    assert lines[0].startswith("'"), "the file should open with its own notes"
    assert "Option Explicit" in lines
    for opening, closing in blocks:
        opened = [line for line in lines if re.match(opening, line, re.IGNORECASE)]
        closed = [line for line in lines if re.match(closing, line, re.IGNORECASE)]
        assert len(opened) == len(closed), "%s is not closed in every case" % opening
        assert opened, "nothing matched %s" % opening

    script = "\n".join(lines)
    for name in (
        "Quote",
        "ServerIsUp",
        "WaitForServer",
        "StartServer",
        "FindPython",
        "OnPath",
        "FindBrowser",
        "OpenDashboard",
    ):
        # Written once where it is defined, and used somewhere else.
        assert script.count(name) >= 2, "%s is never called" % name


def test_a_clone_on_any_platform_gets_the_endings_these_files_need():
    """CRLF for Windows, LF for the .command macOS runs, whatever the machine."""
    attributes = (ROOT / ".gitattributes").read_text(encoding="utf-8")
    assert "*.bat text eol=crlf" in attributes
    assert "*.vbs text eol=crlf" in attributes
    assert "*.command text eol=lf" in attributes


@pytest.mark.skipif(os.name != "nt", reason="cscript is Windows only")
def test_the_script_runs_where_it_can_be_run(tmp_path):
    """On Windows, run the script for real instead of only reading it.

    Nothing is listening on the port, so the path "Start Jobby.bat" asks for -
    shown the window once a server answers, told which one it is with the word
    "wait" - waits its twenty seconds out and finishes cleanly. A syntax error, a
    name used without being declared (Option Explicit), or a flag the script does
    not recognise all come back as a non-zero exit and a message instead.

    Started with the output in a file rather than a pipe: a script that wrongly
    went on to start the server would leave that child holding the pipe, and the
    wait would hide the real error behind a timeout.
    """
    said = tmp_path / "cscript.log"
    with open(said, "w", encoding="utf-8", errors="replace") as handle:
        result = subprocess.run(
            ["cscript", "//nologo", str(VBS), "wait"],
            cwd=str(ROOT),
            stdout=handle,
            stderr=subprocess.STDOUT,
            timeout=120,
        )
    assert result.returncode == 0, said.read_text(encoding="utf-8", errors="replace")


@pytest.mark.skipif(os.name != "nt", reason="the Windows app is Windows only")
def test_double_clicking_it_starts_the_server_and_shows_the_dashboard(tmp_path):
    """The double-click itself, on a machine that can double-click.

    No arguments, exactly as Explorer starts it. A clean exit is the whole
    assertion: the script only reaches WScript.Quit 0 once /api/health has
    answered - a server it could not start ends in a dialog and exit code 1,
    which is what this would come back as. The server it leaves behind stops
    itself, two minutes after the dashboard does. The output goes to a file so
    that a server child holding the other end of a pipe cannot turn a real
    failure into a timeout.
    """
    said = tmp_path / "wscript.log"
    with open(said, "w", encoding="utf-8", errors="replace") as handle:
        result = subprocess.run(
            ["wscript", "//nologo", str(VBS)],
            cwd=str(ROOT),
            stdout=handle,
            stderr=subprocess.STDOUT,
            timeout=300,
        )
    assert result.returncode == 0, said.read_text(encoding="utf-8", errors="replace")
    assert (ROOT / "data" / "server.log").exists()

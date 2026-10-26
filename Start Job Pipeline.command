#!/bin/sh
# Double-click to start Job Pipeline and open the dashboard.
# Keep this Terminal window open while you use the app; Ctrl+C stops the server.
#
# If a server is already running on port 8787, this just opens the dashboard.
#
# A dashboard in a browser cannot start a process on this machine, so keeping
# the server alive is this script's job: if it stops unexpectedly it is started
# again (in the same window) instead of leaving a dead page behind.

cd "$(dirname "$0")" || exit 1

URL="http://127.0.0.1:8787"

server_is_up() {
  python3 - "$URL" <<'PY' >/dev/null 2>&1
import sys
import urllib.request

try:
    with urllib.request.urlopen(sys.argv[1] + "/api/health", timeout=1.5) as response:
        sys.exit(0 if response.status == 200 else 1)
except Exception:
    sys.exit(1)
PY
}

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 was not found."
  echo "Install Python 3.8 or newer from https://www.python.org/downloads/ and try again."
  echo
  printf "Press Return to close this window."
  read -r _
  exit 1
fi

if server_is_up; then
  echo "Job Pipeline is already running at $URL"
  open "$URL"
  exit 0
fi

# Compile can build a real PDF with Tectonic. It is optional: fetch it once
# into tools/tectonic, and carry on (in-app preview) if that is not possible.
python3 install_tectonic.py --quiet
echo
echo "Starting Job Pipeline…"
echo

# Ctrl+C in this window stops the server for good; anything else is a crash.
stopping=0
trap 'stopping=1' INT TERM
quick=0
first_run=1

while :; do
  started=$(date +%s)
  if [ "$first_run" = 1 ]; then
    python3 server.py --open
    first_run=0
  else
    python3 server.py
  fi
  status=$?
  if [ "$stopping" = 1 ]; then
    break
  fi
  ran=$(( $(date +%s) - started ))
  if [ "$ran" -lt 5 ]; then
    quick=$((quick + 1))
  else
    quick=0
  fi
  if [ "$quick" -ge 3 ]; then
    echo
    echo "The server stopped three times within seconds of starting."
    echo "Something else may be using port 8787, or the database could not be opened."
    echo "The error above says which. To start it by hand, run: python3 server.py"
    break
  fi
  echo
  echo "The server stopped unexpectedly (exit code $status). Restarting it…"
  echo
  # Give the port a moment to come back before binding it again.
  sleep 1
done

echo
if [ "$status" -ne 0 ]; then
  echo "The server stopped with an error (exit code $status)."
else
  echo "Server stopped."
fi
printf "Press Return to close this window."
read -r _
